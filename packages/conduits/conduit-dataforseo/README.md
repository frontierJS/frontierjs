# @frontierjs/conduit-dataforseo

DataForSEO over `@frontierjs/conduit`: HTTP Basic per account, a JSON array of
tasks per POST, the standard queue (`task_post` → `tasks_ready` → `task_get`)
and the live endpoints, every task answered on its own with its cost in micros.

**Written from two callers, not extracted.** serpgrid's
`api/src/providers/dataforseo/` (the queue, the per-agency login, the pacing)
and kos's `domain/links/dataforseo.ts` (live backlinks and SERP calls). No real
account was called; the shapes are theirs and docs.dataforseo.com's.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `dataforseoTarget({ ref?, address?, accountId?, perCaller? })` — `signed`/`basic`, credential `login:password`; `accountId` makes one target per account |
| calls | `postTasks(send, path, tasks)` up to 100, each answered; `live(send, path, task)` one task, result inline; `tasksReady(send, path)` and `getTask(send, path, id)`, both free and replayable |
| validator | `envelope` — a 200 whose `status_code` is not 20000 is refused (C4) |
| error mapping | `translate(error, status)` — table below |
| money | `toMicros(0.0006)` → 600; a `@scale(6)` column's unit, because a task is under a cent |
| sink | `sink.ts` — accounts map, `readyAfterMs`, `costUsd` |
| drive | `bun run drive` — 12 rows, sink only; a fixture would bill |

## Errors

| vendor `status_code` | HTTP | conduit kind | `DataforseoFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| 40100 | 401 | `auth_failed` | `auth_failed` | no |
| 40202 | 429 (or 200) | `rate_limited` / `invalid_response` | `rate_limited` + `retryAfterMs` 60 000 — the vendor sends no `Retry-After` | by the caller |
| 40200, 40210 | 200 | `invalid_response` | `no_funds` | no |
| other top-level | 200 | `invalid_response` | `refused` + `code` | no |
| 40601, 40602 on a task | 200 | — (envelope OK) | `TaskAnswer.kind: 'not_ready'` | ask again |
| 4xxxx on a task | 200 | — (envelope OK) | `TaskAnswer.kind: 'refused'` | no |
| 5xx | 5xx | `server_error` | `server_error` | no — a post bills |

## Lost posts

A post is unkeyed and the vendor collapses nothing, so a lost answer is
`indeterminate`: the tasks may exist and may have billed. The caller puts its
own `tag` on every task, and `tasksReady` — free, replayable — lists what was
created by that tag. The drive proves a post applied under a lost answer is
found there. A post WITHOUT a tag has no resolving read, which is why the
README says it rather than the connector minting one: a tag the caller does
not keep resolves nothing.

## What stays the app's

The pace (2,000 calls a minute per login, serpgrid's per-agency slot), the
cache of a paid lookup, the agency's login row and the `getFor` resolver, and
the parse of a result into listings or backlink rows.

## Chaos the sink owns

`{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ refuseWith: 40200 }` (a 200
that fails), `{ failTasks: n }` (n tasks refused inside an accepted post),
`{ noFunds }`; 101 tasks is 40006; a live array of two is 40006.
