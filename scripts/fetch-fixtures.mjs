// Downloads independent piano recordings (University of Iowa Electronic Music
// Studios, "MIS" piano samples — free to use without restriction) and converts
// them to short mono 16-bit WAV files in test/fixtures/iowa (gitignored).
//
// These are a different instrument + recording than the Salamander samples the
// app plays back, so the test harness doesn't only test against its own sounds.
//
// Requires: ffmpeg on PATH. Usage: node scripts/fetch-fixtures.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'test', 'fixtures', 'iowa');
const TMP = join(OUT, '_tmp');
mkdirSync(TMP, { recursive: true });

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const BASE = 'https://theremin.music.uiowa.edu/sound%20files/MIS/Piano_Other/piano/';

const jobs = [];
for (let midi = 36; midi <= 84; midi++) {
  const name = NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
  jobs.push({ midi, name, dyn: 'mf' });
  if (midi % 4 === 0) {
    jobs.push({ midi, name, dyn: 'ff' });
    jobs.push({ midi, name, dyn: 'pp' });
  }
}

let ok = 0;
for (const j of jobs) {
  const out = join(OUT, `${j.dyn}_${j.midi}.wav`);
  if (existsSync(out)) { ok++; continue; }
  const url = `${BASE}Piano.${j.dyn}.${j.name}.aiff`;
  const res = await fetch(url);
  if (!res.ok) { console.warn(`missing ${url} (${res.status})`); continue; }
  const tmp = join(TMP, `${j.dyn}_${j.midi}.aiff`);
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  // Trim leading silence (keep ~30 ms of pre-roll), keep 6 s, mono 44.1 kHz.
  const r = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', tmp,
    '-af', 'silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.03,atrim=0:6',
    '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', out,
  ]);
  rmSync(tmp);
  if (r.status !== 0) { console.warn(`ffmpeg failed for ${j.name}: ${r.stderr}`); continue; }
  if (statSync(out).size < 44100) { rmSync(out); console.warn(`too quiet / empty after trim: ${url}`); continue; }
  ok++;
  console.log(`ok ${j.dyn} ${j.name}`);
}
rmSync(TMP, { recursive: true, force: true });
console.log(`${ok}/${jobs.length} fixtures available in ${OUT}`);
