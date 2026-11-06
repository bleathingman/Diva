// Processus principal : config, grille d'apps, liens, recherche, et le lien entre l'interface
// et les modules (widgets, pont Windows, Spotify, captures, minuteur, mises à jour).
const {
  app, BrowserWindow, Tray, Menu, Notification, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain,
  session, shell, nativeImage,
} = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { expandEnv, isUri, isPathLike, normalize, defaultLinkName, parseLinkTarget } = require('./paths');
const { getAppIcon, fetchFavicon } = require('./icons');
const { createWidgets } = require('./windows');
const { createBridge } = require('./bridge');
const { createUpdates } = require('./updates');
const { createSpotify, REDIRECT_URI } = require('./spotify');
const { createCaptures } = require('./captures');
const { createTimer } = require('./timer');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-config.json');
// Dans l'app installée, le code est dans l'archive app.asar que PowerShell ne sait pas lire :
// les scripts sont copiés à côté, dans app.asar.unpacked (voir "asarUnpack" dans package.json).
const HELPERS_DIR = path.join(__dirname, '..', 'helpers').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const BRIDGE_PATH = path.join(HELPERS_DIR, 'bridge.ps1');
const RECENT_APPS_PATH = path.join(HELPERS_DIR, 'recent-apps.ps1');
const INSTALLED_APPS_PATH = path.join(HELPERS_DIR, 'installed-apps.ps1');
const RECENT_REFRESH_MS = 10 * 60 * 1000;

let win = null; // widget principal
let widgets = null; // src/windows.js : le principal et les widgets détachés
let tray = null;
let config = null;
let bridge = null; // src/bridge.js : média et volume dans un seul processus PowerShell
let updates = null; // src/updates.js
let recentApps = [];
let recentRefreshedAt = 0;
let installedApps = null; // promesse gardée en cache, la liste change rarement
let installedList = [];
let lastSavedConfig = '';
let quitting = false;
let spotify = null;
let captures = null;
let timer = null;
let blurGuard = false; // vrai pendant un menu ou une boîte de dialogue : la perte de focus est normale
let hiddenByBlurAt = 0;

// --- Fichiers utilisateur (%APPDATA%\Diva) -------------------------------------------

const userFile = (name) => path.join(app.getPath('userData'), name);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const file = userFile('config.json');
  if (!fs.existsSync(file)) fs.copyFileSync(DEFAULT_CONFIG_PATH, file);
  const loaded = readJson(file, null);
  if (!loaded) {
    win?.webContents.send('toast', 'config.json invalide, ancienne config gardée');
    return config ?? readJson(DEFAULT_CONFIG_PATH, {});
  }
  return loaded;
}

function watchConfig() {
  let timer = null;
  fs.watch(userFile('config.json'), () => {
    // Windows déclenche souvent plusieurs événements pour une seule sauvegarde.
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Nos propres sauvegardes (panneau Réglages) sont déjà appliquées.
      let content = null;
      try {
        content = fs.readFileSync(userFile('config.json'), 'utf8');
      } catch {
        // Fichier en cours d'écriture : le prochain événement le relira.
      }
      if (content !== null && content !== lastSavedConfig) applyConfig();
    }, 200);
  });
}

function applyConfig() {
  const previousHotkey = config?.hotkey;
  const previousDays = gridSettings().recentDays;
  config = loadConfig();
  widgets.applySettings();
  if (config.hotkey !== previousHotkey) registerHotkey(previousHotkey);
  sendGrid();
  if (gridSettings().recentDays !== previousDays) refreshRecentApps();
}

function saveConfig() {
  lastSavedConfig = JSON.stringify(config, null, 2);
  fs.writeFileSync(userFile('config.json'), lastSavedConfig);
  sendGrid();
}

// --- Lancement d'apps ----------------------------------------------------------------

async function openTarget(target) {
  const expanded = expandEnv(target);
  // Apps du Store et identifiants Windows : seul l'Explorateur sait ouvrir "shell:AppsFolder\...".
  if (expanded.toLowerCase().startsWith('shell:')) {
    spawn('explorer.exe', [expanded], { detached: true, stdio: 'ignore' }).unref();
    return null;
  }
  if (isUri(expanded)) {
    await shell.openExternal(expanded);
    return null;
  }
  const error = await shell.openPath(expanded);
  return error || null;
}

