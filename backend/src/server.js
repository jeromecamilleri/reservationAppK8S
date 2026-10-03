import argon2 from 'argon2';
import { csrfSync } from 'csrf-sync';
import { RedisStore } from 'connect-redis';
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import pg from 'pg';
import { createClient } from 'redis';
import { abortableSleep, retryUntilReady } from './retry.js';

const { Pool } = pg;
const port = Number(process.env.PORT || 8080);
const sessionCookie = 'reservation.sid';
const sessionTtlSeconds = 30 * 60;
const cartTtlSeconds = 24 * 60 * 60;
const shutdownController = new AbortController();
let eventCatalogCache = null;
let databaseInitialized = false;
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-service',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'reservation_db',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
pool.on('error', (error) => {
  console.error(`PostgreSQL idle connection error (${error.code || 'unknown'}): ${error.message}`);
});

const redis = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'redis-service',
    port: Number(process.env.REDIS_PORT || 6379),
    reconnectStrategy: (retries) => Math.min(retries * 250, 3000),
  },
  password: process.env.REDIS_PASSWORD,
});
redis.on('error', (error) => console.error('Redis connection error:', error.message));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters');
}
if (!process.env.DB_PASSWORD || !process.env.REDIS_PASSWORD) {
  throw new Error('DB_PASSWORD and REDIS_PASSWORD must be configured');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(session({
  name: sessionCookie,
  store: new RedisStore({ client: redis, prefix: 'reservation:session:', ttl: sessionTtlSeconds }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: sessionTtlSeconds * 1000,
    path: '/',
  },
}));

const { csrfSynchronisedProtection, generateToken } = csrfSync();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_login_attempts' },
});

const cartSetScript = `
  local quantity = tonumber(ARGV[1])
  local maximum = tonumber(ARGV[2])
  if quantity < 0 or quantity > maximum then return 0 end
  if quantity == 0 then
    redis.call('HDEL', KEYS[1], ARGV[3])
  else
    redis.call('HSET', KEYS[1], ARGV[3], quantity)
    redis.call('EXPIRE', KEYS[1], ARGV[4])
  end
  return 1
`;

const initialEvents = [
  ['concert-elysee', 'Concert aux chandelles', 'Musique', 'Le Trianon', 'Paris', '2026-11-14T19:30:00+01:00', 4900, 180, 'Une soirée de musique live dans un cadre intimiste.'],
  ['festival-lumiere', 'Festival des Lumieres', 'Festival', 'Parc de la Villette', 'Paris', '2026-12-05T17:00:00+01:00', 3200, 600, 'Trois scènes, des artistes émergents et une grande scène en plein air.'],
  ['match-olympique', 'Olympique de Marseille - Lyon', 'Sport', 'Orange Vélodrome', 'Marseille', '2026-11-22T20:45:00+01:00', 6500, 220, 'Une affiche de championnat au cœur du Vélodrome.'],
  ['theatre-misanthrope', 'Le Misanthrope', 'Théâtre', 'Théâtre de la Porte Saint-Martin', 'Paris', '2026-10-30T20:00:00+01:00', 3800, 120, 'La comédie de Molière dans une nouvelle mise en scène.'],
];

function sessionCall(req, operation) {
  return new Promise((resolve, reject) => req.session[operation]((error) => error ? reject(error) : resolve()));
}

function publicUser(user) {
  return { id: String(user.id), name: user.name, email: user.email };
}

function requireUser(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'authentication_required' });
  next();
}

function cartKey(userId) {
  return `reservation:cart:${userId}`;
}

