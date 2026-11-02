// Minuteur simple et Pomodoro. L'état vit ici (processus principal) : il continue de
// tourner quand le widget est caché, et l'interface ne fait que l'afficher.

const PHASE_LABELS = { work: 'Travail', short: 'Pause', long: 'Grande pause' };

function createTimer({ getSettings, onChange, onFinish }) {
  // status : idle | running | paused ; mode : simple | pomodoro
  let state = { status: 'idle' };
  let timeout = null;

  const publish = () => onChange({ ...state });

  function run(next) {
    clearTimeout(timeout);
    state = { ...next, status: 'running', endsAt: Date.now() + next.duration };
    timeout = setTimeout(finish, next.duration);
    publish();
  }

  function startSimple(minutes) {
    const duration = Math.round(Math.min(600, Math.max(1, Number(minutes) || 0)) * 60_000);
    run({ mode: 'simple', duration, label: `Minuteur · ${Math.round(duration / 60_000)} min` });
  }

  function startPhase(phase, cycle) {
    const settings = getSettings();
    const minutes = { work: settings.work, short: settings.shortBreak, long: settings.longBreak }[phase];
    const label = phase === 'work'
      ? `${PHASE_LABELS.work} · ${cycle}/${settings.cyclesBeforeLong}`
      : PHASE_LABELS[phase];
    run({ mode: 'pomodoro', phase, cycle, duration: minutes * 60_000, label });
  }

  // Après le travail : pause (grande pause tous les N cycles) ; après une pause : travail.
  function nextPhase() {
    const { cyclesBeforeLong } = getSettings();
    if (state.phase === 'work') return state.cycle % cyclesBeforeLong === 0 ? ['long', state.cycle] : ['short', state.cycle];
    return ['work', state.phase === 'long' ? 1 : state.cycle + 1];
  }

  function finish() {
    if (state.mode === 'simple') {
      onFinish('Minuteur terminé', `${Math.round(state.duration / 60_000)} min écoulées`);
      clearTimeout(timeout);
      state = { status: 'idle' };
      publish();
      return;
    }
    const [phase, cycle] = nextPhase();
    const settings = getSettings();
    onFinish(
      phase === 'work' ? 'Au travail !' : 'C\'est la pause',
      phase === 'work' ? `${settings.work} min de concentration` : `${phase === 'long' ? settings.longBreak : settings.shortBreak} min pour souffler`,
    );
    startPhase(phase, cycle);
  }

  function pause() {
    if (state.status !== 'running') return;
    clearTimeout(timeout);
    state = { ...state, status: 'paused', remaining: Math.max(0, state.endsAt - Date.now()) };
    publish();
  }

  function resume() {
    if (state.status !== 'paused') return;
    state = { ...state, status: 'running', endsAt: Date.now() + state.remaining };
    timeout = setTimeout(finish, state.remaining);
    publish();
  }

  // Pomodoro : passer directement à la phase suivante, sans notification.
  function skip() {
    if (state.mode !== 'pomodoro') return;
    const [phase, cycle] = nextPhase();
    startPhase(phase, cycle);
  }

  function stop() {
    clearTimeout(timeout);
    state = { status: 'idle' };
    publish();
  }

  return {
    startSimple,
    startPomodoro: () => startPhase('work', 1),
    pause,
    resume,
    skip,
    stop,
    state: () => ({ ...state }),
  };
}

module.exports = { createTimer };
