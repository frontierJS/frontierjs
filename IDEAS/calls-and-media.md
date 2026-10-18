---
id: calls-and-media
status: proposed
dated: 2026-10-13
---

# Idea — Calls and media: a huddle, a screen share and a recording from seams the app already has

**Status: PROPOSED.** Dated 2026-10-13. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. Every noun below is
provisional until `decision-rules` has run on it; the open questions are at the
end and a ruling cites one by its `Q` number.

**Trigger.** Three things read together on 2026-10-13: Slack calls huddles the
fastest-adopted feature in its history and now writes AI notes from them into the
thread; Mattermost's calls plugin does voice, screen share and recording with a
Go SFU and a headless-browser bot; and a screen recorder already exists outside
this repo (`~/code/Z/screen.maverickmade.tech`, Svelte + Tauri, 2.5k lines) that
is most of the browser half. The question was what FJS primitives make
*integrating an app with the browser's media APIs* easy.

---

## The claim

A huddle, a screen share and a recording are, read carefully, **four pieces**,
and FJS owns the seam under each one already:

| Piece | What it needs | What answers it today |
| --- | --- | --- |
| a call | a row that says who is in it and who may join; a roster; a way for two browsers to exchange SDP and ICE | `model Call` + `@@gate`; `channels({ rooms: { 'call:{id}': 'Call' } })` grades membership off the row; presence opt-in per channel, batched as `presence:diff`; a service method + `announce()` on the call's channel is the signaling server |
| a recording | capture, compose, encode, keep, upload | `getDisplayMedia` / `getUserMedia` / WebCodecs are the browser's; Litestone `File` with the S3/R2/B2 provider keeps it; junction's `transport/body.ts` owns the multipart crossing |
| the heavy work | record a call nobody's browser is recording, transcribe it, summarize it | caravan jobs; `@frontierjs/print-kit`'s one headless Chromium behind one seam; `app.conduit.send()` for the STT and the model |
| the artifact | transcript, summary and action items attached to where the call happened | a record attached to the call's channel, written by a job after the call ends — Slack's own shape |

What is missing is the browser-side kit, the rig that strings the first row
together, the server-side participant, and a resumable upload. None of them is
an SFU, and **the first decision this record makes is that FJS does not write
one.**

---

## Prior art, 2026-10 (sources in the links; items marked *unverified* were secondhand)

