import { getProductSuggestions, normalizeSearchText } from './product-search.js';

const POLL_MS = 5000;
const SAVED_FOR_LATER_TTL_MS = 6 * 60 * 60 * 1000;
const AUTOCOMPLETE_LIMIT = 8;
const AUTOCOMPLETE_OPTION_ID_PREFIX = 'product-suggestion-';
const ICONS = {
  remove:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6 18 18"/></svg>',
  bought:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>',
  pending:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 3v5h5"/></svg>',
  later:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  restore:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 5-7 7 7 7"/><path d="M19 12H5"/></svg>',
  save:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',
  cancel:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6 18 18"/></svg>'
};

const state = {
  list: '',
  version: null,
  items: [],
  timer: null,
  inflight: false,
  editingItem: null,
  busyItem: null,
  busyLabel: '',
  deferredSnapshot: null,
  savedForLater: new Set(),
  savedForLaterExpiresAt: null,
  savedForLaterTimer: null,
  autocomplete: {
    matches: [],
    activeIndex: -1,
    open: false
  }
};

const $ = (selector) => document.querySelector(selector);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.ogg', '.oga', '.opus', '.wav', '.aac', '.flac', '.webm']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm']);
const pageTitle = $('#page-title');
const syncStatus = $('#sync-status');
const addForm = $('#add-form');
const nameInput = $('#item-name');
const qtyInput = $('#item-qty');
const suggestionsList = $('#product-suggestions');
const pendingList = $('#pending-items');
const laterSection = $('#later-section');
const laterList = $('#later-items');
const activityList = $('#activity-items');
const pendingCount = $('#pending-count');
const laterCount = $('#later-count');
const activityCount = $('#activity-count');
const progressFill = $('#progress-fill');

function getMediaExtension(media) {
  const source = typeof media.path === 'string' ? media.path : media.url;
  if (typeof source !== 'string') {
    return '';
  }

  const pathname = source.split(/[?#]/, 1)[0] ?? '';
  const dotIndex = pathname.lastIndexOf('.');
  return dotIndex === -1 ? '' : pathname.slice(dotIndex).toLowerCase();
}

function getMediaDisplayKind(media) {
  const extension = getMediaExtension(media);
  const mimeType = typeof media.mime_type === 'string' ? media.mime_type.toLowerCase() : '';

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (media.kind === 'audio' || media.kind === 'image' || media.kind === 'video') {
    return media.kind;
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return 'audio';
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }

  return 'unknown';
}

function openImageViewer(src, alt) {
  const overlay = document.createElement('div');
  overlay.className = 'image-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Imagen adjunta');

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'image-viewer__close';
  closeButton.setAttribute('aria-label', 'Cerrar imagen');
  closeButton.textContent = '×';

  const image = document.createElement('img');
  image.className = 'image-viewer__image';
  image.src = src;
  image.alt = alt;

  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    document.body.classList.remove('has-image-viewer');
  };

  function onKeydown(event) {
    if (event.key === 'Escape') {
      close();
    }
  }

  overlay.addEventListener('click', (event) => {
    close();
  });

  document.addEventListener('keydown', onKeydown);
  overlay.append(closeButton, image);
  document.body.append(overlay);
  document.body.classList.add('has-image-viewer');
  closeButton.focus();
}

function api(name, action = '') {
  const suffix = action ? `/${action}` : '';
  return new URL(`./api/lists/${encodeURIComponent(name)}${suffix}`, location.href);
}

function fmtQty(qty) {
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/\.?0+$/, '');
}

function getStatusLabel(status) {
  switch (status) {
    case 'pending':
      return 'pendiente';
    case 'bought':
      return 'comprado';
    case 'removed':
      return 'quitado';
    default:
      return 'existente';
  }
}

function getAutocompleteMatches(query) {
  return getProductSuggestions(state.items, query, { limit: AUTOCOMPLETE_LIMIT });
}

function closeAutocomplete() {
  state.autocomplete.matches = [];
  state.autocomplete.activeIndex = -1;
  state.autocomplete.open = false;
  suggestionsList.replaceChildren();
  suggestionsList.hidden = true;
  nameInput.setAttribute('aria-expanded', 'false');
  nameInput.removeAttribute('aria-activedescendant');
}

