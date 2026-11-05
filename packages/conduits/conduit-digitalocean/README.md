# @frontierjs/conduit-digitalocean

DigitalOcean compute over `@frontierjs/conduit`: catalog, droplets, money as
minor units. Extracted from
`frontierjs/packages/basecamp/api/src/providers/compute/digitalocean.ts` and
`digitalocean-sink.ts` at commit `6ad199f2`. Basecamp keeps its copy, its
`ComputeConnector` interface and its `MachineMark` spelling; here a create
takes `tags: string[]` and a list takes `{ tag }`.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `digitaloceanTarget({ accountId, ref, address? })` — one per account, bearer, JSON |
| calls | `verify`, `catalog`, `machine` (404 → null), `create` (never keyed), `destroy` (404 → true), `list({ tag })` |
| types | `Catalog`, `Size` (`prices` region → minor units), `Machine`, `MachineSpec` |
| error mapping | `translate(error, status, headers)` — table below; `RateLimit-Reset` surfaced |
| sink | `sink.ts`; options `token`, `bootMs`; the handle's `created`, `boot`, `reset` for a test in the same process |
| drive | `bun run drive` — 13 rows, sink only |

## Errors

| vendor `id` | HTTP | conduit kind | `DoFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `unauthorized` | 401 | `auth_failed` | `auth_failed` | no |
| `not_found` | 404 | `client_error` | `gone` (machine → null, destroy → true) | no |
| `unprocessable_entity` | 422 | `client_error` | `refused` | no |
| `too_many_requests` | 429 | `rate_limited` | `rate_limited` + `rateLimitReset` | GET yes; create by the caller |
| 5xx | 5xx | `server_error` | `server_error` | GET yes; create no |
| — | 202, no droplet id | — | `indeterminate` + `indeterminate: true` | no; reconcile by tag |

**DO ignores `Idempotency-Key`**, so `create` sends none; a lost response is a
`timeout` carrying `indeterminate: true`, and `list({ tag })` is the way back to the machine.
