# Interval Ear Trainer

A web app that trains **relative pitch**: it plays an interval (two notes with real
piano samples), you play it back on your acoustic piano — or sing it — and the app
listens through the microphone and tells you whether you got it right.

- **Piano and voice modes.** Voice rounds to the nearest semitone, shows cents,
  ignores which octave you sing in and judges only the stable part of each note.
- **Adaptive progression**: starts with major 3rd, perfect 5th, octave; unlocks the
  next interval at 90 % over the last 20 attempts; practises your weak intervals more.
  Descending unlocks once ascending is solid. Or pick intervals manually.
- **Start-key hint** on a small keyboard (hide it for a harder mode where only the
  interval counts).
- **Statistics**: accuracy per interval and direction, confusion matrix, trend over
  sessions; JSON export/import.
- **Mic Test** page: live note, cents, confidence, level meter, log of detected notes.
- Works offline (PWA), no backend, nothing leaves your device.

**First time? Open the Mic Test tab** and play a few single notes across your range
(and sing a few). Every note should show up in the log with the right name. If that
works, the trainer will too.

## Using it

- Put the phone on the music stand. On iPhone, add it to the home screen
  (Share → *Add to Home Screen*) for a full-screen app that works offline.
- Turn **silent mode off** on iPhone — it mutes web audio.
- Train → *Start*. Listen, then play the start key and the second note, one after the
  other. Single notes only, no chords. Keys: Enter/Space = next, R = replay.
- If the app sounds very quiet or comes out of the earpiece on iPhone while training,
  check Settings → *Release mic during playback* (on by default on iOS).

## Run locally

```sh
npm install
npm run dev          # http://localhost:5173 (microphone works on localhost)
npm run build        # production build in dist/
npm run preview      # serve dist/
```

Microphone access requires HTTPS or `localhost`. To try it on your phone from your
dev machine, use the deployed GitHub Pages URL (or `npx vite --host` behind an HTTPS
tunnel).

## Tests

```sh
npm test                  # unit tests (judge, progression, note math)
npm run fetch-fixtures    # once: downloads ~40 MB of Iowa piano recordings (needs ffmpeg)
npm run harness           # detection harness → TEST_RESULTS.md (~20 min)
QUICK=1 npm run harness   # quick subset, prints only
npm run build && npm run e2e   # headless Chrome with a fake mic playing piano notes
```

The harness feeds real piano recordings (two independent sample sets, C2–C6, with
overlap/pedal, noise, room reverb, phone-mic bass roll-off, ±50 cent detune) and a
synthetic singing voice (vibrato, onset scoop, glides) through the exact detection and
judging code the app uses. Results and known weaknesses: [TEST_RESULTS.md](TEST_RESULTS.md).
Design decisions: [DECISIONS.md](DECISIONS.md). Open questions: [QUESTIONS.md](QUESTIONS.md).

## Deploy (GitHub Pages)

The workflow in `.github/workflows/deploy.yml` builds and deploys on every push to
`main`. One-time setup for a new repository:

```sh
gh repo create interval-ear-trainer --public --source . --push
gh api -X POST repos/{owner}/interval-ear-trainer/pages -f build_type=workflow
```

(or: GitHub → Settings → Pages → Source: *GitHub Actions*). The site appears at
`https://<user>.github.io/interval-ear-trainer/`. The build uses a relative base path,
so it also works from any other static host or sub-folder.

## How detection works (short)

`src/dsp/` — pure TypeScript, shared by browser and Node:

1. **Frames** (`analyzer.ts`): 2048-sample frames every 512 samples. Level, McLeod
   pitch (NSDF via FFT), clarity, spectral flux. An octave guard catches the classic
   "fundamental too weak → one octave too high" error.
2. **Notes** (`segmenter.ts`): onsets from the level gate, spectral flux / level jumps
   (a new key while the old one rings), sustained pitch changes (legato singing) and
   periodicity in noise. A still-ringing previous note is cancelled with a comb filter.
   Each note's pitch comes from its stable part only (attack/scoop skipped).
3. **Judging** (`../trainer/judge.ts`): interval = difference of the two pitches, so a
   detuned piano doesn't matter; start key by pitch class with tuning compensation.

## Credits

- Piano samples: **Salamander Grand Piano V3** by Alexander Holm, licensed
  [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/)
  ([source](https://sfzinstruments.github.io/pianos/salamander)); mp3 conversion as
  distributed with [Tone.js](https://github.com/Tonejs/audio). 25 samples (C1–C7) are
  bundled in `public/samples/`.
- Test recordings (not bundled, downloaded by `npm run fetch-fixtures`): University of
  Iowa Electronic Music Studios, *Musical Instrument Samples* (piano).