// Les apps de la config passent en premier : elles gardent leur emoji et leur chemin.
function findApp(name) {
  const id = normalize(name);
  return [...config.apps, ...gridSettings().pinned, ...recentApps].find((entry) => normalize(entry.name) === id);
}

async function launchApp(name) {
  const entry = findApp(name);
  if (!entry) return `App inconnue : ${name}`;
  const error = await openTarget(entry.open);
  return error ? `${entry.name} : ${error}` : null;
}

// --- Grille d'apps : épinglées puis récentes --------------------------------------

const SECTION_KEYS = {
  grid: ['count', 'fillWithRecent', 'recentDays', 'pinned', 'hidden'],
  window: ['alwaysOnTop', 'hideOnBlur', 'snapToEdges', 'idleOpacity', 'scale', 'visualizer', 'theme'],
  spotify: ['clientId'],
  captures: ['enabled'],
  timer: ['work', 'shortBreak', 'longBreak', 'cyclesBeforeLong'],
  layout: ['order', 'hidden', 'detached', 'miniMedia'],
};

const SECTIONS = ['media', 'audio', 'captures', 'apps'];

function gridSettings() {
  return { count: 8, fillWithRecent: true, recentDays: 30, pinned: [], hidden: [], ...config?.grid };
}

function windowSettings() {
  // alwaysOnTop était à la racine de la config avant le panneau Réglages : on le reprend.
  return {
    alwaysOnTop: config?.alwaysOnTop ?? true, hideOnBlur: false, snapToEdges: true, idleOpacity: 100, scale: 1,
    visualizer: true, theme: 'dark',
    ...config?.window,
  };
}

function spotifySettings() {
  return { clientId: '', ...config?.spotify };
}

function capturesSettings() {
  return { enabled: true, ...config?.captures };
}

// Ordre, sections masquées et sections détachées dans leur propre widget.
function layoutSettings() {
  // Avant la disposition, les captures avaient leur propre interrupteur : on le reprend.
  const legacyHidden = capturesSettings().enabled === false ? ['captures'] : [];
  const layout = { order: SECTIONS, hidden: legacyHidden, detached: [], ...config?.layout };
  const known = (list) => (Array.isArray(list) ? list.filter((section) => SECTIONS.includes(section)) : []);
  const order = [...new Set([...known(layout.order), ...SECTIONS])];
  return { order, hidden: known(layout.hidden), detached: known(layout.detached), miniMedia: Boolean(layout.miniMedia) };
}

function timerSettings() {
  return { work: 25, shortBreak: 5, longBreak: 15, cyclesBeforeLong: 4, ...config?.timer };
}

function updateSection(section, patch) {
  const keys = SECTION_KEYS[section];
  if (!keys) return;
  const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => keys.includes(key)));
  const current = {
    grid: gridSettings, window: windowSettings, spotify: spotifySettings, captures: capturesSettings,
    timer: timerSettings, layout: layoutSettings,
  }[section]();
  config = { ...config, [section]: { ...current, ...allowed } };
  saveConfig();
  if (section === 'window') widgets.applySettings();
  if (section === 'layout') widgets.sync();
}

const updateGrid = (patch) => updateSection('grid', patch);

function buildGrid() {
  const settings = gridSettings();
  const pinnedIds = new Set(settings.pinned.map((entry) => normalize(entry.name)));
  const hiddenIds = new Set(settings.hidden.map(normalize));
  const recent = settings.fillWithRecent
    ? recentApps.filter((entry) => !pinnedIds.has(normalize(entry.name)) && !hiddenIds.has(normalize(entry.name)))
    : [];
  const freeSlots = Math.max(0, settings.count - settings.pinned.length);
  return {
    title: settings.pinned.length ? 'Mes apps' : 'Récents',
    apps: [...settings.pinned.map((entry) => ({ ...withCurrentIcon(entry), pinned: true })), ...recent.slice(0, freeSlots)],
    settings,
  };
}

// Le logo d'une app du Store est dans un dossier qui porte sa version : après une mise à
// jour, l'ancien chemin n'existe plus. On reprend alors celui trouvé par les scripts.
function withCurrentIcon(entry) {
  if (!entry.iconFile || fs.existsSync(entry.iconFile)) return entry;
  const fresh = [...recentApps, ...installedList].find(sameApp(entry.name));
  return { ...entry, iconFile: fresh?.iconFile };
}

