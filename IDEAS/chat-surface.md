---
id: chat-surface
status: proposed
dated: 2026-09-18
---

# Idea — The conversational surface: a chatbot a visitor can talk to

**Status: PROPOSED.** Dated 2026-09-18. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

**"Agent" means an AI caller and keeps meaning that** (`FJS-D29`, and
`IDEAS/agent-surface.md` owns it). This record is the **other direction**: the app
speaks to a human visitor through a model it drives. The two meet at exactly one
place — the tool list — and the rule there is that there is one generator, not two.

**Two things this file does not re-derive.** `IDEAS/ecosystem-gaps.md` § 12 raised
the streaming design question and left it open pending a ruling; its four-item
table raised vectors and embeddings in one line. This record answers the first and
argues the second. Where it disagrees with those rows, they are the older date.

---

## The claim

A website chatbot is the most requested feature of the moment and it is, read
carefully, four things an application framework either owns or leaves to glue:
**a conversation persisted and access-controlled**, **tokens delivered as they
arrive**, **the app's own data retrieved to ground an answer**, and **the model
allowed to act, bounded by who is asking**.

Probed against the tree, FJS already owns most of the first and all of the
fourth's hard half, and owns the second only *outside* its own API pipeline.

| What a chatbot needs | What answers it today |
| --- | --- |
| a transcript, gated, with a stranger allowed to write their own | `.lite` + `@@gate("0.…")`; the guest-basket pattern in `example/api/src/services/carts.service.ts` is the same shape and is proven |
| a model call with a deadline, a retry, a breaker and a signed header | `app.conduit.send()` — and the vendor stays the app's (`FJS-D153`) |
| the adapter shape to call it behind | `IAIModel` / `AIBuilder` / `AIRegistry` in `packages/junction/src/ai/index.ts` |
| tokens pushed to a browser | `ctx.sse()`, **raw routes only** |
| keyword retrieval over the app's own rows | `@@fts` + `db.x.search()` |
| abuse control on an unauthenticated endpoint | `rateLimitHook` |
| an embed on a page the app does not own | the `widgets/` surface — one `.mesa` into one self-contained IIFE in a shadow root |
| files in the conversation, redaction in the trail | `File[]`, `@encrypted` / `@guarded`, Invariant 7 |
| a human taking the conversation over | channel presence |
| the tool list, scoped to the caller's standing | `packages/mcp` — `generateJsonSchema` at `audience: 'client'` plus four grading inputs (`FJS-D258`) |

So the schema, the service, the gate, the widget and the vendor call are all
there. What is missing is the **middle of the one call this feature makes most**,
and a column type.

---

## Part 1 — A streamed service response *(the seam; the rest is downstream of it)*

**The defect this is really about.** `wrapResult` refuses a stream by name and is
right to (`FJS-D13`): a `Response` and a `ReadableStream` both have no enumerable
own properties, so wrapping one answered `{"kind":"single","data":{}}` with the
stream destroyed. The escape that exists is `ctx.sse()` on a raw route, which
`packages/junction/docs/internals.md` describes accurately as *right for a heartbeat,
wrong for records* — **no hooks, no `gateAuth`, no field protection, no directive
parse**.

Every chatbot built on FJS today therefore routes its single hottest call around
the entire API realm. That is not one developer leaving the paved road; it is the
same workaround in the same place every time, which § IV calls a measurement of the
road.

**What it is not.** `kind` stays two-valued. A third value is branched on at ten
sites and arrives at every one as *not a list* (`FJS-D13`), and the envelope
describes a complete value. Streaming is not an envelope kind.

**What it is.** A method **declares** that it streams, and the pipeline runs
unchanged around it:

- the declaration is on the method, so `describe()` carries it and the client,
  the OpenAPI projection and the MCP projection all read one fact;
- before-hooks, `gateAuth`, the transaction and `ctx.directives` run exactly as
  now, because they run **before the first token**;
- **each frame is a result** and goes through `protect()` and the after-hooks the
  way a published frame already does — which is the precedent, not a new idea:
  `publish()` is an after-hook for this reason;
- transport is `ctx.sse()` under HTTP and the existing `event` frame under WS, so
  neither transport learns a new concept;
- the client gets one call shape that yields chunks and resolves to the final
  record. It does not get a second client.
- a method that returns a bare `ReadableStream` is still refused by name. The
  declaration is the only door.

**The durable half is the transcript, and the stream is a view of it.** The WS
layer deliberately carries no seq and the client comment says *do not add one*;
SSE has no replay. So a reload mid-answer must be recoverable from persisted
`Message` rows and never from the stream — which is the answer FJS's own shape
already wanted, and it makes the interrupted-answer case a model question
(`@@transitions` on a message: `streaming → complete → failed`) rather than a
transport question.

