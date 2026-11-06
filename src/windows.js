// Les widgets : le principal, et un widget par section détachée (index.html?section=...).
// Taille commune (zoom), aimantation aux bords, positions retenues, opacité au repos.
const { BrowserWindow, nativeTheme, screen } = require('electron');
const fs = require('fs');

const WIDTH = 300; // largeur à l'échelle 1 ; l'interface est toujours dessinée sur cette base
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.6;
const SNAP_DISTANCE = 32;
const SNAP_GAP = 8;

const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale) || 1));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isOnScreen(position) {
  return position?.x !== undefined && screen.getAllDisplays().some(({ workArea: a }) =>
    position.x >= a.x && position.x < a.x + a.width && position.y >= a.y && position.y < a.y + a.height);
}

// options :
//   stateFile        state.json : { x, y } du principal, { detached: { section: { x, y } } }
//   page, preload, icon
//   getSettings()    réglages de la fenêtre (thème, opacité, échelle...)
//   getDetached()    sections détachées voulues
//   onLoaded(win)    une page vient de (re)charger : lui renvoyer l'état courant
//   onVisibility()   un widget vient d'apparaître ou de disparaître
//   onScaleChosen(s) l'utilisateur a fini de tirer une poignée : enregistrer l'échelle
function createWidgets({ stateFile, page, preload, icon, getSettings, getDetached, onLoaded, onVisibility, onScaleChosen }) {
  let main = null;
  const detached = new Map(); // section -> fenêtre
  let currentScale = clampScale(getSettings().scale);
  let resizeDrag = null;

  const all = () => [main, ...detached.values()].filter((window) => window && !window.isDestroyed());
  const width = () => Math.round(WIDTH * currentScale);

  function broadcast(channel, payload) {
    for (const window of all()) window.webContents.send(channel, payload);
  }

  function savePosition(window) {
    const state = readJson(stateFile, {});
    const [x, y] = window.getPosition();
    if (window === main) Object.assign(state, { x, y });
    else state.detached = { ...state.detached, [window.diva.section]: { x, y } };
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }

  function create(section, { x, y }) {
    const window = new BrowserWindow({
      x, y,
      width: width(),
      height: 200,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: getSettings().alwaysOnTop,
      show: false,
      icon,
      webPreferences: { preload, contextIsolation: true, sandbox: true, zoomFactor: currentScale },
    });
    // Propre à chaque fenêtre : souris dessus (opacité) et hauteur demandée par l'interface.
    window.diva = { section, hovered: false, contentHeight: 200 };
    window.loadFile(page, section ? { query: { section } } : {});
    window.webContents.on('did-finish-load', () => onLoaded(window));
    window.once('ready-to-show', () => {
      applySettings();
      if (section) window.showInactive();
      else window.show();
    });
    // Chromium ne signale pas toujours à la page qu'Electron l'a cachée : on la prévient.
    for (const [event, visible] of [['show', true], ['hide', false]]) {
      window.on(event, () => {
        onVisibility();
        window.webContents.send('visibility', visible);
      });
    }
    window.on('moved', () => {
      if (getSettings().snapToEdges) snapToEdges(window);
      savePosition(window);
    });
    return window;
  }

  function defaultPosition() {
    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + workArea.width - WIDTH - SNAP_GAP, y: workArea.y + SNAP_GAP };
  }

  // Premier détachement : juste à gauche du widget principal (ou à droite s'il n'y a pas la place).
  function besideMain() {
    const bounds = main.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const x = bounds.x - width() - SNAP_GAP >= area.x ? bounds.x - width() - SNAP_GAP : bounds.x + bounds.width + SNAP_GAP;
    return { x, y: bounds.y + detached.size * 40 };
  }

  function createMain() {
    const saved = readJson(stateFile, {});
    main = create(null, isOnScreen(saved) ? saved : defaultPosition());
    sync();
    return main;
  }

  // Ouvre ou ferme les widgets détachés pour coller à la disposition.
  function sync() {
    const wanted = getDetached();
    for (const [section, window] of detached) {
      if (wanted.includes(section)) continue;
      window.destroy();
      detached.delete(section);
      onVisibility();
    }
    const saved = readJson(stateFile, {}).detached ?? {};
    for (const section of wanted) {
      if (detached.has(section)) continue;
      detached.set(section, create(section, isOnScreen(saved[section]) ? saved[section] : besideMain()));
    }
  }

  function applySettings() {
    if (!main) return;
    const settings = getSettings();
    // « system » suit le mode clair/sombre de Windows ; le CSS lit prefers-color-scheme.
    nativeTheme.themeSource = ['dark', 'light', 'system'].includes(settings.theme) ? settings.theme : 'dark';
    // Opacité réglée au repos, pleine quand la souris est dessus.
    const opacity = Math.min(100, Math.max(30, Number(settings.idleOpacity) || 100));
    const scale = clampScale(settings.scale);
    const rescale = Math.abs(scale - currentScale) > 0.001;
    if (rescale) currentScale = scale;
    for (const window of all()) {
      window.setAlwaysOnTop(settings.alwaysOnTop);
      window.setOpacity(window.diva.hovered ? 1 : opacity / 100);
      if (rescale) applyScale(window, stuckToRight(window));
    }
    broadcast('window-settings', settings);
  }

  function setHovered(window, hovered) {
    if (!window?.diva) return;
    window.diva.hovered = hovered;
    applySettings();
  }

  // Aperçu de l'opacité pendant qu'on tire le curseur des réglages (la souris est dessus).
  function previewOpacity(value) {
    for (const window of all()) window.setOpacity(Math.min(100, Math.max(30, Number(value) || 100)) / 100);
  }

  // --- Taille : tout le widget est mis à l'échelle (zoom), la mise en page ne change pas ---

  function stuckToRight(window) {
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    return Math.abs(bounds.x + bounds.width - (area.x + area.width - SNAP_GAP)) <= 1;
  }

  // Applique currentScale à une fenêtre. anchorRight : son bord droit reste en place
  // (poignée de gauche, ou widget collé à droite de l'écran).
  function applyScale(window, anchorRight = false) {
    const bounds = window.getBounds();
    window.webContents.setZoomFactor(currentScale);
    const x = anchorRight ? bounds.x + bounds.width - width() : bounds.x;
    window.setBounds({ x, y: bounds.y, width: width(), height: bounds.height });
    // La mise en page ne change pas de taille, l'interface ne redemandera pas de hauteur.
    resize(window, window.diva.contentHeight);
  }

  // L'échelle est commune à tous les widgets ; celui qu'on tire garde le côté opposé fixe.
  function setScale(scale, dragged = null) {
    currentScale = scale;
    for (const window of all()) {
      applyScale(window, window === dragged?.window ? dragged.side === 'left' : stuckToRight(window));
    }
  }

  // Poignées des coins du bas : la largeur suit la souris, l'échelle suit la largeur.
  function startResizeDrag(window, side) {
    if (!window) return;
    resizeDrag = { window, side, cursorX: screen.getCursorScreenPoint().x, width: window.getBounds().width };
  }

  function moveResizeDrag() {
    if (!resizeDrag) return;
    const delta = screen.getCursorScreenPoint().x - resizeDrag.cursorX;
    const scale = clampScale((resizeDrag.width + (resizeDrag.side === 'left' ? -delta : delta)) / WIDTH);
    if (Math.abs(scale - currentScale) > 0.002) setScale(scale, resizeDrag);
  }

  function endResizeDrag() {
    if (!resizeDrag) return;
    const scale = Math.round(currentScale * 100) / 100;
    setScale(scale, resizeDrag);
    resizeDrag = null;
    onScaleChosen(scale);
  }

  // Lâché à moins de SNAP_DISTANCE d'un bord de l'écran : le widget s'y colle, à SNAP_GAP du bord.
  function snapToEdges(window) {
    const bounds = window.getBounds();
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
    if (x !== bounds.x || y !== bounds.y) window.setPosition(x, y);
  }

  // Change la hauteur sans sortir de l'écran ; collé en bas, le widget grandit vers le haut.
  // `height` est en pixels d'interface : on applique l'échelle.
  function resize(window, height) {
    if (!window?.diva) return;
    window.diva.contentHeight = height;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const newHeight = Math.min(Math.ceil(height * currentScale), area.height);
    const areaBottom = area.y + area.height;
    const stuckToBottom = Math.abs(bounds.y + bounds.height - (areaBottom - SNAP_GAP)) <= 1;
    let y = stuckToBottom ? areaBottom - SNAP_GAP - newHeight : bounds.y;
    y = Math.max(area.y, Math.min(y, areaBottom - newHeight));
    window.setBounds({ x: bounds.x, y, width: width(), height: newHeight });
  }

  return {
    createMain,
    sync,
    all,
    broadcast,
    applySettings,
    setHovered,
    previewOpacity,
    resize,
    startResizeDrag,
    moveResizeDrag,
    endResizeDrag,
  };
}

module.exports = { createWidgets };
