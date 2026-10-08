// Small piano keyboard graphic (SVG) with highlighted keys.
import { svg } from './dom.ts';
import { NOTE_NAMES } from '../dsp/notes.ts';

const WHITE = [0, 2, 4, 5, 7, 9, 11];
const isWhite = (m: number) => WHITE.includes(((m % 12) + 12) % 12);

export type KeyMark = 'start' | 'target' | 'heard' | 'wrong';

/**
 * Render keys from the C at/below `lo` to the B at/above `hi`.
 * `marks` colours individual keys; `labels` adds a note name to marked keys.
 */
export function keyboard(lo: number, hi: number, marks: Map<number, KeyMark> = new Map(), labels = true): SVGElement {
  const from = lo - (((lo % 12) + 12) % 12);
  const to = hi + (11 - (((hi % 12) + 12) % 12));
  const ww = 24, wh = 100, bw = 15, bh = 62;
  const whites: number[] = [];
  for (let m = from; m <= to; m++) if (isWhite(m)) whites.push(m);
  const width = whites.length * ww;
  const root = svg('svg', { viewBox: `0 0 ${width} ${wh + 2}`, class: 'keyboard', role: 'img', 'aria-label': describe(marks) });
  const xOf = new Map<number, number>();
  whites.forEach((m, i) => xOf.set(m, i * ww));
  for (const m of whites) {
    const mark = marks.get(m);
    root.append(svg('rect', { x: xOf.get(m)! + 0.5, y: 0.5, width: ww - 1, height: wh, rx: 3, class: 'w' + (mark ? ' ' + mark : '') }));
    if (m % 12 === 0 && !mark) {
      const t = svg('text', { x: xOf.get(m)! + ww / 2, y: wh - 8 }, 'C' + (Math.floor(m / 12) - 1));
      root.append(t);
    }
  }
  for (let m = from; m <= to; m++) {
    if (isWhite(m)) continue;
    const left = xOf.get(m - 1);
    if (left === undefined) continue;
    const mark = marks.get(m);
    root.append(svg('rect', { x: left + ww - bw / 2, y: 0.5, width: bw, height: bh, rx: 2, class: 'b' + (mark ? ' ' + mark : '') }));
  }
  if (labels) {
    for (const [m] of marks) {
      if (m < from || m > to) continue;
      const white = isWhite(m);
      const x = white ? xOf.get(m)! + ww / 2 : xOf.get(m - 1)! + ww;
      const t = svg('text', { x, y: white ? wh - 8 : bh + 14, style: 'font-weight:700;fill:currentColor' }, NOTE_NAMES[((m % 12) + 12) % 12]);
      root.append(t);
    }
  }
  return root;
}

function describe(marks: Map<number, KeyMark>): string {
  if (marks.size === 0) return 'Piano keyboard';
  return 'Piano keyboard: ' + [...marks].map(([m, k]) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1} ${k}`).join(', ');
}
