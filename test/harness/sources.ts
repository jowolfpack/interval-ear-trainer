// Test signal sources: real piano recordings (two independent sample sets)
// and a synthetic singing voice.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readWav, decodeToWav, resample, gaussian, ROOT, CACHE } from './audio.ts';
import { midiToFreq } from '../../src/dsp/notes.ts';

export type PianoSource = 'iowa' | 'salamander';

interface Recording { data: Float32Array; sampleRate: number; midi: number }
const cache = new Map<string, Recording>();

function trimOnset(rec: { data: Float32Array; sampleRate: number }): Float32Array {
  let peak = 0;
  for (let i = 0; i < rec.data.length; i++) peak = Math.max(peak, Math.abs(rec.data[i]));
  const thr = peak * 0.05;
  let i = 0;
  while (i < rec.data.length && Math.abs(rec.data[i]) < thr) i++;
  const start = Math.max(0, i - Math.floor(0.003 * rec.sampleRate));
  // Normalise every recording to the same peak; dynamics are applied as gain.
  const out = rec.data.slice(start);
  for (let k = 0; k < out.length; k++) out[k] *= 0.5 / peak;
  return out;
}

function loadIowa(midi: number, dyn: string): Recording | null {
  const key = `iowa_${dyn}_${midi}`;
  if (cache.has(key)) return cache.get(key)!;
  const p = join(CACHE, 'iowa', `${dyn}_${midi}.wav`);
  if (!existsSync(p)) return null;
  const w = readWav(p);
  const rec = { data: trimOnset(w), sampleRate: w.sampleRate, midi };
  cache.set(key, rec);
  return rec;
}

const SAL_NAMES: Record<number, string> = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };
function loadSalamander(midi: number): Recording {
  // Same rule as the app's player: nearest sample on the minor-third grid.
  let best = 0, bestD = Infinity;
  for (let m = 24; m <= 96; m++) {
    if (!(m % 12 in SAL_NAMES)) continue;
    const d = Math.abs(m - midi);
    if (d < bestD || (d === bestD && m > best)) { best = m; bestD = d; }
  }
  const name = SAL_NAMES[best % 12] + (Math.floor(best / 12) - 1);
  const key = `sal_${name}`;
  if (!cache.has(key)) {
    const w = decodeToWav(join(ROOT, 'public', 'samples', name + '.mp3'), 'sal_' + name);
    cache.set(key, { data: trimOnset(w), sampleRate: w.sampleRate, midi: best });
  }
  return cache.get(key)!;
}

export function iowaAvailable(): boolean {
  return existsSync(join(CACHE, 'iowa', 'mf_60.wav'));
}

export interface PianoNoteOpts {
  source: PianoSource;
  midi: number;
  sampleRate: number;
  /** Global detune of the "piano" in cents. */
  detuneCents?: number;
  dyn?: 'pp' | 'mf' | 'ff';
  /** Seconds after which the damper falls; undefined = let it ring (pedal). */
  releaseAt?: number;
  /** Total length in seconds. */
  length?: number;
}

export function pianoNote(o: PianoNoteOpts): Float32Array {
  let rec: Recording | null = null;
  if (o.source === 'iowa') {
    rec = loadIowa(o.midi, o.dyn ?? 'mf');
    if (!rec && o.dyn && o.dyn !== 'mf') rec = loadIowa(o.midi, 'mf');
    if (!rec) {
      // Fall back to the nearest available recording and shift it.
      for (let d = 1; d < 24 && !rec; d++) rec = loadIowa(o.midi - d, 'mf') ?? loadIowa(o.midi + d, 'mf');
    }
    if (!rec) throw new Error('no iowa fixtures — run npm run fetch-fixtures');
  } else {
    rec = loadSalamander(o.midi);
  }
  const ratio = midiToFreq(o.midi + (o.detuneCents ?? 0) / 100) / midiToFreq(rec.midi);
  const step = ratio * (rec.sampleRate / o.sampleRate);
  const length = Math.floor((o.length ?? 3) * o.sampleRate);
  const out = resample(rec.data, step, length);
  const full = new Float32Array(length);
  full.set(out);
  const dynGain = o.dyn === 'pp' ? 0.25 : o.dyn === 'ff' ? 1.4 : 1;
  if (dynGain !== 1) for (let i = 0; i < full.length; i++) full[i] *= dynGain;
  if (o.releaseAt !== undefined) {
    // Damper: fast exponential decay (bass dampers are slower).
    const tau = o.midi < 48 ? 0.12 : 0.06;
    const r0 = Math.floor(o.releaseAt * o.sampleRate);
    for (let i = r0; i < full.length; i++) full[i] *= Math.exp(-(i - r0) / o.sampleRate / tau);
  }
  return full;
}

// ---------------------------------------------------------------------------
// Synthetic voice

