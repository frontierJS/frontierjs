---
id: band
status: proposed
dated: 2026-11-11
---

# Idea — the Haven band: a loft band that sounds like one

**Status: PROPOSED.** Dated 2026-11-11. Nothing here is built. Do not cite
this file as describing behavior — see `VERIFYING.md`. Work the plan from the
first open box.

**The ask.** Make Haven's music better: the sound of the loft's band, and the
songs it plays.

**Today.** `packages/haven/shared/band.js` draws song `k` from a seeded
generator. A song is one of eight progressions in a key, a tempo, a drum feel,
and a style for each part. It renders one bar at a time into five mono parts
and mixes them through `Math.tanh(x * 1.2) * 0.8` in `samples()`. The
instruments are:

- **Guitar:** Karplus-Strong.
- **Singer:** a sine wave plus two harmonics.
- **Keys:** a triangle wave.
- **Bass:** a one-pole-filtered saw.
- **Drums:** synthesized from noise and a swept sine.

There is no reverb, no stereo and no master bus, and nothing tests the band.
`#sound` pipes 16-bit mono PCM to `aplay`, `paplay` or `sox` in the terminal and
to Web Audio in the browser.

**Ruled in chat, 2026-11-11** (owner):

- **Stereo.** The band goes two-channel in both targets.
- **The almanac stays out.** Weather, season, time and moon do not touch the
  music in this plan.
- **Sound over ssh stays out.** The player stays on whatever machine runs Haven.
- **Instruments before songs.** The sound phases come before the composition
  phases.
- **The singer gets vowels.** It sings ooh, ahh and syllables like la and da.
  It does not sing words.
- **The focus is sound and songs.** Visuals, spatial mixing, the play-along idea
  and the other experiments are in § Ideas past the plan.
- **Space before harmony** (after hearing 1.2). The owner wants more drop-outs
  and more passages where one player stands alone, and wants them first among
  the composition phases: form, drop-outs and solos are Phase 3, and harmony,
  melody and groove follow as 4, 5 and 6.

## Shape

The band is a pure function of the wall clock: every screen computes the same
samples, and nothing is sent between them. Every step below keeps that, and
these are the rules that follow from it:

- **A linear effect runs inside `renderBar`, from zero state, per bar.** Reverb,
  filters and chorus are linear. Applying one to a bar's
  `barN * (1 + TAIL)` buffer and overlap-adding the bars gives the same result
  as applying it to the whole song, so a screen that joins mid-song hears what
  the others hear. An effect's tail must die inside `TAIL` bars. At the fastest
  tempo (124 bpm) that is 3.87 s.
- **A stateful nonlinearity never runs in `samples()`.** A compressor or limiter
  that carries state across pulls makes each screen's output depend on when its
  pulls began. If a limiter is needed, its gain must depend only on fixed blocks
  of the song-local sample index.
- **Modulation reads the song-local sample index (`b * barN + i`), not `i`.**
  An LFO that restarts every bar is heard as a seam at the bar line.
- **Discrete choices use whole numbers and the seeded generator only.** These
  are a chord, a note, a step or a section. Bun (JavaScriptCore) and the browser
  (V8) may differ in the last bit of `Math.sin` or `Math.exp`. Floating-point
  maths belongs to synthesis, where that difference cannot be heard.
- **A new song-level draw uses a generator of its own**, the way `slow` draws
  the strings piece. Then `songOf(k)`'s existing choices (progression, key,
  tempo, styles, hook) keep their numbers while Phases 1–2 are compared before
  and after. This covers `songOf` only. `renderBar`'s per-bar draws
  (looseness, how hard each note is played, ghost notes) change once, at 0.2,
  and 0.3's "before" recordings are taken after that. Phases 3–6 change songs
  on purpose, and a song number is then a draw from the new generator.
- **Bars render on the UI thread, inside a pull.** A bar that renders slower
  than the terminal's `AHEAD_MS` (300 ms in `sound.js`; the browser's copy
  in `sound.browser.js` matches) leaves a gap in the sound and drops a frame.
  The render budget is a hard number. It is set in 0.3 and rechecked at the
  end of every phase.

**What proves a change.** No suite pins the band, and while Haven is being
experimented on, no test file is added per feature. Checks work in three ways:

