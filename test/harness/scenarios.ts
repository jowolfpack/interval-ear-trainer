// Scenario generation: piano singles/pairs and voice pairs under different
// acoustic conditions. Everything is seeded, so results are reproducible.
import { pianoNote, voicePhrase, iowaAvailable, VOWELS, type PianoSource, type Vowel } from './sources.ts';
import { addHum, addNoise, addReverb, highpass, mixInto, rng, rms } from './audio.ts';

export type Condition = 'clean' | 'phone' | 'noisy';
export const CONDITIONS: Condition[] = ['clean', 'phone', 'noisy'];

export function applyCondition(x: Float32Array, sr: number, cond: Condition, seed: number): Float32Array {
  if (cond === 'clean') return x;
  const r = rng(seed * 7919 + 13);
  if (cond === 'phone') {
    // Phone on the music stand: bass roll-off, small room, quiet background.
    let y = highpass(Float32Array.from(x), 150, sr);
    y = addReverb(y, sr, 0.5, 0.5, r);
    return addNoise(y, sr, 25, r);
  }
  // Bad case: thin mic, live room, noisy flat, mains hum.
  let y = highpass(Float32Array.from(x), 220, sr);
  y = addReverb(y, sr, 0.9, 0.8, r);
  y = addHum(y, sr, 50, -38, rms(y) * 3);
  return addNoise(y, sr, 12, r);
}

export interface PianoPair {
  kind: 'piano';
  seed: number;
  source: PianoSource;
  cond: Condition;
  start: number;
  interval: number;
  detune: number;
  articulation: 'legato' | 'staccato' | 'pedal';
  ioi: number;
  gain2: number;
  /** Overall level (linear), simulating mic distance / input gain. */
  level: number;
  sampleRate: number;
}

export interface VoicePair {
  kind: 'voice';
  seed: number;
  cond: Condition;
  start: number;
  interval: number;
  offsets: [number, number];
  scoop: [number, number];
  vibrato: number;
  vowel: Vowel;
  legato: boolean;
  level: number;
  sampleRate: number;
  range: 'low' | 'high';
}

export interface Rendered {
  audio: Float32Array;
  /** True notes: onset (s) and actual sounding pitch (fractional midi, incl. detune/offsets). */
  truth: { onset: number; midi: number }[];
}

export function pianoSources(): PianoSource[] {
  return iowaAvailable() ? ['iowa', 'salamander'] : ['salamander'];
}

export function makePianoPairs(count: number, seed0: number, sr = 48000): PianoPair[] {
  const out: PianoPair[] = [];
  const srcs = pianoSources();
  for (let i = 0; i < count; i++) {
    const r = rng(seed0 + i * 31);
    const start = 36 + Math.floor(r() * 49); // C2..C6
    let interval = (1 + Math.floor(r() * 12)) * (r() < 0.5 ? 1 : -1);
    if (start + interval < 33 || start + interval > 96) interval = -interval;
    const arts = ['legato', 'staccato', 'pedal'] as const;
    out.push({
      kind: 'piano', seed: seed0 + i, source: srcs[i % srcs.length], cond: CONDITIONS[Math.floor(i / srcs.length) % 3],
      start, interval,
      detune: Math.round((r() * 2 - 1) * 50),
      articulation: arts[Math.floor(r() * 3)],
      ioi: 0.35 + r() * 0.85,
      gain2: 0.5 + r(),
      level: Math.pow(10, -(r() * 30) / 20),
      sampleRate: sr,
    });
  }
  return out;
}