// Formant frequencies / bandwidths (Hz), Peterson & Barney-style averages.
export const VOWELS = {
  ah: [[700, 110], [1220, 120], [2600, 160]],
  oo: [[300, 70], [870, 90], [2240, 120]],
  ee: [[270, 70], [2290, 100], [3010, 160]],
  eh: [[530, 80], [1840, 100], [2480, 160]],
} as const;
export type Vowel = keyof typeof VOWELS;

export interface VoiceNote {
  midi: number;
  /** Seconds the note lasts (including scoop). */
  duration: number;
  /** Systematic offset of the singer from the intended pitch (cents). */
  offsetCents?: number;
  /** Onset scoop: start this many cents away and glide in. */
  scoopCents?: number;
  scoopTime?: number;
  vibratoCents?: number;
  vibratoRate?: number;
  /** Silence after this note before the next starts (s). 0 = legato glide. */
  gapAfter?: number;
}

export interface VoicePhraseOpts {
  sampleRate: number;
  notes: VoiceNote[];
  vowel?: Vowel;
  driftCents?: number;
  breath?: number;
  seed: () => number;
  leadIn?: number;
}

/**
 * Additive voice synth: glottal-ish source (harmonics rolling off ~-9 dB/oct)
 * shaped by three formants, with vibrato, scoop, slow drift, jitter and breath.
 * Returns the audio plus the ground-truth note intervals (start/end in s).
 */
export function voicePhrase(o: VoicePhraseOpts): { data: Float32Array; truth: { start: number; end: number; midi: number }[] } {
  const sr = o.sampleRate;
  const lead = o.leadIn ?? 0.3;
  const truth: { start: number; end: number; midi: number }[] = [];
  let t = lead;
  for (const n of o.notes) {
    truth.push({ start: t, end: t + n.duration, midi: n.midi + (n.offsetCents ?? 0) / 100 });
    t += n.duration + (n.gapAfter ?? 0.15);
  }
  const total = t + 0.4;
  const len = Math.floor(total * sr);
  const out = new Float32Array(len);
  const formants = VOWELS[o.vowel ?? 'ah'];
  const maxH = 80;
  const phase = new Float64Array(maxH + 1);
  const rand = o.seed;
  let drift = 0;
  let jitter = 0;
  const glide = 0.08;

  for (let i = 0; i < len; i++) {
    const time = i / sr;
    // Which note are we in (or gliding between)?
    let idx = -1;
    for (let k = 0; k < truth.length; k++) if (time >= truth[k].start && time < truth[k].end + (o.notes[k].gapAfter === 0 ? 0 : 0.0)) idx = k;
    let amp = 0;
    let midi = 0;
    if (idx >= 0) {
      const n = o.notes[idx];
      const tr = truth[idx];
      const local = time - tr.start;
      const legatoIn = idx > 0 && o.notes[idx - 1].gapAfter === 0;
      const legatoOut = n.gapAfter === 0 && idx < truth.length - 1;
      const att = legatoIn ? 1 : Math.min(1, local / 0.06);
      const rel = legatoOut ? 1 : Math.min(1, (tr.end - time) / 0.08);
      amp = Math.max(0, Math.min(att, rel));
      midi = tr.midi;
      const scoopT = n.scoopTime ?? 0.15;
      if (n.scoopCents) midi += (n.scoopCents / 100) * Math.exp(-local / (scoopT / 3));
      const vib = n.vibratoCents ?? 0;
      if (vib) midi += (vib / 100) * Math.min(1, Math.max(0, (local - 0.25) / 0.3)) * Math.sin(2 * Math.PI * (n.vibratoRate ?? 5.5) * local);
      if (legatoOut) {
        // Glide into the next note during the last `glide` seconds.
        const g = (time - (tr.end - glide)) / glide;
        if (g > 0) midi += (truth[idx + 1].midi - tr.midi) * (0.5 - 0.5 * Math.cos(Math.PI * g));
      }
    }
    if (i % 64 === 0) {
      drift += gaussian(rand) * 0.02;
      drift *= 0.995;
      jitter = gaussian(rand) * 0.04;
    }
    if (amp <= 0) { continue; }
    midi += ((o.driftCents ?? 8) / 100) * Math.tanh(drift) + jitter / 100;
    const f0 = midiToFreq(midi);
    let s = 0;
    for (let h = 1; h <= maxH; h++) {
      const f = h * f0;
      if (f > Math.min(5000, sr / 2 - 500)) break;
      phase[h] += (2 * Math.PI * f) / sr;
      if (phase[h] > 1e4) phase[h] -= 2 * Math.PI * Math.floor(phase[h] / (2 * Math.PI));
      // Cascade of 2nd-order resonators, each unity gain at DC (all-pole
      // vocal-tract model), times a source falling ~6 dB/octave.
      let env = 1;
      for (const [F, B] of formants) env *= (F * F) / Math.sqrt((F * F - f * f) ** 2 + (B * f) ** 2);
      s += (env / h) * Math.sin(phase[h]);
    }
    out[i] = amp * (s + (o.breath ?? 0.02) * gaussian(rand));
  }
  return { data: out, truth };
}
