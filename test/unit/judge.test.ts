import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, estimateTuning } from '../../src/trainer/judge.ts';
import type { DetectedNote } from '../../src/dsp/segmenter.ts';

const n = (midi: number) => ({ midi } as DetectedNote);

test('correct ascending fifth with start key shown', () => {
  const j = judge({ start: 55, semis: 7 }, [n(55.04), n(62.02)], { mode: 'piano', startShown: true });
  assert.equal(j.correct, true);
  assert.equal(j.played, 7);
});

test('wrong start key fails only when shown', () => {
  const notes = [n(57), n(64)];
  assert.equal(judge({ start: 55, semis: 7 }, notes, { mode: 'piano', startShown: true }).correct, false);
  assert.equal(judge({ start: 55, semis: 7 }, notes, { mode: 'piano', startShown: false }).correct, true);
});

test('direction matters: a descending fourth is not an ascending fifth', () => {
  const j = judge({ start: 55, semis: 7 }, [n(55), n(50)], { mode: 'piano', startShown: true });
  assert.equal(j.correct, false);
  assert.equal(j.played, -5);
});

test('intervals beyond an octave are folded (octave slip)', () => {
  const j = judge({ start: 48, semis: 7 }, [n(48), n(67)], { mode: 'piano', startShown: true });
  assert.equal(j.played, 7);
  assert.equal(j.folded, true);
  assert.equal(j.correct, true);
});

test('voice: start note octave does not matter, cents reported', () => {
  const j = judge({ start: 55, semis: 4 }, [n(43.1), n(47.25)], { mode: 'voice', startShown: true });
  assert.equal(j.correct, true);
  assert.equal(j.intervalCents, 15);
});

test('piano detuned by +48 cents: start key still accepted with tuning estimate', () => {
  const heard = [55.48, 59.49];
  const t = estimateTuning(heard);
  const j = judge({ start: 55, semis: 4 }, heard.map(n), { mode: 'piano', startShown: true, tuningOffset: t });
  assert.equal(j.correct, true);
});

test('only one note → incomplete', () => {
  const j = judge({ start: 55, semis: 4 }, [n(55)], { mode: 'piano', startShown: true });
  assert.equal(j.status, 'incomplete');
});

test('tuning estimate handles wrap-around at ±50 cents', () => {
  const t = estimateTuning([60.49, 64.51, 67.5]);
  assert.ok(Math.abs(Math.abs(t) - 0.5) < 0.02);
});
