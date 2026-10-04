const baseUrl = (process.env.LOAD_URL || 'http://192.168.122.1:8080').replace(/\/$/, '');
const scenario = process.env.SCENARIO || 'catalog';
const userPoolSize = Number(process.env.USER_POOL_SIZE || 5);
const concurrency = Number(process.env.CONCURRENCY || (scenario === 'booking' ? userPoolSize : 60));
const authConcurrency = Number(process.env.AUTH_CONCURRENCY || 3);
const durationSeconds = Number(process.env.DURATION_SECONDS || 180);
const thinkTimeMs = Number(process.env.THINK_TIME_MS || 1000);
const endpoint = `${baseUrl}/api/events`;

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 500) throw new Error('CONCURRENCY must be 1..500');
if (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) throw new Error('DURATION_SECONDS must be 10..3600');
if (!Number.isInteger(thinkTimeMs) || thinkTimeMs < 0 || thinkTimeMs > 60000) throw new Error('THINK_TIME_MS must be 0..60000');
if (!['catalog', 'booking'].includes(scenario)) throw new Error('SCENARIO must be catalog or booking');
if (scenario === 'booking' && (!Number.isInteger(userPoolSize) || userPoolSize < 1 || userPoolSize > 500 || concurrency > userPoolSize)) {
  throw new Error('Booking mode requires CONCURRENCY <= USER_POOL_SIZE <= 500');
}
if (scenario === 'booking' && (!Number.isInteger(authConcurrency) || authConcurrency < 1 || authConcurrency > 20)) {
  throw new Error('AUTH_CONCURRENCY must be 1..20');
}
if (scenario === 'booking' && (!process.env.LOADTEST_PASSWORD || process.env.LOADTEST_PASSWORD.length < 12)) {
  throw new Error('Booking mode requires LOADTEST_PASSWORD with at least 12 characters');
}

const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1000;
let completed = 0;
let successful = 0;
let failed = 0;
let active = 0;
let intervalSuccess = 0;
let intervalFailed = 0;
const totalErrors = new Map();
const intervalErrors = new Map();
const latencies = [];
let intervalJourneys = 0;
let intervalJourneyErrors = 0;
const journeyLatencies = [];

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function recordError(key, sample) {
  for (const errors of [totalErrors, intervalErrors]) {
    const entry = errors.get(key) || { count: 0, sample };
    entry.count += 1;
    errors.set(key, entry);
  }
}

function formatErrors(errors) {
  return [...errors.entries()]
    .map(([key, entry]) => `${key}=${entry.count}${entry.sample ? ` (ex: ${entry.sample})` : ''}`)
    .join(', ');
}

async function worker() {
  while (Date.now() < deadline) {
    const start = performance.now();
    active += 1;
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
      await response.arrayBuffer();
      if (response.ok) {
        successful += 1;
        intervalSuccess += 1;
      } else {
        failed += 1;
        intervalFailed += 1;
        recordError(`HTTP ${response.status} ${response.statusText}`.trim(), response.headers.get('retry-after') ? `Retry-After ${response.headers.get('retry-after')}s` : '');
      }
    } catch (error) {
      failed += 1;
      intervalFailed += 1;
      const causeCodes = error.cause?.errors?.map((cause) => cause.code).filter(Boolean).join(',');
      const causeCode = error.cause?.code || causeCodes;
      recordError(causeCode || error.name || 'FetchError', error.cause?.message || error.message);
    } finally {
      active -= 1;
      completed += 1;
      latencies.push(performance.now() - start);
    }
  }
}

function expectStatus(result, expected, step) {
  if (!expected.includes(result.response.status)) {
    throw new Error(`${step}: HTTP ${result.response.status} ${JSON.stringify(result.data).slice(0, 240)}`);
  }
  return result.data;
}

class VirtualUser {
  constructor(index) {
    this.email = `k8s-loadtest-${String(index + 1).padStart(2, '0')}@reservation.invalid`;
    this.cookie = '';
    this.csrfToken = '';
  }

