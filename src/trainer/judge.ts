// Decides whether what the mic heard matches the target interval.
// Shared by the trainer UI and the Node test harness, so the harness measures
// the exact decision the app makes.

import type { DetectedNote, Mode } from '../dsp/segmenter.ts';

export interface Target {
  /** MIDI number of the start key shown to the user. */
  start: number;
  /** Signed interval in semitones (+ ascending, − descending). */
  semis: number;
}

export interface JudgeOptions {
  mode: Mode;
  /** Whether the start key was shown (then it must be right too). */
  startShown: boolean;
  /** Estimated global tuning offset of the instrument in semitones (piano only). */
  tuningOffset?: number;
}

export interface Judgement {
  status: 'ok' | 'wrong' | 'incomplete';
  correct: boolean;
  /** Heard notes (fractional midi) — first two used. */
  heard: number[];
  /** Interval actually played, signed semitones (after octave folding). */
  played: number | null;
  /** Deviation of the played interval from equal-tempered `played`, in cents. */
  intervalCents: number | null;
  /** Deviation of the first note from the nearest semitone (after tuning offset), cents. */
  startCents: number | null;
  startOk: boolean | null;
  /** First note was the right pitch class but in another octave. */
  startOctaveShift: number;
  /** The raw interval was > an octave and got folded (likely octave error). */
  folded: boolean;
  intervalOk: boolean;
}

const mod12 = (x: number) => ((x % 12) + 12) % 12;

export function judge(target: Target, notes: DetectedNote[], o: JudgeOptions): Judgement {
  const usable = notes.filter((n) => !Number.isNaN(n.midi));
  const heard = usable.slice(0, 2).map((n) => n.midi);
  const base: Judgement = {
    status: 'incomplete', correct: false, heard, played: null, intervalCents: null,
    startCents: null, startOk: null, startOctaveShift: 0, folded: false, intervalOk: false,
  };
  if (heard.length === 0) return base;
  const tune = o.mode === 'piano' ? o.tuningOffset ?? 0 : 0;

  // Start note: compared by pitch class (octave-agnostic: voice sings in its own
  // octave; on piano this also absorbs any residual octave error).
  // A piano that is ~a quarter tone off is ambiguous (G+50 = G♯−50): near the
  // boundary also accept the other representative of the tuning offset.
  const tunings = Math.abs(tune) > 0.4 ? [tune, tune - Math.sign(tune)] : [tune];
  let best = Infinity, bestOct = 0, bestDpc = 0;
  for (const t of tunings) {
    const d = heard[0] - t - target.start;
    const oct = Math.round(d / 12);
    const dpc = d - 12 * oct;
    if (Math.abs(dpc) < best) { best = Math.abs(dpc); bestOct = oct; bestDpc = dpc; }
  }
  base.startCents = Math.round((bestDpc - Math.round(bestDpc)) * 100);
  base.startOk = best < 0.5;
  base.startOctaveShift = base.startOk ? bestOct : 0;
  if (heard.length < 2) return base;

  const raw = heard[1] - heard[0];
  let played = Math.round(raw);
  let folded = false;
  // The trainer only asks for intervals up to an octave. Anything bigger is an
  // octave slip (detector or player): fold it back by whole octaves.
  while (Math.abs(played) > 12) {
    played -= 12 * Math.sign(played);
    folded = true;
  }
  if (played === 0 && folded) played = 12 * Math.sign(target.semis);
  base.played = played;
  base.folded = folded;
  base.intervalCents = Math.round((raw - Math.round(raw)) * 100);
  base.intervalOk = played === target.semis;
  base.correct = base.intervalOk && (!o.startShown || base.startOk === true);
  base.status = base.correct ? 'ok' : 'wrong';
  return base;
}

/** Robust estimate of a piano's global tuning offset from recent notes (semitones, −0.5..0.5). */
export function estimateTuning(midis: number[]): number {
  if (midis.length === 0) return 0;
  // Circular mean of the fractional parts (handles values around ±0.5).
  let s = 0, c = 0;
  for (const m of midis) {
    const a = 2 * Math.PI * (m - Math.round(m));
    s += Math.sin(a); c += Math.cos(a);
  }
  return Math.atan2(s, c) / (2 * Math.PI);
}

export { mod12 };
