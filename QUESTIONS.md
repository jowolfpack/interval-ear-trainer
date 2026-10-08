# Open questions

Things I couldn't decide or verify without you, your piano or your phone.

1. **Does detection work on your piano and voice?** Everything was tested against
   recordings and a synthetic voice, never against a real microphone in a real room.
   Please start with the Mic Test tab: play single notes from C2 to C6 (low notes and
   very soft notes are the riskiest), then sing a few. Tell me which notes come out
   wrong (and whether they're an octave off).

2. **iPhone audio routing.** While a microphone stream is open, iOS sometimes plays web
   audio quietly or through the earpiece. I made *Settings → Release mic during
   playback* default **on** for iOS (the mic is released while the app plays and
   re-opened afterwards). Is playback loud and from the speaker? If yes, try turning the
   option off: listening then starts a bit faster.

3. **Does iOS honour "echo cancellation / noise suppression / auto gain off"?** The Mic
   Test page shows what the browser actually applied under *Audio setup*. If any shows
   "ON ⚠", let me know.

4. **"Solid" for unlocking descending intervals** — I chose: at least 6 ascending
   intervals unlocked and ≥ 85 % over the last 30 ascending attempts. Too early or too
   late for you? (You can force descending on in Settings anytime.)

5. **Default voice range G2–E4** assumes a male voice. Set yours in Settings; should the
   app instead *find* your range (sing lowest/highest note)?

6. **Should the direction be told?** Currently the app never says "up" or "down" before
   you answer; once descending is unlocked you have to hear the direction. An option to
   show only the direction (not the interval name) would be easy to add.

7. **Wrong octave on piano.** If you play G3→D5 for "perfect 5th up from G3" the app
   folds it to a fifth and counts it (with a note that the octave looked off), because
   that's more often a detector octave error than a player error. Playing a fourth
   *down* for a fifth *up* counts as wrong. OK?

8. **Repo visibility.** I created the GitHub repository as **public** so GitHub Pages
   works on a free account. Make it private if you prefer (Pages then needs a paid plan).
