// Streaming note segmentation: groups analysis frames into notes.
//
// A new note starts on any of three cues:
//   1. energy: the signal rises out of silence (gate opens)
//   2. flux:   a spectral-flux peak with an energy rise while a note is still
//              ringing (piano re-strike; the previous note need not decay)
//   3. pitch:  a sustained, consistent pitch change (legato singing, or a soft
//              piano note under a loud ringing one)
// Each note's pitch is estimated from its *stable* part only: for piano we
// skip the hammer attack, for voice we additionally reject scoops/glides.

import { PROFILE_HARMONICS, type Frame } from './analyzer.ts';
import { midiToFreq } from './notes.ts';

export type Mode = 'piano' | 'voice';

export interface DetectedNote {
  id: number;
  /** Onset time (s). */
  onset: number;
  /** End time (s) — when the note stopped or the next began; null while sounding. */
  end: number | null;
  /** Fractional MIDI pitch of the stable part; NaN while unknown. */
  midi: number;
  /** 0..1 combined agreement × clarity. */
  confidence: number;
  /** Time range the pitch estimate was taken from. */
  stableStart: number;
  stableEnd: number;
  /** Number of frames used for the estimate. */
  used: number;
  /** Spread (std dev, semitones) of the used frames — vibrato/instability. */
  spread: number;
  cause: 'energy' | 'flux' | 'pitch' | 'voiced';
  final: boolean;
}

export interface SegmenterOptions {
  mode: Mode;
  /** Seconds per analysis frame hop. */
  hopSec: number;
  /** Seconds covered by one pitch frame (used to skip contaminated frames after an onset). */
  frameSec: number;
}

interface NoteState {
  note: DetectedNote;
  frames: Frame[];
  peakDb: number;
}

const median = (a: number[]): number => {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
};

export class NoteSegmenter {
  readonly opts: SegmenterOptions;
  /** All notes so far (finalized ones plus the currently sounding one). */
  readonly notes: DetectedNote[] = [];
  floorDb = NaN;

  private cur: NoteState | null = null;
  private prevState: NoteState | null = null;
  private nextId = 1;
  private hist: Frame[] = [];
  private quietFrames = 0;
  private lastOnsetTime = -1;
  private pitchRun: Frame[] = [];
  private lastEndTime = -1;

  // Tunables (see DECISIONS.md / TEST_RESULTS.md for how they were chosen).
  gateOnDb = 10;
  gateOffDb = 7;
  minDb = -72;
  fluxRatio = 2.0;
  fluxMin = 0.2;
  fluxRiseDb = 2.0;

  constructor(opts: SegmenterOptions) {
    this.opts = opts;
  }

  get current(): DetectedNote | null {
    return this.cur?.note ?? null;
  }

  reset(): void {
    this.notes.length = 0;
    this.cur = null;
    this.prevState = null;
    this.hist = [];
    this.quietFrames = 0;
    this.pitchRun = [];
    this.lastOnsetTime = -1;
    this.floorDb = NaN;
  }

