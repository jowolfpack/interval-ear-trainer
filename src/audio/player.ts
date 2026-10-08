// Piano sample playback (Salamander Grand Piano V3, CC-BY 3.0, Alexander Holm).
// One sample every minor third (C, D♯, F♯, A); other notes are pitch-shifted
// by at most ±1.5 semitones via playbackRate.
import { ensureAudio } from './context.ts';

const NAMES: Record<number, string> = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };
const LOW = 24; // C1
const HIGH = 96; // C7

const buffers = new Map<string, Promise<AudioBuffer>>();

function sampleFor(midi: number): { name: string; midi: number } {
  let best = LOW, bestD = Infinity;
  for (let m = LOW; m <= HIGH; m++) {
    if (!((m % 12) in NAMES)) continue;
    const d = Math.abs(m - midi);
    if (d < bestD || (d === bestD && m > best)) { best = m; bestD = d; }
  }
  return { name: NAMES[best % 12] + (Math.floor(best / 12) - 1), midi: best };
}

async function load(ctx: AudioContext, name: string): Promise<AudioBuffer> {
  let p = buffers.get(name);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}samples/${name}.mp3`)
      .then((r) => {
        if (!r.ok) throw new Error(`sample ${name}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(b, res, rej)));
    p.catch(() => buffers.delete(name));
    buffers.set(name, p);
  }
  return p;
}

export async function preload(midis: number[]): Promise<void> {
  const ctx = await ensureAudio();
  await Promise.all(midis.map((m) => load(ctx, sampleFor(m).name)));
}

interface Voice { src: AudioBufferSourceNode; gain: GainNode }
let active: Voice[] = [];
let master: GainNode | null = null;

function out(ctx: AudioContext): GainNode {
  if (!master) {
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  return master;
}

export function setVolume(v: number): void {
  if (master) master.gain.value = v;
}

/** Schedule one note. Returns when it is scheduled (not when it ends). */
async function note(ctx: AudioContext, midi: number, at: number, dur: number, fade: number): Promise<void> {
  const s = sampleFor(midi);
  const buf = await load(ctx, s.name);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.pow(2, (midi - s.midi) / 12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(1, at);
  g.gain.setValueAtTime(1, at + dur);
  g.gain.linearRampToValueAtTime(0, at + dur + fade);
  src.connect(g).connect(out(ctx));
  src.start(at);
  src.stop(at + dur + fade + 0.05);
  const v = { src, gain: g };
  active.push(v);
  src.onended = () => { active = active.filter((x) => x !== v); };
}

/** Timing of a played interval (the harness simulates the same schedule). */
export const SCHEDULE = { first: 0.9, second: 1.2, fade: 0.15 };

/**
 * Play two notes one after the other. Resolves when the sound (including the
 * fade-out) has finished.
 */
export async function playInterval(a: number, b: number): Promise<void> {
  const ctx = await ensureAudio();
  stopAll();
  // Make sure both buffers are decoded before scheduling, so timing is exact.
  await Promise.all([load(ctx, sampleFor(a).name), load(ctx, sampleFor(b).name)]);
  const t0 = ctx.currentTime + 0.05;
  await note(ctx, a, t0, SCHEDULE.first, 0.08);
  await note(ctx, b, t0 + SCHEDULE.first, SCHEDULE.second, SCHEDULE.fade);
  const endAt = t0 + SCHEDULE.first + SCHEDULE.second + SCHEDULE.fade;
  await waitUntil(ctx, endAt);
}

export async function playNote(m: number, dur = 1.2): Promise<void> {
  const ctx = await ensureAudio();
  await load(ctx, sampleFor(m).name);
  const t0 = ctx.currentTime + 0.03;
  await note(ctx, m, t0, dur, SCHEDULE.fade);
  await waitUntil(ctx, t0 + dur + SCHEDULE.fade);
}

export function stopAll(): void {
  const now = master ? master.context.currentTime : 0;
  for (const v of active) {
    try {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0, now + 0.03);
      v.src.stop(now + 0.05);
    } catch { /* already stopped */ }
  }
  active = [];
}

function waitUntil(ctx: AudioContext, t: number): Promise<void> {
  return new Promise((res) => {
    const check = () => {
      const left = t - ctx.currentTime;
      if (left <= 0.005) res();
      else setTimeout(check, Math.min(100, left * 1000));
    };
    check();
  });
}

export const PLAYABLE = { low: LOW, high: HIGH };