// Tous les widgets reçoivent les mêmes données ; chacun n'affiche que ses sections.
const broadcast = (channel, payload) => widgets?.broadcast(channel, payload);

function sendGrid() {
  broadcast('grid', buildGrid());
  broadcast('window-settings', windowSettings());
  broadcast('layout', layoutSettings());
  broadcast('captures', capturesPayload());
}

// Compare une app (objet ou simple nom) à un nom, avec la même règle que normalize().
const sameApp = (name) => (entry) => normalize(entry.name ?? entry) === normalize(name);

function pinApp({ name, open, iconFile }) {
  const { pinned } = gridSettings();
  if (!name || !open || pinned.some(sameApp(name))) return;
  updateGrid({ pinned: [...pinned, iconFile ? { name, open, iconFile } : { name, open }] });
}

// --- Liens favoris : un site ou un dossier épinglé comme une app ---

// Renvoie un message d'erreur, ou null si le lien est épinglé.
function addLink({ name, target } = {}) {
  const { open, error } = parseLinkTarget(target, fs.existsSync);
  if (error) return error;
  const label = String(name ?? '').trim() || defaultLinkName(open);
  if (gridSettings().pinned.some(sameApp(label))) return `« ${label} » est déjà épinglé`;
  pinApp({ name: label, open });
  if (/^https?:/i.test(open)) {
    fetchFavicon(open, userFile('icons')).then((iconFile) => {
      if (!iconFile) return;
      const { pinned } = gridSettings();
      updateGrid({ pinned: pinned.map((entry) => (sameApp(label)(entry) ? { ...entry, iconFile } : entry)) });
    });
  }
  return null;
}

// Boîte de dialogue Windows ; renvoie { path, name } avec un nom proposé, ou null si annulée.
async function pickPath(options) {
  blurGuard = true;
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, options);
    return canceled ? null : { path: filePaths[0], name: defaultLinkName(filePaths[0]) };
  } finally {
    blurGuard = false;
  }
}

const pickFolder = () => pickPath({ properties: ['openDirectory'] });

// Pour une app que Diva ne détecte pas (jeu posé sur le bureau, app portable...).
const pickApp = () => pickPath({
  properties: ['openFile'],
  filters: [
    { name: 'Applications et raccourcis', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] },
    { name: 'Tous les fichiers', extensions: ['*'] },
  ],
});

function unpinApp(name) {
  updateGrid({ pinned: gridSettings().pinned.filter((entry) => !sameApp(name)(entry)) });
}

function hideApp(name) {
  const { hidden } = gridSettings();
  if (!hidden.some(sameApp(name))) updateGrid({ hidden: [...hidden, name] });
}

function showAppMenu(name, window = win) {
  blurGuard = true;
  const pinned = gridSettings().pinned.some(sameApp(name));
  // Pour épingler une récente, on garde son icône de package si elle en a une.
  const entry = recentApps.find(sameApp(name)) ?? findApp(name);
  Menu.buildFromTemplate([
    pinned
      ? { label: 'Désépingler', click: () => unpinApp(name) }
      : { label: 'Épingler', click: () => entry && pinApp(entry) },
    { label: 'Masquer de la grille', visible: !pinned, click: () => hideApp(name) },
    { type: 'separator' },
    { label: 'Réglages…', click: () => win.webContents.send('open-settings') },
  ]).popup({ window, callback: () => { blurGuard = false; } });
}

function runAppScript(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      });
  });
}

function refreshRecentApps() {
  recentRefreshedAt = Date.now();
  runAppScript(RECENT_APPS_PATH, ['-Days', String(gridSettings().recentDays)])
    .then((apps) => {
      recentApps = apps;
      sendGrid();
    })
    .catch((error) => console.error('[recent-apps]', error.message));
}

function getInstalledApps() {
  installedApps ??= runAppScript(INSTALLED_APPS_PATH).then((apps) => {
    installedList = apps;
    sendGrid(); // un logo d'app épinglée a pu être retrouvé dans cette liste
    return apps;
  }).catch((error) => {
    console.error('[installed-apps]', error.message);
    installedApps = null;
    return [];
  });
  return installedApps;
}

// --- Recherche : tout ce qui peut se lancer, sans doublons -------------------------

function entryKind(open) {
  if (/^https?:/i.test(open)) return 'Site';
  try {
    if (isPathLike(open) && fs.statSync(expandEnv(open)).isDirectory()) return 'Dossier';
  } catch {
    // Chemin introuvable : on le présente comme une app, le lancement dira l'erreur.
  }
  return 'App';
}

