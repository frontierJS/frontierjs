---
id: failure-handling
status: proposed
dated: 2026-10-08
---

# Idea — failure handling: one fault, read the same way by every layer that may try again

**Status: ruled as `FJS-D655` (B amended), nothing built.** Dated 2026-10-08. Do not cite this file as
describing behavior — see `VERIFYING.md`. Rows marked *(ran)* were probed;
the rest are read from source at the cited line.

The premise is already ruled. `FJS-D194` says what `retryable` means;
`FJS-D201` says there is ONE fault vocabulary, in `@frontierjs/toolbelt/fault`,
read by conduit, caravan and junction. **D201 is unbuilt** — and this paper is
what building it has to settle: the nouns, and what each layer does with a fault.

---

## 1. What exists (measured)

| Piece | Where | What it does |
| --- | --- | --- |
| `retryable` on the wire | `junction/src/core/errors.ts:21,37` | `FrameworkError.retryable?`, serialized only when a boolean |
| one translation owner | `errors.ts` `toFrameworkError` (Invariant 4) | copies a thrown `retryable` boolean onto the framework error (`:171`); *(ran)* `{retryable:false, kind:'server_error'}` → `{"name":"GeneralError","code":500,"retryable":false}` — **`kind` is dropped** |
| Data errors | `litestone/src/core/errors.js` (~20 classes) | each carries `retryable` (`index.d.ts:1095–1212`); `VersionConflictError`/`TransitionConflictError` true, domain refusals false |
| request timeout | `junction/src/transport/http.ts:620` | `RequestTimeout`, 503, `retryable: true` |
| idempotency | `junction/src/core/idempotency.ts:136` `claimIdempotency`, called `service.ts:603` on writes | a keyed write replays its first answer |
| conduit kinds | `conduit/src/types.ts` `CONDUIT_ERROR_KINDS`; `transports/http.ts` `declineReplay` → `indeterminate` | the one place a fault is classified by *kind*, with `retryable` derived (`FJS-D194`) |
| conduit resilience | `types.ts:66–72` — `timeout_ms`, `retry_limit`, `deadline_ms`, `reset_ms`, `max_concurrent`, … per target | in-process retry ladder (`http.ts:195`) + breaker (`resilience.ts`; local faults do not trip it, `FJS-684`) |
| caravan failure | `caravan/src/worker.ts:282–320` | retries until `maxAttempts` (default 3) on a `retryDelay` ladder (1m/5m/30m + jitter); terminal if `err.terminal`. **Never reads `retryable`** (rg: zero hits in `caravan/src`) |
| caravan terminal state | `status: 'failed'` | kept for `retention`, no replay verb |
| webhooks terminal state | `plugins/webhooks/index.ts:86` | `'pending' \| 'delivered' \| 'failed' \| 'dead'`, plus "retry a specific dead delivery" (`:482`) |
| outbox terminal state | `core/outbox.ts:494–527` | `dead` is a *count* (`attempts ≥ maxTry`), not a status |
| user-facing errors | `sierra/src/resource/field-rules.js:1704` (`retryable` read), `:1778` `toFieldErrors` | the client distinguishes *re-read and retry* from a domain refusal |
| `toolbelt/fault` | — | **absent**: no `src/fault/`, no export in `toolbelt/package.json` *(ran: `ls`)* |

**Three words for "gave up": caravan `failed`, webhooks `dead`, outbox `dead`
(computed).** Three ladders: conduit `retry_limit` (in-process, ms), caravan
`maxAttempts`+`retryDelay` (durable, minutes), webhooks/outbox their own.

## 2. The gap, as a failure an app hits

`invoice-collect` is a caravan job calling `app.conduit.send('stripe', …)`.

1. Stripe returns 500 on an unkeyed POST. Conduit answers `retryable: false`
   (indeterminate — the charge may have landed; `FJS-D194`). The handler
   rethrows. **Caravan ignores `retryable` and runs it again in a minute** —
   the exact double charge D194 exists to prevent, one layer up. Only an app
   that remembers to set `err.terminal = true` is safe.
2. Stripe returns 404 (`not_found`, permanent). Caravan retries it three times
   over 36 minutes; the operator sees `failed` with `error: string` — the kind
   is gone (caravan stores `err.message` only, `worker.ts:281`).
3. Same job called from a service instead: `toFrameworkError` keeps
   `retryable` but drops `kind`, so the browser sees a 500 and cannot tell a
   provider outage (`circuit_open`, wait N s) from our bug.
4. The operator wants "everything that gave up today": three tables, two
   spellings, one of them not a column.

The shared defect: **each layer re-derives *should I try again* from a
thrown value that lost its kind on the way up.**

## 3. Options

### A — the fault rides the error; each layer keeps its own ladder

