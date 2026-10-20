# Glossary — a term recurring across the skill reference files, defined once

One line per term that three or more reference files use, across two or more skills. **This line is the definition; a reference file that uses the term points here rather than restating it**, and the paragraph that decides a hazard stays where it is, in the realm's reference file named at the end of the line. A term in only one skill is defined in that skill's file, not here. `packages/cli/test/skill-glossary.test.js` holds each line to that bar, so a term that stopped recurring leaves and a stale pointer fails.

Reached from `data-hazards`, `api-hazards`, `ui-hazards` and `bridge-index`, each of which points here.

## Data — the client and its flavors

- `asSystem()` — the Litestone client flavor that bypasses the gate and row policies and nothing else: a `@check`, a `@@check` and an `@@arc` still run, it grades 8 with 9 locked, and raw SQL needs it once a schema declares access rules. A write through it announces nothing. → `data-hazards`
- `$setAuth(user)` — RETURNS a client scoped to that principal and does not mutate the one it was called on. → `data-hazards`
- `$scopedBy` — a client flavor beside root, `$setAuth` and `asSystem`; every flavor answers the `db.$check*` family the same. → `bridge-index` (Accessor query)
- `@@gate` / `@@allow` / `@@deny` — the access a model declares, enforced at the Data boundary (Invariant 6): a `@@gate` REFUSES and an `@@allow` FILTERS, so a wrong policy is an empty screen rather than an error. → `data-hazards`

## Data — the columns the server owns

- `@system` — a column the application writes and its caller does not; the Data boundary refuses a caller naming one, and `ctx.system` is the set a call supplies. → `ui-hazards` (resources-and-forms)
- `@generated` — a real column the server fills; `@computed` has no column at all, so an index over it is refused. → `data-hazards` (schema-and-parse)
- `@from` — a column read off CHILD rows (`@from(PlanVersion, max: price)`), so it moves when a child is written and the parent row never does. → `ui-hazards` (tethers-and-records)
- `@version` — the revision column; an update carries back the one the screen READ, and a stale one is a 409. Sierra's `x-version` is this column. → `ui-hazards` (tethers-and-records)
- `readOnly` — how every server-owned column reaches the client (`@system`, `@generated`, `@computed`, `@from`, `@version`, a tenancy stamp); `stripReadOnly` drops them from a write. → `ui-hazards` (resources-and-forms)
- `@transient` — a payload key that is not a column; it arrives at `ctx.transients`, never at `ctx.data`. → `api-hazards` (ctx-and-the-call)

## API — the call

- `withLitestoneDb(db)` — Junction's per-request client: it calls `$setAuth(user)` with a fresh principal each call, and runs for an anonymous caller too. → `api-hazards` (secrets-and-the-log-line)
- `callService` — the one place a service call runs for both transports: the `$limit` against `paginate.max`, the idempotency claim and the announcement all happen here. → `bridge-index` (api-ui)
- `autoValidate` / `autoFilter` — two of the three validators (`autoSort` is the third), which trail the app's `before` hooks because it is the shaped `ctx.data` that must satisfy them; `autoValidate` covers create and patch on a model service. → `api-hazards` (the-hook-pipeline)
- `createApp({ system })` — the one place an app says who it acts as on its own behalf, and what a cron fire or boot with no enqueuer runs as; declaring none is valid and gives `null`. → `api-hazards` (jobs-and-the-clock)
- `announceDataWrites` — taps a client's writes to announce them, each TENANT's client on first open; a write through `asSystem()` that skips it leaves every open tab stale. → `data-hazards` (tenancy)
- `correlationId` — the id of the call in progress, carried by `$.log` and written to an audit row, filled from `db.$logContext(fn)`. → `data-hazards` (the-audit-trail-and-the-log)