function selectAutocompleteMatch(match) {
  nameInput.value = match.name;
  closeAutocomplete();
  nameInput.focus();
}

function renderAutocompleteSuggestions() {
  const previousActive = state.autocomplete.matches[state.autocomplete.activeIndex]?.name;
  const matches = getAutocompleteMatches(nameInput.value);
  state.autocomplete.matches = matches;

  if (matches.length === 0) {
    closeAutocomplete();
    return;
  }

  const previousActiveIndex = matches.findIndex((match) => match.name === previousActive);
  state.autocomplete.activeIndex = previousActiveIndex === -1 ? 0 : previousActiveIndex;
  state.autocomplete.open = true;
  suggestionsList.replaceChildren();

  matches.forEach((match, index) => {
    const option = document.createElement('li');
    const id = `${AUTOCOMPLETE_OPTION_ID_PREFIX}${index}`;
    option.id = id;
    option.className = 'autocomplete-option';
    option.role = 'option';
    option.dataset.index = String(index);
    option.setAttribute('aria-selected', String(index === state.autocomplete.activeIndex));

    const name = document.createElement('span');
    name.className = 'autocomplete-option__name';
    name.textContent = match.name;

    const meta = document.createElement('span');
    meta.className = 'autocomplete-option__meta';
    meta.textContent = getStatusLabel(match.status);

    option.append(name, meta);
    suggestionsList.append(option);
  });

  suggestionsList.hidden = false;
  nameInput.setAttribute('aria-expanded', 'true');
  nameInput.setAttribute(
    'aria-activedescendant',
    `${AUTOCOMPLETE_OPTION_ID_PREFIX}${state.autocomplete.activeIndex}`
  );
}

function setAutocompleteActiveIndex(nextIndex) {
  if (!state.autocomplete.open || state.autocomplete.matches.length === 0) {
    return;
  }

  const count = state.autocomplete.matches.length;
  state.autocomplete.activeIndex = (nextIndex + count) % count;

  suggestionsList.querySelectorAll('.autocomplete-option').forEach((option, index) => {
    option.setAttribute('aria-selected', String(index === state.autocomplete.activeIndex));
  });

  nameInput.setAttribute(
    'aria-activedescendant',
    `${AUTOCOMPLETE_OPTION_ID_PREFIX}${state.autocomplete.activeIndex}`
  );
}

function getSavedForLaterStorageKey() {
  return `shopping-list:${state.list}:saved-for-later`;
}

