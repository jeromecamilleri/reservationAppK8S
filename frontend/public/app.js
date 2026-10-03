const eventList = document.querySelector('#event-list');
const eventStatus = document.querySelector('#event-status');
const searchInput = document.querySelector('#search');
const dialog = document.querySelector('#booking-dialog');
const bookingForm = document.querySelector('#booking-form');
const toast = document.querySelector('#toast');
let events = [];
let category = 'all';

const money = (cents) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const eventDate = (value) => new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const escapeText = (value) => String(value ?? '');

async function api(path, options) {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      event_unavailable: 'Cet événement n’a plus assez de places disponibles.',
      reservation_not_found: 'Aucune réservation trouvée avec ces informations.',
      invalid_reservation: 'Vérifiez les informations saisies.',
    };
    throw new Error(messages[body.error] || 'Une erreur est survenue. Réessayez.');
  }
  return body;
}

function renderEvents() {
  const query = searchInput.value.trim().toLocaleLowerCase('fr');
  const visible = events.filter((event) => {
    const matchesCategory = category === 'all' || event.category === category;
    const matchesQuery = `${event.title} ${event.city} ${event.venue} ${event.category}`.toLocaleLowerCase('fr').includes(query);
    return matchesCategory && matchesQuery;
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
    tag.textContent = escapeText(event.category);
    const date = document.createElement('span');
    date.className = 'event-date';
    date.textContent = eventDate(event.starts_at);
    heading.append(tag, date);
    const title = document.createElement('h3');
    title.textContent = escapeText(event.title);
    const location = document.createElement('p');
    location.className = 'event-location';
    location.textContent = `${event.venue} · ${event.city}`;
    const description = document.createElement('p');
    description.className = 'event-description';
    description.textContent = escapeText(event.description);
    const footer = document.createElement('div');
    footer.className = 'event-card-footer';
    const price = document.createElement('p');
    price.className = 'event-price';
    price.innerHTML = `<strong>${money(event.price_cents)}</strong><span> / personne</span>`;
    const seats = document.createElement('span');
    seats.className = 'seats-left';
    seats.textContent = event.available_seats > 0 ? `${event.available_seats} places` : 'Complet';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reserve-button';
    button.textContent = event.available_seats > 0 ? 'Réserver' : 'Indisponible';
    button.disabled = event.available_seats <= 0;
    button.addEventListener('click', () => openBooking(event));
    footer.append(price, button);
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

function openBooking(event) {
  bookingForm.reset();
  bookingForm.elements.eventId.value = event.id;
  document.querySelector('#selected-event').textContent = `${event.title} · ${money(event.price_cents)} / place`;
  document.querySelector('#booking-message').textContent = '';
  dialog.showModal();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 4500);
}

function showReservation(reservation, target) {
  target.replaceChildren();
  const box = document.createElement('article');
  box.className = 'reservation-ticket';
  const status = document.createElement('p');
  status.className = 'eyebrow';
  status.textContent = reservation.status === 'cancelled' ? 'Réservation annulée' : 'Réservation confirmée';
  const title = document.createElement('h3');
  title.textContent = reservation.title || events.find((item) => item.id === reservation.eventId)?.title || 'Votre événement';
  const code = document.createElement('p');
  code.className = 'ticket-code';
  code.textContent = `Référence ${reservation.code}`;
  const detail = document.createElement('p');
  const when = reservation.starts_at ? eventDate(reservation.starts_at) : '';
  const venue = reservation.venue ? `${reservation.venue}, ${reservation.city}` : '';
  detail.textContent = [when, venue, `${reservation.seats} place${reservation.seats > 1 ? 's' : ''}`, money(reservation.total_cents ?? reservation.totalCents)].filter(Boolean).join(' · ');
  box.append(status, title, code, detail);
  if (reservation.status === 'confirmed') {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'text-button';
    cancel.textContent = 'Annuler cette réservation';
    cancel.addEventListener('click', async () => {
      try {
        await api(`reservations/${encodeURIComponent(reservation.code)}/cancel`, {
          method: 'POST', body: JSON.stringify({ email: reservation.customer_email || reservation.email }),
        });
        box.classList.add('cancelled');
        status.textContent = 'Réservation annulée';
        cancel.remove();
        await loadEvents();
        showToast('La réservation a été annulée.');
      } catch (error) {
        showToast(error.message);
      }
    });
    box.append(cancel);
  }
  target.append(box);
}

searchInput.addEventListener('input', renderEvents);
document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    category = button.dataset.category;
    document.querySelectorAll('.filter').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderEvents();
  });
});

document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

bookingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#booking-message');
  const button = bookingForm.querySelector('[type="submit"]');
  const payload = Object.fromEntries(new FormData(bookingForm));
  payload.seats = Number(payload.seats);
  button.disabled = true;
  message.textContent = 'Confirmation en cours…';
  try {
    const reservation = await api('reservations', { method: 'POST', body: JSON.stringify(payload) });
    reservation.customer_email = reservation.email;
    dialog.close();
    document.querySelector('#lookup-message').textContent = '';
    showReservation(reservation, document.querySelector('#reservation-result'));
    document.querySelector('#mes-reservations').scrollIntoView({ behavior: 'smooth' });
    showToast(`Réservation confirmée · ${reservation.code}`);
    await loadEvents();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#lookup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#lookup-message');
  const result = document.querySelector('#reservation-result');
  const data = Object.fromEntries(new FormData(form));
  message.textContent = 'Recherche…';
  result.replaceChildren();
  try {
    const reservation = await api(`reservations/${encodeURIComponent(data.code)}?email=${encodeURIComponent(data.email)}`);
    message.textContent = '';
    showReservation(reservation, result);
  } catch (error) {
    message.textContent = error.message;
  }
});

loadEvents();
