// Persistence: settings, adaptive progress and the attempt log live in
// localStorage; JSON export/import serves as a backup.
import type { Mode } from '../dsp/segmenter.ts';
import { isIOS } from '../audio/context.ts';

export interface Settings {
  mode: Mode;
  /** Start-note range for piano mode (MIDI). */
  pianoLow: number;
  pianoHigh: number;
  /** Comfortable singing range (MIDI); both notes of an exercise stay inside it. */
  voiceLow: number;
  voiceHigh: number;
  /** Preset the voice range came from; null = not chosen yet (the trainer asks). */
  voiceType: VoiceType | null;
  /** Play voice exercises an octave above the sung range. */
  voicePlayOctaveUp: boolean;
  showStartKey: boolean;
  /** Hands-free: replay after a miss, move on after a hit, no tapping. */
  handsFree: boolean;
  showIntervalName: boolean;
  progression: 'adaptive' | 'manual';
  manualIntervals: number[];
  manualDirection: 'up' | 'down' | 'both';
  /** Adaptive mode: include descending intervals even before they unlock. */
  forceDescending: boolean;
  volume: number;
  /** Stop the mic while the app plays (iOS may route audio to the earpiece while recording). */
  releaseMic: boolean;
}

export type VoiceType = 'bass' | 'baritone' | 'tenor' | 'alto' | 'mezzo' | 'soprano' | 'custom';

/**
 * Comfortable (not extreme) ranges for untrained singers, MIDI. About an octave
 * and a half each, so an octave exercise fits without reaching the edges often.
 */
export const VOICE_PRESETS: { type: Exclude<VoiceType, 'custom'>; label: string; low: number; high: number }[] = [
  { type: 'bass', label: 'Bass', low: 40, high: 60 }, // E2–C4
  { type: 'baritone', label: 'Baritone', low: 43, high: 62 }, // G2–D4
  { type: 'tenor', label: 'Tenor', low: 48, high: 67 }, // C3–G4
  { type: 'alto', label: 'Alto', low: 53, high: 72 }, // F3–C5
  { type: 'mezzo', label: 'Mezzo', low: 57, high: 76 }, // A3–E5
  { type: 'soprano', label: 'Soprano', low: 60, high: 79 }, // C4–G5
];

export interface Attempt {
  /** Unix ms. */
  t: number;
  /** Session id (one per app start). */
  s: number;
  mode: Mode;
  start: number;
  /** Target interval, signed semitones. */
  semis: number;
  /** Played interval (signed) or null if incomplete. */
  played: number | null;
  correct: boolean;
  startShown: boolean;
  startOk: boolean | null;
  /** Interval deviation (cents) from the nearest semitone. */
  cents: number | null;
  /** Heard notes (fractional MIDI, 2 decimals). */
  heard: number[];
  /** Exercise picked by the adaptive scheduler (counts toward unlocking). */
  adaptive: boolean;
}

export interface Progress {
  up: number[];
  down: number[];
  descUnlocked: boolean;
  /** Timestamps of the last unlock per direction: only later attempts count toward the next. */
  lastUnlockUp: number;
  lastUnlockDown: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'piano',
  pianoLow: 48, // C3
  pianoHigh: 72, // C5
  voiceLow: 43, // G2–D4 (baritone) until the user picks a voice type
  voiceHigh: 62,
  voiceType: null,
  voicePlayOctaveUp: false,
  showStartKey: true,
  handsFree: false,
  showIntervalName: false,
  progression: 'adaptive',
  manualIntervals: [4, 7, 12],
  manualDirection: 'up',
  forceDescending: false,
  volume: 0.9,
  releaseMic: false,
};

const K_SETTINGS = 'iet.settings.v1';
const K_PROGRESS = 'iet.progress.v1';
const K_ATTEMPTS = 'iet.attempts.v1';
const MAX_ATTEMPTS = 20000;

function read<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, v: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

export const INITIAL_INTERVALS = [4, 7, 12];

export function initialProgress(): Progress {
  return { up: [...INITIAL_INTERVALS], down: [], descUnlocked: false, lastUnlockUp: 0, lastUnlockDown: 0 };
}

class Store {
  settings: Settings;
  progress: Progress;
  attempts: Attempt[];
  readonly session = Date.now();
  /** False if localStorage refused a write (private mode, quota). */
  persistent = true;
  private listeners = new Set<() => void>();

  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, releaseMic: isIOS(), ...(read<Partial<Settings>>(K_SETTINGS) ?? {}) };
    this.progress = { ...initialProgress(), ...(read<Partial<Progress>>(K_PROGRESS) ?? {}) };
    this.attempts = read<Attempt[]>(K_ATTEMPTS) ?? [];
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(): void {
    this.listeners.forEach((f) => f());
  }

  saveSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.persistent = write(K_SETTINGS, this.settings) && this.persistent;
    this.emit();
  }

  saveProgress(p: Progress): void {
    this.progress = p;
    this.persistent = write(K_PROGRESS, p) && this.persistent;
    this.emit();
  }

  addAttempt(a: Attempt): void {
    this.attempts.push(a);
    if (this.attempts.length > MAX_ATTEMPTS) this.attempts.splice(0, this.attempts.length - MAX_ATTEMPTS);
    this.persistent = write(K_ATTEMPTS, this.attempts);
    this.emit();
  }

  exportJson(): string {
    return JSON.stringify({
      app: 'interval-ear-trainer',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: this.settings,
      progress: this.progress,
      attempts: this.attempts,
    }, null, 1);
  }

  /** Merge an export into the current data (attempts are de-duplicated by timestamp). */
  importJson(text: string): { added: number } {
    const d = JSON.parse(text);
    if (!d || d.app !== 'interval-ear-trainer' || !Array.isArray(d.attempts)) throw new Error('Not an Interval Ear Trainer backup file.');
    const seen = new Set(this.attempts.map((a) => a.t));
    const add = (d.attempts as Attempt[]).filter((a) => typeof a.t === 'number' && typeof a.semis === 'number' && !seen.has(a.t));
    this.attempts = [...this.attempts, ...add].sort((a, b) => a.t - b.t);
    write(K_ATTEMPTS, this.attempts);
    if (d.settings) this.saveSettings({ ...DEFAULT_SETTINGS, ...d.settings });
    if (d.progress) this.saveProgress({ ...initialProgress(), ...d.progress });
    this.emit();
    return { added: add.length };
  }

  resetAll(): void {
    this.attempts = [];
    write(K_ATTEMPTS, []);
    this.saveProgress(initialProgress());
  }
}

export const store = new Store();
