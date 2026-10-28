const { app, BrowserWindow, Tray, Menu, dialog, globalShortcut, ipcMain, net, shell, screen, nativeImage } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const WIDTH = 300;
const SNAP_DISTANCE = 32;
const SNAP_GAP = 8;
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-config.json');
// Dans l'app installée, le code est dans l'archive app.asar que PowerShell ne sait pas lire :
// les scripts sont copiés à côté, dans app.asar.unpacked (voir "asarUnpack" dans package.json).
const HELPERS_DIR = path.join(__dirname, '..', 'helpers').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const MEDIA_HELPER_PATH = path.join(HELPERS_DIR, 'media.ps1');
const AUDIO_HELPER_PATH = path.join(HELPERS_DIR, 'audio.ps1');
const RECENT_APPS_PATH = path.join(HELPERS_DIR, 'recent-apps.ps1');
const INSTALLED_APPS_PATH = path.join(HELPERS_DIR, 'installed-apps.ps1');
const RECENT_REFRESH_MS = 10 * 60 * 1000;

let win = null;
let tray = null;
let config = null;
let mediaHelper = null;
let audioHelper = null;
let recentApps = [];
let recentRefreshedAt = 0;
let installedApps = null; // promesse gardée en cache, la liste change rarement
let installedList = [];
let lastSavedConfig = '';
let quitting = false;
let hovered = false;
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
  applyWindowSettings();
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

const expandEnv = (value) => value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);

// "spotify:" ou "https://..." sont des liens ; "C:\..." est un chemin (lettre de lecteur).
const isUri = (value) => /^[a-z][a-z0-9+.-]+:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);

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

// Même règle que recent-apps.ps1 : "Visual Studio Code" et "visual-studio code" sont la même app.
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

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

// Pour un raccourci .lnk, Windows renverrait l'icône générique « fichier + flèche » :
// on prend l'icône déclarée par le raccourci, ou à défaut celle de sa cible.
function resolveIconSource(file) {
  if (!file.toLowerCase().endsWith('.lnk')) return file;
  try {
    const link = shell.readShortcutLink(file);
    // Les outils Windows déclarent souvent "%SystemRoot%\...\x.dll" : variable à remplacer,
    // et une .dll ne donne pas la bonne icône (il faudrait son index) : on prend alors la cible.
    const icon = link.icon && expandEnv(link.icon);
    if (icon && !/\.dll$/i.test(icon) && fs.existsSync(icon)) return icon;
    return link.target ? expandEnv(link.target) : file;
  } catch {
    return file;
  }
}

// Reçoit l'app telle que l'interface l'affiche ({ open, iconFile }) : ça marche aussi
// pour les apps installées pas encore épinglées.
async function getAppIcon({ open, iconFile } = {}) {
  if (typeof iconFile === 'string' && iconFile) {
    const image = nativeImage.createFromPath(iconFile);
    return image.isEmpty() ? null : image.toDataURL();
  }
  if (typeof open !== 'string' || isUri(expandEnv(open))) return null;
  try {
    const source = resolveIconSource(expandEnv(open));
    // Un .ico se charge tel quel ; getFileIcon donnerait l'icône du type de fichier.
    const icon = source.toLowerCase().endsWith('.ico')
      ? nativeImage.createFromPath(source).resize({ width: 64, height: 64 })
      : await app.getFileIcon(source, { size: 'large' });
    return icon.isEmpty() ? null : icon.toDataURL();
  } catch {
    return null;
  }
}

// --- Grille d'apps : épinglées puis récentes --------------------------------------

const SECTION_KEYS = {
  grid: ['count', 'fillWithRecent', 'recentDays', 'pinned', 'hidden'],
  window: ['alwaysOnTop', 'hideOnBlur', 'snapToEdges', 'idleOpacity'],
};

function gridSettings() {
  return { count: 8, fillWithRecent: true, recentDays: 30, pinned: [], hidden: [], ...config?.grid };
}

