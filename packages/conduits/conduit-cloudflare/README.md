# @frontierjs/conduit-cloudflare

Cloudflare DNS over `@frontierjs/conduit`: zones, records, and one
all-or-nothing batch. Extracted from
`frontierjs/packages/basecamp/api/src/providers/edge/cloudflare.ts` and
`cloudflare-sink.ts` at commit `6ad199f2`. Basecamp keeps its copy, the mark
(`basecamp:domain:<id>`) and the `IEdge` interface; here the ownership test is
an `owns(record)` predicate the app passes. Purge cache is not here.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `cloudflareTarget({ accountId, ref, address? })` — one target per account, bearer |
| calls | `verify`, `zones`, `zone`, `records` (paged by `total_pages`, capped), `batch`, `setRecords(send, zoneId, wanted, owns)` |
| error mapping | `envelope` validator (a 200 with `success: false` is `invalid_response`) + `translate` |
| sink | `sink.ts`, the basecamp stand-in plus chaos |
| drive | `bun run drive` — 12 rows, sink only |

## Errors

| vendor | HTTP | conduit kind | `CfFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `success: false` | **200** | `invalid_response` (via `validate`) | `refused`, code + message | no |
| `81053` CNAME beside A | 400 | `client_error` | `conflict` | no |
| `81044`, `7003` | 400/404 | `client_error` | `missing` | no |
| `10000` auth | 403 | `auth_failed` | `forbidden` | no |
| 429 (1,200 / 5 min) | 429 | `rate_limited` | `rate_limited` | GET yes; batch by the caller |
| 5xx | 5xx | `server_error` | `server_error` | GET yes; batch no |

## The rule this connector is about

**A write is one batch and Cloudflare honors no idempotency key on it.** The
connector forwards none; the drive sends the same batch twice and gets two
records. A lost response is `indeterminate` and the zone re-read is how the
caller learns the write landed.