  /**
   * Process one frame. Frames are handled with a one-frame delay so flux
   * peaks can be confirmed as local maxima. Returns notes that were finalized.
   */
  push(f: Frame): DetectedNote[] {
    const done: DetectedNote[] = [];
    this.hist.push(f);
    if (this.hist.length > 64) this.hist.shift();
    const h = this.hist;
    if (h.length < 3) { this.updateFloor(f); return done; }
    // Evaluate the previous frame (we now know its successor).
    const fr = h[h.length - 2];
    const next = h[h.length - 1];
    const prev = h[h.length - 3];
    const sounding = this.cur !== null;

    if (!sounding) this.updateFloor(fr);
    const floor = this.floorDb;
    const onThr = Math.max(floor + this.gateOnDb, this.minDb);

    if (!sounding) {
      if (fr.db > onThr && next.db > onThr - 3) {
        this.startNote(fr, 'energy', done);
        return done;
      }
      // In noise the level gate may never open; a run of clearly periodic
      // frames with a consistent pitch is a note too (noise is aperiodic).
      // Look at the last 8 frames: ≥ 6 periodic ones agreeing on a pitch.
      const win = h.slice(Math.max(0, h.length - 9), h.length - 1);
      const voiced = win.filter((x) => x.clarity >= 0.7 && x.db > floor + 3 && x.time > this.lastEndTime);
      if (voiced.length >= 6) {
        const m = median(voiced.map((x) => x.midi));
        const agree = voiced.filter((x) => Math.abs(x.midi - m) < 0.8);
        // …and the level actually rose (a steady hum/drone is not a note).
        const before = h.slice(0, Math.max(0, h.length - 9)).map((x) => x.db);
        const rose = before.length < 8 || Math.max(...agree.map((x) => x.db)) - Math.min(...before) > 6;
        if (agree.length >= 6 && rose) this.startNote(fr, 'voiced', done, agree);
      }
      return done;
    }

    const st = this.cur!;
    st.peakDb = Math.max(st.peakDb, fr.db);
    const offThr = Math.max(floor + this.gateOffDb, st.peakDb - 50, this.minDb - 6);
    // Still clearly periodic at the note's pitch → not over, even if the level
    // has sunk into the noise floor.
    const voicedHere = fr.clarity >= 0.75 && !Number.isNaN(st.note.midi) && Math.abs(fr.midi - st.note.midi) < 1.5;
    if (fr.db < offThr && !voicedHere) {
      this.quietFrames++;
      if (this.quietFrames * this.opts.hopSec >= 0.09) {
        this.endNote(fr.time - this.quietFrames * this.opts.hopSec, done);
        return done;
      }
    } else {
      this.quietFrames = 0;
    }

    // --- flux / level-jump onset (piano only: voice vibrato/consonants make flux noisy)
    if (this.opts.mode === 'piano' && fr.time - this.lastOnsetTime > 0.09) {
      // Baseline from frames inside the current note only (silence before the
      // note has ~zero flux and would make every wiggle look like an onset).
      const past = h.slice(Math.max(0, h.length - 24), h.length - 3).filter((x) => x.time > st.note.onset + 0.03).map((x) => x.flux);
      const base = past.length >= 3 ? median(past) : 0;
      const isPeak = fr.flux >= prev.flux && fr.flux >= next.flux;
      const thr = Math.max(this.fluxMin, base * this.fluxRatio);
      const minBefore = Math.min(...h.slice(Math.max(0, h.length - 6), h.length - 2).map((x) => x.db));
      const rise = Math.max(fr.db, next.db) - minBefore;
      // A sudden level jump is an onset even when noise makes the flux unreliable.
      const jump = fr.db - prev.db;
      const fluxHit = isPeak && fr.flux > thr && rise > this.fluxRiseDb;
      if ((fluxHit || (rise > 4 && jump > 3)) && fr.db > onThr - 6) {
        this.startNote(fr, 'flux', done);
        return done;
      }
    }

    // --- pitch-change onset
    st.frames.push(fr);
    this.checkPitchChange(fr, done);
    if (this.cur) this.estimate(this.cur, false);
    return done;
  }

  /** Finish the current note (e.g. when listening stops). */
  flush(): DetectedNote[] {
    const done: DetectedNote[] = [];
    if (this.cur) {
      const last = this.hist[this.hist.length - 1];
      if (last && this.cur.frames[this.cur.frames.length - 1] !== last) this.cur.frames.push(last);
      this.endNote(last ? last.time : this.cur.note.onset, done);
    }
    return done;
  }

  private updateFloor(f: Frame): void {
    if (Number.isNaN(this.floorDb)) { this.floorDb = f.db; return; }
    if (f.db < this.floorDb) this.floorDb = 0.7 * this.floorDb + 0.3 * f.db;
    else this.floorDb += Math.min(0.05, f.db - this.floorDb);
  }

  private startNote(f: Frame, cause: DetectedNote['cause'], done: DetectedNote[], frames: Frame[] = []): void {
    // Onset time ≈ middle of the newest hop of the triggering frame.
    const onset = frames.length ? frames[0].time - this.opts.frameSec / 2 : f.time - this.opts.hopSec;
    if (this.cur) this.endNote(onset, done);
    const note: DetectedNote = {
      id: this.nextId++, onset, end: null, midi: NaN, confidence: 0,
      stableStart: NaN, stableEnd: NaN, used: 0, spread: 0, cause, final: false,
    };
    this.cur = { note, frames: [...frames], peakDb: f.db };
    if (!frames.includes(f)) this.cur.frames.push(f);
    this.notes.push(note);
    this.quietFrames = 0;
    this.pitchRun = [];
    this.lastOnsetTime = onset;
  }

  private endNote(time: number, done: DetectedNote[]): void {
    const st = this.cur!;
    st.note.end = Math.max(st.note.onset, time);
    this.lastEndTime = st.note.end;
    this.estimate(st, true);
    st.note.final = true;
    this.cur = null;
    this.pitchRun = [];
    if (Number.isNaN(st.note.midi)) {
      // Unpitched blip (knock, click): drop it.
      this.notes.splice(this.notes.indexOf(st.note), 1);
    } else {
      this.prevState = st;
      done.push(st.note);
    }
  }

