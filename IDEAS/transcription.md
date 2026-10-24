---
id: transcription
status: proposed
dated: 2026-10-23
---

# Idea — Transcription: a stored recording in, a transcript record out

**Status: PROPOSED.** Dated 2026-10-23. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. The engine is ruled
(`FJS-D1492`); everything else is provisional until `decision-rules` has run on
it, and a ruling cites an open question by its `Q` number.

**Trigger.** A local speech-to-text spike on 2026-10-23 found an engine that
transcribes a 45-minute call in five minutes on a CPU-only laptop. The only plan
that named transcription was `calls-and-media.md` step 4.3, behind a signaling
spike, a mesh rig, a recorder kit, a resumable upload and a bot participant. A
recording that already exists as a file needs none of those.

---

## The claim

Transcribing a recording is **one caravan job over a Litestone `File`**, and
every seam it stands on exists:

| Piece | What answers it |
| --- | --- |
| the audio | a `File` field (`packages/litestone/docs/file-storage.md`), copied in from the carrier |
| the work | a caravan job: ffmpeg to 16 kHz mono wav, spawn the engine binary, parse its output |
| the engine | a config string: a local binary (`FJS-D1492`), or a hosted one through a conduit target |
| the transcript | the app's own model, written by the job: segments of `{ startMs, endMs, text }` (`FJS-D541`'s precedent: a transcript is the app's) |

What is missing is the job itself, a place for the binary and the model to come
from on a deployed host, and a way to tell when a transcript dropped speech.

**The consumers are waiting already.** The quo prototype's `AgentTurn.text` is
"what a transcriber made of it" and is null for want of one; its voicemail
`recordingId` and serpgrid's carry the comment *WANTED: copied into our own
storage, which has no owner for a file yet*. `calls-and-media.md` 4.3 becomes a
third consumer rather than the owner.

---

## The evidence (spike, 2026-10-23)

i7-8850H, 6 cores, no GPU, one 44.5-minute English call, 6 threads:

| Engine | Wall | RTF | Model |
| --- | --- | --- | --- |
| Parakeet TDT 0.6B v3 int8, sherpa-onnx + silero VAD | 5.2 min | 0.115 | ~650 MB |
| whisper.cpp `small.en-q5_1` | 29 min | 0.65 | 190 MB |
| whisper.cpp `large-v3-turbo-q5_0` | ~75 min est. | 1.7 (13-min file) | 574 MB |

Both transcripts were readable and both fumbled names. whisper kept fillers and
punctuation better. **Parakeet dropped a phrase where the VAD cut mid-word**,
and nothing reported it. That is the one silent failure here (§ The nine, 9).

The command that ran:

```
ffmpeg -i call.mp3 -ar 16000 -ac 1 call.wav
sherpa-onnx-vad-with-offline-asr --silero-vad-model=silero_vad.onnx \
  --encoder=encoder.int8.onnx --decoder=decoder.int8.onnx --joiner=joiner.int8.onnx \
  --tokens=tokens.txt --model-type=nemo_transducer --num-threads=6 call.wav
```

Sources: `k2-fsa/sherpa-onnx` v2.0.0 release, model
`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`; `ggerganov/whisper.cpp` with
`ggml-small.en-q5_1.bin`. Parakeet v3 is reported to cover 25 European languages
(*unverified*, check the model card before relying on it).

---

## Shape — a pure `transcribe` with every effect passed in

The job is a thin shell around one function that touches no disk, process or
network. The caller hands in the converter, the engine (which carries the model)
and the speech detector; the function sequences them and does the arithmetic.
Sketch only, nothing here has run.

