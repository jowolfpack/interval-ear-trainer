// Glue: raw samples → frames → notes. Used by the Mic Test page, the trainer
// and the Node test harness alike.
import { FrameAnalyzer, type Frame, type AnalyzerOptions } from './analyzer.ts';
import { NoteSegmenter, type DetectedNote, type Mode } from './segmenter.ts';

export class PitchPipeline {
  readonly analyzer: FrameAnalyzer;
  readonly segmenter: NoteSegmenter;
  readonly mode: Mode;

  constructor(sampleRate: number, mode: Mode, opts: Partial<AnalyzerOptions> = {}) {
    this.mode = mode;
    this.analyzer = new FrameAnalyzer({ sampleRate, ...opts });
    this.segmenter = new NoteSegmenter({
      mode,
      hopSec: this.analyzer.hop / sampleRate,
      frameSec: this.analyzer.frameSize / sampleRate,
    });
  }

  /** Feed samples. Returns new frames and notes finalized during this chunk. */
  push(samples: ArrayLike<number>): { frames: Frame[]; finished: DetectedNote[] } {
    const frames = this.analyzer.push(samples);
    const finished: DetectedNote[] = [];
    for (const f of frames) finished.push(...this.segmenter.push(f));
    // Feed back what the analyzer should listen "through" / profile next.
    this.analyzer.suppressFreq = this.segmenter.suppressFreq;
    this.analyzer.profileFreq = this.segmenter.profileFreq;
    return { frames, finished };
  }

  flush(): DetectedNote[] {
    return this.segmenter.flush();
  }

  get notes(): DetectedNote[] {
    return this.segmenter.notes;
  }
}

/** Offline convenience: analyse a whole buffer in browser-sized chunks. */
export function analyzeBuffer(samples: Float32Array, sampleRate: number, mode: Mode, opts: Partial<AnalyzerOptions> = {}): { notes: DetectedNote[]; frames: Frame[] } {
  const p = new PitchPipeline(sampleRate, mode, opts);
  const frames: Frame[] = [];
  const chunk = 128 * 4;
  for (let i = 0; i < samples.length; i += chunk) frames.push(...p.push(samples.subarray(i, i + chunk)).frames);
  p.flush();
  return { notes: [...p.notes], frames };
}
