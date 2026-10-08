# Decisions

Non-obvious choices made while building this overnight, with the alternatives
considered and why. Newest concerns at the bottom of each section.

## Pitch detection

**McLeod Pitch Method (own implementation), not YIN and not the `pitchy` package.**
- Alternatives: YIN (own implementation), `pitchy` (McLeod), spectral methods.
- Why: measured, not by reputation (`test/results/exp1-detectors.txt`, summarised in
  TEST_RESULTS.md §0). On clean recordings all three are ~100 % per frame. With the
  "phone" degradation (bass roll-off, room, noise) YIN dropped to 63–89 % in octaves 4–6
  with many non-octave errors; `pitchy` lost 5–14 % of frames to "no pitch"; our MPM
  was best or tied everywhere. Owning the code also gives access to the NSDF for the
  octave guard and lets us run the detector a second time on a comb-filtered frame.
  `pitchy` stays a devDependency only for the comparison experiment.

**Frame 2048 samples (~43 ms), hop 512 (~11 ms), detection range 62 Hz – 2.2 kHz.**
- 4096 was marginally more robust but halves time resolution, which hurts note
  segmentation. 2048 still gives > 2 periods at C2.
- 62 Hz lower bound = C2 at −50 cents. Below that is not needed (the trainer never
  asks for notes below C2) and it keeps 50/60 Hz mains hum from being "a note".

**Octave guard: two cues for "picked the half period".**
- (a) NSDF at the doubled period clearly higher than at the chosen period (+0.03);
  (b) energy at the half-integer harmonics (1.5·f0, 2.5·f0 …, skipping 0.5·f0 which
  collides with hum). Found from a real failure: a quiet C3 through a 220 Hz high-pass
  (thin phone mic) detected as C4 for 70 % of its frames.
- Note-level semitone voting on top, so isolated octave-error frames can't move a note.

**Comb filter for the still-ringing first note.**
- Problem: held key / pedal → the detector hears a chord. Alternatives: polyphonic
  detection (overkill), "ignore frames that equal the previous note" (fails when the
  mixture produces a third, wrong pitch — observed).
- Chosen: once a new onset is found, also run MPM on `x[n] − x[n−T₁]` (T₁ = period of the
  previous note), which cancels all of its harmonics. Validity checks: residual energy
  ≥ −12 dB (otherwise it was a re-strike/spurious onset).
- The one case a comb can't handle is the octave *above* (all partials coincide). For
  that: compare the old note's harmonic magnitudes before/after the onset; if only the
  even harmonics jumped (+6 dB relative), it's the octave.

- Tried and reverted: "if the comb-filtered and plain estimates are an octave apart,
  trust the plain one" (aimed at a few octave-too-low readings in the C5–C6 range).
  It dropped pedal/held-note accuracy from ~95 % to 86 %: under a ringing note the
  plain estimate is usually the wrong one.

**Onsets: level gate + spectral-flux peak + level jump + pitch change + "voiced run".**
- Flux alone was unreliable in noise (log-magnitude flux of noise is high); a sudden
  ≥ 6 dB jump is always an onset. Pitch-change onsets are needed for legato singing.
  "Voiced run" (≥ 6 of 8 frames periodic and agreeing, with a real level rise) catches
  notes that never clear the level gate in noisy rooms, but not steady hum/drones.
- Bare octave jumps without an attack are treated as detector errors in piano mode.

**A note needs ≥ 3 clearly periodic frames (clarity ≥ 0.75), else it is dropped.**
- Trade-off: in very noisy rooms some real notes are missed, but knocks, page turns
  and TV noise never become notes. A missed note costs a retry; a false note produces a
  wrong judgement, which is worse for trust.

**Voice: stable part = robust mean around the median, after skipping 60 ms of onset.**
- Frames within ±0.6 semitone of the median are averaged (vibrato averages out, scoop
  and glide frames fall outside). Measured median error 2–3 cents, p95 ≈ 8–12 cents
  on the synthetic voice, with scoops of up to 250 cents.

**The trainer's stopping rule lives in shared code (`AttemptListener`).**
- The harness streams audio through the same class in 512-sample chunks and stops when
  the app would. Early versions counted e.g. the first note re-appearing (pedal) after
  the second decayed as a segmentation error, which never matters in the app.

## Judging