function readSavedForLaterStorage() {
  try {
    const raw = localStorage.getItem(getSavedForLaterStorageKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function removeSavedForLaterStorage() {
  try {
    localStorage.removeItem(getSavedForLaterStorageKey());
  } catch {
    // Browser storage may be disabled. The in-memory state still works until reload.
  }
}

function writeSavedForLaterStorage(payload) {
  try {
    localStorage.setItem(getSavedForLaterStorageKey(), JSON.stringify(payload));
  } catch {
    // Browser storage may be disabled. The in-memory state still works until reload.
  }
}

function stopSavedForLaterTimer() {
  if (state.savedForLaterTimer !== null) {
    clearTimeout(state.savedForLaterTimer);
    state.savedForLaterTimer = null;
  }
}

function clearSavedForLater() {
  stopSavedForLaterTimer();
  state.savedForLater.clear();
  state.savedForLaterExpiresAt = null;
  removeSavedForLaterStorage();
}

function renderCurrentSnapshot() {
  apply({
    ok: true,
    list: state.list,
    version: state.version ?? 0,
    changed: true,
    items: state.items
  });
}

function scheduleSavedForLaterExpiry() {
  stopSavedForLaterTimer();

  if (state.savedForLaterExpiresAt === null) {
    return;
  }

  const delay = state.savedForLaterExpiresAt - Date.now();
  if (delay <= 0) {
    clearSavedForLater();
    renderCurrentSnapshot();
    return;
  }

  state.savedForLaterTimer = setTimeout(() => {
    clearSavedForLater();
    renderCurrentSnapshot();
  }, delay);
}

function loadSavedForLater() {
  const payload = readSavedForLaterStorage();
  const items = Array.isArray(payload?.items) ? payload.items.filter((item) => typeof item === 'string') : [];
  const expiresAt = Number(payload?.expiresAt);

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || items.length === 0) {
    clearSavedForLater();
    return;
  }

  state.savedForLater = new Set(items);
  state.savedForLaterExpiresAt = expiresAt;
  scheduleSavedForLaterExpiry();
}

function persistSavedForLater() {
  if (state.savedForLater.size === 0) {
    clearSavedForLater();
    return;
  }

  if (state.savedForLaterExpiresAt === null) {
    state.savedForLaterExpiresAt = Date.now() + SAVED_FOR_LATER_TTL_MS;
  }

  writeSavedForLaterStorage({
    expiresAt: state.savedForLaterExpiresAt,
    items: Array.from(state.savedForLater)
  });
  scheduleSavedForLaterExpiry();
}

function resetSavedForLaterIfExpired() {
  if (state.savedForLaterExpiresAt !== null && state.savedForLaterExpiresAt <= Date.now()) {
    clearSavedForLater();
    return true;
  }

  return false;
}

function pruneSavedForLater(pendingItems) {
  if (state.savedForLater.size === 0) {
    return;
  }

  const pendingNames = new Set(pendingItems.map(getItemKey));
  let changed = false;

  for (const itemName of state.savedForLater) {
    if (!pendingNames.has(itemName)) {
      state.savedForLater.delete(itemName);
      changed = true;
    }
  }

  if (changed) {
    persistSavedForLater();
  }
}

function saveItemForLater(itemName) {
  resetSavedForLaterIfExpired();
  state.savedForLater.add(itemName);
  persistSavedForLater();
  renderCurrentSnapshot();
}

function restoreItemFromLater(itemName) {
  state.savedForLater.delete(itemName);
  persistSavedForLater();
  renderCurrentSnapshot();
}

function splitForDisplay(items) {
  resetSavedForLaterIfExpired();
  const groups = split(items);
  pruneSavedForLater(groups.pending);

  return {
    pending: groups.pending.filter((item) => !state.savedForLater.has(getItemKey(item))),
    later: groups.pending.filter((item) => state.savedForLater.has(getItemKey(item))),
    activity: groups.activity
  };
}

async function readJson(response) {
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Error ${response.status}`);
  }
  return data;
}

function split(items) {
  return {
    pending: items.filter((item) => item.status === 'pending'),
    activity: items
      .filter((item) => item.status === 'bought' || item.status === 'removed')
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  };
}

function hasInlineEditOpen() {
  return state.editingItem !== null;
}

function getItemKey(item) {
  return item.name;
}

function clearBusyState() {
  state.busyItem = null;
  state.busyLabel = '';
}

function makeIconButton(action, kind, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-btn icon-btn--${kind}`;
  button.dataset.action = action;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = ICONS[action];
  return button;
}

function renderEditor(item) {
  const form = document.createElement('form');
  form.className = 'edit-form';
  form.dataset.action = 'save-edit';
  form.dataset.itemName = item.name;

  const nameField = document.createElement('input');
  nameField.name = 'item';
  nameField.type = 'text';
  nameField.required = true;
  nameField.value = item.name;
  nameField.placeholder = 'Producto';

  const qtyField = document.createElement('input');
  qtyField.name = 'qty';
  qtyField.type = 'number';
  qtyField.inputMode = 'decimal';
  qtyField.min = '0.1';
  qtyField.step = '0.1';
  qtyField.required = true;
  qtyField.value = fmtQty(item.qty);

  const noteField = document.createElement('input');
  noteField.name = 'note';
  noteField.type = 'text';
  noteField.value = item.note ?? '';
  noteField.placeholder = 'Nota';

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'icon-btn icon-btn--save';
  saveButton.title = 'Guardar';
  saveButton.setAttribute('aria-label', 'Guardar');
  saveButton.innerHTML = ICONS.save;

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'icon-btn icon-btn--ghost';
  cancelButton.dataset.action = 'cancel-edit';
  cancelButton.title = 'Cancelar';
  cancelButton.setAttribute('aria-label', 'Cancelar');
  cancelButton.innerHTML = ICONS.cancel;

  actions.append(saveButton, cancelButton);
  form.append(nameField, qtyField, noteField, actions);
  return form;
}

function renderMedia(media) {
  if (!media.url) {
    return null;
  }

  const displayKind = getMediaDisplayKind(media);

  if (displayKind === 'image') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'order-media-button';
    button.title = 'Ver imagen completa';
    button.setAttribute('aria-label', 'Ver imagen completa');

    const image = document.createElement('img');
    image.className = 'order-media order-media--image';
    image.src = media.url;
    image.alt = 'Adjunto del pedido';
    image.loading = 'lazy';

    button.append(image);
    button.addEventListener('click', () => {
      openImageViewer(image.currentSrc || image.src, image.alt);
    });
    return button;
  }

  if (displayKind === 'audio') {
    const audio = document.createElement('audio');
    audio.className = 'order-media order-media--audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = media.url;
    if (typeof media.mime_type === 'string' && media.mime_type.startsWith('audio/')) {
      audio.type = media.mime_type;
    }
    return audio;
  }

  if (displayKind === 'video') {
    const video = document.createElement('video');
    video.className = 'order-media order-media--video';
    video.controls = true;
    video.preload = 'metadata';
    video.src = media.url;
    return video;
  }

  return null;
}

function getVisibleOrders(item) {
  if (!Array.isArray(item.orders) || item.orders.length === 0) {
    return [];
  }

  return item.orders.filter((order) => Number(order.qty) > 0);
}

function itemHasMedia(item) {
  return getVisibleOrders(item).some((order) => Array.isArray(order.media) && order.media.length > 0);
}

function getOrderCountText(item) {
  const orderCount = getVisibleOrders(item).length;
  const fallbackCount = orderCount === 0 && Number(item.qty) > 0 ? 1 : orderCount;
  return `${fallbackCount} ${fallbackCount === 1 ? 'pedido' : 'pedidos'}`;
}

function getOrderStatusText(status) {
  switch (status) {
    case 'bought':
      return 'comprado';
    case 'removed':
      return 'quitado';
    default:
      return 'pendiente';
  }
}

function renderOrders(item) {
  const visibleOrders = getVisibleOrders(item);

  if (visibleOrders.length === 0) {
    return null;
  }

  const details = document.createElement('div');
  details.className = 'item-details';

  const heading = document.createElement('div');
  heading.className = 'orders-heading';

  const label = document.createElement('span');
  label.textContent = 'Pedidos';

  const summary = document.createElement('span');
  summary.textContent = `${getOrderCountText(item)} ${getOrderStatusText(item.status)}`;

  heading.append(label, summary);
  details.append(heading);

  for (const order of visibleOrders) {
    const card = document.createElement('div');
    card.className = 'order-card';

    const top = document.createElement('div');
    top.className = 'order-topline';

    const by = document.createElement('span');
    by.className = 'order-by';
    by.textContent = order.ordered_by === 'unknown' ? 'Pedido' : order.ordered_by;

    const meta = document.createElement('span');
    meta.className = 'order-meta';

    const qty = document.createElement('span');
    qty.className = 'order-qty';
    qty.textContent = `x${fmtQty(order.qty)}`;

    const status = document.createElement('span');
    status.className = `order-status order-status--${item.status}`;
    status.textContent = getOrderStatusText(item.status);

    meta.append(qty, status);
    top.append(by, meta);
    card.append(top);

    if (order.note && order.note !== item.note) {
      const note = document.createElement('p');
      note.className = 'order-note';
      note.textContent = order.note;
      card.append(note);
    }

    if (Array.isArray(order.media) && order.media.length > 0) {
      const mediaStrip = document.createElement('div');
      mediaStrip.className = 'order-media-strip';

      for (const media of order.media) {
        const mediaNode = renderMedia(media);
        if (mediaNode) {
          mediaStrip.append(mediaNode);
        }
      }

      if (mediaStrip.childNodes.length > 0) {
        card.append(mediaStrip);
      }
    }

    details.append(card);
  }

  return details;
}

function renderItem(item, mode) {
  const li = document.createElement('li');
  const itemKey = getItemKey(item);
  const isEditing = state.editingItem === itemKey;
  const isBusy = state.busyItem === itemKey;

  li.className = `item item--${mode}`;
  li.dataset.itemName = itemKey;
  li.dataset.status = item.status;

  if (mode === 'later') {
    li.dataset.later = 'true';
  }

  if (isEditing) {
    li.dataset.expanded = 'true';
  }

  if (isBusy) {
    li.dataset.busy = 'true';
  }

  const row = document.createElement('div');
  row.className = `item-row item-row--${mode}`;

  if (mode === 'pending' || mode === 'later') {
    const removeButton = makeIconButton('remove', 'danger', 'Quitar pedidos');
    removeButton.dataset.qty = String(item.qty);
    if (isBusy) {
      removeButton.disabled = true;
    }
    row.append(removeButton);
  }

  const core = document.createElement('button');
  core.type = 'button';
  core.className = 'item-core';
  core.dataset.action = 'edit';
  core.disabled = isBusy;

  const titleLine = document.createElement('div');
  titleLine.className = 'item-title-line';
  if (mode === 'activity') {
    titleLine.classList.add('item-title-line--activity');
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'item-name';
  nameEl.textContent = item.name;

  const qtyEl = document.createElement('span');
  qtyEl.className = 'item-qty';
  qtyEl.textContent = `x${fmtQty(item.qty)}`;

  titleLine.append(nameEl, qtyEl);

  const subline = document.createElement('div');
  subline.className = 'item-subline';
  if (mode === 'activity') {
    subline.classList.add('item-subline--activity');
  }

  if (mode === 'later') {
    const laterEl = document.createElement('span');
    laterEl.className = 'item-later-text';
    laterEl.textContent = 'Guardado para después';
    subline.append(laterEl);
  }

  if (mode === 'activity') {
    const statusPill = document.createElement('span');
    statusPill.className = `state-pill state-pill--${item.status}`;
    statusPill.textContent = item.status === 'bought' ? 'Comprado' : 'Quitado';
    titleLine.append(statusPill);
  }

  if (item.note) {
    const noteEl = document.createElement('span');
    noteEl.className = 'item-note-text';
    noteEl.textContent = item.note;
    subline.append(noteEl);
  }

  const orderSummaryEl = document.createElement('span');
  orderSummaryEl.className = 'item-order-summary';
  orderSummaryEl.textContent = `${getOrderCountText(item)} ${getOrderStatusText(item.status)}`;
  subline.append(orderSummaryEl);

  if (itemHasMedia(item)) {
    const attachmentEl = document.createElement('span');
    attachmentEl.className = 'item-attachment';
    attachmentEl.textContent = 'Adjunto';
    attachmentEl.title = 'Este item tiene archivos adjuntos';
    subline.append(attachmentEl);
  }

  if (isBusy) {
    const busyEl = document.createElement('span');
    busyEl.className = 'item-state-text';
    busyEl.textContent = state.busyLabel || 'Guardando...';
    subline.append(busyEl);
  }

  core.append(titleLine);

  if (subline.childNodes.length > 0) {
    core.append(subline);
  }

  row.append(core);

  if (mode === 'pending') {
    const laterButton = makeIconButton('later', 'ghost', 'Guardar para después');
    if (isBusy) {
      laterButton.disabled = true;
    }
    row.append(laterButton);
  }

  if (mode === 'later') {
    const restoreButton = makeIconButton('restore', 'accent', 'Volver a pendientes');
    if (isBusy) {
      restoreButton.disabled = true;
    }
    row.append(restoreButton);
  }

  const rightButton =
    mode === 'pending' || mode === 'later'
      ? makeIconButton('bought', 'success', 'Marcar pedidos comprados')
      : makeIconButton('pending', item.status === 'removed' ? 'danger' : 'accent', 'Reagregar pedidos');

  rightButton.dataset.action = mode === 'pending' || mode === 'later' ? 'bought' : 'pending';
  if (isBusy) {
    rightButton.disabled = true;
  }
  row.append(rightButton);

  li.append(row);

  const orders = isEditing ? renderOrders(item) : null;
  if (orders) {
    li.append(orders);
  }

  if (isEditing) {
    li.append(renderEditor(item));
  }

  return li;
}

function renderItems(list, items, mode) {
  list.replaceChildren();

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent =
      mode === 'pending'
        ? 'Todo listo.'
        : mode === 'later'
          ? 'Nada guardado para después.'
          : 'Nada aun.';
    list.append(li);
    return;
  }

  for (const item of items) {
    list.append(renderItem(item, mode));
  }
}

function apply(snapshot) {
  state.list = snapshot.list;
  state.version = snapshot.version;
  pageTitle.textContent = state.list;
  document.title = state.list;

  if (snapshot.changed && Array.isArray(snapshot.items)) {
    state.items = snapshot.items;
  }

  const groups = splitForDisplay(state.items);
  const resolved = groups.activity.length;
  const total = state.items.length;
  const progress = total === 0 ? 0 : Math.round((resolved / total) * 100);

  pendingCount.textContent = groups.pending.length;
  laterCount.textContent = groups.later.length;
  activityCount.textContent = groups.activity.length;
  progressFill.style.width = `${progress}%`;
  laterSection.hidden = groups.later.length === 0;

  renderItems(pendingList, groups.pending, 'pending');
  renderItems(laterList, groups.later, 'later');
  renderItems(activityList, groups.activity, 'activity');
  syncStatus.textContent = `v${state.version} · ${progress}% listo`;

  if (document.activeElement === nameInput && nameInput.value.trim()) {
    renderAutocompleteSuggestions();
  }
}

function stopPoll() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function schedulePoll() {
  stopPoll();
  state.timer = setTimeout(() => {
    refresh(false);
  }, POLL_MS);
}

function flushDeferredSnapshot() {
  if (state.deferredSnapshot !== null && !hasInlineEditOpen()) {
    const snapshot = state.deferredSnapshot;
    state.deferredSnapshot = null;
    apply(snapshot);
  }
}

async function refresh(force) {
  if (state.inflight || !state.list) {
    schedulePoll();
    return;
  }

  state.inflight = true;

  try {
    const url = api(state.list);
    if (!force && state.version !== null) {
      url.searchParams.set('since', String(state.version));
    }

    const snapshot = await readJson(await fetch(url));

    if (!snapshot.changed) {
      return;
    }

    if (hasInlineEditOpen()) {
      state.deferredSnapshot = snapshot;
      syncStatus.textContent = 'Cambios pendientes';
      return;
    }

    apply(snapshot);
  } catch (error) {
    syncStatus.textContent = error instanceof Error ? error.message : 'Error inesperado';
  } finally {
    state.inflight = false;
    schedulePoll();
  }
}

async function send(action, payload, busyItem, busyLabel = 'Guardando...') {
  stopPoll();
  state.busyItem = busyItem ?? null;
  state.busyLabel = busyItem ? busyLabel : '';
  syncStatus.textContent = busyLabel;
  apply({
    ok: true,
    list: state.list,
    version: state.version ?? 0,
    changed: true,
    items: state.items
  });

  try {
    const response = await fetch(api(state.list, action), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await readJson(response);
    clearBusyState();
    state.deferredSnapshot = null;
    apply(data.snapshot);
  } catch (error) {
    clearBusyState();
    apply({
      ok: true,
      list: state.list,
      version: state.version ?? 0,
      changed: true,
      items: state.items
    });
    syncStatus.textContent = error instanceof Error ? error.message : 'Error inesperado';
  } finally {
    schedulePoll();
  }
}

function toggleEditing(itemName) {
  if (state.editingItem === itemName) {
    closeEditing();
    return;
  }

  state.editingItem = itemName;
  apply({
    ok: true,
    list: state.list,
    version: state.version ?? 0,
    changed: true,
    items: state.items
  });
}

function closeEditing() {
  state.editingItem = null;
  apply({
    ok: true,
    list: state.list,
    version: state.version ?? 0,
    changed: true,
    items: state.items
  });
  flushDeferredSnapshot();
}

async function handleEditSubmit(form) {
  const currentItem = form.dataset.itemName;
  if (!currentItem) {
    return;
  }

  const formData = new FormData(form);
  const item = String(formData.get('item') ?? '').trim();
  const qty = Number(formData.get('qty'));
  const note = String(formData.get('note') ?? '');

  if (!item || !Number.isFinite(qty) || qty <= 0) {
    syncStatus.textContent = 'Nombre y cantidad validos son obligatorios';
    return;
  }

  state.editingItem = null;
  await send('edit', { currentItem, item, qty, note }, currentItem);
  flushDeferredSnapshot();
}

function handleListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (target === null) {
    return;
  }

  const button = target.closest('[data-action]');
  if (button === null) {
    return;
  }

  const card = button.closest('.item');
  if (card === null) {
    return;
  }

  const itemName = card.dataset.itemName;
  if (!itemName) {
    return;
  }

  switch (button.dataset.action) {
    case 'remove':
      send('remove', { item: itemName, qty: Number(button.dataset.qty) }, itemName, 'Quitando pedidos...');
      break;
    case 'bought':
      send('bought', { item: itemName }, itemName, 'Marcando pedidos...');
      break;
    case 'pending':
      send('pending', { item: itemName }, itemName, 'Reagregando...');
      break;
    case 'later':
      saveItemForLater(itemName);
      break;
    case 'restore':
      restoreItemFromLater(itemName);
      break;
    case 'edit':
      toggleEditing(itemName);
      break;
    case 'cancel-edit':
      closeEditing();
      break;
    default:
      break;
  }
}

pendingList.addEventListener('click', handleListClick);
laterList.addEventListener('click', handleListClick);
activityList.addEventListener('click', handleListClick);

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('edit-form')) {
    return;
  }

  event.preventDefault();
  handleEditSubmit(form);
});

