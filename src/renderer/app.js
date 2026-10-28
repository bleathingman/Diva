const $ = (selector) => document.querySelector(selector);

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

// --- Setups et apps ---

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

async function renderAppIcon(app, slot) {
  if (app.icon) {
    slot.textContent = app.icon;
    return;
  }
  const dataUrl = await window.diva.getAppIcon(app.name);
  if (dataUrl) {
    const image = document.createElement('img');
    image.src = dataUrl;
    slot.append(image);
  } else {
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = app.name[0].toUpperCase();
    slot.append(letter);
  }
}

function renderApps(apps) {
  const container = $('#apps');
  container.replaceChildren();
  for (const app of apps) {
    const button = document.createElement('button');
    button.className = 'app';
    button.title = app.name;

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
    container.append(button);
    renderAppIcon(app, icon);
  }
}

function renderConfig(config) {
  renderSetups(config.setups ?? []);
  renderApps(config.apps ?? []);
}

// --- Démarrage ---

$('#hide').addEventListener('click', () => window.diva.hide());
$('#open-spotify').addEventListener('click', () => window.diva.launchApp('Spotify'));
for (const button of document.querySelectorAll('[data-media]')) {
  button.addEventListener('click', () => window.diva.media(button.dataset.media));
}

// La fenêtre prend exactement la hauteur du widget (+ la marge autour).
new ResizeObserver(() => {
  window.diva.resize(document.documentElement.scrollHeight);
}).observe($('#widget'));

window.diva.onConfig(renderConfig);
window.diva.onMedia(renderMedia);
window.diva.onToast(toast);
window.diva.getConfig().then(renderConfig);

updateClock();
setInterval(updateClock, 10_000);