  private checkPitchChange(fr: Frame, done: DetectedNote[]): void {
    const st = this.cur!;
    const note = st.note;
    const voice = this.opts.mode === 'voice';
    if (Number.isNaN(note.midi) || note.used < (voice ? 6 : 4)) { this.pitchRun = []; return; }
    const minClar = voice ? 0.7 : 0.8;
    const dev = fr.midi - note.midi;
    if (fr.clarity < minClar || Math.abs(dev) < (voice ? 0.6 : 0.6)) {
      // Tolerate single dropouts inside a run.
      if (this.pitchRun.length && fr.clarity >= minClar) this.pitchRun = [];
      return;
    }
    if (this.pitchRun.length && Math.abs(fr.midi - this.pitchRun[0].midi) > (voice ? 0.9 : 0.5)) this.pitchRun = [];
    this.pitchRun.push(fr);
    const need = Math.ceil((voice ? 0.12 : 0.07) / this.opts.hopSec);
    if (this.pitchRun.length < need) return;
    const runMed = median(this.pitchRun.map((x) => x.midi));
    const d = runMed - note.midi;
    if (Math.abs(d) < 0.6) return;
    if (!voice) {
      // On a piano a real new note always comes with an attack; a bare pitch
      // jump by an octave is an octave error of the detector, not a note.
      const r = Math.abs(d) % 12;
      if (r < 0.4 || r > 11.6) { this.pitchRun = []; return; }
    }
    const run = this.pitchRun;
    // Remove the run's frames from the old note before re-estimating it.
    st.frames = st.frames.filter((x) => !run.includes(x));
    this.startNote(fr, 'pitch', done, run);
  }

  /** Estimate the stable pitch of a note from its frames. */
  private estimate(st: NoteState, final: boolean): void {
    const note = st.note;
    const voice = this.opts.mode === 'voice';
    const endT = final && note.end !== null ? note.end : Infinity;
    // Frames whose analysis window overlaps the attack (or the pre-onset
    // signal) are skipped. For piano, later frames carry less information and
    // more of the ringing neighbour, so we cap the window.
    const skip = note.cause === 'pitch' || note.cause === 'voiced' ? 0 : this.opts.frameSec + (voice ? 0.06 : 0.012);
    const t0 = note.onset + skip;
    const t1 = voice ? endT - 0.07 : Math.min(note.onset + 0.7, endT + 0.01);
    const inWin = st.frames.filter((x) => x.time >= t0 && x.time <= t1);
    const pick = (pts: Pt[]): Pt[] => {
      const strict = pts.filter((x) => x.clarity >= (voice ? 0.75 : 0.8));
      return strict.length >= 3 ? strict : pts.filter((x) => x.clarity >= 0.5);
    };
    const plain = pick(inWin.filter((x) => x.freq > 0).map((x) => ({ time: x.time, midi: x.midi, clarity: x.clarity })));
    let cand = plain;

    // Piano: the previous note may still be ringing (held key, pedal, legato
    // overlap). Then the plain detector hears a mixture. Prefer, in order:
    //  1. the comb-filtered estimate (previous note's harmonics cancelled),
    //  2. plain frames that differ from the previous note,
    //  3. the harmonic-profile test for an octave above the previous note
    //     (all its partials coincide with the old note's, so 1. and 2. fail),
    //  otherwise it's a re-strike of the same note.
    const prev = this.contiguousPrev(note);
    if (!voice && prev) {
      const supp = inWin
        .filter((x) => x.midiS > 0 && x.clarityS >= 0.8 && x.combDb > -12 && Math.abs(x.midiS - prev.note.midi) > 0.4)
        .map((x) => ({ time: x.time, midi: x.midiS, clarity: x.clarityS }));
      const plainOther = plain.filter((x) => Math.abs(x.midi - prev.note.midi) > 0.4);
      if (supp.length >= 3 && supp.length >= 0.3 * Math.max(1, plain.length)) cand = supp;
      else if (plainOther.length >= 3 && plainOther.length >= 0.25 * plain.length) cand = plainOther;
      else if (this.octaveUpEvidence(st, prev)) {
        note.midi = prev.note.midi + 12;
        note.used = 1;
        note.spread = 0;
        note.confidence = 0.5;
        note.stableStart = note.onset;
        note.stableEnd = note.onset + 0.25;
        return;
      }
    }

    if (cand.length === 0 && final) {
      // Very short note: fall back to any clearly pitched frame after the onset.
      cand = st.frames.filter((x) => x.freq > 0 && x.clarity >= 0.75 && x.time > note.onset).map((x) => ({ time: x.time, midi: x.midi, clarity: x.clarity }));
    }
    // A note needs a few clearly periodic frames; otherwise it was noise, a
    // knock or a click and must not be judged.
    if (cand.filter((x) => x.clarity >= 0.75).length < 3) {
      note.midi = NaN;
      note.used = 0;
      return;
    }

    // Semitone vote (so octave-error frames can't drag the median), weighted by clarity.
    const votes = new Map<number, number>();
    for (const x of cand) {
      const k = Math.round(x.midi);
      votes.set(k, (votes.get(k) ?? 0) + x.clarity);
    }
    let bestK = 0, bestV = -1, total = 0;
    for (const [k, v] of votes) { total += v; if (v > bestV) { bestV = v; bestK = k; } }
    // Neighbouring semitone bins belong to the same note when the true pitch is near a boundary (detuned piano, sharp singer).
    const near = (k: number) => (votes.get(k) ?? 0);
    const agree = bestV + Math.max(near(bestK - 1), near(bestK + 1));
    let center = median(cand.filter((x) => Math.abs(Math.round(x.midi) - bestK) <= 1).map((x) => x.midi));
    let used = cand.filter((x) => Math.abs(x.midi - center) < (voice ? 0.75 : 0.5));
    if (voice && used.length >= 3) {
      // Robust mean around the median: scoop and glide frames fall outside,
      // vibrato averages out.
      center = median(used.map((x) => x.midi));
      used = used.filter((x) => Math.abs(x.midi - center) < 0.6);
    }
    if (used.length === 0) used = cand;
    const vals = used.map((x) => x.midi);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const value = voice ? mean : median(vals);
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    const clar = used.reduce((a, b) => a + b.clarity, 0) / used.length;
    note.midi = value;
    note.used = used.length;
    note.spread = sd;
    note.confidence = Math.max(0, Math.min(1, (agree / total) * clar * Math.min(1, used.length / 5)));
    note.stableStart = used[0].time - this.opts.frameSec / 2;
    note.stableEnd = used[used.length - 1].time;
  }

