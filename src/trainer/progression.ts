// Exercise selection and adaptive unlocking.
//
// Adaptive: start with three easy-to-tell intervals, unlock the next one when
// the last 20 attempts in that direction are ≥ 90 % correct, and weight
// practice toward intervals that were recently missed. Descending intervals
// unlock once ascending is solid (see DECISIONS.md).
import type { Attempt, Progress, Settings } from './store.ts';
import { INITIAL_INTERVALS } from './store.ts';
import { intervalName } from '../dsp/notes.ts';

/** Introduction order after the first three (P5, P8, M3). */
export const ORDER = [7, 12, 4, 5, 3, 9, 2, 8, 10, 1, 11, 6];
export const UNLOCK_WINDOW = 20;
export const UNLOCK_ACCURACY = 0.9;
/** Descending opens after this many ascending intervals … */
export const DESC_AFTER_UP = 6;
/** … and this accuracy over the last 30 ascending attempts. */
export const DESC_ACCURACY = 0.85;

export interface Exercise {
  start: number;
  semis: number;
  adaptive: boolean;
}

const dirOf = (semis: number) => (semis > 0 ? 'up' : 'down');

/** All (signed) intervals that may currently be asked. */
export function activeIntervals(s: Settings, p: Progress): number[] {
  if (s.progression === 'manual') {
    const set = s.manualIntervals.length ? s.manualIntervals : [7];
    const out: number[] = [];
    if (s.manualDirection !== 'down') out.push(...set);
    if (s.manualDirection !== 'up') out.push(...set.map((x) => -x));
    return out;
  }
  const out = [...p.up];
  if (p.descUnlocked) out.push(...p.down.map((x) => -x));
  else if (s.forceDescending) out.push(...p.up.map((x) => -x));
  return out;
}

/** Notes the exercise may use, given mode and range settings. */
export function exerciseRange(s: Settings): { startLo: number; startHi: number; noteLo: number; noteHi: number } {
  if (s.mode === 'voice') return { startLo: s.voiceLow, startHi: s.voiceHigh, noteLo: s.voiceLow, noteHi: s.voiceHigh };
  // Piano: the range limits the start key; the second note may leave it but
  // stays within what we can play and detect well (C2..C7).
  return { startLo: s.pianoLow, startHi: s.pianoHigh, noteLo: 36, noteHi: 96 };
}

function recentFor(attempts: Attempt[], semis: number, mode: string, n: number): Attempt[] {
  const out: Attempt[] = [];
  for (let i = attempts.length - 1; i >= 0 && out.length < n; i--) {
    const a = attempts[i];
    if (a.semis === semis && a.mode === mode) out.push(a);
  }
  return out;
}

export function pickExercise(s: Settings, p: Progress, attempts: Attempt[], last: Exercise | null, rand = Math.random): Exercise {
  const r = exerciseRange(s);
  let cands = activeIntervals(s, p).filter((semis) => {
    for (let st = r.startLo; st <= r.startHi; st++) if (st + semis >= r.noteLo && st + semis <= r.noteHi) return true;
    return false;
  });
  if (cands.length === 0) cands = [7];
  const weights = cands.map((semis) => {
    const rec = recentFor(attempts, semis, s.mode, 10);
    const err = rec.length ? rec.filter((a) => !a.correct).length / rec.length : 0;
    let w = 1 + 4 * err + (rec.length < 5 ? 1.5 : 0);
    if (last && last.semis === semis) w *= 0.35;
    return w;
  });
  let x = rand() * weights.reduce((a, b) => a + b, 0);
  let semis = cands[cands.length - 1];
  for (let i = 0; i < cands.length; i++) {
    x -= weights[i];
    if (x <= 0) { semis = cands[i]; break; }
  }
  const starts: number[] = [];
  for (let st = r.startLo; st <= r.startHi; st++) {
    if (st + semis >= r.noteLo && st + semis <= r.noteHi && !(last && last.start === st)) starts.push(st);
  }
  const start = starts.length ? starts[Math.floor(rand() * starts.length)] : Math.max(r.startLo, Math.min(r.startHi, 60));
  return { start, semis, adaptive: s.progression === 'adaptive' };
}

/** Apply unlock rules after an attempt. Returns human-readable events. */
export function updateProgress(p: Progress, attempts: Attempt[]): { progress: Progress; events: string[] } {
  const next: Progress = { ...p, up: [...p.up], down: [...p.down] };
  const events: string[] = [];
  const adaptive = attempts.filter((a) => a.adaptive);
  const inDir = (dir: 'up' | 'down', since: number) => adaptive.filter((a) => dirOf(a.semis) === dir && a.t > since);

  for (const dir of ['up', 'down'] as const) {
    if (dir === 'down' && !next.descUnlocked) continue;
    const set = next[dir];
    if (set.length >= ORDER.length) continue;
    const since = dir === 'up' ? next.lastUnlockUp : next.lastUnlockDown;
    const rec = inDir(dir, since).slice(-UNLOCK_WINDOW);
    if (rec.length < UNLOCK_WINDOW) continue;
    const acc = rec.filter((a) => a.correct).length / rec.length;
    if (acc >= UNLOCK_ACCURACY) {
      const add = ORDER.find((x) => !set.includes(x));
      if (add !== undefined) {
        set.push(add);
        const now = rec[rec.length - 1].t;
        if (dir === 'up') next.lastUnlockUp = now; else next.lastUnlockDown = now;
        events.push(`New interval unlocked: ${intervalName(add)} ${dir === 'up' ? '↑' : '↓'}`);
      }
    }
  }

  if (!next.descUnlocked && next.up.length >= DESC_AFTER_UP) {
    const rec = adaptive.filter((a) => a.semis > 0).slice(-30);
    if (rec.length >= 30 && rec.filter((a) => a.correct).length / rec.length >= DESC_ACCURACY) {
      next.descUnlocked = true;
      next.down = [...INITIAL_INTERVALS];
      next.lastUnlockDown = rec[rec.length - 1].t;
      events.push('Descending intervals unlocked: major 3rd ↓, perfect 5th ↓, octave ↓');
    }
  }
  return { progress: next, events };
}