- **Listening.** `bun run band:wav` (0.1) renders the same five reference songs
  (#0 #1 #7 #42 #99, the set `scope.js` measured its `CEIL` against), and the
  owner compares old and new by ear.
- **Measurements.** A throwaway probe in the scratchpad measures what can be
  measured: tuning, render time and determinism.
- **The browser.** A change to `sound.browser.js` is proved by
  `bun run verify:browser` as well.

The same samples on every screen is unenforced: 0.2's chunk-size probe runs
once and is not kept. When the owner says Haven's design has settled, that
probe becomes the band's first test.

**Traps that apply to every step:**

- A gain changed in `band.js` moves its part's `CEIL` in `scope.js`; re-measure
  it, or the scope pins or goes flat.
- A part's bus is also what `levels` reads for the scope, so a send to the reverb
  is taken after the peak is read.

## Plan

### Phase 0 — A listening bench

Goal: hear any song, part and bar span outside Haven, and know what a bar costs
to render.
Done when: `bun run band:wav 42` writes a stereo-ready WAV and prints each bar's
render time, and the worst bar of the five reference songs is recorded under 0.3.

- [x] 0.1 `bun run band:wav <k> [--from bar] [--bars n] [--solo part]` renders
  through `createBand()` to a gitignored folder and prints the WAV path and the
  render time per bar. `--solo` mutes every other part before the mix. — done 2026-11-11: `scripts/band-wav.mjs`; also `--out <dir>`; `createBand({ solo })` threads to `renderBar`; the WAV header follows the channel count `samples()` returns.
- [x] 0.2 Give each part its own generator in `renderBar`, seeded from
  `(k, b, part)`. Today one `rand` feeds all five parts, so changing the guitar
  re-rolls the drums' looseness and the comparison stops being fair. A probe
  confirms that pulling one span in different chunk sizes and from different
  start points gives identical samples. — done 2026-11-11: five generators seeded from `(k, b, part)`. Probe on songs 42 and 99, bars 0-6: pulls of 441, 4410 and a bar are byte-identical; a start at bar 3 matches bars 3-6 of a start at 0; the five solos sum to the full mix pre-tanh within 3.6e-7. Probe deleted.
- [x] 0.3 Baseline: render the five reference songs after 0.2 and before any
  other change, and keep them as the "before" side of every comparison. Record
  the worst-case bar render time and the budget: the worst bar must stay under
  a third of `AHEAD_MS`. The slow strings piece at 54 bpm renders about 13 s of
  audio per bar, so it is the likely worst case. — done 2026-11-11: baseline in `packages/haven/.wav/baseline/` (songs 0, 1, 7, 42, 99 and strings song 4). Worst bar 422 ms (song 4 bar 9; reruns 306-307 ms), against the budget `AHEAD_MS / 3` = 100 ms: OVER. Every song's mean bar is 116-197 ms, also over; worst per song 205-344 ms.

### Phase 1 — In tune, in stereo, in a room

Goal: the band plays in tune, in stereo, in a space, glued into one mix.
Done when: a probe measures the guitar within 1 cent across its range, the band
is heard in stereo through `aplay`/`paplay`/`sox` and the browser
(`verify:browser` green), the owner accepts the five reference songs compared
with 0.3, and the worst bar is within budget.
Owner's A/B: `.wav/baseline/` vs `.wav/phase-1/` (songs 0 1 7 42 99 4); worst bar 95 ms at load 8.

- [x] 1.0 Render inside the budget, with the sound unchanged. 0.3 found every
  song over it (worst 205–422 ms against 100 ms), and a profile of song 42 put
  a third of a bar in `done()`'s mix-and-peaks pass over the whole
  `barN * (1 + TAIL)` buffer, a sixth in `add()`'s per-sample closure call and
  a seventh in `samples()`'s per-sample loop; the synthesis itself is the
  minority. Ruled 2026-11-11 (`decision-rules`, A over raising `AHEAD_MS`,
  loosening the rule or a Worker): fix the code first and amend the rule only
  in writing if the fix falls short.
  - Track the span each part wrote and mix, peak and tanh only that span;
    loop per `BLOCK` without a division per sample; let `add` hand `fn` a
    block rather than a sample where a voice allows it.
  - If that is not enough, render ahead: a pull that first touches bar `b`
    renders one part of bar `b + 1`, so a pull pays a fifth of a bar. The
    output cannot depend on when a bar is rendered, only on `(k, b)`, so this
    keeps every screen alike.
  - Proof: `band:wav` of songs 42, 99 and 4 byte-identical to `.wav/baseline/`
    after the change, and the worst bar re-measured. If it still misses 100 ms,
    Q1 is the owner's. — done 2026-11-11: `add` records each part's span, `done` mixes and peaks only there per `BLOCK` and returns `until`, `samples()` adds held bars span-wise into a float64 run; no render-ahead. Songs 0, 1, 7, 42, 99 and 4 byte-identical to baseline (`cmp`). Worst/mean ms, one pull per bar, machine at load 7-20 from other sessions: before 77/50, 106/58, 104/63, 134/62, 134/72, 186/107; after 86/41, 82/42, 71/46, 68/37, 80/39, 105/51 (songs in that order, song 4 last; song 4 reruns 84-135). Best of three per bar, same code before and after, load 4-13: before worst 78-123, song 4 87-91; after (stereo) worst 50-60, song 4 77. Phase 0's 205-422 was load-inflated; a cold-machine run of song 4 is still owed.
- [x] 1.1 Tune the guitar. The string's loop runs half a sample long (from the
  averaging filter) and rounds its delay to a whole sample. Measured 2026-11-11:
  every note comes out 5–16 cents flat, while the keys sit 3.5 cents sharp
  (`* 1.002`). Fix it with a fractional-delay allpass in the loop
  ([Jaffe & Smith via Smith, *Extended Karplus-Strong*](https://ccrma.stanford.edu/~jos/pasp/Extended_Karplus_Strong_Algorithm.html)). — done 2026-11-11: the loop was half a sample SHORT, not long: the in-place average `0.497 * (buf[j] + buf[j + 1])` reads one sample ahead, so the delay is `N - 0.5`, and the probe measured 0 to +23 cents SHARP (62-81 mean +10.5), not flat. `N = floor(RATE / f)` and an allpass of `RATE / f + 0.5 - N` samples (`C = (1 - d) / (1 + d)`). Probe over MIDI 62-81 (Goertzel, 0.5 s window from 50 ms): before +0.0 to +23.3 cents, after -0.02 to +0.02. `CEIL` guitar 0.35 reads low: loudest 50 ms column over songs 0, 1, 7, 42, 99 is 0.363 before and 0.367 after, which clips the top glyph by 0.4 dB and was left alone. The keys' `* 1.002` is left for 2.2.
- [x] 1.2 Stereo. `renderBar` returns two channels.
  - Each part is panned constant-power by where it stands on the loft's stage
    (`PARTS` order, left to right), with kick, bass and singer held near the
    centre.
  - `samples()` answers two channels, and both `#sound` targets take them:
    `-c 2` / `--channels=2`, and `createBuffer(2, …)`.
  - `levels` stays per part, so the scope is unchanged.
  - The home radio plays the same stereo. — done 2026-11-11: `PAN` beside `PARTS` (guitar -0.55, singer -0.12, drums +0.15, bass +0.08, keys +0.55), `channels` in both `stream`s, `Band.mesa` passes 2, the WAV header says 2 channels; owner's ear: `packages/haven/.wav/1.2/` songs 0, 1, 7, 42, 99, 4 against `.wav/baseline/`. `aplay -c 2` and `paplay --channels=2` accept one second of interleaved silence on stdin (exit 0 and 0; `play` not installed). `verify:browser` all passed, but it never plays the band, so the `createBuffer(2, …)` path is unheard. Worst bar after stereo, best of three, 77 ms (song 4), the other five 50-60 ms.
- [x] 1.3 Reverb on a send bus inside `renderBar`.
  - Use stereo Freeverb: eight combs and four allpasses per channel, the right
    channel's lengths 23 samples longer. The constants are in Jezar's
    `tuning.h`: [mirror](http://dosbox-x.com/doxygen/html/tuning_8h_source.html),
    [Smith on Freeverb](https://ccrma.stanford.edu/~jos/pasp/Freeverb.html).
  - Send levels: guitar, singer and keys wetter; drums drier; bass dry.
  - The tail dies inside `TAIL` bars at 124 bpm, or `TAIL` grows. A larger
    `TAIL` also widens the bars `samples()` holds per sample and the
    `bars.size > TAIL + 2` cache, not only the render length, so the budget is
    rechecked.
  - Run the reverb only over the span the bar's dry signal can reach, since it
    triples the length a bar renders. — done 2026-11-11: `reverb` in `band.js`, Freeverb from zero state inside `done()`, four combs or four allpasses stepped together per pass (a third faster than one line a pass). Sends (`SEND`): guitar 0.30, singer 0.35, keys 0.28, drums 0.10, bass 0; comb feedback 0.84, damping 0.2, one `WET` gain of 2.5, which puts the return about 14-15 dB under the dry mix (at 1 it was 22 dB under and inaudible). Probe, one impulse through the bus: the envelope is under -60 dB from 1.03-1.07 s, -80 dB at 1.5 s (`RT_SAMPLES`, the length a bar stops running it), -101 dB at 2 s; the slope is about 44 dB a second, RT60 about 1.4 s. `TAIL` stays 2 (3.87 s at 124 bpm). The reverb runs from the first sample a sending part wrote to its last plus `RT_SAMPLES`; `until` covers it. Time per bar, best of three, load 6-8: worst/mean 95/61 ms song 0, 75/57 song 1, 75/57 song 7, 92/57 song 42, 88/57 song 99, 91/69 song 4 (before this step 50-60 worst, song 4 77). One-line-a-pass reverb had song 4 at 113 worst/88 mean.
- [x] 1.4 Saturation and a master clip. Saturate the bass and kick per part
  (memoryless `tanh`, so deterministic), and tune the master `tanh` in
  `samples()` against the louder stereo mix. Add a limiter only if 0.3's peaks
  show one is needed, and then only under the stateful-nonlinearity rule in §
  Shape. — done 2026-11-11: `SAT.bass` drive 1.6 and `SAT.kick` drive 1.4 (`tanh(d x) / tanh(d)`, inside each voice's `fn`). Pre-tanh peak per channel (L/R) before the step (1.2): song 0 1.07/1.36, 1 1.33/1.61, 7 1.10/1.41, 42 0.90/1.08, 99 0.96/1.09, 4 0.37/0.47; after reverb and saturation 1.16/1.49, 1.48/1.71, 1.11/1.46, 1.04/1.17, 1.03/1.20, 0.42/0.49 (R is the louder side: drums and keys stand right). The 99.9th percentile sits at 0.74-1.0 on the band's songs. Master `tanh(x * 1.2) * 0.8` became `MASTER_DRIVE` 1 and `MASTER_CEIL` 0.9: output peaks 0.70-0.84 against 0.67-0.77, loudest 99.9th percentile 0.69 against 0.67, quiet bars the same. No limiter: the peaks are rare spikes the `tanh` takes, and a limiter's state would depend on the pull. `CEIL` in `scope.js` re-measured over songs 0 1 7 42 99: guitar 0.37, singer 0.18, drums 1.87 (was 1.75), bass 0.50 (0.44), keys 0.22.
- [x] 1.5 One filter for every part: a zero-delay-feedback state-variable filter
  ([Zavalishin, *The Art of VA Filter Design*](https://www.discodsp.net/VAFilterDesign_2.1.2.pdf)).
  Phase 2's voices take it: a resonant envelope on the bass, and a band-pass for
  the snare and hats. Here it only replaces the bass's one-pole filter, and that
  change is compared by ear. — done 2026-11-11: `svf(Q)` in `band.js` answers the low-pass and leaves `.band` and `.high` on the function. The bass takes it as a low-pass from 1200 Hz down to 160 Hz (`160 + 1040 * exp(-12 t)`, stepped every 32 samples), Q 0.9. Solo bass, before (the 1.4 state) and after: `packages/haven/.wav/1.5/song-42-bass-before.wav` / `-after.wav` and `song-99-bass-before.wav` / `-after.wav`. By measurement they differ little: peak 0.334 to 0.323 and 0.239 to 0.248, rms 0.0604 to 0.0611 and 0.0709 to 0.0721.

### Phase 2 — The instruments

Goal: each part has a voice of its own.
Done when: each step's part is compared old against new soloed (`--solo`) and in
the mix on the five songs, the owner accepts each, `CEIL` is re-measured, and
the worst bar is within budget.
Owner's A/B: `.wav/phase-1/` vs `.wav/phase-2/` (songs 0 1 7 42 99 4; `.wav/2.7/` is the state before 2.5, 2.6 and 2.8); per-pull worst, 4410-sample pulls from a cold process, excluding pull 0: song 0 39.6 ms (158.7 once, a load spike), 1 37.7, 7 38.0, 42 46.1, 99 45.4, strings 4 64.3, at load 3-5.

- [x] 2.1 Guitar: the rest of extended Karplus-Strong. Add a pick-position comb,
  brightness that rises with how hard the note is played, a string-damping
  filter, and stiffness on low strings. — done 2026-11-11: the pluck is noise
  through a one-pole whose cutoff is 1.8 kHz to 7.2 kHz by `vel`, then the comb
  `e[n] - e[n - P]` with `P = round(mu N)`, `mu` a draw from `[.10 .15 .20 .25 .30 .35]`,
  rescaled to one rms so colour changes and loudness does not. The loop is the
  damping zero `(1 - S) x[n] + S x[n - 1]` at S 0.5 (linear phase: half a sample at
  every frequency, so the 1.4 tuning allpass stays) and `rho = 0.001 ** (1 / (f T60)) / cos(w / 2)`
  (the division gives back what the zero takes from the fundamental), `T60` 2.5 s at
  MIDI 50 to 1.2 s at 80. Measured fundamental T60 (Hann-Goertzel, 100 ms steps) 2.6 s at
  50, 2.4 at 55, 2.0 at 65, 1.8 at 70, 1.4 at 80. A note now lasts `0.8 T60` with a 60 ms fade.
  Tuning, Goertzel scan +-40 cents in 0.5 steps over 0.5 s from 50 ms: worst error 0.0
  cents on song 42 bars 2-5 (notes 65 67 70 73 75) and song 99 bars 2-5 (64 65 67 69 70 72 74).
  Stiffness is a dispersion allpass `a = -0.8 min(1, (60 - note) / 6)` below MIDI 60, its
  delay at the fundamental taken off the string's length: note 45 stretches partial 10 by
  +5 cents, note 52 by +13.5, the fundamental stays 0.0. The guitar plays MIDI 62-81
  (chord voicings sit at 64-75, the melody at 62-81), so no note it plays is below 60 and
  the stiffness is never heard. Per-bar ms, best of 3, load 2.6-3.0: song 42 worst 64.9 to
  82.1 and mean 47.9 to 54.0; song 99 worst 66.2 to 65.0 and mean 49.0 to 47.3.
  WAVs: `packages/haven/.wav/2.1/before/` and `after/`, `song-42-solo-guitar.wav` and `song-99-solo-guitar.wav`.
- [x] 2.2 Keys: an FM electric piano. A 1:1 operator pair gives the body, a 14:1
  pair with a very short envelope gives the tine, and how hard a note is played
  sets the modulation index
  ([Yamaha, *FM 101 part 5*](https://yamahasynth.com/learn/synth-programming/fm-101-part-five-expanding-your-sound/)).
  The pad keeps its own warmer voice: detuned saws through the 1.5 filter.
  — done 2026-11-11: stabs and backbeat are `sin(ph + idx e^(-6t) sin(ph))` with `idx` 1.5 to 2.5
  by `vel`, plus a tine `sin(ph + 0.8 sin(14 ph)) e^(-16t)` (a 14:1 modulator, about 60 ms)
  at 0.3 of the body, under `min(1, 400t) e^(-4t)` and a 30 ms release at `len`; the
  `* 1.002` is gone and the phase is an accumulator. The pad is three saws at -c, 0, +c cents
  (`c` 4-7, a whole-number draw per note) through `svf(0.7)` with the cutoff 400 to 1800 Hz
  over the first second (eased, set every 32 samples), the old envelope shape. Three saws
  stayed; song 4 did not need two. Gains 0.06 (piano) and 0.065 (pad) put each style's
  loudest 50 ms column at the old one: stabs 0.218 (was 0.215), backbeat 0.191 (0.209), pad
  0.177 (0.177). Per-bar ms, best of 3, load 2.2 to 1.6, with 2.1 and 2.3 in the new
  column: song 42 worst 55.5 to 61.2, mean 42.8 to 51.2; song 4 worst 90.4 to 72.7 (the
  old worst is a one-bar outlier), mean 56.6 to 62.8. The pad's cutoff sweep starts over at
  each bar's re-struck note, so it breathes once a bar. WAVs: `packages/haven/.wav/2.2/before/` and
  `after/`, songs 42, 99 and 4 (`song-<k>-solo-keys.wav`).
- [x] 2.3 Bass: drive, plus a filter envelope on the 1.5 filter, so each note
  opens and closes. The song draws whether it is round or growling. — done 2026-11-11:
  `songOf` draws `bassVoice` once from its own generator (`rng(Math.imul(k, 0x165667b1) ^ 0xb455)`),
  and `about` says it. Round: peak cutoff 900, floor 160, `exp(-12t)`, Q 0.8, drive 1.4.
  Growl: a second saw a fifth up at 0.25, peak 2400, floor 180, `exp(-7t)`, Q 1.6, drive 2.2.
  Peak cutoff follows `vel` by +-20%. Gain stays 0.32: loudest 50 ms column 0.372 (growl)
  and 0.442 (round) against 0.37 to 0.46 before. Songs 0 and 7 drew growl; 1, 42, 99 round
  (the strings piece, #4, round). `CEIL.bass` 0.50 to 0.44. Per-bar ms, best of 3, load 1.6:
  song 42 worst 55.5 to 61.2, mean 42.8 to 51.2; song 99 worst 57.8 to 66.4, mean 43.2 to
  51.5 (all of 2.1 to 2.3 together); songs 0, 1, 7 worst 60.6, 61.9, 63.4, mean 48.1,
  47.5, 51.3. WAVs: `packages/haven/.wav/2.3/before/` and `after/`
  (`song-<k>-solo-bass.wav`, 42 and 99), and the six whole songs `packages/haven/.wav/2.3/song-{0,1,7,42,99,4}.wav`.
- [x] 2.4 Drums. — done 2026-11-11: kick rests on `hz(tonic + 24)` (33-62 Hz; under 40 Hz the
  octave above, so 41-78 Hz overall), sweeps from 2.5 octaves above at `exp(-30t)`, body `exp(-7t)`, a
  1.8 kHz beater click under `tanh(4 e^(-900t))^2` (gone by 5 ms), `SAT.kick` after. Snare: sines at 180 and 330 Hz
  (`exp(-25t)`) under noise through `svf(1.2).band` at 2.0, 2.8, 3.4 or 4.0 kHz by `vel`, `exp(-18t)`, ghost path
  kept. Hats: six squares (205.3 to 800 Hz, phase accumulators, no cache needed) through `svf(2).band` at 7, 8 or
  9 kHz by `vel`, then a first difference, `exp(-90t)` closed and `exp(-10t)` open. `tom(t0, pitch, g)`, pitches
  `TOM` 220/160/110; heard once: on every other fill (`Math.floor(c / qLen) % 2 === 1`) the fill's last two
  climbing sixteenths are the high and the low tom instead of snares. Solo drums rms 0.122 to 0.128 (song 42),
  0.144 to 0.148 (99), 0.205 to 0.214 (0); the 8 kHz air thinned (second-difference rms 0.070 to 0.019 on 42)
  and the 700 Hz-up body fattened (0.030 to 0.041). `CEIL.drums` 1.87 to 1.93. Per-bar ms, best of 3, load
  2-5 (noisy): song 42 worst 96.6 to 83.6, mean 60.3 to 63.2; 99 worst 88.8 to 77.4, mean 64.1 to 57.8; 0 mean
  54.4 to 62.8; per-pull worst 24.5 to 22.6 (42), 22.2 to 20.7 (99), 26.3 to 29.4 (0). WAVs:
  `packages/haven/.wav/2.4/before/` and `after/` (`song-42-solo-drums.wav`, `song-99-solo-drums.wav`).
  - Kick: tuned to the song's root, with a `tanh`-squared attack.
  - Snare: a tuned body under band-passed noise.
  - Hats: six detuned square waves through a band-pass, the 808 recipe, in place
    of plain noise.
  - Toms, so the fills in 6.1 have something to roll on.
- [x] 2.5 The singer sings vowels. — done 2026-11-11: `FORMANTS` is Csound's table, 3 voices (soprano, alto, tenor) x 5 vowels
  (a e i o u) x 5 formants of whole `[Hz, dB, bandwidth Hz]`. `songOf` draws `voice` and `vowel` from its own generator
  (`rng(Math.imul(k, 0x2c1b3c6d) ^ 0x51d6)`, all five vowels, so `a` is drawn too), and `about` says them; the chorus and the
  ending bar sing `a` whatever the song's is. The source is a Rosenberg glottal flow (open 0.4, closing 0.16 of the period) differenced
  (no DC, a closing kink), vibrato 5.5 Hz at 0.5% from 0.3 s, jitter a random point each 100 ms (+-0.3%, drawn per note from the
  singer's generator, joined linearly) and breath noise at about -30 dB, through five parallel `svf(F / BW).band` filters scaled to
  `10^(dB/20) BW / F`. A syllable is drawn per note: la (F1 and F2 glide from 350 and 1000 Hz over 35 ms, stepped every 32 samples),
  da (a 10 ms noise burst through `svf(2).band` at 3.5 kHz, the voicing 10 ms late) or ooh (the `u`). Gain 0.13 to 0.11:
  solo singer rms 0.0360 to 0.0364 (song 42, +0.1 dB) and 0.0427 to 0.0481 (song 99, +1.0 dB); the pulse is peakier (peak 0.22 to
  0.31 and 0.19 to 0.39), so `CEIL.singer` 0.18 to 0.40. A long-term spectrum over chorus bars shows peaks at the `a` formants
  (song 0, tenor: 650 and 1050 Hz) among the harmonics; it is no measured vowel match. Singer part per bar, load 3-5:
  mean 8.4-10.4 ms, worst 18-30 ms on band songs. WAVs: `packages/haven/.wav/2.5/before/` and
  `after/` (`song-42-solo-singer.wav`, `song-99-solo-singer.wav`).
  - The source is a pulse with vibrato, jitter and breath noise, through 3–5
    parallel resonators set to vowel formants. The tables are Csound's
    soprano/alto/tenor values ([formant values](https://csound.com/manual/misc/formants/)).
  - The voice and vowel are drawn per song from a second generator. The chorus
    opens to "ahh".
  - A syllable is a short consonant burst into a vowel glide: la, da, ooh.
  - The bowed voice of the strings piece is untouched; it is 2.6's.
- [x] 2.6 The strings piece as an ensemble. — done 2026-11-11: four voices, fixed, not drawn: `ENSEMBLE` detunes -9, -3, +4, +10
  cents, onsets 0, 14, 27, 38 ms late, vibrato 4.9, 5.2, 5.5 and 5.8 Hz, each in `PART.singer` at gain 0.035 (the one
  `bow` was 0.09; solo rms 0.0447 to 0.0458, +0.2 dB). The singer stays one mono part (five lanes), so the spread is the chorus's and the
  reverb's, not a pan: `thicken` mixes a delay of 12 ms, swung 3 ms at 0.35 Hz, under the dry at 0.8 over the part's span from zero state,
  its swing read from `b * barN + n`, knotted every 32 samples. Each voice's phase is a phasor turned by a rotation set every
  32 samples (two trig calls a 32 samples, not two a sample, four times over). Applied only when `song.ensemble === 'strings'`. The pad
  and held bass are as they were. Song 4 singer part per bar, load 4-5: mean 25.8 ms, worst 58.9 (over the ~40 ms aimed at, at load 4-5). WAVs: `packages/haven/.wav/2.6/before/` and `after/` (`song-4-solo-singer.wav`),
  `packages/haven/.wav/2.6/song-4.wav` (the full mix).
  - 3–5 detuned bowed voices spread across the stereo field.
  - A chorus whose LFO reads the song-local sample index.
  - The pad and held bass underneath stay.
- [x] 2.7 Bells for the ending bar and the strings piece: a modal voice of 3–6
  decaying partials at bell ratios (about 1, 2.76, 5.40, 8.93). `bell.js` is the
  kitchen's and stays its own. — done 2026-11-11: `bell(t0, note, len, gain)` in `band.js`, six partials at
  1, 2.76, 5.40, 8.93, 11.34, 13.34, levels `0.6^i`, decays `1.2 + 0.6 i` a second, the upper five
  `1 + 2e^(-300t)` louder for the first 10 ms, light `tanh` (`SAT.bell`, drive 1.2), no hum. In the keys'
  bus. Heard: every ending bar on the tonic at `S * 12`, gain 0.07; the strings piece's bars 2 up on the chord
  root (`60 + pc`) at `c % 4 === 0`, gain 0.05, a bar long. Solo keys peak/rms: song 4 0.153/0.0229 to
  0.156/0.0238, song 42 bars 59-60 0.109/0.0214 to 0.129/0.0240; `CEIL.keys` unmoved (0.223).
  WAVs: `packages/haven/.wav/2.7/before/` and `after/` (`song-4-solo-keys.wav`,
  `song-42-from59-bars2-solo-keys.wav`), and the six whole songs `packages/haven/.wav/2.7/song-{0,1,7,42,99,4}.wav`
  (the full mix after 2.9, 2.4 and 2.7, for A/B against `.wav/2.3/`).
- [x] 2.8 Just intonation within a chord: tune each chord's third and fifth as
  ratios of its root (4:5:6 major), and bend the melody's chord tones to match.
  Kept only if the comparison hears it; the difference is about 14 cents on a
  major third ([five-limit tuning](https://en.wikipedia.org/wiki/Five-limit_tuning)).
  — done 2026-11-11 (the owner's ear decides): `tuned(note, chord)` returns the root's ratio for a note whose pitch class is the
  chord's third (5/4 major, 6/5 minor) or fifth (3/2) and the equal-tempered pitch for the root and for everything else, so a
  seventh needs no ratio (the chords are triads). The bar's chord is hoisted to the top of `startBar` (the ending's is the tonic's) and every
  voice takes its pitch from it: keys (`piano`, `warm`), the pad, the bass, and also the guitar and the sung and bowed
  melody, whose notes are chord tones on a downbeat (`snap`) and on any other beat that falls on one. The bell stays equal.
  Measured on song 4 bar 0 (G major, pad, keys solo, 2-3.5 s, the envelope of the band around the shared partial, saws
  detuned 0 so the saws' own beating is out of the way): root h3 against fifth h2 (588 Hz) ripples 0.6 Hz at 24.7% equal and 0.7 Hz at
  0.4% just; root h5 against third h4 (980 Hz) ripples 7.8 Hz at 32.2% and then 1.3 Hz at 0.3%; at 1176 Hz 34.7% to 0.2%. With
  the pad's real +-4-7 cent saws the ripple stays (depth 42.6% to 39.4% at 588 Hz and 49.1% to 44.4% at 980 Hz; the strongest ripple 2.3 to 0.4 Hz and 2.9 to 2.3 Hz), because the saws'
  own beating covers it. WAVs: `packages/haven/.wav/2.8/before/` and `after/` (`song-42-bars8-solo-keys.wav`, `song-4-solo-keys.wav`),
  and the full `packages/haven/.wav/2.8/song-42.wav`, `song-4.wav`.
  **Owner:** **A** keep (default; the clean chord ripple 0.7-7.8 Hz at 25-32% to under 1%) · **B** revert to equal temperament
  (delete `tuned`, take `hz(note)` back in the five voices). **Recommend A**: the measured change is large where it can be heard
  on a plain chord and small under the pad's saw detune; if the pad is the only place you listen, the case for it is thin.
- [x] 2.9 Render ahead, by part. Added 2026-11-11 after 2.3: the best-of-3 bench
  holds under 100 ms, but a single cold pull does not (song 4 bar 2 read
  165 ms, its mean 95 ms, at load 3), and 2.4–2.7 add voices. A pull that
  first touches bar `b` also renders one part of bar `b + 1` not yet rendered,
  so a part is paid per pull and the mix-and-reverb pass (about 30% of a bar)
  is paid once when the bar completes; the per-pull worst becomes about the
  largest of the two. A bar's samples depend on `(k, b)` alone, never on when
  it was rendered, which keeps every screen alike. Proof: `band:wav` output
  byte-identical to the renders before it, and the single-pull worst re-measured.
  — done 2026-11-11: `startBar` answers `{ part(p), finish() }` (`renderBar` is its one-shot);
  `samples()` takes one step per call on the bar after the last it touched (a part, then the mix),
  never past the song's last bar and never under a different cue. Parts are order-free: every
  draw is from `rands[part]`, the walkers and the drums' ghost note included. Byte-identical: yes
  (`cmp` of songs 42, 99, 4 against `.wav/2.3/`; a song 42 pull of 4410 sample chunks over bars 0-8 and the
  whole of songs 4 and 42 hash alike on the old and the new code). Per-pull worst, in-process best of 3: song 4
  112.3 to 39.8 ms, song 42 91.3 to 24.5 (load 2-5). A cold process still pays bar 0 whole on its first pull
  (85-109 ms with JIT warm-up), then at worst 44 ms. Song 4's keys pad is one part of 74-85 ms alone, so
  its pull is bounded by that, not by a fifth of a bar; under the budget, so it stays one step, and
  splitting the pad into a step per note is the move if a gap is ever heard on the strings piece.
  Verified by the main thread: every sample of songs 42, 4 and 0 pulled in 4410-sample chunks equals
  the one-bar-per-pull render, both channels; per-pull worst at load 3: song 42 33 ms, song 4 52 ms,
  song 0 59 ms. `CEIL.guitar` 0.37 to 0.45 and `CEIL.bass` 0.44 to 0.47, left stale by 2.1 and 2.3.

### Phase 3 — Form, drop-outs and solos

Goal: no two songs are built alike, every song has silence in it, and every
song has a passage where one player stands alone.
Done when: `/songs 0` lists songs with different forms; each of three songs
drawn by the new generator has at least one drop-out and one solo passage, and
the soloist is not the guitar in all three; the owner listens to the three
whole and accepts them.
Owner's A/B: `.wav/phase-2/` vs `.wav/phase-3/` (songs 0 1 7 42 99 4; `.wav/3.2/` is the state before 3.3); the per-solo pairs `.wav/3.3/before/` vs `.wav/3.3/after/`; per-pull worst, 4410-sample pulls from a cold process, after pull 0: song 0 55.3 ms, 1 56.6, 42 72.9 (pull 0 127, 124 and 334 at load 5-6), the worst bar in a solo 18.9, 51.4 and 55.9.

- [x] 3.1 A form per song. `songOf` draws a section table that fills the song's
  bar count, from intro, verse, pre-chorus, chorus, bridge, breakdown, solo,
  last chorus and outro, with sections of 4 or 8 bars. `sectionOf` reads the
  table. A **breakdown** is a section one or two parts carry alone. The
  **soloist** is drawn per song from guitar, keys, bass and singer, so the guitar
  is one soloist in four, not the only one. `SONG_MS` stays fixed, because cue
  arithmetic depends on it.
  — done 2026-11-11: `songOf` draws `song.form` (`[{ kind, from, bars }]`, `song.formCode` like `I V P C ...`: I intro, V verse, P
  pre-chorus, C chorus, B bridge, K breakdown, S solo, L last chorus, O outro) from a generator of its own (odd constant
  `0x6a09e667`), so tonic, feel and voices keep their numbers. The grammar: intro (4) -> two rounds of verse (8), pre-chorus (0 or 4),
  chorus (8) -> a middle of solo, bridge + solo or breakdown + solo (4 or 8 each) -> optionally a third round -> last (8) ->
  outro. The sizes are drawn, then the nearest set leaving the outro 2 to 11 bars is taken (an 8-bar intro is the last resort); a
  probe over songs 0..1999 (1675 band songs) finds every form summing to `bars - 1` (60 to 90) and every outro 2 to 10 bars.
  `sectionAt(song, b)` answers `{ kind, from, bars, index, first, last, n }` (`n` the section's place in the form, for the toms'
  every-other-section rule), `sectionOf` its kind; the strings piece and the ending bar have none, and the strings piece keeps no form in this step.
  `startBar`'s fill is a section's last bar (not the outro's). `VOL` gains intro, prechorus, breakdown, last (1, the chorus's) and
  outro (falls from 1 to 0.6 over its bars). The soloist is drawn per song (`song.soloist`); the solo section is still the guitar's
  walker for all four (3.3 gives each its own voice, noted in the code). A breakdown is drawn per song (`song.breakdown`:
  drums and bass, keys and singer, guitar and singer, or bass and hat-only drums). `/songs` appends the form code, `about` names it and
  the soloist. Songs 0..7 are 6 band songs with 5 distinct codes (0 and 1 share `I V P C V P C B S V C L O`, with different section sizes) plus strings 4 and 6; over
  songs 0..199 there are 33 distinct codes among about 170 band songs. Forms: #0 and #1 `I V P C V P C B S V C L O`, #7 `I V P C V C S V P C L O`,
  #42 `I V C V P C K S L O`, #99 `I V C V P C S L O`. **Fork for the owner:** the brief's middle list had bridge alone and breakdown alone; those draw songs
  with no solo (2 of the 5 reference songs did), so every middle holds a solo here. **A** keep (every song has a solo, the done-when
  needs one) · **B** restore the five middles and accept sololess songs. **Recommend A.** A second fork: the extra round sits after the middle, so
  with no extra round the last chorus follows the middle directly; **A** keep · **B** place the extra round before the middle. **Recommend A** until heard.
- [x] 3.2 Arrangement by section. A mask of which parts play, per section,
  replaces the fixed `b < 2` / `b < 4` entries in `renderBar`, and the
  drop-outs are rows drawn into it per song:
  - A part sits out a whole section (which part and which section are drawn;
    never the drums and the bass both out of a chorus).
  - A stop: the band rests for a bar and one part fills the silence, drawn
    from a drum fill, a bass run, a keys flourish, or the singer alone.
  - A drop to drums and voice for a verse or the first half of a chorus.
  - A build into the chorus: a snare roll and a rising filter.
  - A drop: the drums out for a bar.
  - A stripped last verse.
  - The last chorus lifted up a semitone or a whole tone, which carries the
    chord, melody and hook with it.
  — done 2026-11-11: `plays(song, b)` answers `{ guitar, singer, drums, bass, keys }` (null for the strings piece) from the section's own mix
  (intro: bass, drums, keys, the guitar from bar 2, the singer from the first verse; solo: all but the singer, the keys out its first two bars;
  breakdown: its parts; outro: one part gone per 4 bars in a drawn order) less the rows in `song.dropouts`
  (`{ kind, from, bars, ... }` over absolute bars, 2 to 4 drawn from six kinds, each at most once, a row landing on a bar an earlier one holds dropped):
  sitout (a part, a whole section; the singer never out of the last chorus, only guitar or keys out of it), stop (the last bar of a verse or
  pre-chorus; the drums' four climbing hits, a bass run, a keys arpeggio, or the hook's first phrase), duo (drums and voice for a verse or a chorus's first 4 bars),
  build (the bar before a chorus: a snare roll over steps 4 to 15 and the keys through a low-pass rising 300 to 9000 Hz over the bar, `sweep`),
  drop (the drums out the first bar of a chorus or the bar before), strip (the last verse loses guitar and keys, or the drums). The lift is not a row: `song.lift` is
  `{ semis, from }` (0, 0, 1 or 2 drawn, so 0 half the time) and `startBar` takes a bar-local `key` with the tonic raised, so the chord, the melody, the hook
  (carried by pitch), the kick and the ending's tonic move together. The strings piece gets none. Over songs 0..1999: 1 row 81 songs, 2 734, 3 634, 4 226 (none with 0).
  Songs 0 1 7 42 99 (form, soloist, lift): #0 `I V P C V P C B S V C L O`, bass, +1 (sitout keys 44-51, strip guitar+keys 56-63, build 35);
  #1 same form, singer, 0 (duo 24-31, drop 36, sitout keys 44-47); #7 `I V P C V C S V P C L O`, bass, +2 (stop bass 59, drop 32, build 15);
  #42 `I V C V P C K S L O`, keys, +1 (stop drums 31, sitout guitar 12-19); #99 `I V C V P C S L O`, bass, 0 (stop bass 11, drop 31). Every one has a drop-out and a solo,
  and the soloist is the guitar in none of them. Song 4 (strings) is byte-identical to `.wav/phase-2/song-4.wav`. WAVs: `packages/haven/.wav/3.2/` (songs 0 1 7 42 99 4) for the
  listen against `.wav/phase-2/`. Per-pull, 4410-sample chunks, a cold process, load 1.6: song 0 worst 76.9 ms (the first pull), p99 14.7, mean 2.9; song 42 worst 72.3,
  p99 18.1, mean 2.1. Phase 3's acceptance (the owner's listen) stays open.
- [x] 3.3 Solo passages for every part. `walker(part)` already walks a melody
  from a part's own generator; each soloist gets a voice for it: the keys walk
  in their own register with the right hand doubling the chord, the bass walks
  with rests and octave leaps, the singer scats long phrases (2.5's syllables).
  The band thins under a soloist: the pad and a light kick-and-hat under the
  guitar or keys, the pad alone under the bass, the bass and a rim under the
  singer. A breakdown holds the soloist alone or with one other part. The
  guitar's solo keeps 5.2's quote of the hook.
  — done 2026-11-11: each soloist walks from its own part's generator through `walker(part, scale)`, which takes a scale (`melodyOf(song, lo, hi)`
  now takes a register). **Guitar** the 3.2 walk (euclid 6 of 16, pulled to the chord on its first note), the hook's quote left to 5.2.
  **Keys** the right hand in MIDI 67-86 in eighths, a rest one in four, the left hand one time in two the chord's root and fifth
  (`chord.bass`, `+7`, `piano`) on 1 and 3 and otherwise a stab of the chord on the downbeat, the warm pad underneath on a `pad` keyset.
  **Bass** MIDI 40-55 in eighths, a rest one in three, an octave leap one in five, the chord root on steps 0 and 8, and one time in four
  (drawn for the half bar and for the bar's end) a triplet or two sixteenths into the next downbeat. **Singer** `scat`: phrases of 2 to 6
  syllables of 2, 2, 4 or 6 steps, a rest of 2 to 4 between, the song's vowel, a note running past the bar cut at its line, and no rest
  under the section's fill. The thinning is `BACKING` through `plays` plus a `thin` flag in `startBar` (a solo section, not a breakdown):
  under the guitar the pad (`warm`, whole bar) and the drums as kick on 1 and 3 at half gain with closed hats on the quarters, no snare, no rim,
  no crash, no fill; under the keys the drums alone, so no pad unless the keyset is `pad`; under the bass the pad alone; under the singer the
  bass at 0.8 gain and a rim on 2 and 4. The 3.2 rule "keys out the solo's first two bars" is gone (it was the guitar's backing).
  **Breakdown**, drawn from a generator seeded by one draw of the form's, so lift, drop-outs and outro order keep their 3.2 numbers:
  the soloist alone one time in three, else the soloist and one other part drawn from the other four, the drums as hats only half the time
  (the soloist always plays, so a breakdown is never silent). Over the 563 band songs in 0..1999 that have a breakdown: alone 185, with singer 79,
  bass 72, guitar 69, keys 63, drums 57 as full drums and 38 as hats; the other part plays its normal pattern. The fill into the solo is
  3.1's, unchanged; the thinned drums run none at the solo's last bar (**fork:** the next section is always full, so a fill there would be allowed
  by the brief's wording; **A** none, the next section's crash is the downbeat · **B** run it. Recommend A, heard first). Probe over songs 0..31
  (26 band songs, 200 solo and breakdown bars): `plays` matches the table on every bar, the soloist plays in every breakdown bar, 0 bad. Per-part
  ms in the solo bars (whole-bar renders, in-process after warm-up, load 3): bass solo song 0 bass 7.7 + pad 22.2 + mix 10.6; singer song 1
  singer 25.2 + bass 11.2 + drums 0.5 + mix 11.0; guitar song 2 guitar 10.8 + pad 25.8 + drums 5.2 + mix 13.5; keys song 3 keys 35.4 (26 to 42)
  + drums 5.3 + mix 9.7; a verse bar of song 0 is 105 ms in all, so no solo bar is the dearest. `CEIL` re-measured over songs 0 1 7 42 99:
  singer 0.40 to 0.42, drums 1.93 to 2.03, bass 0.47 to 0.57 (the bass solo's overlapping eighths; 0.54 on song 7), guitar 0.44 and keys 0.21
  left. WAVs: `packages/haven/.wav/3.3/before/` and `after/`, `song-<k>-solo-<soloist>.wav` for 0 bass (bars 51-56), 1 singer (47-52),
  2 guitar (39-44), 3 keys (47-52), each from the bar before the solo to the bar after; `.wav/phase-3/` songs 0 1 7 42 99 4, and song 4
  is byte-identical to `.wav/phase-2/song-4.wav`. Phase 3's acceptance (the owner's listen) stays open.

### Phase 4 — Harmony

Goal: chords that move like a band's, not like block chords.
Done when: a probe counts the average semitone motion per chord change across
the five songs and it falls, and the owner accepts songs drawn from the new
generator.

Owner's A/B: `.wav/phase-3/` vs `.wav/phase-4/` (songs 0 1 7 42 99 4); the `.wav/4.2/` keys pairs (`before/` vs `after/`, songs 42 and 99); per-pull worst, 4410-sample pulls from a cold process, after pull 0: song 0 33.1 ms, 42 58.6, the blues song 8 78.8 (pull 0 97.9, 77.3 and 112.7 at load 2.3; the 4.2 state is as slow at load 4); motion per change, keys 3.70 to 2.82 and guitar 3.20 to 2.71 over 4.3's lists (4.1: keys 4.50 to 3.70, guitar 3.60 to 3.20).

- [x] 4.1 Voice leading. `songOf` precomputes one voicing per chord in the cycle,
  each the inversion with the least total motion from the one before, with the
  last wrapping to the first, and holds common tones
  ([Tymoczko, *The Geometry of Musical Chords*](https://dmitri.mycpanel.princeton.edu/sciencearticle.html)).
  `chordOf` reads the table. The keys and the guitar get separate voicings in
  their own registers.
  — done 2026-11-11: not in `songOf` but `voicingsOf(song)`, memoized in a `WeakMap` on the progression object (then by colour), so the ending bar's
  one-chord `song.coda` and 4.3's drawn lists get tables the same way; it works over any list of `[degree, quality]`. The measure is Tymoczko's: the sum
  of absolute semitone motions under the best pairing of voices (`motion`; where a chord has four notes and the next three, a note serves two voices).
  Candidates are every closed voicing (each pitch class once, span at most 11) in the part's register, keys 55-72 and guitar 62-79. The chain starts at the first
  chord's root position nearest the register's middle, takes the least motion at each chord, then re-chooses the first for the least motion from the last
  and chains once more. Voicings are stored as notes above a tonic of 0 and `chordOf` adds `song.tonic` plus whole octaves that centre the table, so 3.2's
  lift still moves everything together and no voice jumps; the notes realised over all 12 tonics are keys 51-75 and guitar 60-81, the window plus up to half an
  octave (**fork:** **A** leave it · **B** a table per tonic, notes exactly in 55-72 and 62-79, 12 times the tables and a build at the lift bar. Recommend A).
  The bass stays the root and `pcs` stays root first. Probe over songs 0 1 7 42 99, the 20 chord changes of their cycles with the seam counted, the old
  nearest-60 and nearest-70 voicing against the table, same measure. On triads alone keys 4.70 to 3.20 and guitar 3.60 to 3.20, and as the songs play (the V
  a dominant 7, each song's own colour) keys 4.50 to 3.70 and guitar 3.60 to 3.20. Common tones held on the same note: 22 of 22 in the keys. The seam's residual,
  last chord to first, in songs 0 1 7 42 99: keys 4 4 3 4 9, guitar 3 3 3 4 3. The chain is greedy: over a whole cycle the optimum would be 3.60 against 4.00 for keys
  under `sevenths` (all other cases equal), which would come from trying every first voicing and keeping the cheapest cycle (not done; the brief's chain stands).
- [x] 4.2 Chord colour, drawn per song: maj7, min7 and dominant 7 (always the V,
  and every chord in the blues), add9, and sus2 or sus4 resolving. The melody's
  downbeat snap (`snap`) reads the colour tones too.
  — done 2026-11-11: `song.colour` from a generator of its own (`0x3c6ef372`, `^ 0xc010`), one in four each of `none`, `sevenths` (maj7 on major chords,
  min7 on minor), `add9` and `sus` (then `song.sus` 2 or 4 by a second draw), named in `about` as `(sevenths)`, `(sus4)`; over songs 0..31 none 9, sevenths 10,
  sus 7, add9 6, strings pieces too. A chord is dominant when it is major and its root is 7 above the tonic, or the progression has `all7` (the blues); it takes
  the minor seventh whatever the colour, and under `add9` it takes that seventh and no ninth (**fork:** a dominant 9th there is a fifth voice · recommend as is).
  `chordOf` answers `pcs` (root, third, fifth, colour tone), `reach` (the intervals it tunes), and `sus`, a second chord for the bar's first half
  (pitch classes, keys, guitar), the resolution being the chord itself; the third's voice moves to the 2nd or 4th by the nearest note, and the
  pad holds what the halves share for the whole bar and swaps only that voice at the half (`heard(i)` picks per step for stabs, backbeat and the strum).
  The keys voicing is the triad plus the colour tone as a fourth voice; the guitar's table is the triad only, and under sus it takes the same third-for-2nd/4th
  swap so it does not play the third against the keys' 4th (**fork:** **A** as built · **B** the guitar plays the resolved triad throughout, which clashes by a
  semitone in a major chord; recommend A). `snap` reads `pcs`, so a downbeat may land on the seventh or ninth where the pentatonic has it; the singer's
  melody is not snapped to the sus tone. `tuned` is a table `JUST` of ratio over the root: 3rd 6/5 or 5/4, 5th 3/2, minor 7th 9/5 (not the dominant's 7/4,
  which clashes with the equal-tempered bass), major 7th 15/8, 9th and sus2 9/8, sus4 4/3; any note off `reach` stays equal-tempered. Probe over songs 0..31
  (chord list of each first cycle as pitch classes): every V is a dominant 7 (0,4,7,10), every blues chord is, every sus half carries the 2nd or 4th, 0 bad.
  Render per whole pull (4410-sample chunks, whole song, cold process, load 0.6-0.9), before to after: song 0 first pull 71.5 to 76.8 ms, worst after the first
  27.1 to 30.3, mean 2.80 to 2.79; song 42 first 67.0 to 68.5, worst 38.5 to 40.2, mean 2.00 to 2.00. `CEIL` re-measured over 0 1 7 42 99: guitar 0.441 to 0.494
  (now 0.49) and keys 0.214 to 0.239 (now 0.24) in `scope.js`; singer 0.42, drums 2.03, bass 0.57 unmoved. Song 4 (G major doo-wop, `none`, strings): its singer
  and bass solos are byte-identical to before over 16 bars (max difference 0), only the keys pad changed: voice led instead of nearest 60, and the D chord is a
  D7 (its C added). WAVs: `packages/haven/.wav/4.2/before/` and `after/`, `song-<k>-bars8-solo-keys.wav` for 42 (sus2) and 99 (sevenths), and the six whole songs
  `packages/haven/.wav/4.2/song-<k>.wav` for 0 (none) 1 (sevenths) 7 (none) 42 (sus2) 99 (sevenths) 4 (strings, none). Phase 4's acceptance (the owner's listen) stays open.
- [x] 4.3 A progression grammar in place of the eight-progression menu.
  - Phrases are tonic, then subdominant, then dominant, then tonic
    ([Rohrmeier, *Towards a generative syntax of tonal harmony*](https://www.tandfonline.com/doi/full/10.1080/17459737.2011.573676)).
  - Secondary dominants and borrowed chords (bVII, iv, a chromatic mediant)
    appear at cycle ends.
  - The blues takes Steedman's rewrite rules
    ([Steedman 1984](https://homepages.inf.ed.ac.uk/steedman/papers/music/40285282.pdf)).
  - The eight existing progressions stay as starting points the grammar may
    draw.
  — done 2026-11-11: a generator of its own (`0x7f4a7c15`, `^ 0x6a3e`) runs after the menu pick, which stays in the `VETO` loop so every other draw keeps its number; the
  strings piece skips it (song 4 byte-identical to `.wav/4.2/song-4.wav`). A drawn band song keeps its menu entry one time in three (`MENU_ODDS`, 1/3), otherwise
  a generated phrase of the entry's mode (so the melody scale and the hook do not move); the blues is always rewritten. A phrase is tonic, subdominant, dominant, last
  tonic, each one chord (4 bars of 4 in the cycle, 16) or two (8 chords, 32): major tonic {I, vi, iii}, subdominant {IV, ii, vi before IV}, dominant {V, V V}, last {I, vi};
  minor tonic {i, bIII, bVI}, subdominant {iv, bVI, bVII}, dominant {V, v, bVII}, last {i, bVI}. Then 0, 1, 1 or 2 cycle-end substitutions, drawn from what fits:
  V/V (II7 before the V), V/vi (III7 before a vi), a borrowed bVII or iv in the subdominant's last slot, a chromatic mediant (bVI or III major) in the V's slot
  before the last tonic; minor takes only V/V. A phrase is named by its numerals (`I–II7–V–I`, `i–i–iv–bVII–II7–V–bIII–i`; `b` and `#` plain letters; the V
  carries no 7, the 4.2 rule making it a dominant anyway). Per-chord flag: `[degree, quality, true]`, the third element read by `tonesOf` (a flagged major chord is
  a dominant seventh whatever the colour), so `chordOf` and `voicingsOf` needed no field of their own. Drawn phrases are interned by name, one object a phrase, so
  the `WeakMap` voicing table is found again when the song is drawn again (table build 0.3 to 1.1 ms). The blues keeps `name: 'blues'` and `all7`, and takes 1 to 3 of
  four rewrites drawn on today's twelve bars: quick change (bar 2 IV), `ii–V` or `V–V` over bars 9-10, `vi` or `VI7` for bar 8, no turnaround (bars 11-12 `I I`);
  `about` reads `blues (quick change, ii–V)`. **Discrepancy:** the brief's base `I I I I IV IV I I V IV I I` is not today's blues, which already ends `I V` in bars
  11-12, so rewrite (d) is the reverse (drop the turnaround). `all7` now also gives a minor chord (the `ii`, `vi`) its minor seventh. Probe over songs 0..199: 31
  strings (menu), of the other 169: menu kept 60, generated 93 (45 of 4 chords, 48 of 8), blues rewritten 16 (6 with one rewrite, 5 with two, 5 with three); every phrase
  begins and ends in the tonic family, 4 or 8 chords, every blues `all7`, 39 secondary dominants all flagged (II or III major), `cycle` as `chords.length` gives, 0 bad.
  Songs 0..31 first cycle: 0 `I–IV–V–I`, 1 `I–iii–ii–IV–V–V–I–vi`, 2 `bIII–bVI–v–i`, 5 `vi–I–vi–bVII–V–V–I–I`, 8 blues (vi, ii–V, no turnaround), 9 `I–II7–V–I`,
  12 `i–bVI–iv–bVII–II7–V–bIII–i`; the rest are menu entries or the strings pieces' laments. Every non-progression field of `songOf(k)` over 0..31 (JSON minus
  `progression`, `about`, `cycle`) identical before and after. The five songs now: 0 `I–IV–V–I`, 1 `I–iii–ii–IV–V–V–I–vi` (sevenths), 7 `I–IV–bVI–I`,
  42 `i–i–iv–bVII–II7–V–bIII–i` (sus2), 99 doo-wop (menu kept, sevenths). Motion per chord change, seam counted, as the songs play (4.1's measure): the menu
  progressions of the same five songs give keys 3.70 and guitar 3.20 over 20 changes (4.1's numbers), the grammar's keys 2.82 and guitar 2.71 over 28 (informational:
  a different chord list; it falls because a phrase repeats a chord or shares tones more than the menu does, and the 8-chord lists average 2.5 to 2.75). **Fork:** the
  minor key takes only V/V at its end (its bVI, bVII and iii-ish chords are already diatonic) · **A** leave it · **B** add a borrowed picardy `I` or a bII (Neapolitan)
  there; recommend A. Per whole pull (4410-sample chunks, cold process), A/B in the same minutes at load 3.7-4.1 because a peer's load was running: first pull, old
  to new, song 0 88.9 to 97.6 ms, 42 113.6 to 108.7, 8 (blues, 12 chords) 123.6 to 106.1; worst after the first 36.9 to 48.8, 48.6 to 53.2, 54.2 to 46.5; mean 3.40 to
  4.06, 2.81 to 2.72, 2.80 to 2.68. At load 2.3 the new state alone: song 0 first 97.9, worst after 33.1, mean 3.18; 42 first 77.3, worst 58.6, 2.88; 8 first
  112.7, worst 78.8, 3.57; 12 first 100.2, worst 43.6, 3.60. The first pull is the cold process rendering, not the table (0.3 to 1.1 ms for 4, 8 and 12 chords), and the
  old state is as slow at the same load, so the 100 ms line is not held at load 2 to 4 by either; a quiet-machine run is owed. `CEIL` over 0 1 7 42 99: singer
  0.42 to 0.44 (the melody snaps to the new chords; now 0.44 in `scope.js`), guitar 0.494, drums 2.027, bass 0.566 and keys 0.243 unmoved. WAVs: six whole songs
  `packages/haven/.wav/phase-4/song-<k>.wav` for 0 1 7 42 99 4. Phase 4's acceptance (the owner's listen) stays open.

### Phase 5 — Melody

Goal: a chorus you can hum after hearing it once.
Done when: the owner hums the chorus of a song drawn by the new generator after
one listen.

- [ ] 5.1 The hook as a motif. Draw a one-bar idea and build the hook as A, A'
  (the same shape a step higher), B (contrast), then A' landing on the tonic.
  The walk follows Narmour's rules: a small step implies another in the same
  direction, a leap is followed by a step back, and a phrase ends on a chord
  tone ([implication–realization](https://en.wikipedia.org/wiki/Implication-Realization)).
- [ ] 5.2 The verse grows from the motif rather than a free walk: the motif
  inverted, stretched to twice its length, or moved up or down. The soloist
  quotes the hook once.
- [ ] 5.3 Call and response: the guitar answers in the singer's rests, using the
  motif's rhythm.

### Phase 6 — Groove

Goal: the band plays like players, not like a sequencer.
Done when: the owner listens to three whole songs drawn by the new generator
and accepts them.

- [ ] 6.1 Fills drawn from a set, using the 2.4 toms, in place of the same four
  climbing sixteenths every time.
- [ ] 6.2 Timing feel.
  - Microtiming becomes pink (1/f) noise, which listeners prefer to white jitter
    ([Hennig et al. 2011](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0026457)).
    It is computed with the Voss algorithm, where each octave is a hash of
    `(k, part, floor(t / 2^i))`, so no state is kept.
  - It stays small: systematic microtiming lowers groove ratings
    ([Davies et al. 2013](https://repositorio.inesctec.pt/items/38083482-243e-4090-bfa6-735d148ee1ff)).
  - Euclidean kick and hat patterns are drawn per song for medium syncopation,
    the peak of the groove curve
    ([Witek et al. 2014](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0094446)).
- [ ] 6.3 Three new feels within the 16-step bar: shuffle, one-drop and
  sixteenth-note funk, each with its own pairings to rule out (`VETO` rows).

## Ideas past the plan

Researched 2026-11-11 and left out on purpose. They are listed here so the next
person does not research them again.

- **The almanac in the music** (ruled out): night thins the band, rain brings
  darker chords and a rain bed. Endel is the precedent. If it returns, it changes
  only the arrangement; `songOf(k)` stays pure, so `/song 42` stays one song.
- **Sound over ssh** (ruled out). The options were the browser twin as the
  speaker, a PulseAudio TCP tunnel over `ssh -R`, or a local helper that renders
  the band from the cue.
- **Spatial mix:** pan and volume by where the member stands, and a low-pass
  through walls. Each screen renders its own sound, so this is local and free of
  sync concerns. It is the natural next step after 1.2.
- **Visuals:**
  - A theory strip showing the chord, Roman numeral, section and beat.
  - Falling notes. The band is a function of time, so notes can be drawn before
    they sound; Strudel's piano roll is the precedent.
  - A loft that pulses on the kick, driven by the drum pattern.
  - Spectrum, waterfall and stereo scope views in braille or half-blocks. The
    terminal player Keet is the reference.
- **Players:** `pw-cat` first on PipeWire, and SoX or `ffplay` on macOS, where
  `afplay` takes no stdin. Native bindings under `bun:ffi` are not safe: the
  callback runs on a foreign thread, and naudiodon segfaults under Bun.
- **Experiments:**
  - Procedural world sounds (rain, wind, fire, crowd) from Farnell's *Designing
    Sound*.
  - An ambient ensemble of loops 5, 7 and 11 bars long.
  - Play-along quantized to the shared clock, NINJAM-style.
  - A shared Orca-style grid.
  - Granular pads, Shepard tones, Sethares dissonance curves.
- **Rejected:**
  - Neural melody models: sampling and floating-point maths differ across
    engines, so screens would hear different songs.
  - Binaural beats: speakers and mono Bluetooth defeat them.
  - Kitty and sixel graphics: they break over ssh and tmux.

## Open questions

- **Q1 — If 1.0 cannot bring the worst bar under `AHEAD_MS / 3`, what gives?**
  Raised 2026-11-11 by the 0.3 baseline; open only if 1.0's proof misses.
  Closed 2026-11-11 without a ruling: 1.0 and 2.9 brought the per-pull worst
  to 33–64 ms on the six songs with every Phase 2 voice in, so the condition
  never arose. Reopen it if a later phase misses the budget.
  **A** — render bars in a Worker in both `#sound` targets; the pull stays
  `fill(from, n)`, the thread changes. Keeps the rule and the sound; the
  largest change. **B** — amend the rule to "under `AHEAD_MS` with a stated
  margin" and write the margin here. **C** — raise `AHEAD_MS` in both `sound.js`
  and `sound.browser.js`; the band starts later and `/volume` answers later.
  **Recommend A** if the miss is large, **B** if it is a few ms on the strings
  piece alone: C moves the number to fit the code and chases every phase's
  added cost.
