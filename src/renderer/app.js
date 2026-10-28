const $ = (selector) => document.querySelector(selector);

// Même règle que le processus principal : sert à reconnaître une app quel que soit son nom exact.
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
// Pour la recherche on ignore les accents : "pokemon" doit trouver "Pokémon Z".
const searchable = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const ICONS = {
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  show: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  add: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
};

// --- Notification ---

let toastTimer = null;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 3500);
}

// --- Horloge ---

function updateClock() {
  $('#clock').textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// --- Musique ---

function renderMedia(state) {
  const media = $('#media');
  media.classList.toggle('idle', !state.active);
  media.classList.toggle('playing', Boolean(state.playing));

  $('#title').textContent = state.active ? state.title || 'Titre inconnu' : 'Rien en lecture';
  $('#artist').textContent = state.active ? state.artist || '' : 'Lance ta musique';

  const thumbnail = state.active && state.thumbnail ? state.thumbnail : '';
  $('#cover').src = thumbnail;
  $('#media-backdrop').style.backgroundImage = thumbnail ? `url("${thumbnail}")` : 'none';
}

// --- Icônes d'apps (en cache : la grille est souvent redessinée) ---

const iconCache = new Map();

function loadIcon(entry) {
  const key = `${entry.open}|${entry.iconFile ?? ''}`;
  if (!iconCache.has(key)) iconCache.set(key, window.diva.getAppIcon(entry));
  return iconCache.get(key);
}

async function fillIcon(entry, slot) {
  if (entry.icon) {
    slot.textContent = entry.icon;
    return;
  }
  const dataUrl = entry.open ? await loadIcon(entry) : null;
  if (dataUrl) {
    const image = document.createElement('img');
    image.src = dataUrl;
    slot.replaceChildren(image);
  } else {
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = entry.name[0].toUpperCase();
    slot.replaceChildren(letter);
  }
}

// --- Setups ---

function renderSetups(setups) {
  const container = $('#setups');
  container.replaceChildren();
  for (const setup of setups) {
    const button = document.createElement('button');
    button.className = 'setup';
    button.title = setup.apps.join(', ');
    if (setup.icon) {
      const icon = document.createElement('span');
      icon.className = 'setup-icon';
      icon.textContent = setup.icon;
      button.append(icon);
    }
    button.append(setup.name);
    button.addEventListener('click', async () => {
      button.classList.add('running');
      toast(`Lancement de ${setup.name}…`);
      const errors = await window.diva.runSetup(setup.name);
      button.classList.remove('running');
      toast(errors.length ? errors.join('\n') : `${setup.name} est prêt`);
    });
    container.append(button);
  }
}

// --- Grille d'apps ---

let grid = { title: 'Apps', apps: [], settings: { count: 8, fillWithRecent: true, pinned: [], hidden: [] } };

function renderGrid(next) {
  grid = next;
  $('#apps-title').textContent = grid.title;
  $('#apps-empty').hidden = grid.apps.length > 0;

  const container = $('#apps');
  container.replaceChildren();
  for (const app of grid.apps) {
    const button = document.createElement('button');
    button.className = app.pinned ? 'app pinned' : 'app';
    button.title = `${app.name}\nClic droit : épingler, masquer…`;

    const icon = document.createElement('span');
    icon.className = 'app-icon';
    const name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = app.name;

    button.append(icon, name);
    button.addEventListener('click', async () => {
      const error = await window.diva.launchApp(app.name);
      toast(error ?? `${app.name} lancé`);
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      window.diva.appMenu(app.name);
    });
    container.append(button);
    fillIcon(app, icon);
  }

  if (!$('#view-settings').hidden) renderSettings();
}

// --- Vues : principale, réglages, ajout d'app ---

let currentView = 'main';

function showView(name) {
  currentView = name;
  for (const view of ['main', 'settings', 'picker']) {
    $(`#view-${view}`).hidden = view !== name;
  }
  $('#toggle-settings').classList.toggle('active', name !== 'main');
  if (name === 'settings') renderSettings();
  if (name === 'picker') openPicker();
}

function actionButton(icon, title, onClick) {
  const button = document.createElement('button');
  button.className = 'icon-button';
  button.title = title;
  button.innerHTML = ICONS[icon];
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function listRow(entry, actions = []) {
  const row = document.createElement('div');
  row.className = 'list-row';
  const icon = document.createElement('span');
  icon.className = 'row-icon';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = entry.name;
  const buttons = document.createElement('div');
  buttons.className = 'row-actions';
  buttons.append(...actions);
  row.append(icon, name, buttons);
  return { row, icon };
}

// --- Réglages ---

function renderSettings() {
  const { pinned, hidden, count, fillWithRecent } = grid.settings;

  const pinnedList = $('#pinned-list');
  pinnedList.replaceChildren();
  pinned.forEach((entry, index) => {
    const move = (delta) => {
      const target = index + delta;
      if (target < 0 || target >= pinned.length) return;
      const reordered = [...pinned];
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
      window.diva.updateGrid({ pinned: reordered });
    };
    const { row, icon } = listRow(entry, [
      actionButton('up', 'Monter', () => move(-1)),
      actionButton('down', 'Descendre', () => move(1)),
      actionButton('remove', 'Retirer', () => {
        window.diva.updateGrid({ pinned: pinned.filter((_, i) => i !== index) });
      }),
    ]);
    pinnedList.append(row);
    fillIcon(entry, icon);
  });
  $('#pinned-empty').hidden = pinned.length > 0;

  $('#fill-recent').checked = fillWithRecent;
  $('#grid-count').textContent = count;

  const hiddenList = $('#hidden-list');
  hiddenList.replaceChildren();
  hidden.forEach((name, index) => {
    const { row, icon } = listRow({ name }, [
      actionButton('show', 'Réafficher', () => {
        window.diva.updateGrid({ hidden: hidden.filter((_, i) => i !== index) });
      }),
    ]);
    hiddenList.append(row);
    fillIcon({ name }, icon);
  });
  $('#hidden-empty').hidden = hidden.length > 0;
}

$('#fill-recent').addEventListener('change', (event) => {
  window.diva.updateGrid({ fillWithRecent: event.target.checked });
});

for (const button of document.querySelectorAll('[data-step]')) {
  button.addEventListener('click', () => {
    // Par rangées de 4, entre 4 et 16 apps.
    const count = Math.min(16, Math.max(4, grid.settings.count + Number(button.dataset.step)));
    window.diva.updateGrid({ count });
  });
}

// --- Ajout d'une app installée ---

let installedApps = null;

// Les icônes ne sont chargées que pour les lignes visibles : la liste fait ~120 apps.
const pickerIcons = new WeakMap();
const iconObserver = new IntersectionObserver((entries) => {
  for (const { isIntersecting, target } of entries) {
    if (!isIntersecting) continue;
    iconObserver.unobserve(target);
    fillIcon(pickerIcons.get(target), target);
  }
}, { root: $('#picker-list') });

async function openPicker() {
  const search = $('#picker-search');
  search.value = '';
  search.focus();
  if (!installedApps) {
    $('#picker-list').replaceChildren();
    $('#picker-empty').textContent = 'Chargement…';
    $('#picker-empty').hidden = false;
    installedApps = await window.diva.getInstalledApps();
  }
  renderPicker();
}

function renderPicker() {
  const query = searchable($('#picker-search').value.trim());
  const pinnedIds = new Set(grid.settings.pinned.map((entry) => normalize(entry.name)));
  const matches = installedApps.filter((entry) => searchable(entry.name).includes(query));

  const list = $('#picker-list');
  list.replaceChildren();
  list.scrollTop = 0;
  for (const entry of matches) {
    const alreadyPinned = pinnedIds.has(normalize(entry.name));
    const status = document.createElement('span');
    status.className = 'row-status';
    status.innerHTML = alreadyPinned ? ICONS.check : ICONS.add;
    const { row, icon } = listRow(entry, [status]);
    row.classList.add('clickable');
    row.classList.toggle('added', alreadyPinned);
    row.addEventListener('click', () => {
      if (row.classList.contains('added')) return;
      window.diva.pinApp(entry);
      row.classList.add('added');
      status.innerHTML = ICONS.check;
      toast(`${entry.name} épinglée`);
    });
    list.append(row);
    pickerIcons.set(icon, entry);
    iconObserver.observe(icon);
  }
  $('#picker-empty').textContent = 'Aucune app trouvée';
  $('#picker-empty').hidden = matches.length > 0;
}

$('#picker-search').addEventListener('input', renderPicker);

// --- Démarrage ---

$('#hide').addEventListener('click', () => window.diva.hide());
$('#toggle-settings').addEventListener('click', () => showView(currentView === 'main' ? 'settings' : 'main'));
$('#add-app').addEventListener('click', () => showView('picker'));
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => showView(button.dataset.back || 'main'));
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (currentView === 'picker') showView('settings');
  else if (currentView === 'settings') showView('main');
});

$('#open-spotify').addEventListener('click', () => window.diva.launchApp('Spotify'));
for (const button of document.querySelectorAll('[data-media]')) {
  button.addEventListener('click', () => window.diva.media(button.dataset.media));
}

// La fenêtre prend exactement la hauteur du widget (+ la marge autour). On mesure le widget
// et pas la page : la page ne descend jamais sous la taille de la fenêtre, qui ne rétrécirait plus.
const widget = $('#widget');
new ResizeObserver(() => {
  const { marginTop, marginBottom } = getComputedStyle(widget);
  window.diva.resize(widget.offsetHeight + parseFloat(marginTop) + parseFloat(marginBottom));
}).observe(widget);

window.diva.onConfig((config) => renderSetups(config.setups ?? []));
window.diva.onGrid(renderGrid);
window.diva.onOpenSettings(() => showView('settings'));
window.diva.onMedia(renderMedia);
window.diva.onToast(toast);
window.diva.getConfig().then((config) => renderSetups(config.setups ?? []));
window.diva.getGrid().then(renderGrid);

updateClock();
setInterval(updateClock, 10_000);
