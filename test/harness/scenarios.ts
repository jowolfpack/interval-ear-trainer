// Scenario generation: piano singles/pairs and voice pairs under different
// acoustic conditions. Everything is seeded, so results are reproducible.
import { pianoNote, voicePhrase, iowaAvailable, VOWELS, type PianoSource, type Vowel } from './sources.ts';
import { addHum, addNoise, addReverb, highpass, mixInto, rng, rms, gaussian, onePoleLowpass } from './audio.ts';

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
    // Same note range as the app (src/trainer/progression.ts: C2..C7).
    if (start + interval < 36 || start + interval > 96) interval = -interval;
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

// ---------------------------------------------------------------------------
// Robustness scenarios

/** Background-only recordings: nothing is played, nothing should be detected. */
export function renderNoiseOnly(kind: 'room' | 'noisy-room' | 'knocks' | 'hum50' | 'hum60', seed: number, sr = 48000): Float32Array {
  const r = rng(seed);
  const len = Math.floor(6 * sr);
  const x = new Float32Array(len);
  if (kind === 'knocks') {
    // Knocks / page turns / bench creaks: short decaying noise bursts, some loud.
    for (let t = 0.3; t < 5.8; t += 0.4 + r() * 0.8) {
      const amp = 0.02 + r() * 0.3;
      const start = Math.floor(t * sr);
      const dur = Math.floor((0.01 + r() * 0.05) * sr);
      for (let i = 0; i < dur && start + i < len; i++) x[start + i] += amp * gaussian(r) * Math.exp(-i / (0.3 * dur));
    }
    const y = addReverb(x, sr, 0.5, 0.5, r);
    // Quiet background so the gate has a floor.
    for (let i = 0; i < len; i++) y[i] += 0.0003 * gaussian(r);
    return y;
  }
  if (kind === 'hum50' || kind === 'hum60') {
    for (let i = 0; i < len; i++) x[i] = 0.0005 * gaussian(r);
    return addHum(x, sr, kind === 'hum50' ? 50 : 60, 0, 0.003);
  }
  for (let i = 0; i < len; i++) x[i] = 0.002 * gaussian(r);
  const y = onePoleLowpass(x, 1500, sr);
  if (kind === 'noisy-room') {
    // A TV / conversation-like modulated noise.
    for (let i = 0; i < len; i++) y[i] *= 3 * (1 + 0.8 * Math.sin((2 * Math.PI * 3 * i) / sr) * Math.sin((2 * Math.PI * 0.4 * i) / sr));
  }
  return y;
}

/**
 * Self-listening: the app plays the target through the phone speaker, fades
 * out, waits `gap` s, then listens while the user plays. Returns audio from
 * the moment listening starts.
 */
export function renderWithPlaybackTail(p: PianoPair, gap: number): Rendered {
  const sr = p.sampleRate;
  const r = rng(p.seed * 3 + 1);
  // App schedule (see src/audio/player.ts): note1 0.9 s, note2 1.2 s, 0.15 s fade.
  const playLen = 0.9 + 1.2;
  const fade = 0.15;
  const listenAt = playLen + fade + gap;
  const userDelay = 0.4 + r() * 1.0;
  const total = listenAt + userDelay + p.ioi + 1.6;
  const spk = new Float32Array(Math.floor(total * sr));
  const target2 = p.start + p.interval;
  const a = pianoNote({ source: 'salamander', midi: p.start, sampleRate: sr, length: playLen + fade });
  const b = pianoNote({ source: 'salamander', midi: target2, sampleRate: sr, length: 1.2 + fade });
  mixInto(spk, a, 0, 0.6);
  mixInto(spk, b, Math.floor(0.9 * sr), 0.6);
  const fadeStart = Math.floor(playLen * sr), fadeEnd = Math.floor((playLen + fade) * sr);
  for (let i = fadeStart; i < spk.length; i++) spk[i] *= i >= fadeEnd ? 0 : 1 - (i - fadeStart) / (fadeEnd - fadeStart);
  // Phone speaker: no bass. Loud: the speaker is right next to the mic.
  highpass(spk, 350, sr);
  // The user's playing in the phone condition (its noise is relative to the
  // user's level); the speaker gets the same room, at 0.3–1× the user's peak.
  const user = renderPianoPair({ ...p, cond: 'phone' });
  let up = 0, sp = 0;
  for (const v of user.audio) up = Math.max(up, Math.abs(v));
  const room = addReverb(spk, sr, 0.5, 0.5, r);
  for (const v of room) sp = Math.max(sp, Math.abs(v));
  const g = (up / (sp || 1)) * (0.3 + 0.7 * r());
  const out = new Float32Array(spk.length);
  for (let i = 0; i < out.length; i++) out[i] = g * room[i];
  const off = Math.floor((listenAt + userDelay - 0.4) * sr); // renderPianoPair has a 0.4 s lead-in
  mixInto(out, user.audio, off, 1);
  // Background noise must also be present before the user starts: continue
  // it at the level of the user recording's (note-free) lead-in.
  const nl = rms(user.audio, 0, Math.floor(0.3 * sr));
  for (let i = 0; i < off && i < out.length; i++) out[i] += nl * gaussian(r);
  const from = Math.floor(listenAt * sr);
  return {
    audio: out.subarray(from),
    truth: user.truth.map((t) => ({ onset: t.onset - 0.4 + userDelay, midi: t.midi })),
  };
}