  async request(path, { method = 'GET', body, retryTransient = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const headers = { accept: 'application/json' };
        if (this.cookie) headers.cookie = this.cookie;
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = this.csrfToken;
        const response = await fetch(`${baseUrl}/api/${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
        for (const setCookie of setCookies) {
          const match = setCookie.match(/(?:^|,\s*)(reservation\.sid=[^;,]*)/);
          if (match) this.cookie = match[1];
        }
        const text = await response.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { response: text.slice(0, 160) }; }
        if (retryTransient && [502, 503, 504].includes(response.status) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
          continue;
        }
        return { response, data };
      } catch (error) {
        if (!retryTransient || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
      }
    }
  }

  async authenticate(index) {
    const csrf = expectStatus(await this.request('auth/csrf', { retryTransient: true }), [200], 'csrf');
    this.csrfToken = csrf.token;
    const payload = {
      name: `Utilisateur test ${index + 1}`,
      email: this.email,
      password: process.env.LOADTEST_PASSWORD,
    };

    if (process.env.LOADTEST_BOOTSTRAP === '1') {
      const registration = await this.request('auth/register', { method: 'POST', body: payload, retryTransient: true });
      if (registration.response.status === 201) {
        this.csrfToken = registration.data.csrfToken;
        return;
      }
      if (registration.response.status !== 409) expectStatus(registration, [201], 'register');
    }

    const login = expectStatus(await this.request('auth/login', {
      method: 'POST',
      body: { email: this.email, password: process.env.LOADTEST_PASSWORD },
      retryTransient: true,
    }), [200], 'login');
    this.csrfToken = login.csrfToken;
  }

  async bookingJourney(eventId) {
    const events = expectStatus(await this.request('events'), [200], 'browse');
    if (!Array.isArray(events) || !events.some((event) => event.id === eventId)) {
      throw new Error(`browse: event ${eventId} is unavailable`);
    }
    expectStatus(await this.request(`cart/items/${encodeURIComponent(eventId)}`, {
      method: 'PUT', body: { quantity: 1 },
    }), [200], 'add-to-cart');
    const cart = expectStatus(await this.request('cart'), [200], 'view-cart');
    if (!cart.items?.some((item) => item.id === eventId && item.quantity === 1)) {
      throw new Error('view-cart: expected ticket not present');
    }
    const orderResult = await this.request('checkout', { method: 'POST', body: {} });
    const order = expectStatus(orderResult, [200, 201], 'checkout');
    if (!order.code) throw new Error('checkout: missing order code');
    const cancelled = expectStatus(await this.request(`orders/${encodeURIComponent(order.code)}/cancel`, {
      method: 'POST', body: {},
    }), [200], 'cancel');
    if (cancelled.status !== 'cancelled') throw new Error('cancel: order was not cancelled');
    const orders = expectStatus(await this.request('orders'), [200], 'verify-cancellation');
    if (!orders.some((item) => item.code === order.code && item.status === 'cancelled')) {
      throw new Error('verify-cancellation: cancelled order not present in history');
    }
    return order.code;
  }

  async recoverAfterFailure() {
    try {
      const orders = expectStatus(await this.request('orders'), [200], 'recovery-orders');
      for (const order of orders.filter((item) => item.status === 'confirmed')) {
        await this.request(`orders/${encodeURIComponent(order.code)}/cancel`, { method: 'POST', body: {} });
      }
      await this.request('cart', { method: 'DELETE' });
    } catch { /* Keep the original journey failure as the reported error. */ }
  }
}

async function runBookingScenario() {
  const users = Array.from({ length: concurrency }, (_, index) => new VirtualUser(index));
  const bootstrap = process.env.LOADTEST_BOOTSTRAP === '1';
  if (bootstrap && concurrency !== userPoolSize) {
    throw new Error('First-time bootstrap must use CONCURRENCY equal to USER_POOL_SIZE so the full fixed pool is created');
  }
  console.log(`${bootstrap ? 'Initialisation/charge' : 'Charge'} du parcours réservation: ${concurrency} utilisateurs distincts du pool fixe de ${userPoolSize}, pause ${thinkTimeMs}ms entre parcours.`);
  let authenticated = 0;
  let nextProgress = 50;
  for (let offset = 0; offset < users.length; offset += authConcurrency) {
    const batch = users.slice(offset, offset + authConcurrency);
    await Promise.all(batch.map((user, index) => user.authenticate(offset + index)));
    authenticated += batch.length;
    if (authenticated >= nextProgress || authenticated === users.length) {
      console.log(`Comptes authentifies/provisionnes: ${authenticated}/${users.length}`);
      nextProgress = authenticated + 50;
    }
  }
  const events = expectStatus(await users[0].request('events'), [200], 'browse');
  if (!Array.isArray(events) || !events.length) throw new Error('No events available for booking test');

  const startedAt = Date.now();
  const deadline = startedAt + durationSeconds * 1000;
  const reporter = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(`${elapsed.toFixed(0)}s | ${intervalJourneys} parcours OK, ${intervalJourneyErrors} echecs / 5s | p95 parcours ${percentile(journeyLatencies.slice(-200), 0.95).toFixed(0)}ms | utilisateurs ${concurrency}`);
    intervalJourneys = 0;
    intervalJourneyErrors = 0;
  }, 5000);

  let completedJourneys = 0;
  let failedJourneys = 0;
  const errors = new Map();
  const workers = users.map(async (user, index) => {
    const eventId = events[index % events.length].id;
    while (Date.now() < deadline) {
      const start = performance.now();
      try {
        await user.bookingJourney(eventId);
        completedJourneys += 1;
        intervalJourneys += 1;
      } catch (error) {
        failedJourneys += 1;
        intervalJourneyErrors += 1;
        const key = error.message.slice(0, 100);
        errors.set(key, (errors.get(key) || 0) + 1);
        await user.recoverAfterFailure();
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        journeyLatencies.push(performance.now() - start);
      }
      if (thinkTimeMs > 0) await new Promise((resolve) => setTimeout(resolve, thinkTimeMs));
    }
  });
  await Promise.all(workers);
  clearInterval(reporter);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  console.log(`Termine: ${completedJourneys} parcours completes, ${failedJourneys} echecs en ${elapsedSeconds.toFixed(1)}s, ${(completedJourneys / elapsedSeconds).toFixed(2)} parcours/s, latence moyenne ${(journeyLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, journeyLatencies.length)).toFixed(0)}ms, p95 ${percentile(journeyLatencies, 0.95).toFixed(0)}ms.`);
  if (errors.size) console.log(`Detail des erreurs: ${[...errors].map(([message, count]) => `${message}=${count}`).join(' | ')}`);
  if (failedJourneys > 0) process.exitCode = 1;
}

if (scenario === 'booking') {
  await runBookingScenario();
} else {
console.log(`Charge GET ${endpoint}: ${concurrency} clients pendant ${durationSeconds}s`);
const reporter = setInterval(() => {
  const elapsed = (Date.now() - startedAt) / 1000;
  const breakdown = formatErrors(intervalErrors);
  console.log(`${elapsed.toFixed(0)}s | ${intervalSuccess} OK, ${intervalFailed} erreurs / 5s${breakdown ? ` [${breakdown}]` : ''} | p95 ${percentile(latencies.slice(-1000), 0.95).toFixed(0)}ms | en vol ${active}`);
  intervalSuccess = 0;
  intervalFailed = 0;
  intervalErrors.clear();
}, 5000);

await Promise.all(Array.from({ length: concurrency }, () => worker()));
clearInterval(reporter);
const elapsedSeconds = (Date.now() - startedAt) / 1000;
console.log(`Terminé: ${completed} requêtes en ${elapsedSeconds.toFixed(1)}s, ${successful} OK, ${failed} erreurs, ${(completed / elapsedSeconds).toFixed(1)} req/s, latence moyenne ${(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)).toFixed(0)}ms, p95 ${percentile(latencies, 0.95).toFixed(0)}ms.`);
if (totalErrors.size) console.log(`Détail des erreurs: ${formatErrors(totalErrors)}`);
if (failed > 0) process.exitCode = 1;
}
