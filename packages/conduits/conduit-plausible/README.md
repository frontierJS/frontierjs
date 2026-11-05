# @frontierjs/conduit-plausible

Plausible Analytics' Stats API v2 over `@frontierjs/conduit`. New. The
reference *read-only, rate-limited report source*: one bearer key, one POST
that only reads, paged by offset, 600 requests an hour.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `plausibleTarget({ ref?, address? })` — bearer, JSON; self-hosted is another `address` |
| calls | `query(send, q)` (`replayable: true`), `queryAll(send, q, { pageSize, cap })` |
| types | `StatsQuery`, `StatsResult`, `Metric`, `DateRange` |
| error mapping | `translate(error, status)` — table below |
| sink | `sink.ts`, 25 fixed rows for `shop.test` |
| drive | `bun run drive` — 8 rows, sink only; `FIXTURE_URL` adds one against Plausible CE |

## Errors

| vendor | HTTP | conduit kind | `PlausibleFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| bad key | 401 | `auth_failed` | `auth_failed` | no |
| `{ error }` validation | 400 | `client_error` | `refused` | no |
| site missing / no access | 404 | `client_error` | `unknown_site` | no |
| 429 + `Retry-After` | 429 | `rate_limited` | — conduit replays the read | yes |
| 429, no header | 429 | `rate_limited` | `quota` (after conduit's retries are spent) | no |
| 5xx | 5xx | `server_error` | — conduit replays the read | yes |

## The rule this connector is about

**A read is `replayable`.** The only POST in this workspace that is: a lost
response and a 429 are retried by conduit itself, where every send-shaped
connector hands them to the caller. A 429 with no `Retry-After` is the hourly
budget, which conduit's backoff cannot outwait — the caller sees `quota`.
