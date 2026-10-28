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

// --- Curseurs (progression, volumes) ---

// La partie remplie de la piste suit la valeur : le CSS lit --fill.
function paintSlider(slider) {
  const range = Number(slider.max) - Number(slider.min) || 1;
  slider.style.setProperty('--fill', `${((Number(slider.value) - Number(slider.min)) / range) * 100}%`);
}

// Met à jour un curseur depuis Windows, sauf si l'utilisateur est en train de le tirer.
function setSlider(slider, value) {
  if (slider.dataset.dragging) return;
  slider.value = value;
  paintSlider(slider);
}

// onMove pendant le glissé (limité à ~15 envois/s), onRelease une fois lâché.
function bindSlider(slider, { onMove, onRelease = onMove }) {
  let lastSent = 0;
  let releaseTimer = null;
  // Après le lâcher, Windows peut encore renvoyer l'ancienne valeur une fois ou deux :
  // on ignore ses mises à jour un court instant pour que le curseur ne saute pas en arrière.
  const release = () => {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => delete slider.dataset.dragging, 700);
  };
  slider.addEventListener('pointerdown', () => {
    clearTimeout(releaseTimer);
    slider.dataset.dragging = '1';
  });
  slider.addEventListener('pointerup', release);
  slider.addEventListener('input', () => {
    paintSlider(slider);
    if (onMove && Date.now() - lastSent > 66) {
      lastSent = Date.now();
      onMove(Number(slider.value));
    }
  });
  slider.addEventListener('change', () => {
    release();
    onRelease(Number(slider.value));
  });
}

// --- Musique ---

let media = { active: false };

function renderMedia(message) {
  if (message.type === 'thumbnail') {
    $('#cover').src = message.data ?? '';
    $('#media-backdrop').style.backgroundImage = message.data ? `url("${message.data}")` : 'none';
    return;
  }
  media = message;
  const card = $('#media');
  card.classList.toggle('idle', !media.active);
  card.classList.toggle('playing', Boolean(media.playing));

  $('#title').textContent = media.active ? media.title || 'Titre inconnu' : 'Rien en lecture';
  $('#artist').textContent = media.active ? media.artist || '' : 'Lance ta musique';
  renderProgress();
}

const formatTime = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

// Windows ne donne la position qu'au moment où l'app l'a mise à jour : on avance l'aiguille
// nous-mêmes depuis ce moment-là tant que la musique joue.
function currentPosition() {
  const elapsed = media.playing ? Date.now() - media.updatedAt : 0;
  return Math.max(0, Math.min(media.durationMs, media.positionMs + elapsed));
}

function renderProgress() {
  const hasTimeline = media.active && media.durationMs > 0;
  $('#progress').hidden = !hasTimeline;
  if (!hasTimeline) return;

  const seek = $('#seek');
  seek.max = media.durationMs;
  seek.disabled = !media.canSeek;
  setSlider(seek, currentPosition());
  $('#position').textContent = formatTime(Number(seek.value));
  $('#duration').textContent = formatTime(media.durationMs);
}

bindSlider($('#seek'), {
  onMove: null,
  onRelease: (position) => {
    window.diva.media(`seek ${Math.round(position)}`);
    // Sans attendre la réponse de l'app : l'aiguille reste où on l'a lâchée.
    media = { ...media, positionMs: position, updatedAt: Date.now() };
    renderProgress();
  },
});
$('#seek').addEventListener('input', () => {
  $('#position').textContent = formatTime(Number($('#seek').value));
});

// --- Volume ---

let audio = { master: 0, muted: false, apps: [] };
const mixerRows = new Map(); // id du processus -> éléments de sa ligne

function renderAudio(state) {
  audio = state;
  $('#audio').classList.toggle('muted', audio.muted);
  setSlider($('#master'), audio.master);
  $('#master-value').textContent = audio.master;
  renderMixer();
}

function mixerRow(app) {
  const row = document.createElement('div');
  row.className = 'mixer-row';

  const icon = document.createElement('button');
  icon.className = 'mixer-icon';
  icon.title = 'Couper / remettre le son';
  icon.addEventListener('click', () => {
    const current = audio.apps.find((entry) => entry.id === app.id);
    window.diva.audio(`appmute ${current?.muted ? 0 : 1} ${app.id}`);
  });
  fillIcon({ name: app.name, open: app.path }, icon);

  const body = document.createElement('div');
  body.className = 'mixer-body';
  const name = document.createElement('span');
  name.className = 'mixer-name';
  name.textContent = app.name;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'slider';
  slider.min = 0;
  slider.max = 100;
  bindSlider(slider, { onMove: (volume) => window.diva.audio(`app ${volume} ${app.id}`) });
  body.append(name, slider);

  const value = document.createElement('span');
  value.className = 'volume-value';
  slider.addEventListener('input', () => { value.textContent = slider.value; });

  row.append(icon, body, value);
  return { row, slider, value };
}

