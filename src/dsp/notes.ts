// Note / interval naming and pitch math (English naming, sharps).

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const NOTE_NAMES_ASCII = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const INTERVALS = [
  { semis: 1, name: 'minor 2nd', short: 'm2' },
  { semis: 2, name: 'major 2nd', short: 'M2' },
  { semis: 3, name: 'minor 3rd', short: 'm3' },
  { semis: 4, name: 'major 3rd', short: 'M3' },
  { semis: 5, name: 'perfect 4th', short: 'P4' },
  { semis: 6, name: 'tritone', short: 'TT' },
  { semis: 7, name: 'perfect 5th', short: 'P5' },
  { semis: 8, name: 'minor 6th', short: 'm6' },
  { semis: 9, name: 'major 6th', short: 'M6' },
  { semis: 10, name: 'minor 7th', short: 'm7' },
  { semis: 11, name: 'major 7th', short: 'M7' },
  { semis: 12, name: 'octave', short: 'P8' },
] as const;

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function noteName(midi: number, withOctave = true): string {
  const m = Math.round(midi);
  const name = NOTE_NAMES[((m % 12) + 12) % 12];
  return withOctave ? name + (Math.floor(m / 12) - 1) : name;
}

export function noteNameAscii(midi: number): string {
  const m = Math.round(midi);
  return NOTE_NAMES_ASCII[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** Parse "C4", "F#3", "Bb2" → midi number. */
export function parseNote(s: string): number | null {
  const m = /^([A-Ga-g])([#♯b♭]?)(-?\d)$/.exec(s.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()]!;
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + base + acc;
}

export function intervalName(semis: number): string {
  const a = Math.abs(semis);
  if (a === 0) return 'unison';
  const octaves = Math.floor((a - 1) / 12);
  const base = INTERVALS[(a - 1) % 12].name;
  const extra = octaves > 0 ? ` + ${octaves} oct` : '';
  return base + extra;
}

export function intervalShort(semis: number): string {
  const a = Math.abs(semis);
  if (a === 0) return 'P1';
  return INTERVALS[(a - 1) % 12].short + (a > 12 ? '+8va' : '');
}

/** Signed cents between two frequencies-as-midi. */
export function cents(midiFloat: number): number {
  return Math.round((midiFloat - Math.round(midiFloat)) * 100);
}
