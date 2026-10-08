// Microphone capture. Browser voice processing (echo cancellation, noise
// suppression, auto gain) is switched off: it distorts pitch and level and
// treats piano tones as "noise" to remove.
import { ensureAudio } from './context.ts';

export type SampleHandler = (samples: Float32Array) => void;

export class Mic {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private handler: SampleHandler | null = null;
  private static workletLoaded = new WeakSet<BaseAudioContext>();
  sampleRate = 48000;
  /** What the browser actually applied (for the Mic Test page). */
  settings: MediaTrackSettings = {};

  get active(): boolean {
    return this.stream !== null;
  }

  onSamples(h: SampleHandler | null): void {
    this.handler = h;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    const ctx = await ensureAudio();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser has no microphone access (needs HTTPS or localhost).');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    const track = this.stream.getAudioTracks()[0];
    this.settings = track?.getSettings?.() ?? {};
    this.sampleRate = ctx.sampleRate;
    this.source = ctx.createMediaStreamSource(this.stream);
    // Keep the capture node pulled by the graph without making a sound.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);

    if (ctx.audioWorklet) {
      if (!Mic.workletLoaded.has(ctx)) {
        await ctx.audioWorklet.addModule(import.meta.env.BASE_URL + 'capture-worklet.js');
        Mic.workletLoaded.add(ctx);
      }
      const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.handler?.(e.data);
      this.node = node;
    } else {
      // Old browsers: deprecated but universally available fallback.
      const sp = ctx.createScriptProcessor(1024, 1, 1);
      sp.onaudioprocess = (e) => this.handler?.(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.node = sp;
    }
    this.source.connect(this.node);
    this.node.connect(this.sink);
  }

  stop(): void {
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    if (this.node instanceof AudioWorkletNode) this.node.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
  }
}

export const mic = new Mic();
