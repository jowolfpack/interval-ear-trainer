// Trainer screen: show start key → play interval → listen → feedback.
import { h, clear, toast, type Screen } from './dom.ts';
import { keyboard, type KeyMark } from './keyboard.ts';
import { mic } from '../audio/mic.ts';
import { playInterval, preload, setVolume, stopAll } from '../audio/player.ts';
import { AttemptListener } from '../trainer/listen.ts';
import { judge, estimateTuning, type Judgement } from '../trainer/judge.ts';
import { pickExercise, updateProgress, activeIntervals, type Exercise } from '../trainer/progression.ts';
import { store, type Attempt } from '../trainer/store.ts';
import { noteName, intervalName } from '../dsp/notes.ts';

type State = 'idle' | 'playing' | 'listening' | 'result';

const GAP_AFTER_PLAYBACK_MS = 300;
const WARMUP_S = 0.15;

const arrow = (semis: number) => (semis > 0 ? '↑' : '↓');
const describeInterval = (semis: number) => `${intervalName(semis)} ${arrow(semis)}`;

export function trainerScreen(): Screen {
  let state: State = 'idle';
  let ex: Exercise | null = null;
  let listener: AttemptListener | null = null;
  let lastJudgement: Judgement | null = null;
  let run = 0; // invalidates stale async continuations
  let wakeLock: { release(): Promise<void> } | null = null;
  const sessionAttempts = () => store.attempts.filter((a) => a.s === store.session);

  const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Instrument' });
  const prompt = h('div', { class: 'prompt' });
  const kbWrap = h('div');
  const legend = h('div', { class: 'legend' });
  const status = h('div', { class: 'status', 'aria-live': 'polite' });
  const live = h('div', { class: 'live', 'aria-live': 'off' });
  const result = h('div');
  const buttons = h('div', { class: 'btns' });
  const session = h('p', { class: 'session small' });
  const hintToggle = h('label', { class: 'row small muted', style: 'justify-content:center;gap:8px' });

  function renderMode() {
    clear(modeSeg);
    for (const m of ['piano', 'voice'] as const) {
      modeSeg.append(h('button', {
        class: store.settings.mode === m ? 'on' : '', 'aria-pressed': String(store.settings.mode === m),
        disabled: state === 'playing' || state === 'listening',
        onclick: () => { store.saveSettings({ mode: m }); ex = null; setState('idle'); },
      }, m === 'piano' ? '🎹 Piano' : '🎤 Voice'));
    }
    clear(hintToggle);
    const cb = h('input', { type: 'checkbox', checked: store.settings.showStartKey, onchange: (e: Event) => { store.saveSettings({ showStartKey: (e.target as HTMLInputElement).checked }); render(); } });
    hintToggle.append(cb, 'Show start key');
  }

  function playNotes(e: Exercise): [number, number] {
    const shift = store.settings.mode === 'voice' && store.settings.voicePlayOctaveUp ? 12 : 0;
    return [e.start + shift, e.start + e.semis + shift];
  }

  function render() {
    renderMode();
    clear(prompt);
    const s = store.settings;
    if (!ex) {
      prompt.append(
        h('div', { class: 'label' }, s.mode === 'piano' ? 'Piano mode' : 'Voice mode'),
        h('div', { class: 'big' }, 'Ready?'),
        h('div', { class: 'sub' }, 'The app plays two notes. Then you play (or sing) them back.'),
      );
    } else {
      const shown = s.showStartKey;
      prompt.append(
        h('div', { class: 'label' }, shown ? 'Start on' : 'Start anywhere'),
        h('div', { class: 'big' }, shown ? noteName(ex.start, s.mode === 'piano') : '?'),
        h('div', { class: 'sub' }, state === 'result' || s.showIntervalName ? describeInterval(ex.semis) : ''),
      );
    }
    renderKeyboard();
    renderButtons();
    renderSession();
  }

  function renderKeyboard() {
    clear(kbWrap);
    clear(legend);
    const s = store.settings;
    const marks = new Map<number, KeyMark>();
    let lo = 48, hi = 71;
    if (ex) {
      const [a, b] = [ex.start, ex.start + ex.semis];
      const down = activeIntervals(s, store.progress).some((x) => x < 0);
      lo = ex.start - (down ? 12 : 0);
      hi = ex.start + 12;
      if (state === 'result') { lo = Math.min(lo, a, b); hi = Math.max(hi, a, b); }
      if (s.showStartKey || state === 'result') marks.set(a, 'start');
      if (state === 'result' && lastJudgement) {
        marks.set(b, 'target');
        const heard = foldHeard(lastJudgement.heard, a, s.mode);
        heard.forEach((m, i) => {
          const r = Math.round(m);
          if (i === 0 && r === a) return;
          if (i === 1 && r === b) return;
          marks.set(r, i === 0 && lastJudgement!.startOk === false && s.showStartKey ? 'wrong' : i === 1 && !lastJudgement!.intervalOk ? 'wrong' : 'heard');
          lo = Math.min(lo, r); hi = Math.max(hi, r);
        });
        legend.append(
          h('span', {}, h('i', { style: 'background:var(--accent)' }), 'start'),
          h('span', {}, h('i', { style: 'background:var(--ok)' }), 'target'),
          h('span', {}, h('i', { style: 'background:var(--bad)' }), 'you (wrong)'),
          h('span', {}, h('i', { style: 'background:var(--info)' }), 'you'),
        );
      }
    }
    kbWrap.append(keyboard(lo, hi, marks));
  }

  function renderButtons() {
    clear(buttons);
    const b = (label: string, onclick: () => void, cls = 'big') => h('button', { class: cls, onclick }, label);
    if (state === 'idle') {
      buttons.append(b(ex ? 'Play' : 'Start', () => next(!ex), 'primary big'));
    } else if (state === 'playing') {
      buttons.append(h('button', { class: 'big', disabled: true }, 'Listen…'));
    } else if (state === 'listening') {
      buttons.append(b('Replay', () => replayAndListen()), b('Done', () => finish()));
    } else {
      buttons.append(b('Replay target', () => replayOnly()), b('Try again', () => replayAndListen()), b('Next', () => next(true), 'primary big'));
    }
  }

  function renderSession() {
    const sa = sessionAttempts();
    const ok = sa.filter((a) => a.correct).length;
    const p = store.progress;
    const set = store.settings.progression === 'adaptive'
      ? `Practising: ${p.up.map((x) => intervalShortName(x)).join(' ')} ↑${p.descUnlocked ? ` · ${p.down.map((x) => intervalShortName(x)).join(' ')} ↓` : ''}`
      : 'Manual interval selection';
    session.textContent = `${sa.length ? `This session: ${ok}/${sa.length} correct · ` : ''}${set}`;
  }

  function setState(s: State, statusText = '', cls = '') {
    state = s;
    status.className = 'status' + (cls ? ' ' + cls : '');
    clear(status);
    if (cls === 'listening') status.append(h('span', { class: 'dot' }));
    status.append(statusText);
    if (s !== 'result') clear(result);
    if (s !== 'listening') live.textContent = '';
    render();
  }

  async function next(newExercise: boolean) {
    const s = store.settings;
    if (newExercise || !ex) ex = pickExercise(s, store.progress, store.attempts, ex);
    lastJudgement = null;
    await requestWakeLock();
    await replayAndListen();
    void preloadAround(ex);
  }

  async function playTarget(myRun: number): Promise<boolean> {
    if (!ex) return false;
    setVolume(store.settings.volume);
    stopListening();
    if (store.settings.releaseMic) mic.stop();
    setState('playing', 'Listen…');
    try {
      const [a, b] = playNotes(ex);
      await playInterval(a, b);
    } catch (e) {
      setState('idle', `Could not play sound: ${(e as Error).message}`);
      return false;
    }
    if (myRun !== run) return false;
    // Let the room (and the speaker) go quiet before listening.
    await new Promise((r) => setTimeout(r, GAP_AFTER_PLAYBACK_MS));
    return myRun === run;
  }

  async function replayOnly() {
    const myRun = ++run;
    await playTarget(myRun);
    if (myRun === run) {
      setState('result', status.textContent ?? '');
      showResult();
    }
  }

  async function replayAndListen() {
    const myRun = ++run;
    if (!(await playTarget(myRun))) return;
    await listen(myRun);
  }

  async function listen(myRun: number) {
    if (!ex) return;
    try {
      await mic.start();
    } catch (e) {
      setState('idle', '');
      clear(result);
      result.append(h('div', { class: 'result bad' }, h('div', { class: 'line' }, `Microphone unavailable: ${(e as Error).message}`), h('div', { class: 'line small muted' }, 'Allow microphone access for this site, then press Play.')));
      return;
    }
    if (myRun !== run) return;
    const mode = store.settings.mode;
    const L = new AttemptListener(mic.sampleRate, { mode });
    listener = L;
    let skip = Math.round(WARMUP_S * mic.sampleRate);
    setState('listening', store.settings.showStartKey ? `Your turn: play ${noteName(ex.start, false)}, then the 2nd note` : 'Your turn: play both notes', 'listening');
    let lastLive = 0;
    mic.onSamples((x) => {
      if (listener !== L) return;
      if (skip > 0) { skip -= x.length; return; }
      const done = L.push(x);
      const now = performance.now();
      if (now - lastLive > 120) { lastLive = now; renderLive(L); }
      if (done) finish();
    });
  }

  function renderLive(L: AttemptListener) {
    const notes = L.notes;
    clear(live);
    if (!notes.length) { live.append('…'); return; }
    live.append('Hearing: ', ...notes.slice(0, 2).flatMap((n, i) => [i ? ' → ' : '', h('b', {}, noteName(n.midi, store.settings.mode === 'piano'))]));
  }

  function stopListening() {
    mic.onSamples(null);
    listener = null;
  }

  function finish() {
    const L = listener;
    if (!L || !ex) return;
    stopListening();
    const notes = L.state === 'done' ? L.notes : L.finish();
    const s = store.settings;
    const recentPiano = store.attempts.filter((a) => a.mode === 'piano').slice(-20).flatMap((a) => a.heard);
    const tuning = s.mode === 'piano' ? estimateTuning([...recentPiano, ...notes.slice(0, 2).map((n) => n.midi)]) : 0;
    const j = judge({ start: ex.start, semis: ex.semis }, notes, { mode: s.mode, startShown: s.showStartKey, tuningOffset: tuning });
    lastJudgement = j;
    if (j.status !== 'incomplete') {
      const a: Attempt = {
        t: Date.now(), s: store.session, mode: s.mode, start: ex.start, semis: ex.semis, played: j.played,
        correct: j.correct, startShown: s.showStartKey, startOk: j.startOk, cents: j.intervalCents,
        heard: j.heard.map((m) => Math.round(m * 100) / 100), adaptive: ex.adaptive,
      };
      store.addAttempt(a);
      if (ex.adaptive) {
        const { progress, events } = updateProgress(store.progress, store.attempts);
        if (events.length) { store.saveProgress(progress); events.forEach((e) => toast('🎉 ' + e, 5000)); }
      }
      if (!store.persistent) toast('Could not save progress (storage blocked?)');
    }
    setState('result', '');
    showResult();
    if (store.settings.releaseMic) mic.stop();
  }

  function showResult() {
    const j = lastJudgement;
    if (!j || !ex) return;
    clear(result);
    const s = store.settings;
    const piano = s.mode === 'piano';
    const target = `${describeInterval(ex.semis)} (${noteName(ex.start, piano)} → ${noteName(ex.start + ex.semis, piano)})`;
    if (j.status === 'incomplete') {
      result.append(h('div', { class: 'result bad' },
        h('div', { class: 'verdict' }, 'Didn’t catch that'),
        h('div', { class: 'line' }, j.heard.length ? `Heard only one note: ${noteName(j.heard[0], piano)}. Play both notes, one after the other.` : 'No clear note heard. Play a bit louder or check the Mic Test.'),
        h('div', { class: 'line small muted' }, `Target: ${target}`),
      ));
      return;
    }
    const lines: (HTMLElement | null)[] = [];
    const heardTxt = `${noteName(j.heard[0], piano)} → ${noteName(j.heard[1], piano)}`;
    lines.push(h('div', { class: 'line' }, 'You played ', h('b', {}, heardTxt), j.played !== null ? ` · ${j.played === 0 ? 'unison' : describeInterval(j.played)}` : ''));
    lines.push(h('div', { class: 'line' }, 'Target ', h('b', {}, target)));
    if (s.showStartKey && j.startOk === false) {
      lines.push(h('div', { class: 'line' }, `Your first note was ${noteName(j.heard[0], false)}, not ${noteName(ex.start, false)}.`));
    } else if (piano && s.showStartKey && j.startOctaveShift !== 0) {
      lines.push(h('div', { class: 'line small muted' }, `Started an octave ${j.startOctaveShift > 0 ? 'higher' : 'lower'} — that’s fine.`));
    }
    if (j.intervalCents !== null && (!piano || Math.abs(j.intervalCents) >= 25)) {
      const c = j.intervalCents;
      lines.push(h('div', { class: 'line cents' }, `Interval ${c > 0 ? '+' : ''}${c} ¢ ${Math.abs(c) < 10 ? '(spot on)' : c > 0 ? '(wide)' : '(narrow)'}`));
    }
    if (!piano && j.startCents !== null && s.showStartKey && j.startOk) {
      const c = j.startCents;
      lines.push(h('div', { class: 'line small muted cents' }, `Start note ${c > 0 ? '+' : ''}${c} ¢`));
    }
    if (j.folded) lines.push(h('div', { class: 'line small muted' }, 'The notes were more than an octave apart; judged by note names (possible octave detection error).'));
    result.append(h('div', { class: 'result ' + (j.correct ? 'ok' : 'bad') },
      h('div', { class: 'verdict' }, j.correct ? '✓ Correct' : '✗ Not quite'), ...lines));
  }

  async function preloadAround(e: Exercise) {
    // Decode samples near the current exercise so the next one starts instantly.
    const r = [e.start - 12, e.start, e.start + 12];
    try { await preload(r.filter((m) => m >= 24 && m <= 96)); } catch { /* offline & uncached */ }
  }

  async function requestWakeLock() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && !wakeLock) wakeLock = await wl.request('screen');
    } catch { /* not supported / denied */ }
  }
  const onVisible = () => { if (document.visibilityState === 'visible' && state !== 'idle') { wakeLock = null; void requestWakeLock(); } };
  document.addEventListener('visibilitychange', onVisible);

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (state === 'idle') void next(!ex);
      else if (state === 'result') void next(true);
      else if (state === 'listening') finish();
    } else if (e.key === 'r' || e.key === 'R') {
      if (state === 'result' || state === 'listening') void replayAndListen();
    }
  };
  document.addEventListener('keydown', onKey);

  const unsub = store.onChange(() => renderSession());
  setState('idle');
  const el = h('section', {},
    h('div', { class: 'row' }, modeSeg, h('div', { class: 'grow' }), hintToggle),
    prompt, kbWrap, legend, status, live, result, buttons, session,
  );
  return {
    el,
    leave: () => {
      run++;
      stopListening();
      stopAll();
      mic.stop();
      unsub();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
      wakeLock?.release().catch(() => {});
      wakeLock = null;
    },
  };
}

function intervalShortName(semis: number): string {
  return ['', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7', 'P8'][Math.abs(semis)] ?? '?';
}

/** Voice: show sung notes in the octave of the start key (octave doesn't matter). */
function foldHeard(heard: number[], start: number, mode: string): number[] {
  if (mode === 'piano' || !heard.length) return heard;
  const shift = 12 * Math.round((start - heard[0]) / 12);
  return heard.map((m) => m + shift);
}
