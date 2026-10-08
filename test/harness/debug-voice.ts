// Debug one voice pair scenario by seed: npx tsx test/harness/debug-voice.ts 5011
import { makeVoicePairs, renderVoicePair } from './scenarios.ts';
import { AttemptListener } from '../../src/trainer/listen.ts';
const seed = parseInt(process.argv[2] ?? '5000');
const v = makeVoicePairs(seed - 5000 + 1, 5000)[seed - 5000];
console.log(JSON.stringify(v));
const r = renderVoicePair(v);
console.log('truth', JSON.stringify(r.truth));
const L = new AttemptListener(48000, { mode: 'voice' });
const at = process.env.AT ? parseFloat(process.env.AT) : r.truth[1].onset;
for (let i = 0; i < r.audio.length; i += 512) {
  const before = L.pipeline.segmenter.notes.length;
  const { frames } = L.pipeline.push(r.audio.subarray(i, i + 512));
  for (const f of frames) if (Math.abs(f.time - at) < (process.env.WIDE ? 0.6 : 0.3) && (f.index % 2 === 0)) console.log(`${f.time.toFixed(3)} db=${f.db.toFixed(1)} m=${f.midi.toFixed(2)} c=${f.clarity.toFixed(2)} flux=${f.flux.toFixed(3)} floor=${L.pipeline.segmenter.floorDb.toFixed(1)} cur=${L.pipeline.segmenter.current?.midi.toFixed(2)}`);
  if (L.pipeline.segmenter.notes.length !== before) console.log('  -> notes', L.pipeline.segmenter.notes.map((n) => `${n.midi.toFixed(2)}@${n.onset.toFixed(2)}(${n.cause})`).join(' '));
}
L.finish();
console.log(L.pipeline.segmenter.notes.map((n) => `${n.midi.toFixed(2)}@${n.onset.toFixed(2)}-${n.end?.toFixed(2)}(${n.cause}) used=${n.used} sd=${n.spread.toFixed(2)}`).join('\n'));