export function renderPianoPair(p: PianoPair): Rendered {
  const sr = p.sampleRate;
  const t1 = 0.4, t2 = t1 + p.ioi;
  const total = t2 + 1.6;
  const x = new Float32Array(Math.floor(total * sr));
  const rel1 = p.articulation === 'legato' ? p.ioi + 0.05 : p.articulation === 'staccato' ? Math.max(0.2, p.ioi - 0.15) : undefined;
  const n1 = pianoNote({ source: p.source, midi: p.start, sampleRate: sr, detuneCents: p.detune, releaseAt: rel1, length: total - t1 });
  const n2 = pianoNote({ source: p.source, midi: p.start + p.interval, sampleRate: sr, detuneCents: p.detune, releaseAt: 1.2, length: 1.6 });
  mixInto(x, n1, Math.floor(t1 * sr), 0.5 * p.level);
  mixInto(x, n2, Math.floor(t2 * sr), 0.5 * p.gain2 * p.level);
  return {
    audio: applyCondition(x, sr, p.cond, p.seed),
    truth: [
      { onset: t1, midi: p.start + p.detune / 100 },
      { onset: t2, midi: p.start + p.interval + p.detune / 100 },
    ],
  };
}

export function renderPianoSingle(source: PianoSource, midi: number, cond: Condition, detune: number, dyn: 'pp' | 'mf' | 'ff', sr = 48000): Rendered {
  const x = new Float32Array(Math.floor(2.2 * sr));
  mixInto(x, pianoNote({ source, midi, sampleRate: sr, detuneCents: detune, dyn, releaseAt: 1.4, length: 1.8 }), Math.floor(0.3 * sr), 0.5);
  return { audio: applyCondition(x, sr, cond, midi * 3 + detune), truth: [{ onset: 0.3, midi: midi + detune / 100 }] };
}

export function makeVoicePairs(count: number, seed0: number, sr = 48000): VoicePair[] {
  const out: VoicePair[] = [];
  const vowels = Object.keys(VOWELS) as Vowel[];
  for (let i = 0; i < count; i++) {
    const r = rng(seed0 + i * 17);
    const range = i % 2 === 0 ? 'low' : 'high';
    // Male-ish E2..E4 or female-ish A3..A5, both notes inside the range.
    const lo = range === 'low' ? 40 : 57, hi = range === 'low' ? 64 : 81;
    let interval = (1 + Math.floor(r() * 12)) * (r() < 0.5 ? 1 : -1);
    let start = lo + Math.floor(r() * (hi - lo + 1));
    if (start + interval < lo || start + interval > hi) { interval = -interval; }
    if (start + interval < lo || start + interval > hi) start = interval > 0 ? lo : hi;
    const scoopOf = () => (r() < 0.75 ? -(50 + r() * 200) : r() < 0.5 ? 40 + r() * 80 : 0);
    out.push({
      kind: 'voice', seed: seed0 + i, cond: CONDITIONS[Math.floor(i / 2) % 3], start, interval,
      offsets: [Math.round((r() * 2 - 1) * 20), Math.round((r() * 2 - 1) * 20)],
      scoop: [scoopOf(), scoopOf()],
      vibrato: r() < 0.3 ? 0 : 15 + r() * 45,
      vowel: vowels[Math.floor(r() * vowels.length)],
      legato: r() < 0.4,
      level: Math.pow(10, -(r() * 30) / 20),
      sampleRate: sr,
      range,
    });
  }
  return out;
}

export function renderVoicePair(v: VoicePair): Rendered {
  const r = rng(v.seed * 101 + 7);
  const { data, truth } = voicePhrase({
    sampleRate: v.sampleRate, seed: r, vowel: v.vowel, breath: 0.01 + r() * 0.04,
    notes: [
      { midi: v.start, duration: 0.8 + r() * 0.6, offsetCents: v.offsets[0], scoopCents: v.scoop[0], scoopTime: 0.1 + r() * 0.15, vibratoCents: v.vibrato, vibratoRate: 4.5 + r() * 2, gapAfter: v.legato ? 0 : 0.08 + r() * 0.3 },
      { midi: v.start + v.interval, duration: 0.8 + r() * 0.6, offsetCents: v.offsets[1], scoopCents: v.scoop[1], scoopTime: 0.1 + r() * 0.15, vibratoCents: v.vibrato, vibratoRate: 4.5 + r() * 2 },
    ],
  });
  for (let i = 0; i < data.length; i++) data[i] *= 0.15 * v.level;
  return { audio: applyCondition(data, v.sampleRate, v.cond, v.seed), truth: truth.map((t) => ({ onset: t.start, midi: t.midi })) };
}
