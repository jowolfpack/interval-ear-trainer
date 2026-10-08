import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickExercise, updateProgress, activeIntervals } from '../../src/trainer/progression.ts';
import { DEFAULT_SETTINGS, initialProgress, type Attempt } from '../../src/trainer/store.ts';

const att = (semis: number, correct: boolean, t: number): Attempt => ({
  t, s: 1, mode: 'piano', start: 60, semis, played: correct ? semis : semis + 1, correct,
  startShown: true, startOk: true, cents: 0, heard: [], adaptive: true,
});

test('initial adaptive set is M3, P5, P8 ascending', () => {
  assert.deepEqual(activeIntervals(DEFAULT_SETTINGS, initialProgress()).sort((a, b) => a - b), [4, 7, 12]);
});

test('unlocks the next interval after 20 attempts at ≥ 90 %', () => {
  const xs = Array.from({ length: 20 }, (_, i) => att([4, 7, 12][i % 3], i !== 3, i + 1));
  const { progress, events } = updateProgress(initialProgress(), xs);
  assert.equal(progress.up.length, 4);
  assert.ok(progress.up.includes(5));
  assert.equal(events.length, 1);
  // The next unlock needs 20 *new* attempts.
  const again = updateProgress(progress, xs);
  assert.equal(again.progress.up.length, 4);
});

test('no unlock at 85 %', () => {
  const xs = Array.from({ length: 20 }, (_, i) => att(7, i % 7 !== 0, i + 1));
  assert.equal(updateProgress(initialProgress(), xs).progress.up.length, 3);
});

test('exercise stays in range and uses active intervals', () => {
  let last = null;
  for (let i = 0; i < 500; i++) {
    const e = pickExercise(DEFAULT_SETTINGS, initialProgress(), [], last);
    assert.ok([4, 7, 12].includes(e.semis));
    assert.ok(e.start >= DEFAULT_SETTINGS.pianoLow && e.start <= DEFAULT_SETTINGS.pianoHigh);
    last = e;
  }
});

test('voice: both notes inside the voice range', () => {
  const s = { ...DEFAULT_SETTINGS, mode: 'voice' as const, progression: 'manual' as const, manualIntervals: [11, 12], manualDirection: 'both' as const };
  for (let i = 0; i < 300; i++) {
    const e = pickExercise(s, initialProgress(), [], null);
    assert.ok(e.start >= s.voiceLow && e.start + e.semis <= s.voiceHigh && e.start + e.semis >= s.voiceLow);
  }
});
