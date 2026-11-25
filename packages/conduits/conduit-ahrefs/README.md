# @frontierjs/conduit-ahrefs

Ahrefs API v3 over `@frontierjs/conduit`: the bearer target, the projects a
caller adds and removes, the Site Audit health score, the cost of every call,
and the one place a 403 is told apart as a spent allowance or a bad key. TPM
(`api/src/domain/actions/ahrefs.ts`) is the caller whose dialect this holds; it
keeps its own sentences and moves onto the package in a later phase.

Held out of releases until `ADMITTED` names it (`FJS-D2365`).

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `ahrefsTarget({ ref?, address?, id? })` — a bearer on `https://api.ahrefs.com/v3`, `Accept: application/json` |
| calls | `verify`, `listProjects`, `findProject`, `addProject`, `removeProject`, `siteAudit`, each taking `send` first and answering `{ value, cost }` |
| error mapping | `translate(error, { status, headers }, { quota? })` |
| cost | `costOf(meta)` → `{ rows, perRow, total, actual, cache }` from the five `x-api-*` headers; `null` where a header is absent |
| sink | `sink.ts`, `startAhrefsSink(opts)`, the stand-in plus chaos |
| drive | `bun run drive` — 33 rows against the sink, 39 with `AHREFS_FIXTURE_KEY` |

Every call here is free (`/management/*`, `/site-audit/projects`,
limits-and-usage). A paid read waits for a caller. A call that fails throws
`AhrefsError` with a `failure` carrying `kind`, `message`, `retryable` and the
`cost` the refusal reported.

## Errors

| Ahrefs | HTTP | `kind` | retryable |
| --- | --- | --- | --- |
| wrong key, `["Error","Unauthorized"]` | 401 | `auth_failed`, Ahrefs' text | no |
| no key, `["Error","Forbidden"]` | 403 | `auth_failed`, Ahrefs' text | no |
| `{ error: "API units limit reached…" }` | 403 | `quota`: the key's or the workspace's units are spent; the key is fine | no |
| a 403 of any other wording | 403 | `auth_failed`, Ahrefs' text | no |
| a limit | 429 | `rate_limited`, `retryAfterMs` from `Retry-After`, else 60 s | yes |
| `{ error: "missing argument 'date'" }` | 400 | `refused`, Ahrefs' text | no |

Error bodies come in two shapes, not the spec's one. A plan refusal (a Starter
key on a paid call) has never been captured and is not matched.

## Projects

`POST /management/projects` takes no idempotency key, so a replay makes a second
project. `addProject` finds the domain first (matched on `bare()`: scheme, `www.`
and path stripped, lowercased) and posts once; an answer lost on the way is
resolved by the list. Defaults are the whole domain, both protocols, shared.
`removeProject` answers `null` for a domain with no project.

## Fixture

`AHREFS_FIXTURE_KEY=<key> bun run drive` adds six rows against api.ahrefs.com.
They send only GETs, and a `target` only when it is `ahrefs.com`, `yep.com` or
`firehose.com` (free on any paid plan). The drive refuses anything else before
it leaves. A project add and delete are not in the fixture: they would change a
live workspace.
