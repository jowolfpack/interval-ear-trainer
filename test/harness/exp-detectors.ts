// Experiment 1: frame-level accuracy of candidate pitch detectors on single
// piano notes, per register, clean vs. "phone in a room".
import { PitchDetector } from 'pitchy';
import { McLeodDetector, YinDetector } from '../../src/dsp/pitch.ts';
import { freqToMidi } from '../../src/dsp/notes.ts';
import { pianoNote, iowaAvailable, type PianoSource } from './sources.ts';
import { highpass, addReverb, addNoise, rng } from './audio.ts';

const SR = 48000;
type Cond = 'clean' | 'phone';

function degrade(x: Float32Array, cond: Cond, seed: number): Float32Array {
  if (cond === 'clean') return x;
  const r = rng(seed);
  let y = highpass(Float32Array.from(x), 150, SR);
  y = addReverb(y, SR, 0.5, 0.5, r);
  return addNoise(y, SR, 25, r);
}

const frameSizes = [2048, 4096];
const configs: { name: string; make: (n: number) => (f: Float32Array) => number | null }[] = [];
for (const n of frameSizes) {
  configs.push({ name: `mpm-${n}`, make: () => { const d = new McLeodDetector({ sampleRate: SR, frameSize: n, minFreq: 50, maxFreq: 2200 }); return (f) => { const e = d.detect(f); return e && e.clarity > 0.5 ? e.freq : null; }; } });
  configs.push({ name: `yin-${n}`, make: () => { const d = new YinDetector({ sampleRate: SR, frameSize: n, minFreq: 50, maxFreq: 2200 }); return (f) => { const e = d.detect(f); return e && e.clarity > 0.5 ? e.freq : null; }; } });
  configs.push({ name: `pitchy-${n}`, make: () => { const d = PitchDetector.forFloat32Array(n); return (f) => { const [p, c] = d.findPitch(f, SR); return c > 0.5 && p > 50 && p < 2200 ? p : null; }; } });
}

const sources: PianoSource[] = iowaAvailable() ? ['iowa', 'salamander'] : ['salamander'];
const conds: Cond[] = ['clean', 'phone'];
const regs = [2, 3, 4, 5, 6];

for (const src of sources) for (const cond of conds) {
  console.log(`\n== ${src} / ${cond} ==   (ok% / octave-err% / other-err% / none%) per octave`);
  const rows: Record<string, string[]> = {};
  for (const cfg of configs) rows[cfg.name] = [];
  for (const reg of regs) {
    const mids: number[] = [];
    for (let m = (reg + 1) * 12; m < (reg + 2) * 12 && m <= 84; m++) mids.push(m);
    const stats: Record<string, number[]> = {};
    for (const cfg of configs) stats[cfg.name] = [0, 0, 0, 0];
    for (const midi of mids) {
      const x = degrade(pianoNote({ source: src, midi, sampleRate: SR, length: 1.2 }), cond, midi);
      for (const cfg of configs) {
        const n = parseInt(cfg.name.split('-')[1]);
        const det = cfg.make(n);
        for (let s = Math.floor(0.06 * SR); s + n < Math.floor(1.0 * SR); s += 1024) {
          const f = det(x.subarray(s, s + n));
          const st = stats[cfg.name];
          if (f === null) { st[3]++; continue; }
          const d = freqToMidi(f) - midi;
          if (Math.abs(d) < 0.5) st[0]++;
          else if (Math.abs(Math.abs(d) - 12) < 0.5 || Math.abs(Math.abs(d) - 24) < 0.5 || Math.abs(d - 19) < 0.5) st[1]++;
          else st[2]++;
        }
      }
    }
    for (const cfg of configs) {
      const st = stats[cfg.name];
      const tot = st.reduce((a, b) => a + b, 0);
      rows[cfg.name].push(st.map((v) => ((100 * v) / tot).toFixed(0).padStart(3)).join('/'));
    }
  }
  console.log('config        ' + regs.map((r) => `   oct ${r}      `).join(''));
  for (const cfg of configs) console.log(cfg.name.padEnd(14) + rows[cfg.name].map((s) => s.padEnd(17)).join(''));
}
