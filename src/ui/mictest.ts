// "Mic Test" diagnostic screen: live note, cents, confidence, level meter and
// a log of segmented notes — to check detection on your piano/voice before
// trusting the trainer.
import { h, clear, type Screen } from './dom.ts';
import { mic } from '../audio/mic.ts';
import { playNote } from '../audio/player.ts';
import { PitchPipeline } from '../dsp/pipeline.ts';
import type { Frame } from '../dsp/analyzer.ts';
import type { DetectedNote, Mode } from '../dsp/segmenter.ts';
import { noteName, midiToFreq } from '../dsp/notes.ts';
import { estimateTuning } from '../trainer/judge.ts';
import { store } from '../trainer/store.ts';

export function micTestScreen(): Screen {
  let mode: Mode = store.settings.mode;
  let pipe: PitchPipeline | null = null;
  let last: Frame | null = null;
  let lastPitched: { f: Frame; at: number } | null = null;
  const logged: DetectedNote[] = [];
  let raf = 0;
  let octFixed = 0, pitched = 0;
  let error = '';

  const noteEl = h('div', { class: 'bignote', 'aria-live': 'polite' }, '—');
  const centsEl = h('div', { class: 'cents', style: 'text-align:center;font-size:1.4rem;min-height:1.6em' }, '');
  const pin = h('div', { class: 'pin', style: 'left:50%;display:none' });
  const needle = h('div', { class: 'needle', 'aria-hidden': 'true' },
    ...[-40, -30, -20, -10, 10, 20, 30, 40].map((c) => h('div', { class: 'tick', style: `left:${50 + c}%` })),
    h('div', { class: 'mid' }), pin);
  const fill = h('div', { class: 'fill', style: 'width:0%' });
  const floorMark = h('div', { class: 'floor', style: 'left:0%' });
  const meter = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Input level' }, fill, floorMark);
  const kv = h('dl', { class: 'kv' });
  const logEl = h('ul', { class: 'log' });
  const btn = h('button', { class: 'primary big', onclick: () => toggle() }, 'Start microphone');
  const errEl = h('p', { class: 'error' });
  const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Detection mode' });
  const diag = h('dl', { class: 'kv small' });

  function renderModeSeg() {
    clear(modeSeg);
    for (const m of ['piano', 'voice'] as const) {
      modeSeg.append(h('button', { class: mode === m ? 'on' : '', 'aria-pressed': String(mode === m), onclick: () => { mode = m; renderModeSeg(); if (pipe) reset(); } }, m === 'piano' ? 'Piano' : 'Voice'));
    }
  }

  function reset() {
    pipe = new PitchPipeline(mic.sampleRate, mode);
    logged.length = 0;
    octFixed = 0; pitched = 0;
    renderLog();
  }

  async function toggle() {
    if (mic.active) {
      stop();
      return;
    }
    error = '';
    errEl.textContent = '';
    btn.disabled = true;
    try {
      await mic.start();
      reset();
      mic.onSamples((x) => {
        if (!pipe) return;
        const { frames, finished } = pipe.push(x);
        for (const f of frames) {
          last = f;
          if (f.freq > 0) { pitched++; if (f.octaveFixed) octFixed++; }
          if (f.freq > 0 && f.clarity >= (mode === 'voice' ? 0.7 : 0.8) && f.db > pipe.segmenter.floorDb + 6) lastPitched = { f, at: performance.now() };
        }
        if (finished.length) {
          logged.unshift(...finished.reverse());
          logged.length = Math.min(logged.length, 30);
        }
      });
      btn.textContent = 'Stop microphone';
      loop();
    } catch (e) {
      error = (e as Error).message || String(e);
      errEl.textContent = `Microphone error: ${error}`;
    } finally {
      btn.disabled = false;
    }
    renderDiag();
  }

  function stop() {
    mic.onSamples(null);
    mic.stop();
    cancelAnimationFrame(raf);
    btn.textContent = 'Start microphone';
    noteEl.textContent = '—';
    centsEl.textContent = '';
    pin.style.display = 'none';
  }

  let tick = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!last || !pipe) return;
    const floor = pipe.segmenter.floorDb;
    const pct = (db: number) => Math.max(0, Math.min(100, ((db + 90) / 90) * 100));
    fill.style.width = pct(last.db) + '%';
    if (!Number.isNaN(floor)) floorMark.style.left = pct(floor) + '%';
    const lp = lastPitched;
    const fresh = lp && performance.now() - lp.at < 350;
    if (lp && fresh) {
      const f = lp.f;
      const c = Math.round((f.midi - Math.round(f.midi)) * 100);
      noteEl.textContent = noteName(f.midi);
      noteEl.style.opacity = '1';
      centsEl.textContent = `${c > 0 ? '+' : ''}${c} ¢ · ${f.freq.toFixed(1)} Hz · conf ${(f.clarity * 100).toFixed(0)}%`;
      pin.style.display = 'block';
      pin.style.left = `${50 + Math.max(-50, Math.min(50, c))}%`;
    } else {
      noteEl.style.opacity = '0.35';
      pin.style.display = 'none';
    }
    if (++tick % 6 === 0) { renderLog(); renderKv(); }
  }

  function renderKv() {
    if (!last || !pipe) return;
    clear(kv);
    const floor = pipe.segmenter.floorDb;
    const add = (k: string, v: string) => kv.append(h('dt', {}, k), h('dd', {}, v));
    add('Level', `${last.db.toFixed(1)} dBFS`);
    add('Noise floor', Number.isNaN(floor) ? '—' : `${floor.toFixed(1)} dBFS`);
    add('Clarity', `${(last.clarity * 100).toFixed(0)}%`);
    add('Octave guard', pitched ? `${((100 * octFixed) / pitched).toFixed(1)}% of pitched frames` : '—');
    if (mode === 'piano') {
      const ms = logged.filter((n) => !Number.isNaN(n.midi) && n.confidence > 0.5).map((n) => n.midi);
      if (ms.length >= 3) {
        const t = Math.round(estimateTuning(ms) * 100);
        add('Piano tuning', `${t > 0 ? '+' : ''}${t} ¢ vs. A440 (from ${ms.length} notes)`);
      }
    }
  }

  function renderLog() {
    clear(logEl);
    const cur = pipe?.segmenter.current;
    const items = [...(cur && !Number.isNaN(cur.midi) ? [cur] : []), ...logged].slice(0, 16);
    if (!items.length) {
      logEl.append(h('li', { class: 'muted' }, mic.active ? 'Play or sing single notes…' : 'Start the microphone, then play single notes.'));
      return;
    }
    const t0 = items[items.length - 1].onset;
    for (const n of items) {
      const c = Math.round((n.midi - Math.round(n.midi)) * 100);
      logEl.append(h('li', {},
        h('span', { class: 'n' }, noteName(n.midi)),
        h('span', { class: 'c' }, `${c > 0 ? '+' : ''}${c} ¢`),
        h('span', { class: 'muted small grow' }, `${midiToFreq(n.midi).toFixed(1)} Hz · conf ${(n.confidence * 100).toFixed(0)}% · ${n.cause}${n.final ? '' : ' · sounding'}`),
        h('span', { class: 'muted small' }, `${(n.onset - t0).toFixed(2)} s`),
      ));
    }
  }

  function renderDiag() {
    clear(diag);
    const s = mic.settings;
    const add = (k: string, v: string) => diag.append(h('dt', {}, k), h('dd', {}, v));
    add('Sample rate', `${mic.sampleRate} Hz`);
    if (pipe) add('Frame / hop', `${pipe.analyzer.frameSize} / ${pipe.analyzer.hop} samples`);
    const flag = (v: unknown) => (v === undefined ? 'not reported' : v ? 'ON ⚠' : 'off');
    add('Echo cancellation', flag(s.echoCancellation));
    add('Noise suppression', flag(s.noiseSuppression));
    add('Auto gain', flag(s.autoGainControl));
    if (s.deviceId) add('Device', String((s as { label?: string }).label ?? s.deviceId).slice(0, 40));
  }

  renderModeSeg();
  renderLog();

  const el = h('section', {},
    h('h1', {}, 'Mic Test'),
    h('p', { class: 'muted' }, 'Check that the app hears your piano or voice correctly before you trust the trainer. Play single notes across your range; each should appear in the log with the right name.'),
    h('div', { class: 'row' }, modeSeg, h('div', { class: 'grow' }), h('button', { class: 'small', onclick: () => playNote(60).catch(() => {}) }, 'Play test C4')),
    h('div', { class: 'btns' }, btn),
    errEl,
    h('div', { class: 'card' }, noteEl, centsEl, needle, meter, h('div', { class: 'spacer' }), kv),
    h('h2', {}, 'Detected notes'),
    h('div', { class: 'card' }, logEl),
    h('h2', {}, 'Audio setup'),
    h('div', { class: 'card' }, diag, h('p', { class: 'small muted' }, 'Echo cancellation, noise suppression and auto gain should all be off; some browsers ignore the request (shown as ON ⚠), which can make detection less reliable.')),
  );
  renderDiag();
  return { el, leave: stop };
}