  /** The previous note if it ended right at this note's onset (so it may still ring). */
  private contiguousPrev(note: DetectedNote): NoteState | null {
    const p = this.prevState;
    if (!p || p.note === note || Number.isNaN(p.note.midi) || p.note.end === null) return null;
    return p.note.end >= note.onset - 0.05 ? p : null;
  }

  /**
   * Octave-above test: compare the previous note's harmonic magnitudes just
   * before vs. just after the onset. A note an octave higher adds energy only
   * to the even harmonics; a re-strike of the same key raises all of them.
   */
  private octaveUpEvidence(st: NoteState, prev: NoteState): boolean {
    const pf = midiToFreq(prev.note.midi);
    const same = (x: Frame) => x.profile !== null && Math.abs(x.profileHz / pf - 1) < 0.01;
    const before = prev.frames.filter((x) => same(x) && x.time < st.note.onset - 0.005).slice(-3);
    const after = st.frames.filter((x) => same(x) && x.time >= st.note.onset + this.opts.frameSec && x.time <= st.note.onset + this.opts.frameSec + 0.2);
    if (before.length < 2 || after.length < 2) return false;
    const avg = (fs: Frame[], h: number) => fs.reduce((a, x) => a + x.profile![h], 0) / fs.length;
    let even = 0, odd = 0, ne = 0, no = 0;
    for (let h = 0; h < PROFILE_HARMONICS; h++) {
      const b = avg(before, h), a = avg(after, h);
      if (b < -150 || a < -150) continue;
      // h is 0-based: index 1 = 2nd harmonic (even).
      if (h % 2 === 1) { even += a - b; ne++; } else { odd += a - b; no++; }
    }
    if (ne < 2 || no < 2) return false;
    const adv = even / ne - odd / no;
    this.lastOctaveTest = adv;
    return adv > 6;
  }

  /** For tests/diagnostics: the even-vs-odd harmonic gain of the last octave-up test (dB). */
  lastOctaveTest = NaN;

  /** Frequency the analyzer should comb-filter out (a possibly still ringing previous note). */
  get suppressFreq(): number {
    if (this.opts.mode === 'voice' || !this.cur) return 0;
    const p = this.contiguousPrev(this.cur.note);
    return p ? midiToFreq(p.note.midi) : 0;
  }

  /** Frequency whose harmonic profile the analyzer should report. */
  get profileFreq(): number {
    if (this.opts.mode === 'voice' || !this.cur) return 0;
    const c = this.cur.note;
    if (!Number.isNaN(c.midi) && c.used >= 4) return midiToFreq(c.midi);
    const p = this.prevState?.note;
    return p && !Number.isNaN(p.midi) ? midiToFreq(p.midi) : 0;
  }
}

type Pt = { time: number; midi: number; clarity: number };

/** Merge consecutive notes with the same (rounded) pitch — re-strikes / spurious splits. */
export function collapseRepeats(notes: DetectedNote[]): DetectedNote[] {
  const out: DetectedNote[] = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.midi - n.midi) < 0.5) continue;
    out.push(n);
  }
  return out;
}
