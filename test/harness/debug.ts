// Ad-hoc debugging: render one scenario and print frames + detected notes.
// Usage: npx tsx test/harness/debug.ts piano|voice <midi1> <midi2> [frames]
import { analyzeBuffer } from '../../src/dsp/pipeline.ts';
import { noteName } from '../../src/dsp/notes.ts';
import { pianoNote, voicePhrase } from './sources.ts';
import { mixInto, rng, highpass, addReverb, addNoise } from './audio.ts';

const SR = 48000;
const [mode = 'piano', a = '60', b = '67', showFrames = ''] = process.argv.slice(2);
const m1 = parseInt(a), m2 = parseInt(b);
let x: Float32Array;
if (mode === 'piano') {
  x = new Float32Array(SR * 3);
  mixInto(x, pianoNote({ source: 'iowa', midi: m1, sampleRate: SR, length: 2.5, releaseAt: 0.85 }), Math.floor(0.3 * SR), 0.8);
  mixInto(x, pianoNote({ source: 'iowa', midi: m2, sampleRate: SR, length: 1.8, releaseAt: 1.4 }), Math.floor(1.1 * SR), 0.8);
} else {
  x = voicePhrase({ sampleRate: SR, seed: rng(1), notes: [
    { midi: m1, duration: 1, scoopCents: -150, vibratoCents: 40, gapAfter: 0 },
    { midi: m2, duration: 1, scoopCents: -100, vibratoCents: 40 },
  ] }).data;
}
if (process.env.PHONE) {
  const r = rng(2);
  x = addNoise(addReverb(highpass(x, 150, SR), SR, 0.5, 0.5, r), SR, 25, r);
}
const { notes, frames } = analyzeBuffer(x, SR, mode as 'piano' | 'voice');
if (showFrames) for (const f of frames) {
  if (f.db < -80) continue;
  console.log(`${f.time.toFixed(3)} db=${f.db.toFixed(1)} midi=${f.midi.toFixed(2)} clar=${f.clarity.toFixed(2)} flux=${f.flux.toFixed(3)}${f.octaveFixed ? ' OCT' : ''}`);
}
for (const n of notes) console.log(`note ${noteName(n.midi)} ${n.midi.toFixed(2)} onset=${n.onset.toFixed(3)} end=${n.end?.toFixed(3)} conf=${n.confidence.toFixed(2)} used=${n.used} spread=${n.spread.toFixed(2)} cause=${n.cause}`);
