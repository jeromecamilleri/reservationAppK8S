const eventList = document.querySelector('#event-list');
const eventStatus = document.querySelector('#event-status');
const searchInput = document.querySelector('#search');
const authDialog = document.querySelector('#auth-dialog');
const cartDialog = document.querySelector('#cart-dialog');
const toast = document.querySelector('#toast');
let events = [];
let category = 'all';
let csrfToken = '';
let currentUser = null;
let authMode = 'login';
let pendingEvent = null;

const money = (cents) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const eventDate = (value) => new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.method && !['GET', 'HEAD'].includes(options.method)) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(`/api/${path}`, { ...options, headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      authentication_required: 'Connectez-vous pour continuer.',
      email_already_registered: 'Cette adresse e-mail possède déjà un compte.',
      invalid_credentials: 'Adresse e-mail ou mot de passe incorrect.',
      invalid_registration: 'Vérifiez vos informations. Le mot de passe doit contenir au moins 12 caractères.',
      too_many_login_attempts: 'Trop de tentatives. Réessayez dans quelques minutes.',
      event_unavailable: 'Le nombre de places demandé n’est plus disponible.',
      cart_inventory_changed: 'Le stock a changé. Vérifiez votre panier puis réessayez.',
      cart_empty: 'Votre panier est vide.',
      invalid_csrf_token: 'Votre session a expiré. Rechargez la page et réessayez.',
      order_not_cancellable: 'Cette commande ne peut plus être annulée.',
    };
    throw new Error(messages[body.error] || 'Une erreur est survenue. Réessayez.');
  }
  return body;
}

function renderEvents() {
  const query = searchInput.value.trim().toLocaleLowerCase('fr');
  const visible = events.filter((event) => {
    const matchesCategory = category === 'all' || event.category === category;
    return matchesCategory && `${event.title} ${event.city} ${event.venue} ${event.category}`.toLocaleLowerCase('fr').includes(query);
  });
  eventList.replaceChildren();
  eventStatus.textContent = visible.length ? `${visible.length} événement${visible.length > 1 ? 's' : ''} à découvrir` : 'Aucun événement ne correspond à votre recherche.';
  for (const event of visible) {
    const article = document.createElement('article');
    article.className = `event-card theme-${['Musique', 'Sport', 'Théâtre', 'Festival'].indexOf(event.category)}`;
    const heading = document.createElement('div');
    heading.className = 'event-card-top';
    const tag = document.createElement('span');
    tag.className = 'category-tag';
    tag.textContent = event.category;
    const date = document.createElement('span');
    date.className = 'event-date';
    date.textContent = eventDate(event.starts_at);
    heading.append(tag, date);
    const title = document.createElement('h3');
    title.textContent = event.title;
    const location = document.createElement('p');
    location.className = 'event-location';
    location.textContent = `${event.venue} · ${event.city}`;
    const description = document.createElement('p');
    description.className = 'event-description';
    description.textContent = event.description;
    const footer = document.createElement('div');
    footer.className = 'event-card-footer';
    const price = document.createElement('p');
    price.className = 'event-price';
    const strong = document.createElement('strong');
    strong.textContent = money(event.price_cents);
    const perSeat = document.createElement('span');
    perSeat.textContent = ' / personne';
    price.append(strong, perSeat);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reserve-button';
    button.textContent = event.available_seats > 0 ? 'Ajouter au panier' : 'Complet';
    button.disabled = event.available_seats <= 0;
    button.addEventListener('click', () => addEvent(event));
    footer.append(price, button);
    const seats = document.createElement('span');
    seats.className = 'seats-left';
    seats.textContent = event.available_seats > 0 ? `${event.available_seats} places disponibles` : 'Complet';
    article.append(heading, title, location, description, seats, footer);
    eventList.append(article);
  }
}

async function loadEvents() {
  try {
    events = await api('events');
    renderEvents();
  } catch (error) {
    eventStatus.textContent = error.message;
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 4000);
}

