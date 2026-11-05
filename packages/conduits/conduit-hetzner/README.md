# @frontierjs/conduit-hetzner

Hetzner Cloud compute over `@frontierjs/conduit`: catalog, servers,
per-location prices as minor units. Extracted from
`frontierjs/packages/basecamp/api/src/providers/compute/hetzner.ts` and
`hetzner-sink.ts` at commit `6ad199f2`. Basecamp keeps its copy; here a
create takes `labels` and a list takes `{ labelSelector }`.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `hetznerTarget({ accountId, ref, address? })` — bearer, JSON, `per_page` max 50 |
| calls | `verify`, `catalog`, `machine`, `create` (label keys checked before sending), `destroy` (200 + action; 404 → true), `list({ labelSelector })` |
| error mapping | `translate` — table below |
| sink | `sink.ts`; options `token`, `bootMs`; the handle's `created`, `boot`, `reset` for a test in the same process |
| drive | `bun run drive` — 14 rows, sink only |

## Errors

| `error.code` | HTTP | conduit kind | `HzFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `unauthorized` | 401 | `auth_failed` | `auth_failed` | no |
| `not_found` | 404 | `client_error` | `gone` | no |
| `invalid_input` | 400 | `client_error` | `refused` | no |
| `resource_unavailable`, `resource_limit_exceeded` | 423 | `client_error` | `capacity` — not now, not never | no (later) |
| `rate_limit_exceeded` | 429 | `rate_limited` | `rate_limited` + `rateLimitReset` | GET yes; create by the caller |
| 5xx | 5xx | `server_error` | `server_error` | GET yes; create no |
| — | 201, no server id | — | `indeterminate` + `indeterminate: true` | no; reconcile by label |

Money: `price_monthly.gross` per location, a decimal string, becomes minor
units in EUR; a type priced nowhere is dropped from the catalog.