async function loadOrder(code, userId) {
  const { rows } = await pool.query(
    `SELECT o.code, o.status, o.total_cents, o.created_at,
            COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
              'eventId', oi.event_id, 'title', oi.event_title, 'seats', oi.seats,
              'unitPriceCents', oi.unit_price_cents
            ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) AS items
     FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.code = $1 AND o.user_id = $2
     GROUP BY o.id`,
    [code, userId],
  );
  return rows[0] || null;
}

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73910244)');
    await client.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      venue TEXT NOT NULL,
      city TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      total_seats INTEGER NOT NULL CHECK (total_seats >= 0),
      available_seats INTEGER NOT NULL CHECK (available_seats >= 0 AND available_seats <= total_seats),
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL REFERENCES events(id),
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 8),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS reservations_email_idx ON reservations (LOWER(customer_email));
    CREATE INDEX IF NOT EXISTS reservations_event_idx ON reservations (event_id, status);
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      user_id BIGINT NOT NULL REFERENCES users(id),
      checkout_key UUID NOT NULL,
      total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT orders_user_checkout_key UNIQUE (user_id, checkout_key)
    );
    CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES events(id),
      event_title TEXT NOT NULL,
      seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 8),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      UNIQUE (order_id, event_id)
    );
    `);

    for (const event of initialEvents) {
      await client.query(
        `INSERT INTO events (id, title, category, venue, city, starts_at, price_cents, total_seats, available_seats, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9) ON CONFLICT (id) DO NOTHING`,
        event,
      );
    }
    await client.query('COMMIT');
    await refreshEventCatalog();
    databaseInitialized = true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function refreshEventCatalog() {
  const { rows } = await pool.query(
    `SELECT id, title, category, venue, city, starts_at, price_cents,
            total_seats, available_seats, description
     FROM events WHERE starts_at > NOW() ORDER BY starts_at`,
  );
  eventCatalogCache = rows;
  return rows;
}

app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    if (!redis.isReady) return res.status(503).json({ error: 'redis_unavailable' });
    if (!databaseInitialized) return res.status(503).json({ error: 'database_initializing' });
    res.json({ status: 'ready' });
  } catch {
    if (redis.isReady && eventCatalogCache) {
      return res.json({ status: 'degraded', database: 'unavailable', catalog: 'cached' });
    }
    res.status(503).json({ error: 'dependency_unavailable' });
  }
});

app.get('/auth/csrf', (req, res) => res.json({ token: generateToken(req) }));
app.use(csrfSynchronisedProtection);

app.get('/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/auth/register', loginLimiter, async (req, res, next) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (name.length < 2 || name.length > 100 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'invalid_registration' });
  }

  try {
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3)
       RETURNING id, name, email`,
      [name, email, passwordHash],
    );
    await sessionCall(req, 'regenerate');
    req.session.user = publicUser(rows[0]);
    const token = generateToken(req);
    res.status(201).json({ user: req.session.user, csrfToken: token });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'users_email_lower_idx') {
      return res.status(409).json({ error: 'email_already_registered' });
    }
    next(error);
  }
});