function openAuth(event = null) {
  pendingEvent = event;
  document.querySelector('#auth-message').textContent = '';
  authDialog.showModal();
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  document.querySelector('#auth-title').textContent = registering ? 'Créer un compte' : 'Connexion';
  document.querySelector('#name-field').hidden = !registering;
  document.querySelector('#name-field input').required = registering;
  document.querySelector('#auth-form [type="password"]').autocomplete = registering ? 'new-password' : 'current-password';
  document.querySelector('#auth-form [type="submit"]').textContent = registering ? 'Créer mon compte' : 'Se connecter';
  document.querySelector('#password-note').hidden = !registering;
  document.querySelectorAll('.auth-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
}

async function addEvent(event) {
  if (!currentUser) return openAuth(event);
  try {
    const existing = await api('cart');
    const item = existing.items.find((entry) => entry.id === event.id);
    const quantity = Math.min(8, (item?.quantity || 0) + 1);
    await api(`cart/items/${encodeURIComponent(event.id)}`, { method: 'PUT', body: JSON.stringify({ quantity }) });
    await refreshCart();
    cartDialog.showModal();
    showToast('Ajouté au panier. Ajustez les quantités avant validation.');
  } catch (error) { showToast(error.message); }
}

async function refreshCart() {
  if (!currentUser) {
    document.querySelector('#cart-count').textContent = '0';
    return;
  }
  const cart = await api('cart');
  const target = document.querySelector('#cart-items');
  target.replaceChildren();
  document.querySelector('#cart-count').textContent = String(cart.items.reduce((sum, item) => sum + item.quantity, 0));
  document.querySelector('#cart-total').textContent = money(cart.totalCents);
  if (!cart.items.length) {
    const empty = document.createElement('p');
    empty.className = 'status-line';
    empty.textContent = 'Votre panier est vide.';
    target.append(empty);
  }
  for (const item of cart.items) {
    const row = document.createElement('article');
    row.className = 'cart-row';
    const detail = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.title;
    const sub = document.createElement('span');
    sub.textContent = `${item.quantity} place${item.quantity > 1 ? 's' : ''} · ${money(item.price_cents)} / place`;
    detail.append(title, sub);
    const actions = document.createElement('div');
    actions.className = 'cart-actions';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Nombre de places pour ${item.title}`);
    for (let n = 1; n <= Math.min(8, item.available_seats + item.quantity); n += 1) {
      const option = document.createElement('option');
      option.value = String(n);
      option.textContent = String(n);
      option.selected = n === item.quantity;
      select.append(option);
    }
    select.addEventListener('change', async () => {
      try { await api(`cart/items/${encodeURIComponent(item.id)}`, { method: 'PUT', body: JSON.stringify({ quantity: Number(select.value) }) }); await refreshCart(); }
      catch (error) { showToast(error.message); }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Retirer';
    remove.addEventListener('click', async () => {
      try { await api(`cart/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await refreshCart(); }
      catch (error) { showToast(error.message); }
    });
    actions.append(select, remove);
    row.append(detail, actions);
    target.append(row);
  }
  document.querySelector('#checkout-button').disabled = !cart.items.length;
}