**The artefact that makes the old way visible.** A `fli check` rule: a raw route
that calls `ctx.sse()` and reaches no gate is a finding, named. Today that route
is indistinguishable from a correct one, and what it leaks is records.

---

## Part 2 — `Embedding(n)` and `findSimilar()`

**Superseded by `IDEAS/embedding.md` (2026-09-20), which measured the engines and
changed both names in this heading.** The claim below survives and is strengthened
— a prefilter measures as a 3–4× cut to the scan, so the gate does not merely
apply for free, it pays for itself — but the column is `Bytes @vector(n)` and the
retrieval is an `orderBy` on `findMany`, not a verb. Read that record for the
shape; this section is kept for what a chatbot needs on top of it.

Listed in `packages/litestone/docs/roadmap.md` as
`Embedding(1536)` + `findSimilar()` + cosine, and as one row in
`IDEAS/ecosystem-gaps.md`'s four-item table with the verdict already applied —
*in-house column type; the model that produces the embedding is a Conduit target
already*. This record only adds what a chatbot needs on top:

- **hybrid retrieval, and no new word for it.** FTS5 ships; a distance comparison
  is the half that does not exist. Grounding an answer is `search()` and
  `findSimilar()` over the same `where`, so **the gate and the row policies apply
  to retrieval for free** — which is the whole claim, and is structurally
  unavailable to anything whose authorization lives in handlers. A retrieved
  passage a caller may not read is the leak this feature would otherwise be.
- **embedding on write is a transform hook**, which litestone already has. No new
  pipeline.
- **chunking is the app's.** A chunk is a row; deciding where a document breaks is
  domain work and a framework guessing it is a config flag with a paragraph
  attached.

---

## Part 3 — Content blocks and a tool turn

`AIMessage` is `{ role, content: string }`. Every current model API takes a list
of typed blocks (text, image, tool use, tool result) and returns them, so the
present shape cannot express a bot that *does* anything, cannot carry a
screenshot, and cannot ask for structured output.

Widening `AIMessage.content` to blocks is a shape change inside the battery, which
stays severable — no vendor enters junction.

**The tool list is derived and there is exactly one generator.** `packages/mcp`
already produces a tool definition per service method, with input schemas at
`audience: 'client'` (because `system` would put a password hash into a tool
description) and four grading inputs deciding visibility per standing
(`FJS-D258`). A chatbot answering a signed-out visitor sees the level-0 tool set
because the same grader says so. Writing a second tool generator for the chatbot
path is the failure mode here, and it is the tempting one, because the MCP package
sits behind a plugin and reads at first glance as *the agent feature*.

---

## Part 4 — A dev model sink

Every other outbound integration in this repo has a dev stand-in: a mail sink, a
payment provider, an identity provider, a Stripe stand-in, two hosting providers.
A model has none, so a test either hits a paid vendor or hand-fakes `IAIModel` —
and a hand-faked adapter is exactly the shape Invariant *fake clients hide real
bugs* was written about.

Cheap, and it belongs beside the others: a small server that answers the adapter
contract deterministically, streaming its tokens on a timer so the Part 1 seam has
something honest to be tested against.

---

## Part 5 — Chat components in `@frontierjs/ui`

Absent: a transcript list, a message bubble, a pending indicator, autoscroll that
does not fight a reader who scrolled up, and a renderer for a message body.
`@markdown` exists at the data boundary and nothing renders it.

Constraints, both already binding: a kit component may not style a class
`@frontierjs/css` owns, and a message is styled by tone and treatment rather than
by a color. Nothing here needs a new class.

---

## Part 6 — Token accounting

`AIResponse` carries `inputTokens` and `outputTokens` and nothing persists,
aggregates or caps them. For a hosted bot that is money, and a per-tenant budget
is the difference between a feature and an unbounded bill payable by whoever
scripts the widget.

Two owners already exist and a third must not be invented:
`app.registerMetricsSource(name, fn)` for the live number, and a row for the
durable one. The cap itself is a before-hook refusing the call, so it inherits the
audit trail and the gate like every other refusal.

---

## The widget is an off-origin caller, and that is its own small list

- **A cookie does not cross to a third-party domain.** The visitor identity is a
  minted token the transcript's own policy checks, which is `cartToken`'s shape
  exactly (`@@allow('read', token == auth().cartToken)`), not a bearer credential
  handed to a page the app does not control — `IDEAS/bearer-access.md` and the
  off-origin finding behind `FJS-D204` are the reasons to state this once here.
