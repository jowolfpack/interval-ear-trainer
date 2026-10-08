# Test results — pitch detection & judging

Everything below was measured with the exact code the app runs (`src/dsp/*`,
`src/trainer/judge.ts`, `src/trainer/listen.ts`), fed in 512-sample chunks like the
browser's AudioWorklet delivers them, with the same stopping rule the trainer uses.
Regenerate with `npm run fetch-fixtures && npm run harness`.

**What it is not:** a test with your microphone, your room or your piano. The
recordings are close-miked studio samples that I degrade with filters, reverb and
noise; the voice is synthetic. Treat the numbers as "the logic works and is robust
to these effects", then confirm on the Mic Test page.

## Test material

| Source | What | Used for |
| --- | --- | --- |
| University of Iowa MIS piano | real recordings, every note C2–C6 at *mf*, plus *pp* and *ff* for every 4th note | independent instrument (not the app's own sound) |
| Salamander Grand V3 (the app's samples) | real recordings, one per minor third, pitch-shifted ≤ ±1.5 semitones like the player does | second piano |
| Synthetic voice | harmonic source + 3-formant vocal tract (4 vowels), vibrato, onset scoop, glides, drift, jitter, breath noise | voice mode |

Conditions applied on top:

- **clean** — as recorded.
- **phone** — phone on the music stand: 150 Hz high-pass (small mic, weak bass), 0.5 s room reverb (50 % wet), noise at 25 dB below the loudest half second.
- **noisy** — stress test: 220 Hz high-pass, 0.9 s live room (80 % wet), mains hum, noise only 12 dB below the loudest half second (the decaying second note is often < 8 dB above the noise).

Plus random overall level (0 to −30 dB), random global detune (±50 cents), both 48 and 44.1 kHz.

## 0. Choosing the detector (frame level, single notes)

Fraction of analysis frames (60 ms – 1 s after the onset, single notes C2–C6) that are
correct / octave error / other error / no pitch. Full output: `test/results/exp1-detectors.txt`.

| detector (2048-sample frames) | Iowa clean, octaves 2–6 | Iowa phone, octave 4 / 5 / 6 | Salamander phone, octave 4 / 5 / 6 |
| --- | --- | --- | --- |
| **McLeod (own)** | 99–100 % | 95 / 98 / 100 % | 95 / 97 / 91 % |
| YIN (own) | 99–100 % | 82 / 85 / 93 % (9 % octave err in oct. 4) | 88 / 82 / 63 % (28 % other err in oct. 6) |
| `pitchy` (McLeod) | 99–100 % | 92 / 93 / 95 % | 93 / 93 / 84 % |

McLeod was best or tied in every cell; YIN's errors grow quickly once the bass is
filtered and noise is added. 4096-sample frames were ~1 point better but halve time
resolution; I kept 2048 (~43 ms). The note-level stages below (octave guard, voting,
stable-part selection) turn these frame accuracies into the note accuracies reported next.

<!-- RESULTS -->

## 5. Summary and remaining weaknesses (honest version)

**Headline** (start-key hint hidden; with the hint the numbers are within 0.5 points):
piano pairs are judged correctly in **~99.8 % clean / ~98 % "phone" / ~93 % "noisy"**
scenarios; voice pairs **100 % / ~99 % / ~84 %**. The judge **never accepted a wrong
neighbouring interval** in clean/phone conditions (false accept 0.0 %), background
noise, knocks and 50/60 Hz hum produced **zero false notes**, and with the app's own
playback still decaying in the room the user's notes were segmented correctly in
~99 % of trials (gap 100–500 ms; the app uses 300 ms + 150 ms mic warm-up).

Known weaknesses, roughly in order of how likely you are to meet them:

1. **First note still ringing (held key or pedal) is the hardest piano case**
   (~95 % vs ~98–99 % for legato/staccato). The comb-filter trick removes the old
   note, but with a quiet second note under a loud first one the new note's pitch is
   sometimes taken from only a few frames, and a second note *an octave above* the
   first relies on a harmonic-profile heuristic. If you see misses, lift the first key
   before (or as) you play the second.
2. **Octave errors are rare but not zero** — ~0.5–1 % per note in the phone condition,
   mostly the second note an octave too low in the C5–C6 range, or too high in the
   bass when the mic has no low end. The judge folds > octave intervals back, but an
   octave-wrong note *inside* an octave changes the interval and is judged wrong.
3. **Very noisy rooms.** At ~6–8 dB SNR the second (decaying) piano note or a soft
   high sung note is often not detected at all — the app then says "Didn’t catch that"
   instead of guessing. This is by design (a note needs ≥ 3 clearly periodic frames).
4. **Voice onsets are soft**: the detected onset of a legato (gliding) second note is
   often 80–150 ms late. This doesn't affect the judged interval, only the segmentation
   statistic above (that's why voice "segmentation ok" is lower than "interval ok").
8. **44.1 kHz is ~3 points worse than 48 kHz** on piano pairs (94 % vs 97 %, mostly the
   noisy condition). Most phones and browsers run at 48 kHz; the Mic Test page shows it.
5. **A singer far off pitch.** Intervals are rounded to the nearest semitone; a "minor
   2nd" sung 60 cents narrow merges into one note, and anything ±50 cents off flips to
   the neighbouring interval. The cents readout shows how far off you were.
6. **Detuned piano**: intervals are immune; the start-key check needs a tuning estimate
   and is ambiguous for a piano that is ~a quarter-tone off (both readings accepted).
7. **Not covered by these tests**: real phone microphones (AGC that ignores our
   request, compression), unusual pianos (very old/honky-tonk strings, uprights with
   strong bass inharmonicity beyond the two sample sets), real singers (breathy, very
   low male voices, strong nasal formants), speech or other music in the room, and
   iOS-specific audio routing. Please check with the Mic Test page.
