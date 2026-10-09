---
name: api-hazards
description: Junction — a service, the hook pipeline, HTTP/WS transport, a raw route, a plugin, `ctx`, a job or cron. Correct-but-surprising behavior in the API realm; use when touching any of them.
---

# API-realm live hazards

**Correct behavior you have to know about.** Things that are *wrong* live in `ISSUES.md`, one id each; things that are *fixed* live in git. If a rule here is pinned by a test that cannot be deleted quietly, it does not need to be here.

**The index below is each hazard's rule; its section's reference file holds the rest** — the mechanism, the measurement, and what it refuses. Read that file before changing code the rule is about.

## `ctx` and the call
Detail: `references/ctx-and-the-call.md`

- **`ctx.params` does not exist anywhere in Junction, and `ctx.route` is not it.**
- **Absent is not null on `auth`.**
- **A payload key that is not a column is declared `@transient`, and it arrives at `ctx.transients` — never at `ctx.data`.**
- **A payload key that names no field of the model is a 400; one that names a field the caller may not WRITE is dropped in silence** (`FJS-889`)
- **`PUT` to an id that does not exist is 404 and does not create the row** (`FJS-D207`)
- **`update` is `patch` with an id REQUIRED, and it MERGES** (`FJS-D179`)
- **The METHOD decides list vs single.**

## The hook pipeline
Detail: `references/the-hook-pipeline.md`

- **A custom method takes the model's READ gate as a floor, and declares anything above it** (`FJS-826`)
  - **A method authenticated by something that is NOT a session states `gate: 0`**
  - **Declaring one gate means naming the whole surface**
- **The gate runs before anything an app wrote, and `validated:` is the phase after the derived layer.**
- **An `Idempotency-Key` on a mutating request executes once and replays the first answer**
  - **A custom method is a write until it declares `read: true`** (`FJS-D505`) — undeclared, a keyed search keeps its answer, query and all, for 24 hours, and the bus announces it; declared, a write inside it runs again on a keyed retry
- **An irreversible effect belongs in `ctx.afterCommit(fn)`, not in an `after` hook.**
- **Under `transactional:`, a result carrying a non-empty `errors` is a 422 and a rollback** (`FJS-2149`)
- **A `mailer.send()` that answers `sent` sends everything the message declared — including `cc`, `bcc`, `attachments` and `headers`** (`FJS-895`)
- **A recurring `app.scheduler` job does not overlap itself, and the tick it dropped is COUNTED** (`FJS-896`)
- **The log level is a CELL shared down the whole tree, and `setLevel` moves all of it** (`FJS-897`)
- **A job records the request that queued it** (`FJS-897`)
- **`ctx.enqueue(job, payload)` is the durable half, and it is a second VERB because a closure cannot be persisted** (`FJS-D35`)
  - **A row that keeps failing is given up on, and `dead` is the only thing that says so** (`FJS-778`)
  - **The relay's walk is COLD, and a tick is ONE walk.**

## Routes, query and headers
Detail: `references/routes-query-and-headers.md`

- **A query string is PARSED, and the schema still wins.**
- **Raw routes (`app.get`/`app.post`) take `{id}`, not `:id`**
- **`apiPrefix` moves EVERY route the app registers**
- **Every READ carries `$withDeleted`; on a WRITE only `update`/`patch` by id do.**
- **`hasRoute()` is a matching question, not an existence one**
- **A header the caller varies per call must be DECLARED, or it works until the socket connects.**
- **A raw route's own `new Response(readable)` is held to its end for a gzip caller; build a stream with `ctx.stream()` or name `content-encoding`** (`FJS-D509`)
- **The client's address is declared, never discovered.**

## Sockets
Detail: `references/sockets.md`

- **A socket stays alive because the SERVER pings it, and an app calls nothing.**
- **Never call `ws.send()` directly.**

## Secrets and the log line
Detail: `references/secrets-and-the-log-line.md`

- **The logger redacts a credential by NAME, on both paths, and it is a floor rather than a proof** (`FJS-775`)
- **`defineEnv` will not quote a value it must not, and infers that from the NAME.**
- **An adapter cache is keyed on `$schema`, never on the client** (`FJS-777`)

## Plugins, config and autoload
Detail: `references/plugins-config-and-autoload.md`

- **A plugin reads `junction.config.js` in `boot()`, never in `register()`.**
- **A missing config DIRECTORY is not a missing config file.**
- **Where an app's services are is PROBED, not derived**

## The four snapshots
Detail: `references/the-four-snapshots.md`

- **What an app ANSWERS, what it RUNS with no caller, what it can TELL somebody, and who a caller BECOMES are each committed beside the API, in `api/`.**
- Plus a table and prose that are only in the reference file.

## Auth and the principal
Detail: `references/auth-and-the-principal.md`

- **`IAuth.sessionFor(userId)` is how a principal is rebuilt without a credential**
- **A bearer token is the credentials list's last entry: `verifySession`, then `verifyApiKey` when that answers null**
- **`bearerClaim` refuses a presented token that does not work (401); no token stays anonymous**
- **`bearerClaim` refuses a session beside a grant (400), BEFORE the grant is read** — a dead token beside a session is the same 400, so the request's shape is not an oracle for which tokens exist. A store whose signed-in shoppers still send the basket header states `session: 'merge'` or every one of them is refused (`FJS-D832`).

## Jobs and the clock
Detail: `references/jobs-and-the-clock.md`

- **Caravan owns the clock; `app.scheduler` is in-process only** (`FJS-D36`)
- **A background job runs as whoever asked for it, and a job nobody asked for runs as the app.**
- **A job attempt has no bound unless one is declared, and `oldestRunningMs` is how you see the ones that do not.**
- **Caravan's `unique` is a lock on work IN FLIGHT, not an idempotency key.**
- **A job in `jobsDir` is named by its file and declares its own schedule.**
- **A cache value is JSON, and what JSON would LOSE is refused at `set()`.**
- **The docs page is hand-written HTML with two caller-supplied values in it.**
- **A battery names a vendor in a comment and never in a call** (`FJS-D215`)
- **Nothing here mocks a module, and the reason is a design rule.**
- **A test may not name a port, and the reason is the runner.**
- Plus a table and prose that are only in the reference file.
