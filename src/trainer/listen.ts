// One listening attempt: feeds mic samples into the pipeline and decides when
// we have heard enough (two distinct notes, the second one settled). The
// trainer UI and the test harness both use this, so the harness measures what
// the app will actually decide.

import { PitchPipeline } from '../dsp/pipeline.ts';
import { collapseRepeats, type DetectedNote, type Mode } from '../dsp/segmenter.ts';

export interface ListenOptions {
  mode: Mode;
  /** How long the second note must have sounded before we judge (s). */
  settle?: number;
  /** Give up this long after listening started without any note (s). */
  maxWaitFirst?: number;
  /** Give up this long after the first note without a second one (s). */
  maxWaitSecond?: number;
}

export type ListenState = 'waiting' | 'heard-one' | 'done' | 'timeout';

export class AttemptListener {
  readonly pipeline: PitchPipeline;
  readonly opts: Required<ListenOptions>;
  private samples = 0;
  readonly sampleRate: number;
  state: ListenState = 'waiting';

  constructor(sampleRate: number, o: ListenOptions) {
    this.sampleRate = sampleRate;
    this.pipeline = new PitchPipeline(sampleRate, o.mode);
    this.opts = {
      mode: o.mode,
      settle: o.settle ?? (o.mode === 'piano' ? 0.45 : 0.75),
      maxWaitFirst: o.maxWaitFirst ?? 15,
      maxWaitSecond: o.maxWaitSecond ?? 8,
    };
  }

  get time(): number {
    return this.samples / this.sampleRate;
  }

  /** Distinct notes so far (re-strikes of the same key merged). */
  get notes(): DetectedNote[] {
    return collapseRepeats(this.pipeline.notes.filter((n) => !Number.isNaN(n.midi)));
  }

  /** Feed samples; returns true once the attempt is complete (done or timeout). */
  push(chunk: ArrayLike<number>): boolean {
    if (this.state === 'done' || this.state === 'timeout') return true;
    this.pipeline.push(chunk);
    this.samples += chunk.length;
    const t = this.time;
    const notes = this.notes;
    if (notes.length >= 3) {
      this.state = 'done';
    } else if (notes.length === 2) {
      const n2 = notes[1];
      if (n2.final || (t - n2.onset >= this.opts.settle && n2.used >= 3)) this.state = 'done';
    } else if (notes.length === 1) {
      this.state = 'heard-one';
      if (t - notes[0].onset > this.opts.maxWaitSecond) this.state = 'timeout';
    } else if (t > this.opts.maxWaitFirst) {
      this.state = 'timeout';
    }
    return this.state === 'done' || this.state === 'timeout';
  }

  /** Stop now (e.g. user pressed "done"): finalize whatever is sounding. */
  finish(): DetectedNote[] {
    this.pipeline.flush();
    if (this.state !== 'timeout') this.state = 'done';
    return this.notes;
  }
}