// Ce que lance vraiment une entrée : la cible d'un raccourci, sinon le chemin ou le lien.
function launchTarget(open) {
  const expanded = expandEnv(open).toLowerCase();
  if (!expanded.endsWith('.lnk')) return expanded;
  try {
    const { target, args } = shell.readShortcutLink(expanded);
    // Les arguments comptent : Discord et Discord Canary passent par des Update.exe différents,
    // mais deux jeux Steam passent tous deux par steam.exe avec des arguments différents.
    return target ? `${target} ${args ?? ''}`.trim().toLowerCase() : expanded;
  } catch {
    return expanded;
  }
}

// Ordre = priorité en cas de doublon : épinglées, récentes (avec leur nombre de
// lancements, qui sert au classement), apps de la config, puis toutes les installées.
async function getSearchEntries() {
  const installed = await getInstalledApps();
  const seen = new Set();
  const entries = [];
  const add = (entry, source) => {
    // Doublon si même nom, ou même programme sous un autre nom ("VS Code" et
    // "Visual Studio Code" pointent tous deux vers Code.exe).
    const id = normalize(entry.name);
    const target = `target:${launchTarget(entry.open)}`;
    if (!id || seen.has(id) || seen.has(target)) return;
    seen.add(id);
    seen.add(target);
    entries.push({
      name: entry.name, open: entry.open, iconFile: entry.iconFile, icon: entry.icon,
      source, runs: entry.runs ?? 0, kind: entryKind(entry.open),
    });
  };
  gridSettings().pinned.forEach((entry) => add(withCurrentIcon(entry), 'pinned'));
  recentApps.forEach((entry) => add(entry, 'recent'));
  config.apps.forEach((entry) => add(entry, 'app'));
  installed.forEach((entry) => add(entry, 'app'));
  return entries;
}

// Lance un résultat de recherche : par son nom s'il est connu, sinon par sa cible.
async function openEntry({ name, open } = {}) {
  const known = typeof name === 'string' ? findApp(name) : null;
  const target = known?.open ?? open;
  if (typeof target !== 'string' || !target) return 'Rien à ouvrir';
  const error = await openTarget(target);
  return error ? `${name} : ${error}` : null;
}

// --- Spotify (src/spotify.js) -------------------------------------------------------

function spotifyStatus() {
  return { connected: spotify.isConnected(), clientId: spotifySettings().clientId, redirectUri: REDIRECT_URI };
}

// Renvoie { error } ou le nouvel état.
async function connectSpotify(clientId) {
  updateSection('spotify', { clientId: String(clientId ?? '').trim() });
  try {
    await spotify.connect();
    win.show();
    return spotifyStatus();
  } catch (error) {
    return { ...spotifyStatus(), error: error.message };
  }
}

// --- Captures d'écran (src/captures.js) ----------------------------------------------

function capturesPayload() {
  return { enabled: capturesSettings().enabled, items: captures?.list() ?? [], folders: captures?.folders() ?? [] };
}

// Glisser une miniature hors du widget dépose le vrai fichier (dans Discord, l'Explorateur...).
async function dragCapture(sender, file) {
  if (!captures.find(file)) return;
  const thumbnail = await captures.thumbnail(file);
  const icon = thumbnail ? nativeImage.createFromDataURL(thumbnail).resize({ width: 96 }) : nativeImage.createFromPath(ICON_PATH);
  sender.startDrag({ file, icon });
}

function showCaptureMenu(file, window = win) {
  if (!captures.find(file)) return;
  blurGuard = true;
  Menu.buildFromTemplate([
    { label: 'Copier l\'image', click: () => clipboard.writeImage(nativeImage.createFromPath(file)) },
    { label: 'Ouvrir', click: () => shell.openPath(file) },
    { label: 'Afficher dans le dossier', click: () => shell.showItemInFolder(file) },
  ]).popup({ window, callback: () => { blurGuard = false; } });
}

// --- Minuteur (src/timer.js) ---------------------------------------------------------

// Fin d'un minuteur : notification Windows, et le widget se montre sans voler le focus.
function timerFinished(title, body) {
  new Notification({ title, body, icon: ICON_PATH }).show();
  if (!win.isVisible()) win.showInactive();
  win.webContents.send('timer-done', { title, body });
}

// --- Son du système pour le visualiseur ---------------------------------------------