```ts
// transcribe.ts — imports nothing from node or bun
export type Span = { startMs: number, endMs: number }
export type Segment = Span & { text: string }

export type Wav = { path: string, dispose?: () => Promise<void> }
export type Convert = (src: string) => Promise<Wav>                     // ffmpeg to 16 kHz mono
export type Engine = (wavPath: string, o: { signal?: AbortSignal }) => Promise<Segment[]>
export type Detect = (wavPath: string) => Promise<Span[]>               // independent speech spans

export type Transcript = { segments: Segment[], text: string, coverage: number | null }

export async function transcribe(
  src: string,
  d: { convert: Convert, engine: Engine, detect?: Detect, signal?: AbortSignal },
): Promise<Transcript> {
  const wav = await d.convert(src)
  try {
    const segments = tidy(await d.engine(wav.path, { signal: d.signal }))
    const speech = d.detect ? await d.detect(wav.path) : null
    return {
      segments,
      text: segments.map(s => s.text).join(' '),
      coverage: speech ? coverage(speech, segments) : null,
    }
  } finally {
    await wav.dispose?.()
  }
}

// sort, trim, drop empty and inverted segments
export const tidy = (segs: Segment[]): Segment[] =>
  segs
    .map(s => ({ ...s, text: s.text.trim() }))
    .filter(s => s.text && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs)

const merge = (spans: Span[]): Span[] => {
  const out: Span[] = []
  for (const s of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const last = out.at(-1)
    if (last && s.startMs <= last.endMs) last.endMs = Math.max(last.endMs, s.endMs)
    else out.push({ startMs: s.startMs, endMs: s.endMs })
  }
  return out
}

// the share of detected speech time some segment covers; 1 when no speech was detected
export function coverage(speech: Span[], segments: Span[]): number {
  const a = merge(speech), b = merge(segments)
  const total = a.reduce((n, s) => n + s.endMs - s.startMs, 0)
  if (!total) return 1
  let hit = 0, j = 0
  for (const s of a) {
    while (j < b.length && b[j].endMs <= s.startMs) j++
    for (let k = j; k < b.length && b[k].startMs < s.endMs; k++)
      hit += Math.min(s.endMs, b[k].endMs) - Math.max(s.startMs, b[k].startMs)
  }
  return hit / total
}
```

**An engine is a factory that takes the model and the effects.** The model is data
passed in, never a global:

```ts
export type Run = (cmd: string, args: string[], o?: { signal?: AbortSignal }) => Promise<string>

export const sherpa = (c: {
  run: Run, bin: string, vad: string, threads?: number,
  model: { encoder: string, decoder: string, joiner: string, tokens: string, type: 'nemo_transducer' },
}): Engine => async (wav, o) =>
  parseSherpa(await c.run(c.bin, [
    `--silero-vad-model=${c.vad}`,
    `--encoder=${c.model.encoder}`, `--decoder=${c.model.decoder}`, `--joiner=${c.model.joiner}`,
    `--tokens=${c.model.tokens}`, `--model-type=${c.model.type}`,
    `--num-threads=${c.threads ?? 2}`, wav,
  ], o))

// one line per segment, "0.512 -- 3.840: hello there" — format UNVERIFIED, probe the binary
export const parseSherpa = (out: string): Segment[] =>
  [...out.matchAll(/^(\d+(?:\.\d+)?) -- (\d+(?:\.\d+)?):\s*(.*)$/gm)]
    .map(m => ({ startMs: Math.round(+m[1] * 1000), endMs: Math.round(+m[2] * 1000), text: m[3] }))
```

`whisperCpp({ run, bin, model })` and `deepgram({ send, key })` have the same
`Engine` type, so Phase 2 is a different factory behind the same config string. The
spawn has one owner, the app's `providers/transcribe/local.ts` (`outpost`'s
`spawnRun` is Docker-shaped and not an app's dependency). The job builds `engine`
from the config string, passes `ffmpegToWav` and a silence detector, and writes the
result.

**What the shape buys**

- A fake `engine` returning canned segments tests `tidy` and `coverage` without the
  650 MB model; `parseSherpa` tests off a saved stdout.
