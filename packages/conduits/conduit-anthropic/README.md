# @frontierjs/conduit-anthropic

The Messages API over `@frontierjs/conduit`: a completion, a token count, a
bounded tool loop, and a stream read through `conduit.stream()`. Sink-only — no key exists
on this machine and the vendor is the only implementation.

**A completion is a bill.** Every `createMessage` is sent once: Anthropic has no
idempotency key, so a replay is a second charge. A 429, a 529 and a lost
response come back to the caller with `retryable` and `retryAfterMs`, and the
caller decides when to spend again. A count is free and is replayed by conduit.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `anthropicTarget({ ref?, address? })` — `api_key` under `x-api-key`, `anthropic-version: 2023-06-01` on the target, `resilience.timeout_ms: 120_000` |
| calls | `createMessage(send, req)` (unkeyed, unreplayable), `countTokens(send, req)` (`replayable: true`) |
| tool loop | `runToolLoop(send, req, tools, { maxTurns })` — `tool_use` → run → `tool_result` → again; usage summed across turns; `turn_limit` when capped, with the conversation so far |
| streaming | `streamMessage(bindStream(conduit), req)` — the vendor's events through `conduit.stream()`; `assemble(events)` joins the deltas |
| payload types | `MessagesRequest`, `MessagesResponse`, `ContentBlock`, `Usage`, `StreamEvent`, `AnthropicErrorBody` |
| error mapping | `translate(ConduitError, status) → AnthropicFailure` — the table below |
| sink | `sink.ts`, `startAnthropicSink()` on `port: 0` |
| door | `anthropicDoor({ send, model?, maxTokens?, effort? })` — one question, one `Reply` |
| drive | `bun run drive` — 42 rows, sink only |

`send` is `bindSend(conduit)`: the connector never holds an app.

## Errors

| vendor `error.type` | HTTP | conduit kind | `AnthropicFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `invalid_request_error` | 400 | `client_error` | `refused` | no |
| `authentication_error` | 401 | `auth_failed` | `auth_failed` — forget the key | no |
| `permission_error` | 403 | `auth_failed` | `forbidden` — the policy's, keep the key | no |
| `not_found_error` | 404 | `client_error` | `model_gone` — the pinned model id retired (`FJS-D153`'s cadence cost) | no |
| `request_too_large` | 413 | `client_error` | `too_long` | no |
| `rate_limit_error` | 429 | `rate_limited` | `rate_limited`, `retryAfterMs` from `retry-after` | yes, after the wait |
| `overloaded_error` | 529 | `server_error` | `server_error` — refused at the door, nothing billed | yes |
| `api_error` | 500 | `server_error` | `server_error`, `indeterminate: true` — may have run | no |
| — | — | — | `turn_limit` — the loop hit `maxTurns`; local | no |

The 403 and the 404 are read off the status, since conduit folds each into a
neighbor. The 529 is the one place the connector reopens a `retryable` conduit
closed: conduit answers an unkeyed POST's 5xx as indeterminate, and the vendor's
own word for a 529 is that the request was not run.

## The door

`anthropicDoor({ send })` is the Messages API as `@frontierjs/toolbelt/ask`'s
one-answer door: `door(question, { model, signal })` returns a `Reply` and never
throws. It is the deployed half of what `@frontierjs/claude`'s `claudeDoor` does
on a developer's machine, so an app moves between them without changing a line.

```ts
import { anthropicDoor, bindSend } from '@frontierjs/conduit-anthropic'

const ask = anthropicDoor({ send: bindSend(conduit), effort: 'low' })
const reply = await ask({ prompt: 'Who signed it?', schema: { type: 'object', properties: { name: { type: 'string' } } } })
```

The model is `opts.model`, else the door's, else `DEFAULT_MODEL`
(`claude-sonnet-5-5`); `maxTokens` defaults to 16 000 and `effort`, absent, is
left off the request. `question.schema` goes through `normalizeSchema` first:
every object closed with `additionalProperties: false`, the bounds the API
refuses dropped. A safeguard decline (`stop_reason: 'refusal'`) is `refused`,
`max_tokens` is `cut_off`, and a schema answer that is not a JSON object is
`no_answer`. `costUsd` is `null` until a price table exists.

The door sends again once on a 429 or a 529, which are refused before anything
ran, waiting `retry-after` (about a second when absent; over 30 s it gives up
as `rate_limited`). A timeout, a dropped connection or a 500 is never resent.

## Streaming

`streamMessage` posts through `conduit.stream()`, which reads the
`text/event-stream` and yields one chunk per event (`FJS-D934`). The breaker,
concurrency cap, observers and credential remint apply to a stream as they do
to a completion, and a refusal before the first event goes through the same
`translate()`. Every stream ends in exactly one of `message_stop`, the vendor's
`error` event, or the connector's `stream_error`. A socket that closes before
`message_stop` is `stream_error` even when the close is clean.

## Chaos the sink owns

`/_sink/arm` with `{ lost }`, `{ rateLimit: { retryAfter } }`, `{ overloaded }`,
`{ failNext }`, `{ dieMidStream }`. A model id starting `retired-` is the 404, a
body over 32 KiB the 413, a key the sink knows and refuses is the 403. A missing
`anthropic-version` is refused by name — the drive's negative control. A
`get_weather` tool with no `tool_result` yet is the `tool_use` turn; a
`cache_control` block is created on first sight and read after.

## Traps

- **Never put `stream: true` on `createMessage`** — refused locally; the events
  would arrive as one unparsed text body. Use `streamMessage`.
- **`maxTurns` is a bill cap, not a safety net**; the capped result carries
  `messages` so the loop can be resumed with a larger budget.
- **The target's 120 s timeout is per attempt**; a drive or a probe overrides it
  on the descriptor, not by a per-call `timeout_ms`, which conduit grades as the
  caller's patience and does not count against the target.