function windowSettings() {
  // alwaysOnTop était à la racine de la config avant le panneau Réglages : on le reprend.
  return {
    alwaysOnTop: config?.alwaysOnTop ?? true, hideOnBlur: false, snapToEdges: true, idleOpacity: 100,
    ...config?.window,
  };
}

function updateSection(section, patch) {
  const keys = SECTION_KEYS[section];
  if (!keys) return;
  const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => keys.includes(key)));
  const current = section === 'grid' ? gridSettings() : windowSettings();
  config = { ...config, [section]: { ...current, ...allowed } };
  saveConfig();
  if (section === 'window') applyWindowSettings();
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

function sendGrid() {
  win?.webContents.send('grid', buildGrid());
  win?.webContents.send('window-settings', windowSettings());
}

// Compare une app (objet ou simple nom) à un nom, avec la même règle que normalize().
const sameApp = (name) => (entry) => normalize(entry.name ?? entry) === normalize(name);

function pinApp({ name, open, iconFile }) {
  const { pinned } = gridSettings();
  if (!name || !open || pinned.some(sameApp(name))) return;
  updateGrid({ pinned: [...pinned, iconFile ? { name, open, iconFile } : { name, open }] });
}

// --- Liens favoris : un site ou un dossier épinglé comme une app ---

const isPathLike = (value) => /^([a-z]:[\\/]|\\\\|%)/i.test(value);

function defaultLinkName(open) {
  if (isPathLike(open)) return path.basename(expandEnv(open).replace(/[\\/]+$/, '')) || open;
  try {
    return new URL(open).hostname.replace(/^www\./, '') || open;
  } catch {
    return open;
  }
}

// Renvoie un message d'erreur, ou null si le lien est épinglé.
function addLink({ name, target } = {}) {
  // Sans caractères de contrôle ni guillemets (ceux du « Copier en tant que chemin » de Windows).
  let open = String(target ?? '').replace(/[\u0000-\u001f]/g, '').trim().replace(/^"(.*)"$/, '$1');
  if (!open) return 'Indique une adresse ou un dossier';
  if (isPathLike(open)) {
    if (!fs.existsSync(expandEnv(open))) return 'Dossier ou fichier introuvable';
  } else {
    // "youtube.com" tout court : on suppose un site web. Un protocole fait au moins 2 lettres
    // ("C:" est un lecteur, pas un protocole).
    if (!/^[a-z][a-z0-9+.-]+:/i.test(open)) open = `https://${open}`;
    try {
      new URL(open);
    } catch {
      return 'Adresse invalide';
    }
  }
  const label = String(name ?? '').trim() || defaultLinkName(open);
  if (gridSettings().pinned.some(sameApp(label))) return `« ${label} » est déjà épinglé`;
  pinApp({ name: label, open });
  if (/^https?:/i.test(open)) {
    fetchFavicon(open).then((iconFile) => {
      if (!iconFile) return;
      const { pinned } = gridSettings();
      updateGrid({ pinned: pinned.map((entry) => (sameApp(label)(entry) ? { ...entry, iconFile } : entry)) });
    });
  }
  return null;
}

