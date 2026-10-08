// Streaming frame analyzer: turns raw microphone samples into a sequence of
// analysis frames (level, pitch, clarity, spectral flux). Pure TS, no DOM —
// the browser and the Node test harness run exactly this code.

import { FFT } from './fft.ts';
import { McLeodDetector } from './pitch.ts';
import { freqToMidi } from './notes.ts';

export const PROFILE_HARMONICS = 8;

export interface Frame {
  /** Index of this frame since start. */
  index: number;
  /** Time (s) of the newest sample in the frame. */
  time: number;
  /** RMS level in dBFS of the newest hop-sized window. */
  db: number;
  /** Detected fundamental (Hz) or 0 when unvoiced/too quiet. */
  freq: number;
  /** Fractional MIDI note number (0 when no pitch). */
  midi: number;
  /** Periodicity 0..1. */
  clarity: number;
  /** Log-magnitude spectral flux (onset detection function). */
  flux: number;
  /** True if the octave guard moved the estimate an octave down. */
  octaveFixed: boolean;
  /**
   * Pitch after comb-filtering out `suppressFreq` (a previous note that may
   * still be ringing). 0 when suppression is off or nothing periodic remains.
   */
  midiS: number;
  clarityS: number;
  /** Energy of the comb-filtered frame relative to the input (dB); −∞ when off. */
  combDb: number;
  /** Harmonic magnitudes (dB) of `profileFreq`, harmonics 1..8; null when off. */
  profile: Float32Array | null;
  /** The frequency `profile` refers to. */
  profileHz: number;
}

export interface AnalyzerOptions {
  sampleRate: number;
  /** Pitch frame length in samples (default ≈ 43 ms rounded to a power of two). */
  frameSize?: number;
  /** Hop in samples (default frameSize / 4). */
  hop?: number;
  minFreq?: number;
  maxFreq?: number;
  /** Frames quieter than this (dBFS) are not pitch-analysed. */
  silenceDb?: number;
  /** Enable the octave guard. */
  octaveGuard?: boolean;
}

export class FrameAnalyzer {
  readonly sampleRate: number;
  readonly frameSize: number;
  readonly hop: number;
  readonly silenceDb: number;
  octaveGuard: boolean;
  /** Set by the segmenter: frequency of a previous note to cancel (comb filter). */
  suppressFreq = 0;
  /** Set by the segmenter: frequency whose harmonic profile to report. */
  profileFreq = 0;
  /** Test hook: receives octave-guard internals for every pitched frame. */
  guardDebug?: (info: { f0: number; nsdf2: number; clarity: number; ratio: number }) => void;
  readonly detector: McLeodDetector;

  private readonly ring: Float32Array;
  private writePos = 0;
  private filled = 0;
  private sinceHop = 0;
  private totalSamples = 0;
  private frameIndex = 0;
  private readonly frame: Float64Array;
  private readonly comb: Float64Array;
  // DC blocker state
  private dcX = 0;
  private dcY = 0;
  private readonly dcA: number;
  // Spectral flux
  private readonly specSize: number;
  private readonly specFft: FFT;
  private readonly specRe: Float64Array;
  private readonly specIm: Float64Array;
  private readonly specWin: Float64Array;
  private readonly prevMag: Float64Array;
  private readonly mag: Float64Array;
  private readonly fluxBins: number;
  // Zero-padded FFT of the full frame (octave guard, harmonic profile)
  private readonly ogSize: number;
  private readonly ogFft: FFT;
  private readonly ogRe: Float64Array;
  private readonly ogIm: Float64Array;
  private readonly ogWin: Float64Array;
  private readonly ogMag: Float64Array;
  private ogFor: Float64Array | null = null;

  constructor(o: AnalyzerOptions) {
    this.sampleRate = o.sampleRate;
    const target = 0.043 * o.sampleRate;
    let n = 512;
    while (n * 1.5 < target) n <<= 1;
    this.frameSize = o.frameSize ?? n;
    this.hop = o.hop ?? this.frameSize / 4;
    this.silenceDb = o.silenceDb ?? -75;
    this.octaveGuard = o.octaveGuard ?? true;
    this.detector = new McLeodDetector({
      sampleRate: o.sampleRate,
      frameSize: this.frameSize,
      // 62 Hz: just below C2 at −50 cents. Keeps 50/60 Hz mains hum out.
      minFreq: o.minFreq ?? 62,
      maxFreq: o.maxFreq ?? 2200,
    });
    this.ring = new Float32Array(this.frameSize * 2);
    this.frame = new Float64Array(this.frameSize);
    this.comb = new Float64Array(this.frameSize);
    this.dcA = Math.exp((-2 * Math.PI * 30) / o.sampleRate);

    this.specSize = this.frameSize / 2;
    this.specFft = new FFT(this.specSize);
    this.specRe = new Float64Array(this.specSize);
    this.specIm = new Float64Array(this.specSize);
    this.specWin = hann(this.specSize);
    this.fluxBins = Math.min(this.specSize / 2, Math.floor((8000 / o.sampleRate) * this.specSize));
    this.prevMag = new Float64Array(this.specSize / 2);
    this.mag = new Float64Array(this.specSize / 2);

    this.ogSize = this.frameSize * 2;
    this.ogFft = new FFT(this.ogSize);
    this.ogRe = new Float64Array(this.ogSize);
    this.ogIm = new Float64Array(this.ogSize);
    this.ogWin = hann(this.frameSize);
    this.ogMag = new Float64Array(this.ogSize / 2);
  }

