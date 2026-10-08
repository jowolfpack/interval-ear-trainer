// Debug one piano pair scenario by seed: npx tsx test/harness/debug-pair.ts 1208 [sr]
import { makePianoPairs, renderPianoPair } from './scenarios.ts';
import { AttemptListener } from '../../src/trainer/listen.ts';
const seed = parseInt(process.argv[2] ?? '1000');
const sr = parseInt(process.argv[3] ?? '48000');
const seed0 = sr === 48000 ? 1000 : 9000;
const p = makePianoPairs(seed - seed0 + 1, seed0, sr)[seed - seed0];
console.log(JSON.stringify(p));
const r = renderPianoPair(p);
const L = new AttemptListener(sr, { mode: 'piano' });
const t2 = r.truth[1].onset;
for (let i = 0; i < r.audio.length; i += 512) {
  const before = L.pipeline.segmenter.notes.length;
  const { frames } = L.pipeline.push(r.audio.subarray(i, i + 512));
  for (const f of frames) if (Math.abs(f.time - (process.env.AT ? parseFloat(process.env.AT) : t2)) < (process.env.WIDE ? 0.6 : 0.25)) console.log(`${f.time.toFixed(3)} db=${f.db.toFixed(1)} m=${f.midi.toFixed(2)} c=${f.clarity.toFixed(2)} mS=${f.midiS.toFixed(2)} cS=${f.clarityS.toFixed(2)} comb=${f.combDb.toFixed(1)} flux=${f.flux.toFixed(3)} floor=${L.pipeline.segmenter.floorDb.toFixed(1)}`);
  if (L.pipeline.segmenter.notes.length !== before) console.log('  -> notes', L.pipeline.segmenter.notes.map((n) => `${n.midi.toFixed(2)}@${n.onset.toFixed(2)}(${n.cause})`).join(' '));
}
L.finish();
console.log(L.pipeline.segmenter.notes.map((n) => `${n.midi.toFixed(2)}@${n.onset.toFixed(2)}(${n.cause}) used=${n.used}`).join('\n'), 'octTest', L.pipeline.segmenter.lastOctaveTest);
