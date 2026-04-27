const syncStatus = document.querySelector('#sync-status');
const listDirectory = document.querySelector('#list-directory');
const apiListsUrl = new URL('./api/lists', location.href);

async function readJson(response) {
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function renderDirectory(lists) {
  listDirectory.replaceChildren();

  if (lists.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No hay listas todavia.';
    listDirectory.append(li);
    return;
  }

  for (const name of lists) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `./list.html?list=${encodeURIComponent(name)}`;
    a.textContent = name;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = '<path d="m9 18 6-6-6-6"/>';

    a.append(svg);
    li.append(a);
    listDirectory.append(li);
  }
}

async function init() {
  try {
    const data = await readJson(await fetch(apiListsUrl));
    renderDirectory(data.lists);
    syncStatus.textContent = `${data.lists.length} lista${data.lists.length === 1 ? '' : 's'}`;
  } catch (e) {
    syncStatus.textContent = e.message;
  }
}

init();
