import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteName, parseNote, intervalName, freqToMidi } from '../../src/dsp/notes.ts';

test('note names', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C♯4');
  assert.equal(parseNote('Bb2'), 46);
  assert.equal(intervalName(7), 'perfect 5th');
  assert.equal(intervalName(-12), 'octave');
  assert.ok(Math.abs(freqToMidi(440) - 69) < 1e-9);
});
