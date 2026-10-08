import { FrameAnalyzer } from '../../src/dsp/analyzer.ts';
import { renderPianoSingle, type Condition } from './scenarios.ts';
const [src = 'iowa', m = '60', dyn = 'mf', cond = 'clean', det = '0'] = process.argv.slice(2);
const r = renderPianoSingle(src as 'iowa', parseInt(m), cond as Condition, parseInt(det), dyn as 'mf');
const a = new FrameAnalyzer({ sampleRate: 48000 });
let t = 0;
a.guardDebug = (i) => { if (t > 0.3 && t < 1.0) console.log(t.toFixed(3), JSON.stringify(i)); };
for (let i = 0; i < r.audio.length; i += 512) { t = i / 48000; a.push(r.audio.subarray(i, i + 512)); }