Build `@frontierjs/toolbelt/fault` exactly as D201 says: `FAULT_KINDS`, and
per kind `{ retryable, tripsBreaker, audience }`. A thrown value carries
`fault: { kind, retryable, indeterminate, retryAfterMs? }`. Readers:

- conduit: `CONDUIT_ERROR_KINDS` *becomes* a subset of `FAULT_KINDS`.
- caravan `worker.ts`: `retryable === false` ⇒ terminal (replaces app-set
  `terminal`, which is deleted); `retryAfterMs` floors the next `run_at`.
- `toFrameworkError`: keeps `fault.kind` on the wire beside `retryable`.
- litestone errors: each class names its kind (`conflict`, `refused`, …).

Cost: one toolbelt module, four readers, no schema. Refuses: a retry
decision made from anything but the fault (no `instanceof` ladders in apps,
no `terminal` flag). Leaves three terminal-state words alone.

### B — A, plus one terminal noun and one replay verb

A, and every durable retrier ends in the same state, **`dead`**, with the
same row shape (`kind`, `attempts`, `lastError`, `deadAt`) and one operator
verb, `revive(id)`. Caravan's `'failed'` is renamed `'dead'`; outbox's
computed `dead` becomes a status; webhooks already match. `fli` / devtools
list all dead rows across the three.

Cost: A + a caravan status rename (no back-compat, per policy) + outbox
column + one listing. Refuses: a fourth spelling for *gave up*; a terminal
row with no kind.

### C — one retry engine

Conduit's in-process ladder, caravan, webhooks and outbox all delegate to a
single policy object (`retry: { attempts, delays, deadline }`) evaluated by
one function. Cost: large — the ladders differ in kind, not degree (ms
in-memory vs minutes durable vs at-least-once delivery); a shared engine
needs a mode switch per caller, which is three engines with one name.
Refuses: per-layer tuning. Mostly wrong.

**Recommend B — why.** A alone fixes the double charge (the dangerous half)
and is D201 as written; B adds the operator half for the price of a rename
the evolution policy says costs nothing. C collapses things that are honestly
different (*cut one level simpler*). If B's rename is contested, ship A first
— it does not foreclose B.

## 4. Nouns coined, and every collision

| Noun | Sense | Collisions swept |
| --- | --- | --- |
| **Fault** | a classified failure: `kind` + derived `retryable`/`indeterminate` | D201 already uses it (good). `conduit` "local fault" vs "breaker fault" (`resilience.ts:170`) — same sense, keep. No `VOCABULARY.md` row yet. |
| **fault kind** | member of `FAULT_KINDS` | conduit's `CONDUIT_ERROR_KINDS` ("kind") — subsumed, not parallel. Caravan `onMissingActor` is not a kind. |
| **Dead** (B) | terminal state of a durable retrier | caravan `'failed'` (renamed); outbox `dead` count (becomes status); webhooks `'failed'` is a *non-terminal* attempt state there — **real collision**: webhooks `failed` ≠ caravan `failed`; B removes it. |
| **revive** (B) | operator verb: dead → pending | webhooks "retry a specific dead delivery" (`:482`) — rename to `revive`; `retry` stays the automatic ladder only. No hit for `revive` in `packages/*/src`. |
| `retryable` | unchanged, `FJS-D194` | — |
| `terminal` | **deleted** (A) | caravan `err.terminal`, also caravan's prose "terminal jobs" (`types.ts:247,371`) — prose sense stays. |

Not coined: *transient/permanent* — they are a column of the kind table, not
nouns (D194: transient is not retryable). *User-facing vs operator* is the
`audience` column, not a noun.

## 5. Open questions for the owner

- **Q1 — does a fault cross to the browser by kind?** **A** — `kind` on the
  wire beside `retryable` (lets a form say "provider down, retry in 30 s").
  **B** — `retryable` only; kind stays server-side. **Recommend A** — the
  client already branches on `retryable` (`field-rules.js:1704`) and a kind is
  not a secret; `sanitizeError` still owns message redaction.
- **Q2 — caravan rename `failed` → `dead`?** **A** — rename (B above).
  **B** — keep `failed`, rename webhooks/outbox to it. **Recommend A** —
  webhooks already uses `failed` for a non-terminal attempt, so `failed`
  cannot be the terminal word without a second rename.
- **Q3 — does an indeterminate fault inside a job park or die?** **A** —
  dead immediately. **B** — park pending a reconcile hook (`onIndeterminate`).
  **Recommend A** now; B is a new option and earns its place only when a
  stressor (Quo/Telnyx) needs reconciliation.
- **Q4 — `claimIdempotency` across the caravan hop:** should a job's
  dispatch id become the conduit `Idempotency-Key` by default, turning the
  indeterminate POST into a retryable one? Probably yes; separate paper.