// Icône d'un site : d'abord celles déclarées dans la page (apple-touch-icon, la plus nette),
// puis /favicon.ico. Enregistrée en PNG dans %APPDATA%\Diva\icons.
async function fetchFavicon(pageUrl) {
  const { origin } = new URL(pageUrl);
  const candidates = [];
  try {
    const html = await (await net.fetch(pageUrl)).text();
    for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
      const rel = /\brel=["']?([^"'>]+)/i.exec(tag)?.[1].toLowerCase() ?? '';
      const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1];
      if (!href || !rel.includes('icon') || /\.svg(\?|$)/i.test(href)) continue;
      candidates.push({ url: new URL(href, pageUrl).href, rank: rel.includes('apple-touch') ? 0 : 1 });
    }
  } catch {
    // Page inaccessible : on tente quand même /favicon.ico.
  }
  candidates.sort((a, b) => a.rank - b.rank);
  candidates.push({ url: `${origin}/favicon.ico` });

  const folder = userFile('icons');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${crypto.createHash('md5').update(origin).digest('hex').slice(0, 12)}.png`);
  for (const { url } of candidates) {
    try {
      const response = await net.fetch(url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      let image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) {
        // Les .ico ne se lisent que depuis un fichier.
        const ico = `${file}.ico`;
        fs.writeFileSync(ico, buffer);
        image = nativeImage.createFromPath(ico);
        fs.rmSync(ico, { force: true });
      }
      if (image.isEmpty()) continue;
      if (image.getSize().width > 64) image = image.resize({ width: 64, height: 64, quality: 'best' });
      fs.writeFileSync(file, image.toPNG());
      return file;
    } catch {
      // Candidat suivant.
    }
  }
  return null;
}

async function pickFolder() {
  blurGuard = true;
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return canceled ? null : filePaths[0];
  } finally {
    blurGuard = false;
  }
}

function unpinApp(name) {
  updateGrid({ pinned: gridSettings().pinned.filter((entry) => !sameApp(name)(entry)) });
}

function hideApp(name) {
  const { hidden } = gridSettings();
  if (!hidden.some(sameApp(name))) updateGrid({ hidden: [...hidden, name] });
}

function showAppMenu(name) {
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
  ]).popup({ window: win, callback: () => { blurGuard = false; } });
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

// --- Modules permanents : média (helpers/media.ps1) et volume (helpers/audio.ps1) ----

// Lance un script PowerShell qui tourne en continu : chaque ligne JSON qu'il écrit part vers
// l'interface sur `channel`, et send() lui transmet une commande. Relancé s'il s'arrête.
function startHelper(script, channel) {
  const helper = {
    process: null,
    send: (command) => helper.process?.stdin.write(`${String(command).replace(/[\r\n]/g, ' ')}\n`),
  };
  const start = () => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true });
    helper.process = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        win?.webContents.send(channel, JSON.parse(line));
      } catch {
        // Ligne parasite (avertissement PowerShell...) : on l'ignore.
      }
    });
    child.stderr.on('data', (data) => console.error(`[${channel}]`, data.toString()));
    child.on('exit', () => {
      helper.process = null;
      if (!quitting) setTimeout(start, 2000);
    });
  };
  start();
  return helper;
}

// --- Fenêtre, barre des tâches, raccourci --------------------------------------------

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - WIDTH - SNAP_GAP, y: workArea.y + SNAP_GAP };
}

function createWindow() {
  const saved = readJson(userFile('state.json'), {});
  const visibleOnScreen = saved.x !== undefined &&
    screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x >= a.x && saved.x < a.x + a.width && saved.y >= a.y && saved.y < a.y + a.height);
  const { x, y } = visibleOnScreen ? saved : defaultPosition();

  win = new BrowserWindow({
    x, y,
    width: WIDTH,
    height: 400,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: windowSettings().alwaysOnTop,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    applyWindowSettings();
    win.show();
  });

  win.on('moved', () => {
    if (windowSettings().snapToEdges) snapToEdges();
    const [newX, newY] = win.getPosition();
    fs.writeFileSync(userFile('state.json'), JSON.stringify({ x: newX, y: newY }));
  });

  win.on('blur', () => {
    if (blurGuard || !windowSettings().hideOnBlur) return;
    win.hide();
    hiddenByBlurAt = Date.now();
  });
}

function applyWindowSettings() {
  if (!win) return;
  const settings = windowSettings();
  win.setAlwaysOnTop(settings.alwaysOnTop);
  // Opacité réglée au repos, pleine quand la souris est dessus.
  const opacity = Math.min(100, Math.max(30, Number(settings.idleOpacity) || 100));
  win.setOpacity(hovered ? 1 : opacity / 100);
  win.webContents.send('window-settings', settings);
}

// Lâché à moins de SNAP_DISTANCE d'un bord de l'écran : le widget s'y colle, à SNAP_GAP du bord.
function snapToEdges() {
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  let { x, y } = bounds;
  const left = area.x + SNAP_GAP;
  const top = area.y + SNAP_GAP;
  const right = area.x + area.width - bounds.width - SNAP_GAP;
  const bottom = area.y + area.height - bounds.height - SNAP_GAP;
  if (Math.abs(x - left) < SNAP_DISTANCE) x = left;
  else if (Math.abs(x - right) < SNAP_DISTANCE) x = right;
  if (Math.abs(y - top) < SNAP_DISTANCE) y = top;
  else if (Math.abs(y - bottom) < SNAP_DISTANCE) y = bottom;
  if (x !== bounds.x || y !== bounds.y) win.setPosition(x, y);
}

// Change la hauteur sans sortir de l'écran ; collé en bas, le widget grandit vers le haut.
function resizeWindow(height) {
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const newHeight = Math.min(Math.ceil(height), area.height);
  const areaBottom = area.y + area.height;
  const stuckToBottom = Math.abs(bounds.y + bounds.height - (areaBottom - SNAP_GAP)) <= 1;
  let y = stuckToBottom ? areaBottom - SNAP_GAP - newHeight : bounds.y;
  y = Math.max(area.y, Math.min(y, areaBottom - newHeight));
  win.setBounds({ x: bounds.x, y, width: WIDTH, height: newHeight });
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
  const refreshMenu = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher / masquer', click: toggleWindow },
    { label: 'Modifier la config', click: () => shell.openPath(userFile('config.json')) },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings(LOGIN_ITEM).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: item.checked });
        refreshMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
  refreshMenu();
}

// --- Communication avec l'interface --------------------------------------------------

ipcMain.handle('get-grid', () => buildGrid());
ipcMain.handle('get-window-settings', () => windowSettings());
ipcMain.handle('add-link', (_event, link) => addLink(link));
ipcMain.handle('pick-folder', () => pickFolder());
ipcMain.handle('get-installed-apps', () => getInstalledApps());
ipcMain.handle('launch-app', (_event, name) => launchApp(name));
ipcMain.handle('get-search-entries', () => getSearchEntries());
ipcMain.handle('open-entry', (_event, entry) => openEntry(entry));
ipcMain.handle('get-app-icon', (_event, entry) => getAppIcon(entry));
ipcMain.on('update-grid', (_event, patch) => updateGrid(patch));
ipcMain.on('update-window', (_event, patch) => updateSection('window', patch));
ipcMain.on('preview-opacity', (_event, value) => {
  win.setOpacity(Math.min(100, Math.max(30, Number(value) || 100)) / 100);
});
ipcMain.on('hover', (_event, isHovered) => {
  hovered = Boolean(isHovered);
  applyWindowSettings();
});
ipcMain.on('pin-app', (_event, entry) => pinApp(entry));
ipcMain.on('app-menu', (_event, name) => showAppMenu(name));
ipcMain.on('media-command', (_event, command) => mediaHelper?.send(command));
ipcMain.on('audio-command', (_event, command) => audioHelper?.send(command));
ipcMain.on('hide', () => win.hide());
ipcMain.on('resize', (_event, height) => resizeWindow(height));

// --- Démarrage -----------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    config = loadConfig();
    createWindow();
    createTray();
    registerHotkey();
    watchConfig();
    mediaHelper = startHelper(MEDIA_HELPER_PATH, 'media');
    audioHelper = startHelper(AUDIO_HELPER_PATH, 'audio');
    refreshRecentApps();
    getInstalledApps(); // préchargées : la recherche répond tout de suite
    setInterval(() => {
      installedApps = null;
      refreshRecentApps();
      getInstalledApps();
    }, RECENT_REFRESH_MS);
  });

  app.on('before-quit', () => {
    quitting = true;
    mediaHelper?.process?.stdin.end();
    audioHelper?.process?.stdin.end();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Le widget vit dans la barre des tâches : on ne quitte pas quand la fenêtre est cachée.
  app.on('window-all-closed', () => {});
}