nameInput.addEventListener('input', () => {
  renderAutocompleteSuggestions();
});

nameInput.addEventListener('focus', () => {
  if (nameInput.value.trim()) {
    renderAutocompleteSuggestions();
  }
});

nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    if (!state.autocomplete.open) {
      renderAutocompleteSuggestions();
    } else {
      setAutocompleteActiveIndex(state.autocomplete.activeIndex + 1);
    }
    event.preventDefault();
    return;
  }

  if (event.key === 'ArrowUp') {
    if (!state.autocomplete.open) {
      renderAutocompleteSuggestions();
    } else {
      setAutocompleteActiveIndex(state.autocomplete.activeIndex - 1);
    }
    event.preventDefault();
    return;
  }

  if (event.key === 'Escape' && state.autocomplete.open) {
    closeAutocomplete();
    event.preventDefault();
    return;
  }

  if ((event.key === 'Enter' || event.key === 'Tab') && state.autocomplete.open) {
    const match = state.autocomplete.matches[state.autocomplete.activeIndex];
    if (match === undefined) {
      return;
    }

    if (normalizeSearchText(match.name) === normalizeSearchText(nameInput.value)) {
      closeAutocomplete();
      return;
    }

    selectAutocompleteMatch(match);
    if (event.key === 'Enter') {
      event.preventDefault();
    }
  }
});