async function loadOrders() {
  const target = document.querySelector('#orders-list');
  target.replaceChildren();
  if (!currentUser) {
    const text = document.createElement('p');
    text.className = 'status-line';
    text.textContent = 'Connectez-vous pour afficher vos commandes.';
    target.append(text);
    return;
  }
  const orders = await api('orders');
  if (!orders.length) {
    const text = document.createElement('p');
    text.className = 'status-line';
    text.textContent = 'Aucune commande pour le moment.';
    target.append(text);
  }
  for (const order of orders) {
    const box = document.createElement('article');
    box.className = `reservation-ticket${order.status === 'cancelled' ? ' cancelled' : ''}`;
    const status = document.createElement('p');
    status.className = 'eyebrow';
    status.textContent = order.status === 'cancelled' ? 'Commande annulée' : 'Commande confirmée';
    const code = document.createElement('h3');
    code.textContent = `Commande ${order.code}`;
    const items = document.createElement('p');
    items.textContent = order.items.map((item) => `${item.title} · ${item.seats} place${item.seats > 1 ? 's' : ''}`).join(' / ');
    const total = document.createElement('p');
    total.textContent = `Total · ${money(order.total_cents)} · ${new Date(order.created_at).toLocaleDateString('fr-FR')}`;
    box.append(status, code, items, total);
    if (order.status === 'confirmed') {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'text-button';
      cancel.textContent = 'Annuler la commande';
      cancel.addEventListener('click', async () => {
        if (!window.confirm(`Annuler la commande ${order.code} et remettre les places en vente ?`)) return;
        try { await api(`orders/${encodeURIComponent(order.code)}/cancel`, { method: 'POST' }); await Promise.all([loadOrders(), loadEvents()]); showToast('Commande annulée.'); }
        catch (error) { showToast(error.message); }
      });
      box.append(cancel);
    }
    target.append(box);
  }
}

async function updateAccount() {
  const button = document.querySelector('#account-open');
  const summary = document.querySelector('#account-summary');
  button.textContent = currentUser ? 'Déconnexion' : 'Connexion';
  summary.textContent = currentUser ? `Connecté·e en tant que ${currentUser.name} (${currentUser.email}).` : 'Connectez-vous pour retrouver vos billets et gérer vos commandes.';
  await Promise.all([refreshCart(), loadOrders()]);
}

searchInput.addEventListener('input', renderEvents);
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  category = button.dataset.category;
  document.querySelectorAll('.filter').forEach((item) => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  renderEvents();
}));

document.querySelector('#account-open').addEventListener('click', async () => {
  if (!currentUser) return openAuth();
  try {
    await api('auth/logout', { method: 'POST' });
    currentUser = null;
    csrfToken = (await api('auth/csrf')).token;
    await updateAccount();
    showToast('Vous êtes déconnecté·e.');
  } catch (error) { showToast(error.message); }
});
document.querySelector('#cart-open').addEventListener('click', async () => {
  if (!currentUser) return openAuth();
  try { await refreshCart(); cartDialog.showModal(); }
  catch (error) { showToast(error.message); }
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => document.querySelector(`#${button.dataset.close}`).close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
document.querySelectorAll('.auth-tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));

document.querySelector('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#auth-message');
  const button = form.querySelector('[type="submit"]');
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  message.textContent = 'Connexion en cours…';
  try {
    const result = await api(`auth/${authMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(data) });
    csrfToken = result.csrfToken;
    currentUser = result.user;
    authDialog.close();
    form.reset();
    await updateAccount();
    showToast(`Bienvenue${authMode === 'register' ? '' : ' de retour'}, ${currentUser.name} !`);
    if (pendingEvent) { const eventToAdd = pendingEvent; pendingEvent = null; await addEvent(eventToAdd); }
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector('#checkout-button').addEventListener('click', async () => {
  const button = document.querySelector('#checkout-button');
  const message = document.querySelector('#cart-message');
  button.disabled = true;
  message.textContent = 'Validation de la commande…';
  try {
    const order = await api('checkout', { method: 'POST' });
    cartDialog.close();
    message.textContent = '';
    await Promise.all([refreshCart(), loadOrders(), loadEvents()]);
    document.querySelector('#mes-reservations').scrollIntoView({ behavior: 'smooth' });
    showToast(`Commande confirmée · ${order.code}`);
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});

async function start() {
  try {
    const csrf = await api('auth/csrf');
    csrfToken = csrf.token;
    const result = await api('auth/me');
    currentUser = result.user;
    await updateAccount();
  } catch (error) { showToast(error.message); }
  await loadEvents();
}

setAuthMode('login');
start();
