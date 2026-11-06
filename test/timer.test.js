// Minuteur en accéléré : 0,001 « minute » = 60 ms.
const assert = require('node:assert');
const { test } = require('node:test');
const { createTimer } = require('../src/timer');

const MINUTE = 0.001;
const settings = { work: 2 * MINUTE, shortBreak: MINUTE, longBreak: 1.5 * MINUTE, cyclesBeforeLong: 2 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTimer() {
  const finished = [];
  const timer = createTimer({ getSettings: () => settings, onChange: () => {}, onFinish: (title) => finished.push(title) });
  return { timer, finished };
}

test('minuteur simple : 1 minute au minimum, arrêt', () => {
  const { timer } = makeTimer();
  timer.startSimple(0.0001);
  assert.strictEqual(timer.state().duration, 60_000);
  timer.stop();
  assert.strictEqual(timer.state().status, 'idle');
});

test('pause puis reprise : le temps restant ne file pas', async () => {
  const { timer } = makeTimer();
  timer.startSimple(1);
  await sleep(50);
  timer.pause();
  const { remaining, status } = timer.state();
  assert.strictEqual(status, 'paused');
  assert.ok(remaining > 59_000 && remaining <= 60_000, `reste ${remaining}`);
  await sleep(80);
  assert.strictEqual(timer.state().remaining, remaining);
  timer.resume();
  assert.ok(Math.abs(timer.state().endsAt - Date.now() - remaining) < 20);
  timer.stop();
});

test('pomodoro : travail -> pause -> travail -> grande pause -> travail 1', async () => {
  const { timer, finished } = makeTimer();
  timer.startPomodoro();
  const phases = [`${timer.state().phase}${timer.state().cycle}`];
  for (let i = 0; i < 4; i++) {
    await sleep(timer.state().endsAt - Date.now() + 40);
    phases.push(`${timer.state().phase}${timer.state().cycle}`);
  }
  timer.stop();
  assert.deepStrictEqual(phases, ['work1', 'short1', 'work2', 'long2', 'work1']);
  assert.deepStrictEqual(finished, ['C\'est la pause', 'Au travail !', 'C\'est la pause', 'Au travail !']);
});

test('passer : phase suivante sans notification', () => {
  const { timer, finished } = makeTimer();
  timer.startPomodoro();
  timer.skip();
  assert.strictEqual(timer.state().phase, 'short');
  assert.strictEqual(finished.length, 0);
  timer.stop();
});

test('arrêt : plus aucune notification ensuite', async () => {
  const { timer, finished } = makeTimer();
  timer.startPomodoro();
  timer.stop();
  await sleep(200);
  assert.strictEqual(finished.length, 0);
});
