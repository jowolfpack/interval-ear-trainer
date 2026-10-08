// Debug one rendered single piano note: npx tsx test/harness/debug-single.ts iowa 84 pp clean 28
import { analyzeBuffer } from '../../src/dsp/pipeline.ts';
import { renderPianoSingle, type Condition } from './scenarios.ts';
const [src = 'iowa', m = '60', dyn = 'mf', cond = 'clean', det = '0'] = process.argv.slice(2);
const r = renderPianoSingle(src as 'iowa', parseInt(m), cond as Condition, parseInt(det), dyn as 'mf');
const { notes, frames } = analyzeBuffer(r.audio, 48000, 'piano');
for (const f of frames) if (f.db > -90 && f.time < 1.2) console.log(`${f.time.toFixed(3)} db=${f.db.toFixed(1)} midi=${f.midi.toFixed(2)} clar=${f.clarity.toFixed(2)} flux=${f.flux.toFixed(3)}${f.octaveFixed ? ' OCT' : ''}`);
for (const n of notes) console.log(JSON.stringify(n));