| Who | How it is built | What is copyable |
| --- | --- | --- |
| **Slack Huddles** | Amazon Chime SDK, bought media ([customers](https://aws.amazon.com/chime/chime-sdk/customers/)). AI notes since 2025-07-17: live audio plus the huddle thread's messages → a canvas of topics, takeaways and action items posted into the thread after the call; off by default, a participant starts it ([help](https://slack.com/help/articles/31377193680019-Use-AI-to-take-huddle-notes-in-Slack)) | **The artifact model.** A call is a thread; the notes are a record attached to it by a job after `call.ended` |
| **Mattermost Calls** | `rtcd`, a Go SFU on Pion v4; WS signaling via the main server ([deployment](https://docs.mattermost.com/deployment-guide/calls/calls-deployment-guide)). Recording = `calls-recorder`: a bot user joins in Chromium on Xvfb via chromedp, ffmpeg grabs screen and audio, the file is posted to the call thread ([repo](https://github.com/mattermost/calls-recorder)); 720p15 → 8 concurrent jobs on a c6i.2xlarge. Transcription = whisper.cpp tiny/base/small as a job; live captions tiny/base only, ~1.3 GB per call ([offloader](https://github.com/mattermost/calls-offloader)) | **The recorder is a participant.** Record and transcribe are jobs; their runner is a Docker-per-job service, which is their choice and not the pattern |
| **LiveKit** | OSS SFU + client SDKs + Agents (an agent is a headless participant) + Egress (headless-Chrome room composite) + Ingress (WHIP). Cloud free tier 5,000 min, then $0.0005/participant-min ([pricing](https://livekit.com/pricing)). Matrix's Element Call, Pipecat and most agent frameworks target it | The SFU adapter's first target. Its Room / Participant / Track words are the field's |
| **Cloudflare Realtime** | SFU + anycast TURN at $0.05/GB, TURN free with the SFU, **the app keeps signaling** ([pricing](https://developers.cloudflare.com/realtime/sfu/pricing)). RealtimeKit (ex-Dyte) is the full room SDK at $0.002/min | Cheapest hosted media and TURN when signaling stays ours |
| **Browser, what shipped** | WebCodecs everywhere (Safari 26). WebTransport baseline (Safari 26.4). `RTCRtpScriptTransform` cross-browser since Chrome 141. `MediaStreamTrackProcessor`: Safari worker-only, Chrome main-thread, **Firefox none**. Document PiP: Chrome 116, Firefox 151, no Safari. **iOS Safari has no `getDisplayMedia`** ([caniuse](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia)). Region Capture, Element Capture (Chrome 132), Conditional Focus, Captured Surface Control: Chromium only | Feature-detect, never branch on UA. Every screen-share nicety is progressive enhancement; the baseline is capture, WebCodecs, MediaRecorder |
| **Recording stack** | `webm-muxer` / `mp4-muxer` are deprecated for **Mediabunny**: demux, mux and encode, a `StreamTarget` that writes to OPFS with backpressure so a multi-GB recording never grows the heap ([guide](https://mediabunny.dev/guide/introduction)). ffmpeg.wasm alive, in-memory FS, post-processing only. Cap (OSS Loom, Tauri 2, AGPL) uploads while recording and applies zoom at render time from a cursor event log ([Cap](https://github.com/CapSoftware/Cap)); Screen Studio the same | WebCodecs → Mediabunny → OPFS, MediaRecorder with a duration fix as the fallback, and a **cursor/click event log saved beside the media** so zoom is a render-time job |
| **Uploads** | tus is deployed; the IETF `draft-ietf-httpbis-resumable-upload-12` (Apple, Cloudflare, Transloadit) is past WGLC and in `URLSession` ([draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-resumable-upload/)) | Resumable chunks into a raw route, finalize as a job |
| **AI participant** | On infrastructure you own, the agent **joins the room as a participant** (LiveKit Agents, Pipecat). On meetings you do not own, a bot joins through a headless browser (Recall.ai, $0.50/hr). Nobody transcribes inside the SFU. Streaming STT: Deepgram $0.0048/min, AssemblyAI $0.0025/min billed on session time, whisper.cpp self-hosted | One primitive covers recording, transcription and notes: a server-side participant |
| **Signaling** | Transport-agnostic; the WS is the signaling server. Mesh holds to about four participants (n·(n−1) encodes); beyond that an SFU. Serverless signaling (Trystero) is toy-grade. MoQ is `draft-22`, not a 2026 dependency | Nothing to buy for mesh. A full-ICE SDP does not fit a QR code and NAT still wants TURN |

*Unverified:* Safari 26 screen-share audio; the exact Chrome versions of
`surfaceSwitching` and `monitorTypeSurfaces`; Agora and 100ms per-minute figures.

**The recorder app, read against this.** `getDisplayMedia` + `getUserMedia` mixed
into one `MediaStream` → `MediaRecorder(200ms)` → `fixWebmDuration` → Cloudinary
→ rewritten share URL; a draggable webcam bubble, a HUD with hotkeys, a trim
timeline and an MP4 convert, both over a CDN-loaded ffmpeg.wasm. What prior art
exposes: the whole recording sits in a chunks array in RAM, the upload starts
after stop rather than during, there is no event log so a zoom can never be
added, and ffmpeg.wasm is a heavy trim. What ports as is: the four components'
UX.

---

## The four pieces

Names are provisional (Q1). The unit is a **Rig** (`FJS-D630`): schema fragment,
a `service/` part that is a Plugin, UI parts, any subset installable.

### 1. A browser media kit — UI realm, a leaf beside `@frontierjs/ui`

Pure functions and Mesa components, no server dependency, so `site/`, `widgets/`
and `extension/` get it too. Answers the client half of `ecosystem-gaps.md` § 9.

```
capture()   getDisplayMedia / getUserMedia; the Chromium extras feature-detected
compose()   screen + camera bubble; canvas captureStream by default, a WebCodecs worker where MediaStreamTrackProcessor exists
record()    WebCodecs → Mediabunny → OPFS; MediaRecorder + duration fix as the fallback; the cursor/click/timestamp event log written beside the media
upload()    resumable chunks, sent while recording, tus-shaped
<Recorder/> <CamBubble/> <RecordHud/> <Trim/>   the four Svelte components, ported
```

Mediabunny is the one dependency and it is charged to the kit, not the core.

### 2. The `calls` rig — three realms

```
schema    model Call { channel, startedAt, endedAt, participants, artifacts File[] } @@gate(…)
service   calls.start / join / leave / signal({ to, sdp | ice }) / turn()
channel   call:{id} — presence on, rooms: { 'call:{id}': 'Call' }
client    client.calls.join(id) → tracks in and out; roster as a signal
ui        <CallDock/> <ScreenShare/> <Participants/>
adapter   mesh (default, ≤4, no infrastructure) · livekit · cloudflare-sfu
```

**Signaling rides what exists.** The WS dispatcher handles `ping`, `pong`,
`service_call`, `subscribe` and `unsubscribe` and nothing peer-to-peer, which is
right: `calls.signal` is a service call graded like any other, and the frame
reaches the one recipient through `announce()` on the call's channel. Signaling
latency is not media latency.

**The adapter seam is one interface**, `connect(room, token) → { publish,
subscribe, leave }`, and the rig's schema, service, channel and UI never learn
which one is behind it. Mesh needs TURN beyond a LAN: coturn self-hosted, or
Cloudflare's. `calls.turn()` mints short-lived credentials; a static credential
in the bundle is the shape this refuses.

### 3. A server-side participant — one primitive, three jobs

A Bun process holding a participant token for the call. Under mesh it is a
caravan job that runs a headless Chromium, joins as a bot principal and pipes
what it receives to a file or an STT socket — the print-kit worker's shape, run
from the job rather than as a Docker container per job. Under LiveKit it is
Egress and Agents, and the job only orchestrates.

Three jobs stand on it: **record** (artifact → `Call.artifacts`), **transcribe**
(whisper.cpp local, or Deepgram through a conduit target), **notes** (transcript +
the channel's messages → summary and action items, through `app.conduit.send()`,
written as a record attached to the call's channel). Live captions wait on
`chat-surface.md` § Part 1: a method that declares it streams.

### 4. A resumable upload — one owner, two consumers

A raw route that accepts chunks with an offset, a finalize job that writes the
Litestone `File`. The recorder kit sends to it while recording; `bulk-data.md`'s
import is the second consumer. tus-shaped on the wire so the IETF draft's
clients (Apple's `URLSession` among them) can speak to it later.

---

## The nine (`PHILOSOPHY.md` § V), answered before any edit

1. **Origin** — call state lives in the `Call` row and nowhere else; the roster
   is channel presence; the transcript is a record; media state lives in the
   browser or the SFU and is never persisted. One origin per fact.
2. **Concept budget** — three new words: *call* (a row), *media adapter* (a seam),
   *server-side participant* (a job shape). The kit is components, not a
   concept. Dependencies charged: Mediabunny to the kit, a LiveKit SDK to its
   adapter only, nothing to the core. The field has older names for all three
   (room, media server, bot) and § IV's *familiarity vs. precision* says steal
   the proven shape; Q1 asks which spelling.
3. **Complexity** — NAT traversal, the n² mesh ceiling, codec and container
   choice are the problem's and the field named them (TURN, SFU, WHIP). The
   adapter seam is the one thing we add, and a second SFU without it is the
   complexity we would have added.
4. **Predictability** — the rig has `notifications`' shape, the jobs have
   caravan's, the channel policy is `rooms` as it exists, the worker is
   print-kit's. Knowing one teaches the next.
5. **Derived** — roster from presence, admission from the `Call` row's gate,
   transcript from the recording, notes from the transcript. Nothing maintained
   by hand beside its source.
6. **Owner** — signaling: `transport/channels.ts` (`announce()`); files:
   Litestone's store (`FJS-D260`); heavy work: caravan; the vendor call:
   conduit. **The headless Chromium has an owner already** in print-kit, and its
   seam is PDF-shaped — a second Chromium owner beside it is an Invariant 4
   breach, so Q3 asks whether print-kit's worker is lifted into a seam both
   consume.
7. **Boundary** — the adapter interface is typed; `calls.signal` goes through
   `validateInput`; the chunk route is tested by the kit's spec and by
   bulk-data's; the `rooms` policy is already tested.
8. **Failure** — a join the gate refuses is a 403 by name. A missing TURN in
   production connects on a LAN and silently fails across NAT, which is a
   destructive silence, so a prod start with mesh and no TURN is a refusal
   (`fli check`, or the plugin's `ready`). A failed recording job retries and
   notifies; it never drops the artifact silently.
9. **Silence** — a call that "connects" with no media: the artefact is a browser
   drive over two CDP tabs asserting a track arrives, on mesa's shared harness. A
   recording with no duration or an unseekable container: the kit's spec parses
   its own output (Invariant 15's shape). No TURN in prod: the rule in 8.

**Adjudications in tension** (§ IV): *batteries vs. smallness* — every media
dependency sits in a kit or a rig and the core is untouched; *paved road vs. the
workaround* — mesh is the paved road and the SFU adapter is a second road, not a
workaround, because the n² ceiling is the problem's; *familiarity vs. precision*
— the field's room/participant/track words are taken as is. *Preservation vs.
evolution*: none in tension, nothing here exists yet.

**Tier** (§ VII): Assessment. A ruling on a `Q` below moves to the Register.

---

## Open questions

- **Q1** — The nouns. `Call` for the row; *huddle* is Slack's product word and
  *room* is the SFU's. **Recommend `Call`** — it is what the row is, and the
  adapter keeps *room* for the SFU's object.
  - **A** — `model Call` is the row, `calls` the rig, `call:{id}` the channel; *room* survives
    only inside the adapter as the SFU's object (`connect(room, token)`, § 2)
  - **B** — `model Huddle`: Slack's product word as the noun, `huddles.*` service; the row
    then names one UX rather than the thing every meeting, 1:1 or bot join is
  - **C** — `model Room`: the SFU's word lifted to the row, so the adapter's `connect(room)`
    and the schema share one noun — but a mesh call has no room object to match it
  - **Recommend A** — the row is a call whatever the transport, and keeping *room* behind
    the adapter keeps one word for one thing (`decision-rules` coin test).
- **Q2** — Mesh default or SFU default? **Recommend mesh**: zero infrastructure,
  ≤4 covers the huddle; the SFU adapter is Phase 5.
  - **A** — mesh is the default adapter: no infrastructure past TURN (`calls.turn()`), ≤4
    peers; LiveKit / Cloudflare SFU adapters arrive in Phase 5 behind the same `connect()`
  - **B** — an SFU is the default from Phase 1: LiveKit (self-hosted or cloud) as a required
    service for any app with calls; scales past 4 and gives Egress for § 3, but every app
    pays a server and a token issuer before its first call
  - **Recommend A** — the target is the ≤4 huddle, and the adapter seam means the SFU is a
    config change later, not a rewrite; B charges infrastructure to the common case.
- **Q3** — Does print-kit's Chromium worker become a seam two kits consume, or
  does the server-side participant get its own? **Recommend lift**: one owner,
  and the 25-jobs-per-tab replacement and the 30 s wedge rule are already learned
  there.
  - **A** — lift: `createPrinter`'s queue/tab worker (`packages/print-kit/src/printer.js:37`)
    becomes a shared seam the participant also consumes
  - **B** — the participant builds its own worker on `@frontierjs/mesa/drive` (`openChrome`,
    already what print-kit imports, `printer.js:31`), which is where the 30 s bound lives
    (`printer.js:34`); print-kit stays as it is
  - **Recommend B** — the printer's lessons are specific to short, offline, script-off,
    one-at-a-time jobs (`printer.js:20`, `TAB_JOBS = 25` at `:69`); a participant is one
    long, networked, script-on tab, so the shared part already has its owner in `mesa/drive`.
- **Q4** — Does the recorder kit need a schema at all? **Recommend no**: a share
  link is a `File` column in the app's own model; the kit stays a leaf.
  - **A** — no schema: the kit is a UI leaf; an app that keeps recordings declares its own
    `File` column (as `Call.artifacts` does, § 2)
  - **B** — the kit ships a `Recording` schema fragment an app imports (the way auth ships
    fragments), with share-link and view-count fields — and so a server half
  - **Recommend A** — a schema makes the kit a three-realm rig and ends its use from
    `site/`, `widgets/` and `extension/` (§ 1); B can be added when two apps model the same row.
- **Q5** — `desktop/` (Tauri 2) for native capture, Cap-style? **Recommend not
  now**: web `getDisplayMedia` covers everything but macOS system audio and the
  picker, and iOS is out either way.
  - **A** — not now: web `getDisplayMedia` only; macOS system audio and the native picker
    are recorded as known gaps
  - **B** — a `desktop/` surface (`FJS-D263`) that `wraps` `web/` and adds a Tauri 2 native
    capture plugin for system audio and the picker, Cap-style
  - **Recommend A** — the gap is two features on one OS, and B adds a native build and
    release to a kit that is not yet built; `FJS-D263` keeps B open as a later surface.

---

## Phases

### Phase 0 — Groundwork

Goal: prove the seams carry it before anything is named.
Done when: two tabs in `example` exchange an offer and an answer over a service call and `announce()`, and a `rooms` policy on `call:{id}` refuses a third tab the gate does not admit.

- [ ] 0.1 Spike signaling: a `calls.signal` method on a throwaway service, `announce()` on `call:{id}`, two CDP tabs, SDP round trip measured
- [ ] 0.2 Confirm `channels({ rooms })` grades `call:{id}` off a `Call` row with a `@@gate`, presence on for that channel only
- [ ] 0.3 Measure the recorder app: which of its four components port unchanged, what ffmpeg.wasm is used for, what the chunks array peaks at on a ten-minute recording
- [ ] 0.4 Rule Q1–Q5

### Phase 1 — The `calls` rig, mesh only

Goal: a huddle in `example` with nothing to deploy beside the app.
Done when: a browser drive over two CDP tabs asserts a remote track arrives in each, and `fli check` refuses a prod start with mesh and no TURN.

- [ ] 1.1 Schema fragment: `Call`, `@@gate`, `participants`, `artifacts File[]`
- [ ] 1.2 Service: `start`, `join`, `leave`, `signal`, `turn`; `validateInput` on `signal`
- [ ] 1.3 Channel: `call:{id}` with presence, `rooms` policy
- [ ] 1.4 Client: `client.calls.join(id)`, the mesh adapter behind the one interface
- [ ] 1.5 UI: `<CallDock/>`, `<Participants/>`, `<ScreenShare/>`
- [ ] 1.6 The no-TURN-in-prod refusal
- [ ] 1.7 The two-tab drive on mesa's harness

### Phase 2 — The browser media kit

Goal: the recorder app, as a leaf Mesa kit, with the RAM and the late upload fixed.
Done when: a ten-minute recording's heap stays flat, its output parses as a seekable container in the kit's own spec, and the event log sits beside it.

- [ ] 2.1 `capture()` with every Chromium extra feature-detected
- [ ] 2.2 `compose()`: canvas `captureStream` default, WebCodecs worker where `MediaStreamTrackProcessor` exists
- [ ] 2.3 `record()`: WebCodecs → Mediabunny → OPFS; MediaRecorder + duration fix as the fallback
- [ ] 2.4 The cursor/click/timestamp event log
- [ ] 2.5 Port `<Recorder/>`, `<CamBubble/>`, `<RecordHud/>`, `<Trim/>`; trim over Mediabunny rather than ffmpeg.wasm
- [ ] 2.6 The spec: output parsed, duration asserted, Firefox and Safari paths exercised

### Phase 3 — The resumable upload

Goal: one owner for a chunked upload, used by the kit and ready for bulk-data.
Done when: a recording uploads while it records, a dropped connection resumes from its offset, and the finalize job writes a Litestone `File`.

- [ ] 3.1 Raw route: create, chunk at offset, head; tus-shaped
- [ ] 3.2 Finalize job → `File`
- [ ] 3.3 `upload()` in the kit sends during `record()`

### Phase 4 — The server-side participant

Goal: a call nobody's browser is recording still gets its recording, transcript and notes.
Done when: a job joins a mesh call as a bot principal, the artifact lands in `Call.artifacts`, and a notes record is attached to the call's channel.

- [ ] 4.1 Lift or sibling the Chromium worker (Q3)
- [ ] 4.2 Record job: join as bot principal, write through Phase 3
- [ ] 4.3 Transcribe job: whisper.cpp local, Deepgram as a conduit target
- [ ] 4.4 Notes job: transcript + channel messages → `app.conduit.send()` → record on the channel

### Phase 5 — The SFU adapter

Goal: the same rig past four participants.
Done when: `example` runs the Phase 1 drive against a LiveKit room with no change to schema, service, channel or UI.

- [ ] 5.1 LiveKit adapter behind the one interface
- [ ] 5.2 Egress replaces 4.2 and Agents replaces 4.3 under that adapter
- [ ] 5.3 Live captions, once `chat-surface.md` § Part 1 has landed

---

## See also

- `chat-surface.md` § Part 1 — the streamed service response live captions wait on
- `rigs.md` — the unit; `FJS-D630`
- `ecosystem-gaps.md` § 9 — media processing, the client half answered here
- `bulk-data.md` — the second consumer of Phase 3
- `packages/print-kit/CLAUDE.md` — the worker Q3 is about
- `packages/junction/docs/internals.md` § channels — presence, `rooms`, the frame bounds
