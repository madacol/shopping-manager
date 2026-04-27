const POLL_MS = 5000;
const state = { list: '', version: null, items: [], timer: null, inflight: false };

const $ = (s) => document.querySelector(s);
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

function api(name) { return `/api/lists/${encodeURIComponent(name)}`; }
function fmtQty(q) { return Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/\.?0+$/, ''); }

async function readJson(r) {
  const d = await r.json();
  if (!r.ok || d.ok === false) throw new Error(d.error || `Error ${r.status}`);
  return d;
}

function split(items) {
  return {
    pending: items.filter(i => i.status === 'pending'),
    activity: items
      .filter(i => i.status === 'bought' || i.status === 'removed')
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  };
}

function renderItems(ul, items, mode) {
  ul.replaceChildren();

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = mode === 'pending' ? 'Todo listo.' : 'Nada aun.';
    ul.append(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.itemName = item.name;
    li.dataset.status = item.status;

    const info = document.createElement('div');
    info.className = 'item-info';

    const header = document.createElement('div');
    header.className = 'item-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'item-name';
    nameEl.textContent = item.name;
    header.append(nameEl);

    if (mode === 'activity') {
      const statusPill = document.createElement('span');
      statusPill.className = `state-pill state-pill--${item.status}`;
      statusPill.textContent = item.status === 'bought' ? 'Comprado' : 'Quitado';
      header.append(statusPill);
    }

    const detail = document.createElement('span');
    detail.className = 'item-detail';
    const parts = [`x${fmtQty(item.qty)}`];
    if (item.note) parts.push(item.note);
    detail.textContent = parts.join(' \u2014 ');

    info.append(header, detail);
    li.append(info);

    if (mode === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const buyBtn = document.createElement('button');
      buyBtn.className = 'btn btn-buy';
      buyBtn.textContent = 'Listo';
      buyBtn.dataset.action = 'bought';

      const rmBtn = document.createElement('button');
      rmBtn.className = 'btn btn-remove';
      rmBtn.textContent = 'Quitar';
      rmBtn.dataset.action = 'remove';
      rmBtn.dataset.qty = String(item.qty);

      actions.append(buyBtn, rmBtn);
      li.append(actions);
    }

    ul.append(li);
  }
}

function apply(snap) {
  state.list = snap.list;
  state.version = snap.version;
  pageTitle.textContent = state.list;
  document.title = state.list;

  if (snap.changed && Array.isArray(snap.items)) state.items = snap.items;

  const g = split(state.items);
  const resolved = g.activity.length;
  const total = state.items.length;
  const pct = total === 0 ? 0 : Math.round((resolved / total) * 100);

  pendingCount.textContent = g.pending.length;
  activityCount.textContent = g.activity.length;
  progressFill.style.width = `${pct}%`;

  renderItems(pendingList, g.pending, 'pending');
  renderItems(activityList, g.activity, 'activity');
  syncStatus.textContent = `v${state.version} \u00b7 ${pct}% listo`;
}

function stopPoll() { if (state.timer) { clearTimeout(state.timer); state.timer = null; } }
function schedulePoll() { stopPoll(); state.timer = setTimeout(() => refresh(false), POLL_MS); }

async function refresh(force) {
  if (state.inflight || !state.list) { schedulePoll(); return; }
  state.inflight = true;
  try {
    const url = new URL(api(state.list), location.origin);
    if (!force && state.version !== null) url.searchParams.set('since', String(state.version));
    apply(await readJson(await fetch(url)));
  } catch (e) {
    syncStatus.textContent = e.message;
  } finally {
    state.inflight = false;
    schedulePoll();
  }
}

async function send(action, payload) {
  stopPoll();
  syncStatus.textContent = 'Guardando...';
  try {
    const r = await fetch(`${api(state.list)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    apply((await readJson(r)).snapshot);
  } catch (e) {
    syncStatus.textContent = e.message;
  } finally {
    schedulePoll();
  }
}

// Event delegation for pending items
pendingList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('[data-item-name]');
  if (!card) return;

  if (btn.dataset.action === 'bought') {
    send('bought', { item: card.dataset.itemName });
  } else if (btn.dataset.action === 'remove') {
    send('remove', { item: card.dataset.itemName, qty: Number(btn.dataset.qty) });
  }
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const item = nameInput.value.trim();
  if (!item) return;
  const qty = Number(qtyInput.value);
  await send('add', { item, qty });
  addForm.reset();
  qtyInput.value = '1';
  nameInput.focus();
});

// Collapsible sections
document.querySelectorAll('.section-toggle').forEach(label => {
  label.addEventListener('click', () => {
    const target = document.getElementById(label.dataset.target);
    if (!target) return;
    label.classList.toggle('collapsed');
    target.style.display = target.style.display === 'none' ? '' : 'none';
  });
});

async function init() {
  const name = new URL(location.href).searchParams.get('list')?.trim();
  if (!name) { syncStatus.textContent = 'Falta ?list=...'; return; }
  state.list = name;
  nameInput.focus();
  await refresh(true);
}

init();