- **Rate limiting is per visitor and per origin**, and the origin is the only one
  of the two the app can trust.
- CORS is configured, not defaulted open, on the one surface a stranger reaches.

---

## The nine questions (`PHILOSOPHY.md` § V) — answered before any code

1. **Another origin of truth?** No, if two rules hold: the tool list derives from
   `packages/mcp`'s generator, and token counts land in a metrics source plus a
   row rather than a third counter. Both are the way this proposal fails.
2. **Concept budget?** +1 concept (a method that streams) and +1 column type. Not
   a third envelope `kind`, not a second client, not a word for hybrid retrieval.
3. **Whose complexity?** Token-at-a-time delivery, retrieval and metered spend are
   the problem's. The dev sink is ours and is small. Chunking is refused as the
   app's.
4. **Predictability?** Improves. Today a developer must know that the chat call is
   the one call with no gate, no hooks and no field protection, and nothing says
   so at the call site.
5. **Derived rather than restated?** The tool list, the input schemas, the tool
   visibility, a message label and a control all derive from the seed. The
   embedding dimension is the column's.
6. **Exactly one owner?** Streaming: the bridge that owns the envelope. The
   column: litestone. Blocks: junction's AI battery. Components:
   `@frontierjs/ui`. Metering: `registerMetricsSource` + one model. The sink: the
   app, beside its sibling stand-ins.
7. **Boundary named, typed, tested?** The declaration is the boundary and an
   undeclared stream is refused by name. Testable, with one honest gap: transport
   parity compares HTTP against WS, and a streamed call is the first method whose
   two transports are not the same shape — see § Open questions.
8. **Failure proportional?** The cost of being wrong here is records leaving
   through an ungated stream, so the default is refuse: a declared stream runs the
   full pipeline and per-frame `protect()`, and an undeclared one does not exist.
9. **Wrong with nothing saying so?** Today, yes — an ungated `ctx.sse()` route
   reads exactly like a correct one. The artefact is the `fli check` rule in
   Part 1, and it is the part of this record most worth building first.

**Adjudications in tension** (§ IV): *paved road vs. the workaround* — the same
raw-route workaround in the same place every time is the measurement, so the road
changes. *Batteries vs. smallness* — the AI battery stays severable and no vendor
enters it, `FJS-D153` unchanged. *Familiarity vs. precision* — the ecosystem's
shapes are taken (blocks, tool turns, streamed tokens) and two of its words are
not: `agent` is already an AI caller here, and *RAG* names a pipeline this
framework does not have.

**Tier** (§ VII): Assessment. This binds nothing. Part 1 needs a ruling in
`DECISIONS.md` before it is built, and § 12's open question is what it closes.

---

## Open questions

- **How does a streaming method DECLARE itself, and what does a transport that
  cannot stream answer?**
  - **A** — an option on the method definition, and a non-streaming transport
    buffers the frames and answers one ordinary envelope.
  - **B** — an option on the method definition, and a non-streaming transport
    refuses the call by name.
  - **Recommend A** — buffering keeps transport parity meaningful (the same call
    down both transports still compares), and a refusal moves a transport
    limitation into every caller. It costs one honest sentence: under a
    non-streaming transport the tokens arrive together.
- **Does a frame go through the after-hook chain, or only through `protect()`?**
  - **A** — the full after chain per frame, consistent with `publish()`.
  - **B** — `protect()` per frame, the after chain once on the final record.
  - **Recommend B** — an after-hook that announces, enqueues or invalidates would
    fire once per token under A, and a hook author cannot be expected to know
    which of their hooks is on a streamed method.
- **Does the transcript belong to the framework or to the app?**
  - **A** — machinery models: the framework ships `Conversation` / `Message`
    (`IDEAS/machinery-models.md`'s question, and its rule — right for every app →
    import; the app must decide → ship the file).
  - **B** — the app's own models, with only the streaming seam and the column type
    in the framework.
  - **Recommend B** — for now: a transcript's gate, its retention and its tenancy
    differ per app, and a shipped `@@gate` is final. Revisit once two apps here
    have written one.

---

## Sequencing

1. The `fli check` rule on an ungated `ctx.sse()`. It is the visibility artefact
   for the defect that exists today and it costs a rule.
2. The ruling on Part 1, then Part 1. Everything else is downstream of it, and
   `IDEAS/agent-surface.md` needs the same seam.
3. The dev model sink, because Part 1 cannot be honestly tested without it.
4. `Embedding(n)` + `findSimilar()`.
5. Content blocks and the tool turn, reading `packages/mcp`'s generator.
6. Components, then metering.
