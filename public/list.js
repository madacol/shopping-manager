const POLL_MS = 5000;
const ICONS = {
  remove:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6 18 18"/></svg>',
  bought:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>',
  pending:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 3v5h5"/></svg>',
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
  deferredSnapshot: null
};

const $ = (selector) => document.querySelector(selector);
const pageTitle = $('#page-title');
const syncStatus = $('#sync-status');
const addForm = $('#add-form');
const nameInput = $('#item-name');
const qtyInput = $('#item-qty');
const pendingList = $('#pending-items');
const activityList = $('#activity-items');
const pendingCount = $('#pending-count');
const activityCount = $('#activity-count');
const progressFill = $('#progress-fill');

function api(name, action = '') {
  const suffix = action ? `/${action}` : '';
  return new URL(`./api/lists/${encodeURIComponent(name)}${suffix}`, location.href);
}

function fmtQty(qty) {
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/\.?0+$/, '');
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

function renderItem(item, mode) {
  const li = document.createElement('li');
  const itemKey = getItemKey(item);
  const isEditing = state.editingItem === itemKey;
  const isBusy = state.busyItem === itemKey;

  li.className = `item item--${mode}`;
  li.dataset.itemName = itemKey;
  li.dataset.status = item.status;

  if (isEditing) {
    li.dataset.expanded = 'true';
  }

  if (isBusy) {
    li.dataset.busy = 'true';
  }

  const row = document.createElement('div');
  row.className = `item-row item-row--${mode}`;

  if (mode === 'pending') {
    const removeButton = makeIconButton('remove', 'danger', 'Quitar');
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

  const rightButton =
    mode === 'pending'
      ? makeIconButton('bought', 'success', 'Listo')
      : makeIconButton('pending', item.status === 'removed' ? 'danger' : 'accent', 'Reagregar');

  rightButton.dataset.action = mode === 'pending' ? 'bought' : 'pending';
  if (isBusy) {
    rightButton.disabled = true;
  }
  row.append(rightButton);

  li.append(row);

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
    li.textContent = mode === 'pending' ? 'Todo listo.' : 'Nada aun.';
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

  const groups = split(state.items);
  const resolved = groups.activity.length;
  const total = state.items.length;
  const progress = total === 0 ? 0 : Math.round((resolved / total) * 100);

  pendingCount.textContent = groups.pending.length;
  activityCount.textContent = groups.activity.length;
  progressFill.style.width = `${progress}%`;

  renderItems(pendingList, groups.pending, 'pending');
  renderItems(activityList, groups.activity, 'activity');
  syncStatus.textContent = `v${state.version} · ${progress}% listo`;
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

  const input = document.querySelector('.edit-form input[name="item"]');
  if (input instanceof HTMLInputElement) {
    input.focus();
    input.select();
  }
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
      send('remove', { item: itemName, qty: Number(button.dataset.qty) }, itemName);
      break;
    case 'bought':
      send('bought', { item: itemName }, itemName);
      break;
    case 'pending':
      send('pending', { item: itemName }, itemName, 'Reagregando...');
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
activityList.addEventListener('click', handleListClick);

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('edit-form')) {
    return;
  }

  event.preventDefault();
  handleEditSubmit(form);
});

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const item = nameInput.value.trim();
  const qty = Number(qtyInput.value);

  if (!item || !Number.isFinite(qty) || qty <= 0) {
    return;
  }

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
  nameInput.focus();
  await refresh(true);
}

init();
