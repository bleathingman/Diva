// Pont permanent avec Windows : helpers/bridge.ps1, qui fait tourner les modules média et volume
// dans un seul processus PowerShell. Relancé s'il s'arrête.
const { spawn } = require('child_process');
const readline = require('readline');

// onMessage(channel, message) reçoit chaque ligne JSON écrite par le script (channel : media | audio).
// isQuitting() : vrai quand Diva se ferme, pour ne pas relancer le script.
function createBridge({ script, onMessage, isQuitting }) {
  let child = null;
  let pace = 'fast';
  // Le script n'écrit que les changements : on garde le dernier message de chaque type pour
  // le donner aux fenêtres ouvertes après coup (widget détaché, rechargement).
  const lastMessages = new Map(); // "canal:type" -> { channel, message }

  const send = (command) => child?.stdin.write(`${String(command).replace(/[\r\n]/g, ' ')}\n`);

  const start = () => {
    child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true });
    send(`pace ${pace}`); // un pont relancé repart au rythme rapide : on lui redonne le bon
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return; // ligne parasite (avertissement PowerShell...)
      }
      const { channel } = message;
      lastMessages.set(`${channel}:${message.type}`, { channel, message });
      onMessage(channel, message);
    });
    child.stderr.on('data', (data) => console.error('[bridge]', data.toString()));
    child.on('exit', () => {
      child = null;
      if (!isQuitting()) setTimeout(start, 2000);
    });
  };
  start();

  return {
    send,
    // Aucun widget visible : le script espace ses relevés (2 s au lieu de 0,4 s).
    setVisible(visible) {
      pace = visible ? 'fast' : 'slow';
      send(`pace ${pace}`);
    },
    lastMessages: () => [...lastMessages.values()],
    stop: () => child?.stdin.end(),
  };
}

module.exports = { createBridge };