**Intervals are judged on the raw difference of the two detected pitches, rounded.**
- Global piano detune cancels out (±50 cents tested). Intervals > 12 semitones are
  folded by octaves (cannot be a target, so it's an octave slip) and flagged.
- Direction counts: playing a fourth down when a fifth up was asked is wrong (same
  pitch classes, but a different interval). Measured octave errors were low enough
  (≈ 0–1 % per note outside the stress condition) to afford this strictness.

**Start key compared by pitch class, octave ignored, with tuning compensation.**
- Voice: you sing in your octave. Piano: playing the right key in another octave is
  fine (we say so). The piano's tuning offset is estimated (circular mean of the
  fractional cents of the last ~40 piano notes + current ones); at ~±50 cents both
  representatives are accepted because G+50 and G♯−50 are physically the same pitch.

**Incomplete attempts (0–1 notes heard) are not recorded in the statistics.**
- Usually a detection or "didn't play yet" problem, not a hearing mistake.

## Trainer

**The interval name is hidden until the answer (setting to show it).** The exercise is
to reproduce by ear; showing "perfect 5th" first would make it a theory exercise.

**Adaptive progression.** Start with M3, P5, P8 ascending (most distinct). Order after:
P4, m3, M6, M2, m6, m7, m2, M7, tritone. Unlock the next when the last 20 adaptive
attempts in that direction (since the previous unlock) are ≥ 90 % correct. Practice
weight per interval = 1 + 4 × recent error rate (+1.5 while it has < 5 attempts), the
interval just asked is down-weighted to avoid repeats.

**Descending unlocks** when ≥ 6 ascending intervals are unlocked and the last 30
ascending attempts are ≥ 85 % — "solid" was not defined; this means roughly half the
intervals are learned. Descending then starts with the same three. A setting forces
descending on earlier (uses the ascending set).

**Voice exercises keep both notes inside the user's singing range**, and are played
at the sung pitch (option: an octave higher). Default range G2–E4 (typical male voice).

**Piano range limits the start key only** (default C3–C5); the second note may go
outside, down to C2 / up to C7.

**Timing:** first note 0.9 s, second 1.2 s, 150 ms fade, then 300 ms of silence and
150 ms of ignored mic warm-up before listening. The harness tested 100/300/500 ms
gaps with a loud phone speaker next to the mic: no self-listening errors at any gap;
300 ms adds margin for real rooms.

**Screen wake lock** while training (phone on the music stand).

## Platform

**Vanilla TypeScript + Vite, no UI framework, no runtime dependencies.**

**Mic: AudioWorklet with ScriptProcessor fallback; analysis on the main thread.**
Lets the exact DSP code run in Node. Cost is a few ms per second of audio.

**iOS: "Release mic during playback" defaults ON on iPhone/iPad.** iOS may route Web
Audio to the earpiece or duck it while a recording stream is open. Releasing and
re-acquiring the stream per attempt avoids that at the cost of ~100–300 ms. Unverified
on a device — see QUESTIONS.md.

**Samples:** the Salamander mp3 set as distributed with Tone.js (C, D♯, F♯, A per
octave, C1–C7, 25 files, 1.8 MB). Max pitch shift ±1.5 semitones. Kept as-is rather
than re-encoded.

**Relative Vite base (`./`)** so the same build works on GitHub Pages under
`/<repo>/` and on any other static host. Hash routing for the same reason.

**Service worker generated at build time** (tiny Vite plugin) with a precache list of
every built file including all samples → fully offline after the first visit.

## Test harness

**Two independent real piano sources:** University of Iowa MIS piano (free to use, a
different instrument/recording, every note C2–C6 at mf, pp/ff every 4th note) and the
Salamander samples the app plays. Iowa files are downloaded by a script, not committed
(~40 MB).

**Synthetic voice:** additive harmonics through a DC-normalised 3-formant cascade
(an earlier parallel-formant version made the fundamental ~30 dB too weak, causing
unrealistic octave+fifth errors; fixed before tuning the detector on it).

**Scenario note range matches the app (C2–C7).** An early run showed ~88 % for pairs
starting in octave 2; almost all failures were descending targets below C2 that the
app never asks for (and the detector deliberately ignores, see the 62 Hz floor).

**End-to-end test in real Chrome** (`npm run e2e`): puppeteer-core drives the built
app with Chrome's fake microphone playing a WAV (Iowa piano pair, then a synthetic
singer), so AudioWorklet capture, getUserMedia constraints and UI are exercised too.

**Conditions:** clean; *phone* (150 Hz high-pass, 0.5 s room, 25 dB SNR); *noisy*
(220 Hz high-pass, 0.9 s live room, mains hum, 12 dB SNR) — the last one is a stress
test, not the expected use.
