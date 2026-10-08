// Main test harness: renders scenarios, runs the real detection pipeline +
// judge on them, and writes TEST_RESULTS.md.
//
//   npm run harness            full run (a few minutes)
//   QUICK=1 npm run harness    ~1/4 of the trials, prints only
//   ONLY=piano-pairs ...       one suite (piano-single | piano-pairs | voice-pairs)
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeBuffer } from '../../src/dsp/pipeline.ts';
import { collapseRepeats, type DetectedNote, type Mode } from '../../src/dsp/segmenter.ts';
import { judge, estimateTuning } from '../../src/trainer/judge.ts';
import { AttemptListener } from '../../src/trainer/listen.ts';
import { noteNameAscii } from '../../src/dsp/notes.ts';
import {
  CONDITIONS, makePianoPairs, makeVoicePairs, pianoSources, renderPianoPair, renderPianoSingle, renderVoicePair,
  renderNoiseOnly, renderWithPlaybackTail, type Condition, type Rendered,
} from './scenarios.ts';
import { ROOT } from './audio.ts';

const QUICK = !!process.env.QUICK;
const ONLY = process.env.ONLY;
const OUT = join(ROOT, 'test', 'results');
mkdirSync(OUT, { recursive: true });

const pct = (a: number, b: number) => (b === 0 ? '—' : `${((100 * a) / b).toFixed(1)}%`);
const quant = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

class Tally {
  n = 0;
  c: Record<string, number> = {};
  v: Record<string, number[]> = {};
  add(key: string, ok: boolean | number = true) { this.c[key] = (this.c[key] ?? 0) + (ok === true ? 1 : ok === false ? 0 : ok); }
  val(key: string, x: number) { (this.v[key] ??= []).push(x); }
}
const groups = new Map<string, Tally>();
const T = (key: string) => { if (!groups.has(key)) groups.set(key, new Tally()); return groups.get(key)!; };

