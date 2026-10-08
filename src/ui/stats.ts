// Statistics: accuracy per interval & direction, confusion matrix, trend over
// sessions, plus JSON export/import.
import { h, svg, clear, toast, type Screen } from './dom.ts';
import { store, type Attempt } from '../trainer/store.ts';
import { INTERVALS, intervalName } from '../dsp/notes.ts';

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

export function statsScreen(): Screen {
  let mode: 'all' | 'piano' | 'voice' = 'all';
  let dir: 'up' | 'down' = 'up';
  const body = h('div');
  const tip = h('div', { class: 'card small', role: 'tooltip', style: 'position:fixed;pointer-events:none;display:none;margin:0;padding:6px 10px;z-index:30' });

  function showTip(e: { clientX: number; clientY: number }, lines: [string, string][]) {
    clear(tip);
    for (const [strong, rest] of lines) tip.append(h('div', {}, h('b', {}, strong), ' ', h('span', { class: 'muted' }, rest)));
    tip.style.display = 'block';
    const x = Math.min(window.innerWidth - 180, e.clientX + 12);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${e.clientY - 48}px`;
  }
  const hideTip = () => { tip.style.display = 'none'; };

  function attempts(): Attempt[] {
    return store.attempts.filter((a) => mode === 'all' || a.mode === mode);
  }

  function seg<T extends string>(opts: [T, string][], cur: T, set: (v: T) => void) {
    return h('div', { class: 'seg', role: 'group' }, ...opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', 'aria-pressed': String(v === cur), onclick: () => { set(v); render(); } }, l)));
  }

  function render() {
    clear(body);
    const all = attempts();
    const ok = all.filter((a) => a.correct).length;
    body.append(
      h('div', { class: 'row' }, seg([['all', 'All'], ['piano', 'Piano'], ['voice', 'Voice']], mode, (v) => { mode = v; })),
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          stat(String(all.length), 'attempts'),
          stat(all.length ? `${pct(ok, all.length)}%` : '—', 'correct'),
          stat(String(new Set(all.map((a) => a.s)).size), 'sessions'),
        )),
    );
    if (!all.length) {
      body.append(h('p', { class: 'muted' }, 'No attempts yet. Train a little and come back.'));
      body.append(backup());
      return;
    }
    body.append(h('h2', {}, 'Accuracy per interval'), h('div', { class: 'card' }, perInterval(all)));
    body.append(h('h2', {}, 'Trend over sessions'), h('div', { class: 'card' }, trend(all)));
    body.append(
      h('div', { class: 'row', style: 'margin-top:18px' }, h('h2', { style: 'margin:0' }, 'What you played'), h('div', { class: 'grow' }), seg([['up', 'Ascending'], ['down', 'Descending']], dir, (v) => { dir = v; })),
      h('div', { class: 'card' }, confusion(all)),
    );
    body.append(backup());
  }

  function stat(v: string, label: string) {
    return h('div', { class: 'grow', style: 'text-align:center' }, h('div', { style: 'font-size:1.8rem;font-weight:800' }, v), h('div', { class: 'muted small' }, label));
  }

  function perInterval(all: Attempt[]) {
    const rows = INTERVALS.map(({ semis, name }) => {
      const cell = (sign: 1 | -1) => {
        const xs = all.filter((a) => a.semis === sign * semis);
        const c = xs.filter((a) => a.correct).length;
        const last = xs.slice(-20);
        const lc = last.filter((a) => a.correct).length;
        if (!xs.length) return h('td', { class: 'muted' }, '—');
        const bar = h('div', { class: 'bar', tabindex: '0', 'aria-label': `${name} ${sign > 0 ? 'ascending' : 'descending'}: ${pct(c, xs.length)}% of ${xs.length}` }, h('span', { style: `width:${pct(c, xs.length)}%` }));
        const tipLines = (): [string, string][] => [[`${pct(c, xs.length)}%`, `${c}/${xs.length} overall`], [`${pct(lc, last.length)}%`, `last ${last.length}`]];
        bar.addEventListener('pointermove', (e) => showTip(e, tipLines()));
        bar.addEventListener('pointerleave', hideTip);
        bar.addEventListener('focus', () => { const r = bar.getBoundingClientRect(); showTip({ clientX: r.left, clientY: r.top }, tipLines()); });
        bar.addEventListener('blur', hideTip);
        return h('td', {}, h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('span', { style: 'min-width:3.2em' }, `${pct(c, xs.length)}%`), h('div', { class: 'grow' }, bar), h('span', { class: 'muted small' }, `n=${xs.length}`)));
      };
      return h('tr', {}, h('th', {}, name), cell(1), cell(-1));
    });
    return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Interval'), h('th', {}, '↑ ascending'), h('th', {}, '↓ descending'))), h('tbody', {}, ...rows));
  }

  function trend(all: Attempt[]) {
    const bySession = new Map<number, Attempt[]>();
    for (const a of all) {
      if (!bySession.has(a.s)) bySession.set(a.s, []);
      bySession.get(a.s)!.push(a);
    }
    const sessions = [...bySession.entries()].sort((a, b) => a[0] - b[0]).slice(-30).map(([s, xs]) => ({
      s, n: xs.length, acc: pct(xs.filter((a) => a.correct).length, xs.length),
    }));
    const W = 640, H = 300, L = 70, R = 16, T = 16, B = 44;
    const x = (i: number) => (sessions.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (sessions.length - 1));
    const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Accuracy per session, last ${sessions.length} sessions` });
    for (const v of [0, 50, 90, 100]) {
      root.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
      if (v !== 100) root.append(svg('text', { x: L - 8, y: y(v) + 7, 'text-anchor': 'end' }, `${v}%`));
    }
    const fmt = (s: number) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    root.append(svg('text', { x: L, y: H - 8 }, fmt(sessions[0].s)));
    if (sessions.length > 1) root.append(svg('text', { x: W - R, y: H - 8, 'text-anchor': 'end' }, fmt(sessions[sessions.length - 1].s)));
    if (sessions.length > 1) root.append(svg('path', { class: 'series', d: sessions.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.acc).toFixed(1)}`).join(' ') }));
    sessions.forEach((p, i) => root.append(svg('circle', { cx: x(i), cy: y(p.acc), r: 6, class: 'pt' })));
    // Crosshair + tooltip snapping to the nearest session.
    const hair = svg('line', { y1: T, y2: H - B, class: 'axis', style: 'display:none' });
    root.append(hair);
    const hit = svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
    root.append(hit);
    hit.addEventListener('pointermove', (e) => {
      const ev = e as PointerEvent;
      const box = root.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      let best = 0;
      sessions.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
      hair.setAttribute('x1', String(x(best)));
      hair.setAttribute('x2', String(x(best)));
      hair.setAttribute('style', '');
      const p = sessions[best];
      showTip(ev, [[`${p.acc}%`, `${p.n} attempts`], [new Date(p.s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), '']]);
    });
    hit.addEventListener('pointerleave', () => { hair.setAttribute('style', 'display:none'); hideTip(); });
    const table = h('details', {}, h('summary', { class: 'small muted' }, 'Show as table'),
      h('table', { class: 'small' }, h('thead', {}, h('tr', {}, h('th', {}, 'Session'), h('th', {}, 'Attempts'), h('th', {}, 'Correct'))),
        h('tbody', {}, ...sessions.slice().reverse().map((p) => h('tr', {}, h('td', {}, new Date(p.s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })), h('td', {}, String(p.n)), h('td', {}, `${p.acc}%`))))));
    return h('div', {}, root, table);
  }

  function confusion(all: Attempt[]) {
    const sign = dir === 'up' ? 1 : -1;
    const xs = all.filter((a) => Math.sign(a.semis) === sign);
    if (!xs.length) return h('p', { class: 'muted' }, `No ${dir === 'up' ? 'ascending' : 'descending'} attempts yet.`);
    // Columns: what was played (signed), restricted to the plausible span.
    const cols: number[] = [];
    for (let k = -12; k <= 12; k++) cols.push(k);
    const used = cols.filter((k) => xs.some((a) => a.played === k) || (k !== 0 && Math.sign(k) === sign));
    const rows = INTERVALS.map((i) => i.semis * sign).filter((t) => xs.some((a) => a.semis === t));
    const head = h('tr', {}, h('th', { style: 'text-align:right' }, 'asked ╲ played'), ...used.map((k) => h('th', {}, label(k))));
    const trs = rows.map((t) => {
      const ofT = xs.filter((a) => a.semis === t);
      return h('tr', {}, h('th', { style: 'text-align:right;white-space:nowrap' }, intervalName(t)), ...used.map((k) => {
        const n = ofT.filter((a) => a.played === k).length;
        const f = n / ofT.length;
        const diag = k === t;
        const td = h('td', {
          class: 'cell', tabindex: n ? '0' : null,
          style: n ? `background:color-mix(in srgb, ${diag ? 'var(--ok)' : 'var(--bad)'} ${Math.round(15 + 85 * f)}%, transparent)` : '',
          'aria-label': n ? `target ${intervalName(t)}, played ${label(k)}: ${n} times` : null,
        }, n ? String(n) : '');
        if (n) {
          const lines = (): [string, string][] => [[`${n}×`, `${Math.round(100 * f)}% of ${intervalName(t)} ${dir === 'up' ? '↑' : '↓'}`], [`played ${label(k)}`, '']];
          td.addEventListener('pointermove', (e) => showTip(e, lines()));
          td.addEventListener('pointerleave', hideTip);
        }
        return td;
      }));
    });
    return h('div', {},
      h('p', { class: 'small muted' }, 'Rows: the interval you were asked for. Columns: what you played (− = descending). Green = correct; red cells show your typical confusions.'),
      h('div', { class: 'matrix' }, h('table', {}, h('thead', {}, head), h('tbody', {}, ...trs))));
  }

  function label(k: number) {
    if (k === 0) return 'P1';
    const s = ['', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7', 'P8'][Math.abs(k)];
    return (k < 0 ? '−' : '') + s;
  }

  function backup() {
    const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const { added } = store.importJson(await f.text());
        toast(`Imported ${added} new attempts`);
        render();
      } catch (e) {
        toast(`Import failed: ${(e as Error).message}`);
      }
      file.value = '';
    });
    const exp = () => {
      const blob = new Blob([store.exportJson()], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `interval-trainer-backup-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    };
    return h('div', {},
      h('h2', {}, 'Backup'),
      h('div', { class: 'card' },
        h('p', { class: 'small muted' }, 'Your data is stored only in this browser. Export a backup now and then; importing merges it with what is here.'),
        h('div', { class: 'btns' }, h('button', { onclick: exp }, 'Export JSON'), h('button', { onclick: () => file.click() }, 'Import JSON')),
        file));
  }

  render();
  const unsub = store.onChange(render);
  document.body.append(tip);
  return { el: h('section', {}, h('h1', {}, 'Statistics'), body), leave: () => { unsub(); tip.remove(); } };
}