- Q1's lift is a move, not a rewrite: the file imports nothing from the app.
- Q2 stays out of the function. It never learns where the model lives; the deploy
  step only has to make the model paths resolve.
- The `Run` seam lets a test, a container or a remote runner stand in for the spawn.

**The detector must be independent of the engine.** `sherpa-onnx-vad-with-offline-asr`
prints only the segments its own VAD kept, so a phrase that VAD cut is missing from
both sides and coverage reads 100% — the silent failure from the spike, uncaught.
`detect` is its own dependency (ffmpeg `silencedetect` or an energy gate), not a
by-product of the engine.

**Left out of the function on purpose:** reading the `File`, writing rows,
idempotence, retries, the timeout. Those are the caravan job's. If 0.2 shows fixed
10-minute chunks beat the VAD settings, chunking is an `Engine` wrapper that splits,
calls the inner engine and offsets the times; `transcribe` does not change.

---

## The nine (`PHILOSOPHY.md` § V), answered before any edit

1. **Origin** — the audio is the `File`; the transcript is derived from it and
   written once by the job. One origin per fact.
2. **Concept budget** — no new noun. *Transcript* is the field's word and the
   app's own model; the job is caravan's shape.
3. **Complexity** — VAD, chunking and model choice are the problem's, and the
   engine owns them. We add the job and the coverage figure.
4. **Predictability** — the worker has print-kit's shape: one binary behind one
   seam, owned by one module.
5. **Derived** — transcript from recording, coverage from an independent
   detector's speech seconds against the transcribed seconds. Nothing typed by hand.
6. **Owner** — files: Litestone's store; heavy work: caravan; a hosted engine:
   conduit. Nothing else in the repo transcribes.
7. **Boundary** — ffmpeg's wav in, the engine's segments out. The engine string
   is the seam.
8. **Failure cost** — a bad transcript costs a re-run, not data.
9. **Silence** — *every stretch of speech ends up in the transcript* is the
   promise, and today nothing checks it. Step 1.4 records coverage on the result,
   measured by a detector the engine does not share.

---

## Not in scope

- **Live captions** — streaming, during a call. `calls-and-media.md` 5.3, after
  `chat-surface.md` § Part 1.
- **Speakers** — diarization is a second model and a second question; a call
  carrier's two channels may answer it for free.
- **Notes and summaries** — `calls-and-media.md` 4.4, a model call through conduit
  over the transcript this paper writes.

---

## Open questions

- **Q1** — Where the job's code lives first. **Recommend in the app**: one consumer
  is not a kit.
  - **A** — the quo prototype's own `transcribe.job.ts`; lift to a kit when a second app
    writes the same job (Phase 3)
  - **B** — `@frontierjs/transcribe-kit` from the start, print-kit's shape:
    `app.own('transcriber', …)`, one binary behind one seam
  - **Recommend A** — the job's shape is guessed until one app has run it on real voicemail;
    B fixes an interface before anything has pushed on it. § Shape keeps A's lift cheap:
    `transcribe` imports nothing from the app.
- **Q2** — Where the binary and the ~650 MB model come from on a deployed host.
  **Recommend a deploy step.**
  - **A** — a deploy step downloads a pinned release and model, checks a sha256, and keeps
    them in a cache directory outside the release, so a redeploy reuses them
  - **B** — the first job downloads them into the same cache
  - **C** — no local engine in production: a hosted engine through conduit there, local
    in development only
  - **Recommend A** — B puts a 650 MB download inside a job's timeout and fails the first
    voicemail of every new host; C pays per minute for what the box does in a fifth of real time.
- **Q3** — What the job writes. **Recommend segments.**
  - **A** — segments `{ startMs, endMs, text }` on the app's model, plus the joined text
  - **B** — the joined text only
  - **Recommend A** — the engine already emits segment times, quo's `AgentTurn` is already
    that shape, and B throws away the times a player needs to seek to a line.

---

## Phases

### Phase 0 — Groundwork