app.post('/auth/login', loginLimiter, async (req, res, next) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || email.length > 254 || password.length > 128) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, password_hash FROM users WHERE LOWER(email) = $1`,
      [email],
    );
    if (!rows[0] || !(await argon2.verify(rows[0].password_hash, password))) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    await sessionCall(req, 'regenerate');
    req.session.user = publicUser(rows[0]);
    const token = generateToken(req);
    res.json({ user: req.session.user, csrfToken: token });
  } catch (error) {
    next(error);
  }
});

app.post('/auth/logout', requireUser, async (req, res, next) => {
  try {
    await sessionCall(req, 'destroy');
    res.clearCookie(sessionCookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      path: '/',
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/events', async (_req, res, next) => {
  try {
    res.json(await refreshEventCatalog());
  } catch (error) {
    if (eventCatalogCache) {
      res.set('X-Service-State', 'degraded');
      return res.json(eventCatalogCache);
    }
    next(error);
  }
});

app.get('/cart', requireUser, async (req, res, next) => {
  try {
    const key = cartKey(req.session.user.id);
    const entries = await redis.hGetAll(key);
    const eventIds = Object.keys(entries);
    if (!eventIds.length) return res.json({ items: [], totalCents: 0, checkoutKey: req.session.checkoutKey || null });
    const { rows } = await pool.query(
      `SELECT id, title, category, venue, city, starts_at, price_cents, available_seats
       FROM events WHERE id = ANY($1::text[])`,
      [eventIds],
    );
    const items = rows.map((event) => ({ ...event, quantity: Number(entries[event.id]) }));
    const totalCents = items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
    res.json({ items, totalCents, checkoutKey: req.session.checkoutKey || null });
  } catch (error) {
    next(error);
  }
});

app.put('/cart/items/:eventId', requireUser, async (req, res, next) => {
  const eventId = String(req.params.eventId);
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 8) {
    return res.status(400).json({ error: 'invalid_quantity' });
  }
  try {
    const eventResult = await pool.query(
      `SELECT id, available_seats FROM events WHERE id = $1 AND starts_at > NOW()`,
      [eventId],
    );
    if (!eventResult.rows[0]) return res.status(404).json({ error: 'event_not_found' });
    if (quantity > eventResult.rows[0].available_seats) return res.status(409).json({ error: 'event_unavailable' });

    const key = cartKey(req.session.user.id);
    const currentCount = await redis.hLen(key);
    if (quantity > 0 && currentCount === 0) req.session.checkoutKey = crypto.randomUUID();
    const result = await redis.eval(cartSetScript, {
      keys: [key],
      arguments: [String(quantity), String(eventResult.rows[0].available_seats), eventId, String(cartTtlSeconds)],
    });
    if (Number(result) !== 1) return res.status(409).json({ error: 'event_unavailable' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/cart/items/:eventId', requireUser, async (req, res, next) => {
  try {
    await redis.hDel(cartKey(req.session.user.id), String(req.params.eventId));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/cart', requireUser, async (req, res, next) => {
  try {
    await redis.del(cartKey(req.session.user.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/checkout', requireUser, async (req, res, next) => {
  const user = req.session.user;
  const key = cartKey(user.id);
  let client;
  try {
    const items = await redis.hGetAll(key);
    const eventIds = Object.keys(items).sort();
    if (!eventIds.length) return res.status(400).json({ error: 'cart_empty' });
    if (!req.session.checkoutKey) req.session.checkoutKey = crypto.randomUUID();
    await sessionCall(req, 'save');
    const checkoutKey = req.session.checkoutKey;

    const existing = await pool.query(
      `SELECT code FROM orders WHERE user_id = $1 AND checkout_key = $2`,
      [user.id, checkoutKey],
    );
    if (existing.rows[0]) {
      const order = await loadOrder(existing.rows[0].code, user.id);
      await redis.del(key);
      return res.json(order);
    }

    client = await pool.connect();
    await client.query('BEGIN');
    const purchased = [];
    for (const eventId of eventIds) {
      const seats = Number(items[eventId]);
      if (!Number.isInteger(seats) || seats < 1 || seats > 8) throw Object.assign(new Error('Invalid cart quantity'), { status: 400, publicCode: 'invalid_cart' });
      const { rows } = await client.query(
        `UPDATE events SET available_seats = available_seats - $2
         WHERE id = $1 AND starts_at > NOW() AND available_seats >= $2
         RETURNING id, title, price_cents`,
        [eventId, seats],
      );
      if (!rows[0]) throw Object.assign(new Error('Event inventory changed'), { status: 409, publicCode: 'cart_inventory_changed' });
      purchased.push({ ...rows[0], seats });
    }

    const totalCents = purchased.reduce((sum, item) => sum + item.price_cents * item.seats, 0);
    let order;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = crypto.randomBytes(6).toString('hex').toUpperCase();
      const inserted = await client.query(
      `INSERT INTO orders (code, user_id, checkout_key, total_cents)
         VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING id, code`,
        [code, user.id, checkoutKey, totalCents],
      );
      if (inserted.rows[0]) {
        order = inserted.rows[0];
        break;
      }
    }
    if (!order) throw new Error('Unable to generate an order code');

    for (const item of purchased) {
      await client.query(
        `INSERT INTO order_items (order_id, event_id, event_title, seats, unit_price_cents)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, item.id, item.title, item.seats, item.price_cents],
      );
    }
    await client.query('COMMIT');
    const result = await loadOrder(order.code, user.id);
    await redis.del(key);
    res.status(201).json(result);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error.constraint === 'orders_user_checkout_key') {
      try {
        const existing = await pool.query(
          `SELECT code FROM orders WHERE user_id = $1 AND checkout_key = $2`,
          [user.id, req.session.checkoutKey],
        );
        if (existing.rows[0]) {
          const order = await loadOrder(existing.rows[0].code, user.id);
          await redis.del(key);
          return res.json(order);
        }
      } catch (lookupError) {
        return next(lookupError);
      }
    }
    if (error.publicCode) return res.status(error.status).json({ error: error.publicCode });
    next(error);
  } finally {
    client?.release();
  }
});

