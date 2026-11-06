// Mises à jour automatiques : l'app installée regarde la dernière release de
// github.com/bleathingman/Diva ; si elle est plus récente, elle la télécharge en arrière-plan
// puis l'installe au prochain redémarrage de Diva.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// onReady(status) : une version est téléchargée. beforeInstall() : juste avant de quitter pour installer.
function createUpdates({ onReady, beforeInstall }) {
  let ready = null; // version téléchargée, installée au prochain redémarrage

  const status = () => ({ version: app.getVersion(), ready });

  // Renvoie un message pour les réglages.
  async function check() {
    if (!app.isPackaged) return 'Pas de mise à jour en mode développement';
    if (ready) return `Version ${ready} prête`;
    try {
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      return latest && latest !== app.getVersion() ? `Téléchargement de la ${latest}…` : 'Diva est à jour';
    } catch (error) {
      if (/No published versions/i.test(error.message)) return 'Aucune version publiée sur GitHub pour l\'instant';
      return `Vérification impossible : ${error.message}`;
    }
  }

  function start() {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', ({ version }) => {
      ready = version;
      onReady(status());
    });
    autoUpdater.on('error', (error) => console.error('[mises à jour]', error.message));
    check();
    setInterval(check, CHECK_EVERY_MS);
  }

  function install() {
    if (!ready) return;
    beforeInstall();
    autoUpdater.quitAndInstall(true, true); // installation silencieuse, puis Diva se relance
  }

  return { start, check, status, install, ready: () => ready };
}

module.exports = { createUpdates };