Goal: know the engine's failure and its cost on a production-sized box before writing a job.
Done when: the dropped-phrase rate has a number under two VAD settings and a fixed-chunk run, and a 2-vCPU host's RTF and peak memory are measured.

- [x] 0.1 Spike: Parakeet against whisper.cpp on one real call (§ The evidence)
- [ ] 0.2 The VAD drop: rerun the same call with a longer min-silence and with fixed 10-minute chunks; count words lost against the whisper transcript
- [ ] 0.3 Measure on a 2-vCPU droplet: RTF, peak RSS, and whether two jobs at once starve the app
- [ ] 0.4 Rule Q1–Q3

### Phase 1 — A voicemail gets a transcript

Goal: the quo prototype transcribes its own voicemail with no hand step.
Done when: a voicemail left on the prototype has a transcript row with segments and a coverage figure, written by the job, and a rerun is a no-op.

- [x] 1.1 Copy the carrier's recording into a `File` when it lands: `Call.recordingFile`, `core/storage.ts` (local disk, ruled 2026-10-23), the `transcribe` job dispatched from `call.recording.saved`. The fetch from Telnyx's link is UNPROVEN: quo's suite does not boot while its `auth.ts` is mid-migration (`createAuthPlugin` is not exported), so only the storage write and read-back ran
- [x] 1.2 `transcribe` (§ Shape) and the `sherpa` engine factory, in the quo prototype (`api/src/domain/transcribe.ts`, `api/src/providers/transcribe/{sherpa,local}.ts`). Run end to end 2026-10-23 on a public 11 s sample: the real binary's stdout parses (`0.294 -- 2.252: text`, banner and RTF on stderr), RTF 0.10 at 2 threads, and dropping a segment lowers `coverage`. No test file yet (the paper is still proposed)
- [x] 1.3 The job: `jobs/transcribe.job.ts` over `domain/voicemail.ts`; a `Transcript` model (`text` and `segments` are `@personal`, ruled 2026-10-23), migration `20261023120000_transcript.sql` hand-cut to this change alone (the generator also wanted unrelated auth drift). Run on a real mp3: copy, transcribe from the stored copy, a second run is a no-op. Retention and consent stay a WANTED on `Call.recordingId`.
- [ ] 1.4 Coverage: an independent detector (not the engine's VAD) against transcribed seconds, stored on the transcript, low coverage logged. **The threshold is the open part**: `silencedetect` at a fixed -35 dB found no silence in the sample (noise floor above it), so every pause counted as speech and a perfect transcript scored 0.75; at -30 dB it found three. Pick a level relative to the file (`volumedetect` mean minus a margin) and name the "low" cutoff in 0.2's done-when

### Phase 2 — The hosted engine

Goal: the same job with a hosted engine behind the same config string.
Done when: switching the engine string to the hosted one transcribes the Phase 1 voicemail with no change to the job.

- [ ] 2.1 A Deepgram connector in `conduit-connectors` (`FJS-D1185`)
- [ ] 2.2 The job calls `app.conduit.send()` when the engine is hosted

### Phase 3 — Lift

Goal: one owner, once a second app writes the same job.
Done when: two apps transcribe through one module and neither holds its own copy.

- [ ] 3.1 The second consumer: serpgrid voicemail, or `calls-and-media.md` 4.3
- [ ] 3.2 Lift the job's engine half to a kit, print-kit's shape
- [ ] 3.3 The deploy step from Q2 in `cli`'s setup steps

---

## See also

- `calls-and-media.md` — step 4.3 consumes this; 4.4 and 5.3 are out of scope here
- `ecosystem-gaps.md` § 9 — media processing; this is its audio half
- `packages/print-kit/CLAUDE.md` — the one-binary-behind-one-seam shape Phase 3 lifts to
- `packages/litestone/docs/file-storage.md` — the `File` the audio lives in
- `DECISIONS.md` `FJS-D1492` (the engine), `FJS-D541` (a transcript is the app's)