function table(header: string[], rows: string[][]): string {
  const line = (r: string[]) => `| ${r.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

interface PairEval {
  segOk: boolean;
  count: number;
  onsetOk: boolean;
  octErr: number;
  noteErr: number;
  intervalOk: boolean;
  startOk: boolean;
  falseAccept: boolean;
  centsErr: number[];
  notes: DetectedNote[];
}

function evalPair(r: Rendered, mode: Mode, sr: number, target: { start: number; semis: number }): PairEval {
  // Stream the audio exactly like the app does and stop when the app would.
  const L = new AttemptListener(sr, { mode });
  let stopped = false;
  for (let i = 0; i < r.audio.length && !stopped; i += 512) stopped = L.push(r.audio.subarray(i, i + 512));
  const notes = stopped ? L.notes : L.finish();
  const count = notes.length;
  // Sung onsets are soft (and a legato glide has no sharp boundary), so voice gets a wider window.
  const tol = mode === 'piano' ? 0.08 : 0.15;
  const onsetOk = count >= 2 && Math.abs(notes[0].onset - r.truth[0].onset) < tol && Math.abs(notes[1].onset - r.truth[1].onset) < tol;
  let octErr = 0, noteErr = 0;
  const centsErr: number[] = [];
  for (let i = 0; i < Math.min(2, count); i++) {
    const e = notes[i].midi - r.truth[i].midi;
    if (Math.abs(e) < 0.5) centsErr.push(Math.abs(e) * 100);
    else if (Math.abs(Math.abs(e) - 12) < 0.5 || Math.abs(Math.abs(e) - 24) < 0.5) octErr++;
    else noteErr++;
  }
  const tuning = mode === 'piano' ? estimateTuning(notes.slice(0, 2).map((n) => n.midi)) : 0;
  const hidden = judge(target, notes, { mode, startShown: false, tuningOffset: tuning });
  const shown = judge(target, notes, { mode, startShown: true, tuningOffset: tuning });
  // False accept: would the judge also have accepted a neighbouring wrong target?
  const wrongA = judge({ ...target, semis: target.semis + 1 }, notes, { mode, startShown: false, tuningOffset: tuning });
  const wrongB = judge({ ...target, semis: target.semis - 1 }, notes, { mode, startShown: false, tuningOffset: tuning });
  return {
    segOk: onsetOk, count, onsetOk, octErr, noteErr,
    intervalOk: hidden.correct, startOk: shown.correct,
    falseAccept: wrongA.correct || wrongB.correct, centsErr, notes,
  };
}

const failures: string[] = [];
const md: string[] = [];
const t0 = Date.now();

// ---------------------------------------------------------------------------
function suitePianoSingle() {
  const srcs = pianoSources();
  const dyns = ['mf', 'pp', 'ff'] as const;
  for (const src of srcs) for (const cond of CONDITIONS) for (let midi = 36; midi <= 84; midi += QUICK ? 3 : 1) {
    for (const dyn of dyns) {
      if (dyn !== 'mf' && (src !== 'iowa' || midi % 4 !== 0)) continue;
      const detune = ((midi * 37) % 101) - 50;
      const r = renderPianoSingle(src, midi, cond, detune, dyn);
      const { notes: raw } = analyzeBuffer(r.audio, 48000, 'piano');
      const notes = collapseRepeats(raw);
      const reg = `C${Math.floor(midi / 12) - 1}`;
      for (const key of [`ps|${src}|${cond}|${reg}`, `ps|all|${cond}|${reg}`, `ps|all|${cond}|all`, `ps|${src}|all|all`]) {
        const t = T(key);
        t.n++;
        if (notes.length === 0) { t.add('missed'); continue; }
        const e = notes[0].midi - r.truth[0].midi;
        if (Math.abs(e) < 0.5) { t.add('ok'); t.val('cents', Math.abs(e) * 100); }
        else if (Math.abs(Math.abs(e) - 12) < 0.5 || Math.abs(Math.abs(e) - 24) < 0.5) t.add('oct');
        else t.add('other');
        if (notes.length > 1) t.add('extra');
      }
      if (notes.length !== 1 || Math.abs(notes[0].midi - r.truth[0].midi) >= 0.5) {
        failures.push(`piano-single ${src} ${dyn} ${cond} ${noteNameAscii(midi)} detune=${detune}: heard [${notes.map((n) => n.midi.toFixed(2) + '@' + n.onset.toFixed(2)).join(', ')}]`);
      }
    }
  }
  md.push('## 1. Piano — single notes\n');
  md.push(`Every note C2–C6 (${srcs.join(' + ')}; Iowa additionally at pp and ff for every 4th note), each with a fixed pseudo-random detune in ±50 cents. A note counts as correct if the detected pitch is within ±50 cents of the true (detuned) pitch.\n`);
  const regs = ['C2', 'C3', 'C4', 'C5', 'C6'];
  const rows: string[][] = [];
  for (const cond of CONDITIONS) for (const reg of regs) {
    const t = T(`ps|all|${cond}|${reg}`);
    rows.push([cond, reg, String(t.n), pct(t.c.ok ?? 0, t.n), pct(t.c.oct ?? 0, t.n), pct(t.c.other ?? 0, t.n), pct(t.c.missed ?? 0, t.n), pct(t.c.extra ?? 0, t.n), (quant(t.v.cents ?? [], 0.5)).toFixed(1)]);
  }
  md.push(table(['condition', 'octave', 'n', 'correct', 'octave err', 'other err', 'missed', 'extra notes', 'median |cents|'], rows));
  md.push('');
  const rows2: string[][] = [];
  for (const src of srcs) { const t = T(`ps|${src}|all|all`); rows2.push([src, String(t.n), pct(t.c.ok ?? 0, t.n), pct(t.c.oct ?? 0, t.n), pct(t.c.extra ?? 0, t.n)]); }
  md.push(table(['source', 'n', 'correct', 'octave err', 'extra notes'], rows2));
  md.push('');
}

// ---------------------------------------------------------------------------
function suitePianoPairs() {
  const sets = [{ sr: 48000, n: QUICK ? 240 : 1200, seed: 1000 }, { sr: 44100, n: QUICK ? 60 : 300, seed: 9000 }];
  for (const set of sets) {
    const pairs = makePianoPairs(set.n, set.seed, set.sr);
    for (const p of pairs) {
      const r = renderPianoPair(p);
      const e = evalPair(r, 'piano', set.sr, { start: p.start, semis: p.interval });
      const reg = `C${Math.floor(p.start / 12) - 1}`;
      const absDet = Math.abs(p.detune) >= 35 ? '35–50' : Math.abs(p.detune) >= 15 ? '15–34' : '0–14';
      const keys = set.sr === 48000
        ? [`pp|${p.cond}|${reg}`, `pp|${p.cond}|all`, `pp|art|${p.articulation}`, `pp|src|${p.source}`, `pp|det|${absDet}`, `pp|all|all`, `pp|ioi|${p.ioi < 0.6 ? 'fast' : 'slow'}`]
        : [`pp44|all|all`];
      for (const key of keys) {
        const t = T(key);
        t.n++;
        t.add('seg', e.segOk);
        t.add('int', e.intervalOk);
        t.add('start', e.startOk);
        t.add('fa', e.falseAccept);
        t.add('oct', e.octErr);
        t.add('noteErr', e.noteErr);
        t.add('notes', Math.min(2, e.count));
      }
      if (e.intervalOk && !e.startOk) failures.push(`piano-start-only det=${p.detune} start=${p.start} heard=${e.notes.slice(0, 2).map((n) => n.midi.toFixed(2))}`);
      if (!e.intervalOk || !e.segOk) {
        failures.push(`piano-pair sr=${set.sr} ${p.source} ${p.cond} ${p.articulation} ${noteNameAscii(p.start)}${p.interval > 0 ? '+' : ''}${p.interval} det=${p.detune} ioi=${p.ioi.toFixed(2)} g2=${p.gain2.toFixed(2)} lvl=${(20 * Math.log10(p.level)).toFixed(0)}dB seed=${p.seed}: ` +
          `heard [${e.notes.map((n) => `${n.midi.toFixed(2)}@${n.onset.toFixed(2)}(${n.cause})`).join(', ')}] truth onsets ${r.truth.map((t) => t.onset.toFixed(2)).join(',')}`);
      }
    }
  }
  md.push('## 2. Piano — note pairs (the actual exercise)\n');
  md.push('Random start note C2–C6, random interval ±1…12 semitones, random global detune ±50 cents, random onset spacing 0.35–1.2 s, ' +
    'random second-note loudness (−6…+3.5 dB), random overall level (0…−30 dB), and one of three articulations: ' +
    '*legato* (first note damped 50 ms after the second starts), *staccato* (released before), *pedal* (first note keeps ringing under the second).\n');
  md.push('- **segmentation ok**: the first two notes found (at the moment the app stops listening) have onsets within ±80 ms of the true ones.\n- **interval ok**: the judge accepts the correct interval (start-key hint hidden).\n' +
    '- **start+interval ok**: the judge accepts with the start-key hint shown (first note must match the start key by pitch class; tuning offset self-estimated from the two notes).\n' +
    '- **false accept**: the judge would *also* accept the neighbouring wrong interval (±1 semitone) — should be ~0.\n- **octave err**: notes detected an octave off (per note).\n');
  const rows: string[][] = [];
  const regs = ['C2', 'C3', 'C4', 'C5', 'C6'];
  const row = (label: string[], t: Tally) => [...label, String(t.n), pct(t.c.seg ?? 0, t.n), pct(t.c.int ?? 0, t.n), pct(t.c.start ?? 0, t.n), pct(t.c.fa ?? 0, t.n), pct(t.c.oct ?? 0, 2 * t.n), pct(t.c.noteErr ?? 0, 2 * t.n)];
  const head = ['n', 'segmentation ok', 'interval ok', 'start+interval ok', 'false accept', 'octave err (per note)', 'other note err'];
  for (const cond of CONDITIONS) {
    for (const reg of regs) rows.push(row([cond, reg], T(`pp|${cond}|${reg}`)));
    rows.push(row([`**${cond}**`, '**all**'], T(`pp|${cond}|all`)));
  }
  md.push(table(['condition', 'start octave', ...head], rows));
  md.push('\nBreakdowns (all conditions pooled, 48 kHz):\n');
  const rows2: string[][] = [];
  for (const a of ['legato', 'staccato', 'pedal']) rows2.push(row(['articulation', a], T(`pp|art|${a}`)));
  for (const s of pianoSources()) rows2.push(row(['source', s], T(`pp|src|${s}`)));
  for (const d of ['0–14', '15–34', '35–50']) rows2.push(row(['|detune| (cents)', d], T(`pp|det|${d}`)));
  rows2.push(row(['onset spacing', '< 0.6 s'], T('pp|ioi|fast')));
  rows2.push(row(['onset spacing', '≥ 0.6 s'], T('pp|ioi|slow')));
  rows2.push(row(['**all @ 48 kHz**', ''], T('pp|all|all')));
  rows2.push(row(['**all @ 44.1 kHz**', ''], T('pp44|all|all')));
  md.push(table(['breakdown', 'value', ...head], rows2));
  md.push('');
}

// ---------------------------------------------------------------------------
function suiteVoicePairs() {
  const pairs = makeVoicePairs(QUICK ? 180 : 900, 5000);
  for (const v of pairs) {
    const r = renderVoicePair(v);
    const e = evalPair(r, 'voice', v.sampleRate, { start: v.start, semis: v.interval });
    const keys = [`vp|${v.cond}|${v.range}`, `vp|${v.cond}|all`, `vp|leg|${v.legato}`, `vp|vib|${v.vibrato > 0}`, `vp|vowel|${v.vowel}`, `vp|all|all`];
    for (const key of keys) {
      const t = T(key);
      t.n++;
      t.add('seg', e.segOk); t.add('int', e.intervalOk); t.add('start', e.startOk); t.add('fa', e.falseAccept);
      t.add('oct', e.octErr); t.add('noteErr', e.noteErr);
      for (const c of e.centsErr) t.val('cents', c);
    }
    if (!e.intervalOk || !e.segOk) {
      failures.push(`voice-pair ${v.cond} ${v.range} ${v.vowel} ${v.legato ? 'legato' : 'gap'} ${noteNameAscii(v.start)}${v.interval > 0 ? '+' : ''}${v.interval} off=${v.offsets} scoop=${v.scoop.map((s) => s.toFixed(0))} vib=${v.vibrato.toFixed(0)} seed=${v.seed}: ` +
        `heard [${e.notes.map((n) => `${n.midi.toFixed(2)}@${n.onset.toFixed(2)}(${n.cause})`).join(', ')}] truth ${r.truth.map((t) => t.midi.toFixed(2) + '@' + t.onset.toFixed(2)).join(', ')}`);
    }
  }
  md.push('## 3. Voice — synthetic sung note pairs\n');
  md.push('Additive voice model (glottal-like harmonic source, 4 vowels with 3 formants, breath noise, slow pitch drift and jitter). Each note: ' +
    'singer offset ±20 cents (ground truth includes it), onset scoop (75%: from 50–250 cents below; some from above), vibrato 15–60 cents on 70% of trials, ' +
    'either a gap between the notes or a legato glide. Ranges: *low* E2–E4 (male), *high* A3–A5 (female).\n');
  md.push('- **segmentation ok**: as for piano, but with a ±150 ms window (sung onsets ramp in, and a legato glide has no sharp boundary).\n');
  md.push('- **cents error**: |measured − true| of each correctly identified note, i.e. how well the stable part is found despite scoop and vibrato.\n');
  const head = ['n', 'segmentation ok', 'interval ok', 'start+interval ok', 'false accept', 'octave err (per note)', 'median cents err', 'p95 cents err'];
  const row = (label: string[], t: Tally) => [...label, String(t.n), pct(t.c.seg ?? 0, t.n), pct(t.c.int ?? 0, t.n), pct(t.c.start ?? 0, t.n), pct(t.c.fa ?? 0, t.n), pct(t.c.oct ?? 0, 2 * t.n), quant(t.v.cents ?? [], 0.5).toFixed(1), quant(t.v.cents ?? [], 0.95).toFixed(1)];
  const rows: string[][] = [];
  for (const cond of CONDITIONS) {
    for (const rg of ['low', 'high']) rows.push(row([cond, rg], T(`vp|${cond}|${rg}`)));
    rows.push(row([`**${cond}**`, '**all**'], T(`vp|${cond}|all`)));
  }
  md.push(table(['condition', 'range', ...head], rows));
  md.push('');
  const rows2: string[][] = [];
  rows2.push(row(['articulation', 'legato glide'], T('vp|leg|true')));
  rows2.push(row(['articulation', 'gap'], T('vp|leg|false')));
  rows2.push(row(['vibrato', 'yes'], T('vp|vib|true')));
  rows2.push(row(['vibrato', 'no'], T('vp|vib|false')));
  for (const v of ['ah', 'oo', 'ee', 'eh']) rows2.push(row(['vowel', v], T(`vp|vowel|${v}`)));
  rows2.push(row(['**all**', ''], T('vp|all|all')));
  md.push(table(['breakdown', 'value', ...head], rows2));
  md.push('');
}

// ---------------------------------------------------------------------------
function suiteRobustness() {
  md.push('## 4. Robustness: false triggers and self-listening\n');
  md.push('**Background only** (6 s each, nothing played; any detected note is a false trigger). The trainer would take a false note as the user\'s first note.\n');
  const rows: string[][] = [];
  for (const kind of ['room', 'noisy-room', 'knocks', 'hum50', 'hum60'] as const) {
    let notes = 0, trials = 0;
    for (let s = 0; s < (QUICK ? 5 : 20); s++) {
      const x = renderNoiseOnly(kind, 100 + s);
      const { notes: ns } = analyzeBuffer(x, 48000, 'piano');
      const { notes: nv } = analyzeBuffer(x, 48000, 'voice');
      notes += ns.length + nv.length;
      trials += 2;
      for (const n of [...ns, ...nv]) failures.push(`false-trigger ${kind} seed=${100 + s}: ${n.midi.toFixed(2)}@${n.onset.toFixed(2)} (${n.cause})`);
    }
    rows.push([kind, String(trials), String(notes), (notes / (trials * 6 / 60)).toFixed(2)]);
  }
  md.push(table(['background', 'runs (piano+voice mode)', 'false notes', 'false notes / minute'], rows));
  md.push('\n**Self-listening**: the target is played through a (bass-less) phone speaker right next to the mic, faded out over 150 ms; after a gap the app starts listening and the user plays the pair 0.4–1.4 s later (phone condition). Counted as failure if the first heard note is not the user\'s first note.\n');
  const rows2: string[][] = [];
  for (const gap of [0.1, 0.3, 0.5]) {
    const pairs = makePianoPairs(QUICK ? 40 : 150, 20000 + Math.round(gap * 1000));
    let ok = 0, intOk = 0;
    for (const p of pairs) {
      const r = renderWithPlaybackTail(p, gap);
      const e = evalPair(r, 'piano', 48000, { start: p.start, semis: p.interval });
      if (e.segOk) ok++;
      if (e.intervalOk) intOk++;
      if (!e.segOk) failures.push(`self-listen gap=${gap} ${noteNameAscii(p.start)}${p.interval > 0 ? '+' : ''}${p.interval} seed=${p.seed}: heard [${e.notes.map((n) => `${n.midi.toFixed(2)}@${n.onset.toFixed(2)}(${n.cause})`).join(', ')}] truth ${r.truth.map((t) => t.onset.toFixed(2)).join(',')}`);
    }
    rows2.push([`${gap * 1000} ms`, String(pairs.length), pct(ok, pairs.length), pct(intOk, pairs.length)]);
  }
  md.push(table(['gap after playback', 'n', 'segmentation ok', 'interval ok'], rows2));
  md.push('');
}

if (!ONLY || ONLY === 'piano-single') suitePianoSingle();
if (!ONLY || ONLY === 'piano-pairs') suitePianoPairs();
if (!ONLY || ONLY === 'voice-pairs') suiteVoicePairs();
if (!ONLY || ONLY === 'robustness') suiteRobustness();

const body = md.join('\n');
console.log(body);
writeFileSync(join(OUT, `failures${ONLY ? '-' + ONLY : ''}.txt`), failures.join('\n') + '\n');
console.log(`\n${failures.length} failures written to test/results/; ${((Date.now() - t0) / 1000).toFixed(0)} s`);

if (!QUICK && !ONLY) {
  const tpl = join(ROOT, 'test', 'harness', 'TEST_RESULTS.template.md');
  const head = existsSync(tpl) ? readFileSync(tpl, 'utf8') : '# Test results\n\n<!-- RESULTS -->\n';
  const stamp = `_Generated by \`npm run harness\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, ${((Date.now() - t0) / 1000).toFixed(0)} s._\n\n`;
  writeFileSync(join(ROOT, 'TEST_RESULTS.md'), head.replace('<!-- RESULTS -->', stamp + body));
}
export type { Condition };