suggestionsList.addEventListener('mousedown', (event) => {
  event.preventDefault();
});

suggestionsList.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const option = target?.closest('.autocomplete-option');
  if (option === null || option === undefined) {
    return;
  }

  const index = Number(option.dataset.index);
  const match = state.autocomplete.matches[index];
  if (match !== undefined) {
    selectAutocompleteMatch(match);
  }
});

document.addEventListener('click', (event) => {
  const target = event.target instanceof Node ? event.target : null;
  if (target !== null && !addForm.contains(target)) {
    closeAutocomplete();
  }
});

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const item = nameInput.value.trim();
  const qty = Number(qtyInput.value);

  if (!item || !Number.isFinite(qty) || qty <= 0) {
    return;
  }

  closeAutocomplete();
  await send('add', { item, qty }, null);
  addForm.reset();
  qtyInput.value = '1';
  nameInput.focus();
});

document.querySelectorAll('.section-toggle').forEach((label) => {
  label.addEventListener('click', () => {
    const target = document.getElementById(label.dataset.target);
    if (!target) {
      return;
    }

    const nextExpanded = label.getAttribute('aria-expanded') !== 'true';
    label.setAttribute('aria-expanded', String(nextExpanded));
    label.classList.toggle('collapsed', !nextExpanded);
    target.hidden = !nextExpanded;
  });
});

async function init() {
  const listName = new URL(location.href).searchParams.get('list')?.trim();
  if (!listName) {
    syncStatus.textContent = 'Falta ?list=...';
    return;
  }

  state.list = listName;
  loadSavedForLater();
  nameInput.focus();
  await refresh(true);
}

init();