app.get('/orders', requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.code, o.status, o.total_cents, o.created_at,
              COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
                'eventId', oi.event_id, 'title', oi.event_title, 'seats', oi.seats,
                'unitPriceCents', oi.unit_price_cents
              ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) AS items
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id ORDER BY o.created_at DESC`,
      [req.session.user.id],
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post('/orders/:code/cancel', requireUser, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, status FROM orders WHERE code = $1 AND user_id = $2 FOR UPDATE`,
      [String(req.params.code).toUpperCase(), req.session.user.id],
    );
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'order_not_found' });
    }
    if (found.rows[0].status !== 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'order_not_cancellable' });
    }
    const { rows: items } = await client.query(
      `SELECT event_id, seats FROM order_items WHERE order_id = $1 ORDER BY event_id FOR UPDATE`,
      [found.rows[0].id],
    );
    for (const item of items) {
      await client.query(
        `UPDATE events SET available_seats = LEAST(total_seats, available_seats + $2) WHERE id = $1`,
        [item.event_id, item.seats],
      );
    }
    await client.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [found.rows[0].id]);
    await client.query('COMMIT');
    res.json({ code: String(req.params.code).toUpperCase(), status: 'cancelled' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.get('/reservations/:code', async (req, res, next) => {
  const code = String(req.params.code).trim().toUpperCase();
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!/^[A-F0-9]{10}$/.test(code) || !email) return res.status(400).json({ error: 'invalid_lookup' });
  try {
    const { rows } = await pool.query(
      `SELECT r.code, r.customer_name, r.customer_email, r.seats, r.unit_price_cents,
              r.status, r.created_at, e.title, e.venue, e.city, e.starts_at
       FROM reservations r JOIN events e ON e.id = r.event_id
       WHERE r.code = $1 AND LOWER(r.customer_email) = $2`,
      [code, email],
    );
    if (!rows[0]) return res.status(404).json({ error: 'reservation_not_found' });
    res.json({ ...rows[0], total_cents: rows[0].unit_price_cents * rows[0].seats });
  } catch (error) {
    next(error);
  }
});

app.post('/reservations', (_req, res) => res.status(410).json({ error: 'use_cart_checkout' }));

app.use((error, _req, res, _next) => {
  if (error.code === 'EBADCSRFTOKEN') return res.status(403).json({ error: 'invalid_csrf_token' });
  if (error.code === '23505') return res.status(409).json({ error: 'conflict' });
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', '57P01', '08006', 'NR_CLOSED'].includes(error.code)) {
    res.set('Retry-After', '3');
    return res.status(503).json({ error: 'service_temporarily_unavailable' });
  }
  console.error(error);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(port, '0.0.0.0', () => console.log(`Reservation API listening on ${port}`));

retryUntilReady(initializeDatabase, {
  signal: shutdownController.signal,
  sleep: abortableSleep,
  onRetry: (error, attempt, delayMs) => console.error(`PostgreSQL initialization attempt ${attempt} failed (${error.code || error.message}); retrying in ${delayMs}ms`),
}).catch((error) => {
  if (!shutdownController.signal.aborted) console.error('PostgreSQL retry loop stopped:', error.message);
});

retryUntilReady(async () => {
  if (!redis.isOpen) await redis.connect();
}, {
  signal: shutdownController.signal,
  sleep: abortableSleep,
  onRetry: (error, attempt, delayMs) => console.error(`Redis connection attempt ${attempt} failed (${error.code || error.message}); retrying in ${delayMs}ms`),
}).catch((error) => {
  if (!shutdownController.signal.aborted) console.error('Redis retry loop stopped:', error.message);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    shutdownController.abort(new Error('Process shutting down'));
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
}