  /** Feed samples; returns the frames completed by this chunk. */
  push(chunk: ArrayLike<number>): Frame[] {
    const out: Frame[] = [];
    const ring = this.ring;
    for (let i = 0; i < chunk.length; i++) {
      // DC blocker / gentle high-pass (removes rumble and offsets).
      const x = chunk[i];
      const y = x - this.dcX + this.dcA * this.dcY;
      this.dcX = x; this.dcY = y;
      ring[this.writePos] = y;
      this.writePos = (this.writePos + 1) % ring.length;
      this.totalSamples++;
      if (this.filled < ring.length) this.filled++;
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        if (this.filled >= this.frameSize) out.push(this.analyze());
      }
    }
    return out;
  }

  private analyze(): Frame {
    const n = this.frameSize;
    const ring = this.ring;
    const start = (this.writePos - n + ring.length) % ring.length;
    for (let i = 0; i < n; i++) this.frame[i] = ring[(start + i) % ring.length];
    const frame = this.frame;
    this.ogFor = null;

    // Level of the newest hop (fast reacting, good for gates/onsets).
    let e = 0;
    for (let i = n - this.hop; i < n; i++) e += frame[i] * frame[i];
    const db = 10 * Math.log10(e / this.hop + 1e-12);

    // Spectral flux on the newest half frame.
    const s = this.specSize;
    const off = n - s;
    for (let i = 0; i < s; i++) { this.specRe[i] = frame[off + i] * this.specWin[i]; this.specIm[i] = 0; }
    this.specFft.transform(this.specRe, this.specIm);
    let flux = 0;
    for (let k = 1; k < this.fluxBins; k++) {
      const m = Math.log1p(1000 * Math.hypot(this.specRe[k], this.specIm[k]));
      const d = m - this.prevMag[k];
      if (d > 0) flux += d;
      this.mag[k] = m;
    }
    this.prevMag.set(this.mag);
    flux /= this.fluxBins;

    let freq = 0, clarity = 0, octaveFixed = false;
    let freqS = 0, clarityS = 0, combDb = -Infinity;
    let profile: Float32Array | null = null;
    if (db > this.silenceDb) {
      const est = this.pitch(frame);
      freq = est.freq; clarity = est.clarity; octaveFixed = est.fixed;
      if (this.suppressFreq > 0 && this.filled >= n + this.sampleRate / this.suppressFreq + 3) {
        this.combFilter(this.suppressFreq);
        let ec = 0, ef = 0;
        for (let i = 0; i < n; i++) { ec += this.comb[i] * this.comb[i]; ef += frame[i] * frame[i]; }
        combDb = 10 * Math.log10((ec + 1e-20) / (ef + 1e-20));
        const es = this.pitch(this.comb);
        freqS = es.freq; clarityS = es.clarity;
      }
      if (this.profileFreq > 0) profile = this.harmonicProfile(this.profileFreq);
    }
    return {
      index: this.frameIndex++,
      time: this.totalSamples / this.sampleRate,
      db,
      freq,
      midi: freq > 0 ? freqToMidi(freq) : 0,
      clarity,
      flux,
      octaveFixed,
      midiS: freqS > 0 ? freqToMidi(freqS) : 0,
      clarityS,
      combDb,
      profile,
      profileHz: profile ? this.profileFreq : 0,
    };
  }

  private pitch(frame: Float64Array): { freq: number; clarity: number; fixed: boolean } {
    const est = this.detector.detect(frame);
    if (!est) return { freq: 0, clarity: 0, fixed: false };
    if (this.octaveGuard) {
      const g = this.guard(frame, est.period, est.clarity);
      if (g) return { freq: g.freq, clarity: g.clarity, fixed: true };
    }
    return { freq: est.freq, clarity: est.clarity, fixed: false };
  }

  /**
   * y[n] = x[n] − x[n − T]: notches out every harmonic of 1/T. Used to hear a
   * new note "through" a previous note that is still ringing (held key/pedal).
   */
  private combFilter(f: number): void {
    const n = this.frameSize;
    const ring = this.ring;
    const len = ring.length;
    const T = this.sampleRate / f;
    const ti = Math.floor(T);
    const fr = T - ti;
    const base = this.writePos - n + len * 2;
    const at = (k: number) => ring[(base + k) % len];
    for (let i = 0; i < n; i++) {
      // Cubic interpolation of x[i − T].
      const p = i - ti;
      const y0 = at(p + 1), y1 = at(p), y2 = at(p - 1), y3 = at(p - 2);
      const d = y1 + 0.5 * fr * (y2 - y0 + fr * (2 * y0 - 5 * y1 + 4 * y2 - y3 + fr * (3 * (y1 - y2) + y3 - y0)));
      this.comb[i] = this.frame[i] - d;
    }
  }

  private spectrum(frame: Float64Array): Float64Array {
    if (this.ogFor === frame) return this.ogMag;
    const n = this.frameSize;
    for (let i = 0; i < n; i++) { this.ogRe[i] = frame[i] * this.ogWin[i]; this.ogIm[i] = 0; }
    for (let i = n; i < this.ogSize; i++) { this.ogRe[i] = 0; this.ogIm[i] = 0; }
    this.ogFft.transform(this.ogRe, this.ogIm);
    for (let k = 0; k < this.ogSize / 2; k++) this.ogMag[k] = Math.hypot(this.ogRe[k], this.ogIm[k]);
    this.ogFor = frame;
    return this.ogMag;
  }

  private peakNear(mag: Float64Array, f: number, tol = 0.03): number {
    const binHz = this.sampleRate / this.ogSize;
    const c = f / binHz;
    const w = Math.max(1, Math.round(c * tol));
    let m = 0;
    for (let k = Math.max(1, Math.round(c) - w); k <= Math.round(c) + w && k < mag.length; k++) m = Math.max(m, mag[k]);
    return m;
  }

  private harmonicProfile(f: number): Float32Array {
    const mag = this.spectrum(this.frame);
    const p = new Float32Array(PROFILE_HARMONICS);
    for (let h = 1; h <= PROFILE_HARMONICS; h++) {
      const fh = h * f;
      p[h - 1] = fh < this.sampleRate / 2 - 100 ? 20 * Math.log10(this.peakNear(mag, fh, 0.015) + 1e-9) : -200;
    }
    return p;
  }

  /**
   * Octave guard against "too high" errors (the common failure when the
   * fundamental is weak or filtered out by a small phone mic). Two cues:
   *  - the NSDF at the doubled period is clearly *higher* than at the chosen
   *    one. For a true period T the NSDF at 2T is almost always a bit lower
   *    (decay, inharmonicity, shorter overlap), so this means MPM's k-threshold
   *    picked the half period;
   *  - substantial spectral energy at the half-integer multiples of f0 (the
   *    odd harmonics of f0/2) while the doubled period is also well supported.
   */
  private guard(frame: Float64Array, period: number, clarity: number): { freq: number; clarity: number } | null {
    const det = this.detector;
    const lag2 = Math.round(period * 2);
    if (lag2 + 1 >= det.nsdf.length || this.sampleRate / (period * 2) < det.opts.minFreq) return null;
    let best = lag2;
    for (let t = lag2 - 2; t <= lag2 + 2; t++) if (det.nsdf[t] > det.nsdf[best]) best = t;
    const r = det.refine(best);
    if (r.value < 0.6) { this.guardDebug?.({ f0: this.sampleRate / period, nsdf2: r.value, clarity, ratio: -1 }); return null; }

    const mag = this.spectrum(frame);
    const f0 = this.sampleRate / period;
    let harm = 0, half = 0;
    for (let h = 1; h <= 6; h++) {
      if ((h + 0.5) * f0 > Math.min(6000, this.sampleRate / 2 - 200)) break;
      harm += this.peakNear(mag, h * f0) ** 2;
      // Skip 0.5·f0 itself: it collides with mains hum and is often weak anyway.
      half += this.peakNear(mag, (h + 0.5) * f0) ** 2;
    }
    if (harm <= 0) return null;
    this.guardDebug?.({ f0, nsdf2: r.value, clarity, ratio: half / harm });
    if ((half / harm > 0.1 && r.value > clarity - 0.1) || r.value > clarity + 0.03) {
      return { freq: this.sampleRate / r.period, clarity: r.value };
    }
    return null;
  }
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
