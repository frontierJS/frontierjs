# @frontierjs/conduit-turnstile

Cloudflare Turnstile's `siteverify` over `@frontierjs/conduit`. New. The
smallest connector on the list, kept because the token is single-use, must be
verified server-side with the visitor's IP, and a form that skips it is spam
within a day. hCaptcha is the same shape at another address and is not built.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `turnstileTarget({ ref?, address? })` — `signed`, signer `turnstile-secret-in-body`, `encoding: 'form'` |
| signer | `turnstileSigner` appends `secret=` to the form conduit serialized; refuses a target without form encoding |
| call | `siteverify(send, { token, remoteip, idempotencyKey?, expectedHostname?, expectedAction? })` |
| error mapping | `verdict` validator (a 200 with `success: false` is `invalid_response`) + `translate` |
| sink | `sink.ts` |
| drive | `bun run drive` — 12 rows, sink only; no fixture exists |

## Errors

Turnstile answers 200 for every verdict; the kind is read off `error-codes`.

| codes | conduit kind | `TurnstileFailure.kind` | retryable |
| --- | --- | --- | --- |
| `timeout-or-duplicate` | `invalid_response` | `spent` | no — the token is gone |
| `invalid-input-response`, `bad-request`, `missing-input-response` | `invalid_response` | `refused` | no |
| `invalid-input-secret`, `missing-input-secret` | `invalid_response` | `misconfigured` | no |
| `internal-error` | `invalid_response` | `server_error` | yes |
| 429 | `rate_limited` | `rate_limited` | by the caller |
| `hostname-mismatch`, `action-mismatch` | — (local) | `refused` | no |

## The rule this connector is about

**A token is spent on first use, and Turnstile's own `idempotency_key` is
what makes a retry safe.** With a key the call is `replayable` and a lost
response is replayed; without one it is handed back, because a second
verify is `timeout-or-duplicate`.