// getDisplayMedia() ne demande rien à l'utilisateur : on répond à sa place avec la capture
// « loopback » de Windows (ce qui sort des enceintes), le son reste écoutable normalement.
// Le son n'est qu'analysé dans l'interface, jamais enregistré ni envoyé.
function allowSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const [source] = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: source, audio: 'loopback' });
  });
}

// --- Pont permanent avec Windows (src/bridge.js) -----------------------------------

// Aucun widget visible : le pont espace ses relevés, personne ne voit la musique bouger.
function updatePace() {
  bridge?.setVisible(widgets.all().some((window) => window.isVisible()));
}

// --- Fenêtre, barre des tâches, raccourci --------------------------------------------

const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

function createWindow() {
  widgets = createWidgets({
    stateFile: userFile('state.json'),
    page: path.join(__dirname, 'renderer', 'index.html'),
    preload: path.join(__dirname, 'preload.js'),
    icon: ICON_PATH,
    getSettings: windowSettings,
    getDetached: () => layoutSettings().detached,
    // Une page (re)chargée reçoit tout de suite le dernier état de la musique et du volume.
    onLoaded: (window) => {
      for (const { channel, message } of bridge?.lastMessages() ?? []) window.webContents.send(channel, message);
    },
    onVisibility: updatePace,
    onScaleChosen: (scale) => updateSection('window', { scale }),
  });
  win = widgets.createMain();
  win.on('blur', () => {
    if (blurGuard || !windowSettings().hideOnBlur) return;
    win.hide();
    hiddenByBlurAt = Date.now();
  });
}

function toggleWindow() {
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
    if (Date.now() - recentRefreshedAt > 60_000) refreshRecentApps();
  }
}

function registerHotkey(previous) {
  if (previous) globalShortcut.unregister(previous);
  if (!config.hotkey) return;
  if (!globalShortcut.register(config.hotkey, toggleWindow)) {
    win?.webContents.send('toast', `Raccourci ${config.hotkey} déjà pris par une autre app`);
  }
}

// Installée, Diva.exe se lance seule. Avec npm start, Windows doit lancer electron.exe
// avec le dossier du projet, sinon il ouvrirait l'écran d'accueil d'Electron.
const LOGIN_ITEM = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }));
  tray.setToolTip('Diva');
  tray.on('click', () => {
    // Avec « se cacher quand je clique ailleurs », ce clic vient de cacher le widget :
    // le réafficher aussitôt annulerait le geste.
    if (Date.now() - hiddenByBlurAt < 400) return;
    toggleWindow();
  });
  refreshTrayMenu();
}

function refreshTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Installer Diva ${updates?.ready()} et redémarrer`, visible: Boolean(updates?.ready()), click: () => updates.install() },
    { type: 'separator', visible: Boolean(updates?.ready()) },
    { label: 'Afficher / masquer', click: toggleWindow },
    { label: 'Modifier la config', click: () => shell.openPath(userFile('config.json')) },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings(LOGIN_ITEM).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: item.checked });
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
}

// --- Communication avec l'interface --------------------------------------------------

ipcMain.handle('get-grid', () => buildGrid());
ipcMain.handle('get-window-settings', () => windowSettings());
ipcMain.handle('add-link', (_event, link) => addLink(link));
ipcMain.handle('pick-folder', () => pickFolder());
ipcMain.handle('pick-app', () => pickApp());
ipcMain.handle('get-captures', () => capturesPayload());
ipcMain.handle('capture-thumbnail', (_event, file) => captures.thumbnail(String(file)));
ipcMain.on('capture-drag', (event, file) => dragCapture(event.sender, String(file)));
ipcMain.on('capture-open', (_event, file) => captures.find(String(file)) && shell.openPath(String(file)));
ipcMain.on('capture-menu', (event, file) => showCaptureMenu(String(file), windowOf(event)));
ipcMain.on('update-captures', (_event, patch) => updateSection('captures', patch));
ipcMain.handle('get-layout', () => layoutSettings());
ipcMain.handle('get-update', () => updates.status());
ipcMain.handle('check-updates', () => updates.check());
ipcMain.on('install-update', () => updates.install());
ipcMain.on('update-layout', (_event, patch) => updateSection('layout', patch));
// Le × d'un widget détaché le rattache au widget principal.
ipcMain.on('attach-section', (_event, section) => {
  updateSection('layout', { detached: layoutSettings().detached.filter((entry) => entry !== section) });
});
ipcMain.handle('get-timer', () => ({ ...timer.state(), settings: timerSettings() }));
ipcMain.on('timer', (_event, action, minutes) => {
  const actions = {
    start: () => timer.startSimple(minutes), pomodoro: timer.startPomodoro,
    pause: timer.pause, resume: timer.resume, skip: timer.skip, stop: timer.stop,
  };
  actions[action]?.();
});
ipcMain.handle('spotify-status', () => spotifyStatus());
ipcMain.handle('spotify-connect', (_event, clientId) => connectSpotify(clientId));
ipcMain.handle('spotify-disconnect', () => {
  spotify.disconnect();
  return spotifyStatus();
});
ipcMain.handle('spotify-lookup', (_event, title) => spotify.lookup(String(title)).catch((error) => ({ error: error.message })));
ipcMain.handle('spotify-like', (_event, uri, liked) => spotify.setLiked(String(uri), Boolean(liked))
  .then(() => null, (error) => error.message));
ipcMain.handle('get-installed-apps', () => getInstalledApps());
ipcMain.handle('launch-app', (_event, name) => launchApp(name));
ipcMain.handle('get-search-entries', () => getSearchEntries());
ipcMain.handle('open-entry', (_event, entry) => openEntry(entry));
ipcMain.handle('get-app-icon', (_event, entry) => getAppIcon(entry));
ipcMain.on('update-grid', (_event, patch) => updateGrid(patch));
ipcMain.on('update-window', (_event, patch) => updateSection('window', patch));
ipcMain.on('preview-opacity', (_event, value) => widgets.previewOpacity(value));
ipcMain.on('hover', (event, isHovered) => widgets.setHovered(windowOf(event), Boolean(isHovered)));
ipcMain.on('pin-app', (_event, entry) => pinApp(entry));
ipcMain.on('app-menu', (event, name) => showAppMenu(name, windowOf(event)));
ipcMain.on('media-command', (_event, command) => bridge?.send(`media ${command}`));
ipcMain.on('audio-command', (_event, command) => bridge?.send(`audio ${command}`));
ipcMain.on('hide', () => win.hide());
ipcMain.on('resize', (event, height) => widgets.resize(windowOf(event), height));
ipcMain.on('resize-start', (event, side) => widgets.startResizeDrag(windowOf(event), side === 'left' ? 'left' : 'right'));
ipcMain.on('resize-move', () => widgets.moveResizeDrag());
ipcMain.on('resize-end', () => widgets.endResizeDrag());

// --- Démarrage -----------------------------------------------------------------------

// Sans accélération graphique, Diva consomme moins (mesuré : CPU 3,2 % -> 1,3 % en lecture,
// processus GPU 224 -> 112 Mo) pour un rendu identique : un widget n'a pas besoin du GPU.
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    config = loadConfig();
    spotify = createSpotify({ tokenFile: userFile('spotify.token'), getClientId: () => spotifySettings().clientId });
    allowSystemAudioCapture();
    // Les notifications Windows s'affichent au nom de l'app installée (raccourci du menu Démarrer).
    if (app.isPackaged) app.setAppUserModelId('com.bleathingman.diva');
    captures = createCaptures({ onChange: () => broadcast('captures', capturesPayload()) });
    timer = createTimer({
      getSettings: timerSettings,
      onChange: (state) => broadcast('timer', { ...state, settings: timerSettings() }),
      onFinish: timerFinished,
    });
    createWindow();
    captures.start();
    createTray();
    registerHotkey();
    watchConfig();
    bridge = createBridge({ script: BRIDGE_PATH, onMessage: broadcast, isQuitting: () => quitting });
    updatePace();
    refreshRecentApps();
    getInstalledApps(); // préchargées : la recherche répond tout de suite
    updates = createUpdates({
      onReady: (status) => {
        win.webContents.send('update', status);
        refreshTrayMenu();
      },
      beforeInstall: () => { quitting = true; },
    });
    updates.start();
    setInterval(() => {
      installedApps = null;
      refreshRecentApps();
      getInstalledApps();
    }, RECENT_REFRESH_MS);
  });

  app.on('before-quit', () => {
    quitting = true;
    bridge?.stop();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Le widget vit dans la barre des tâches : on ne quitte pas quand la fenêtre est cachée.
  app.on('window-all-closed', () => {});
}
