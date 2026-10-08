// Settings screen.
import { h, toast, type Screen } from './dom.ts';
import { store, initialProgress, VOICE_PRESETS, type Settings } from '../trainer/store.ts';
import { INTERVALS, noteNameAscii, intervalName } from '../dsp/notes.ts';
import { ORDER } from '../trainer/progression.ts';

function noteSelect(value: number, lo: number, hi: number, onchange: (v: number) => void) {
  const sel = h('select', { onchange: (e: Event) => onchange(parseInt((e.target as HTMLSelectElement).value, 10)) });
  for (let m = lo; m <= hi; m++) sel.append(h('option', { value: String(m), selected: m === value }, noteNameAscii(m)));
  return sel;
}

export function settingsScreen(): Screen {
  const el = h('section');
  const render = () => {
    const s = store.settings;
    const save = (p: Partial<Settings>) => { store.saveSettings(p); render(); };
    const field = (label: string, hint: string, control: Node) =>
      h('div', { class: 'field' }, h('label', {}, label, hint ? h('span', { class: 'hint' }, hint) : null), control);
    const check = (key: keyof Settings) =>
      h('input', { type: 'checkbox', checked: !!s[key], onchange: (e: Event) => save({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>) });

    const p = store.progress;
    const unlocked = h('p', { class: 'small' },
      `Ascending: ${ORDER.filter((x) => p.up.includes(x)).map(intervalName).join(', ')}. `,
      p.descUnlocked ? `Descending: ${ORDER.filter((x) => p.down.includes(x)).map(intervalName).join(', ')}.` : 'Descending: locked (opens once 6 ascending intervals are solid).');

    const manual = h('div', { class: 'checks' }, ...INTERVALS.map((i) => h('label', {},
      h('input', {
        type: 'checkbox', checked: s.manualIntervals.includes(i.semis),
        onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          const set = new Set(s.manualIntervals);
          if (on) set.add(i.semis); else set.delete(i.semis);
          if (set.size === 0) { toast('Pick at least one interval'); render(); return; }
          save({ manualIntervals: [...set].sort((a, b) => a - b) });
        },
      }), i.name)));

    el.replaceChildren(
      h('h1', {}, 'Settings'),
      h('h2', {}, 'Exercise'),
      h('div', { class: 'card' },
        field('Instrument', '', h('select', { onchange: (e: Event) => save({ mode: (e.target as HTMLSelectElement).value as Settings['mode'] }) },
          h('option', { value: 'piano', selected: s.mode === 'piano' }, 'Piano'), h('option', { value: 'voice', selected: s.mode === 'voice' }, 'Voice'))),
        field('Show start key', 'Off = harder: start anywhere, only the interval counts', check('showStartKey')),
        field('Show interval name before playing', 'Off = pure ear training', check('showIntervalName')),
        field('Progression', 'Adaptive unlocks intervals as you get them right', h('select', { onchange: (e: Event) => save({ progression: (e.target as HTMLSelectElement).value as Settings['progression'] }) },
          h('option', { value: 'adaptive', selected: s.progression === 'adaptive' }, 'Adaptive'), h('option', { value: 'manual', selected: s.progression === 'manual' }, 'Manual'))),
        s.progression === 'adaptive'
          ? h('div', {}, field('Include descending now', 'Practise descending before it unlocks', check('forceDescending')), unlocked,
            h('button', { class: 'small', onclick: () => { if (confirm('Reset unlocked intervals to the first three?')) { store.saveProgress(initialProgress()); render(); } } }, 'Reset progression'))
          : h('div', {},
            field('Direction', '', h('select', { onchange: (e: Event) => save({ manualDirection: (e.target as HTMLSelectElement).value as Settings['manualDirection'] }) },
              ...([['up', 'Ascending'], ['down', 'Descending'], ['both', 'Both']] as const).map(([v, l]) => h('option', { value: v, selected: s.manualDirection === v }, l)))),
            h('p', { class: 'small muted' }, 'Intervals to drill:'), manual),
      ),
      h('h2', {}, 'Range'),
      h('div', { class: 'card' },
        field('Piano: lowest start note', '', noteSelect(s.pianoLow, 36, s.pianoHigh, (v) => save({ pianoLow: v }))),
        field('Piano: highest start note', '', noteSelect(s.pianoHigh, s.pianoLow, 84, (v) => save({ pianoHigh: v }))),
        field('Voice type', 'Sets a comfortable range; adjust the notes below if needed', h('select', {
          onchange: (e: Event) => {
            const p = VOICE_PRESETS.find((v) => v.type === (e.target as HTMLSelectElement).value);
            if (p) save({ voiceType: p.type, voiceLow: p.low, voiceHigh: p.high });
          },
        },
          ...VOICE_PRESETS.map((v) => h('option', { value: v.type, selected: s.voiceType === v.type }, `${v.label} (${noteNameAscii(v.low)}–${noteNameAscii(v.high)})`)),
          h('option', { value: 'custom', selected: s.voiceType === 'custom' || s.voiceType === null, disabled: true }, s.voiceType === null ? 'Not chosen yet' : 'Custom'))),
        field('Voice: lowest note', 'Both notes of a voice exercise stay inside your range', noteSelect(s.voiceLow, 36, s.voiceHigh - 12, (v) => save({ voiceLow: v, voiceType: 'custom' }))),
        field('Voice: highest note', '', noteSelect(s.voiceHigh, s.voiceLow + 12, 84, (v) => save({ voiceHigh: v, voiceType: 'custom' }))),
        field('Voice: play an octave higher', 'E.g. if you prefer hearing the target in the piano’s middle register', check('voicePlayOctaveUp')),
      ),
      h('h2', {}, 'Sound & microphone'),
      h('div', { class: 'card' },
        field('Volume', '', h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(s.volume), onchange: (e: Event) => save({ volume: parseFloat((e.target as HTMLInputElement).value) }) })),
        field('Release mic during playback', 'Helps if the sound gets quiet or comes from the earpiece on iPhone while the mic is on', check('releaseMic')),
      ),
      h('h2', {}, 'Data'),
      h('div', { class: 'card' },
        h('p', { class: 'small muted' }, `${store.attempts.length} attempts stored in this browser. Export/import is on the Stats page.`),
        h('button', { class: 'small', onclick: () => { if (confirm('Delete all attempts and progress? Export a backup first if unsure.')) { store.resetAll(); toast('All data deleted'); render(); } } }, 'Delete all data'),
      ),
      h('h2', {}, 'About'),
      h('div', { class: 'card small' },
        h('p', {}, 'Interval Ear Trainer — trains relative pitch: hear an interval, play or sing it back, the app listens and checks.'),
        h('p', {}, 'Piano sound: ', h('a', { href: 'https://sfzinstruments.github.io/pianos/salamander', target: '_blank', rel: 'noopener' }, 'Salamander Grand Piano V3'), ' by Alexander Holm, licensed ', h('a', { href: 'https://creativecommons.org/licenses/by/3.0/', target: '_blank', rel: 'noopener' }, 'CC-BY 3.0'), ' (mp3 conversion as distributed with Tone.js).'),
        h('p', { class: 'muted' }, 'Everything runs locally in your browser; no audio leaves your device.'),
      ),
    );
  };
  render();
  return { el };
}