function renderMixer() {
  if ($('#mixer').hidden) return;
  const list = $('#mixer-list');
  const ids = audio.apps.map((app) => app.id).join('|');

  // On ne reconstruit les lignes que si la liste d'apps change, pour ne pas casser un glissé.
  if (ids !== list.dataset.ids) {
    list.dataset.ids = ids;
    mixerRows.clear();
    list.replaceChildren();
    for (const app of audio.apps) {
      const parts = mixerRow(app);
      mixerRows.set(app.id, parts);
      list.append(parts.row);
    }
  }
  for (const app of audio.apps) {
    const { row, slider, value } = mixerRows.get(app.id);
    row.classList.toggle('muted', app.muted);
    row.classList.toggle('inactive', !app.active);
    setSlider(slider, app.volume);
    if (!slider.dataset.dragging) value.textContent = app.volume;
  }
  $('#mixer-empty').hidden = audio.apps.length > 0;
}

bindSlider($('#master'), { onMove: (volume) => window.diva.audio(`master ${volume}`) });
$('#master').addEventListener('input', () => { $('#master-value').textContent = $('#master').value; });
$('#mute').addEventListener('click', () => window.diva.audio(`mute ${audio.muted ? 0 : 1}`));
$('#toggle-mixer').addEventListener('click', () => {
  const mixer = $('#mixer');
  mixer.hidden = !mixer.hidden;
  $('#toggle-mixer').classList.toggle('open', !mixer.hidden);
  renderMixer();
});

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
  for (const view of ['main', 'settings', 'picker', 'link']) {
    $(`#view-${view}`).hidden = view !== name;
  }
  $('#toggle-settings').classList.toggle('active', name !== 'main');
  if (name === 'settings') renderSettings();
  if (name === 'picker') openPicker();
  if (name === 'link') openLinkForm();
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

// --- Réglages de la fenêtre ---

function renderWindowSettings(settings) {
  $('#always-on-top').checked = settings.alwaysOnTop;
  $('#hide-on-blur').checked = settings.hideOnBlur;
  $('#snap-to-edges').checked = settings.snapToEdges;
  setSlider($('#idle-opacity'), settings.idleOpacity);
  if (!$('#idle-opacity').dataset.dragging) $('#idle-opacity-value').textContent = settings.idleOpacity;
}

for (const [id, key] of [['#always-on-top', 'alwaysOnTop'], ['#hide-on-blur', 'hideOnBlur'], ['#snap-to-edges', 'snapToEdges']]) {
  $(id).addEventListener('change', (event) => window.diva.updateWindow({ [key]: event.target.checked }));
}

// Pendant le glissé, la souris est sur le widget (donc à 100 %) : on montre l'opacité
// choisie en direct, puis on l'enregistre au lâcher.
bindSlider($('#idle-opacity'), {
  onMove: (value) => window.diva.previewOpacity(value),
  onRelease: (value) => window.diva.updateWindow({ idleOpacity: value }),
});
$('#idle-opacity').addEventListener('input', () => {
  $('#idle-opacity-value').textContent = $('#idle-opacity').value;
});

// --- Ajout d'un lien ---

function openLinkForm() {
  $('#link-form').reset();
  $('#link-error').hidden = true;
  $('#link-target').focus();
}

$('#pick-folder').addEventListener('click', async () => {
  const folder = await window.diva.pickFolder();
  if (folder) $('#link-target').value = folder;
});

$('#link-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const link = { target: $('#link-target').value, name: $('#link-name').value };
  const error = await window.diva.addLink(link);
  if (error) {
    $('#link-error').textContent = error;
    $('#link-error').hidden = false;
    return;
  }
  toast('Lien épinglé');
  showView('settings');
});

// --- Démarrage ---

$('#hide').addEventListener('click', () => window.diva.hide());
$('#toggle-settings').addEventListener('click', () => showView(currentView === 'main' ? 'settings' : 'main'));
$('#add-app').addEventListener('click', () => showView('picker'));
$('#add-link').addEventListener('click', () => showView('link'));
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => showView(button.dataset.back || 'main'));
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (currentView === 'picker' || currentView === 'link') showView('settings');
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

window.diva.onGrid(renderGrid);
window.diva.onOpenSettings(() => showView('settings'));
window.diva.onMedia(renderMedia);
window.diva.onAudio(renderAudio);
setInterval(renderProgress, 250);
window.diva.onToast(toast);
window.diva.getGrid().then(renderGrid);
window.diva.onWindowSettings(renderWindowSettings);
window.diva.getWindowSettings().then(renderWindowSettings);

// Opacité au repos : le processus principal repasse à 100 % tant que la souris est dessus.
document.documentElement.addEventListener('mouseenter', () => window.diva.hover(true));
document.documentElement.addEventListener('mouseleave', () => window.diva.hover(false));

updateClock();
setInterval(updateClock, 10_000);
