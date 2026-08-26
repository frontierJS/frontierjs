---
id: tenancy-pass
status: shipped
dated: 2026-08-23
---

# Plan — The tenancy pass: five open rows that are one missing owner

**Status: SHIPPED 2026-08-23, except §5, which is filed as [FJS-D126](../ISSUES.md#fjs-d126).**
The plan below is kept as written; what it got wrong is worth more than what it
got right. §0 said `FJS-387` did not reproduce and it was half right — the
symptom it named was gone and the column was still WRITABLE, which is a second
defect the app's own workaround had been hiding. Removing the workaround is what
surfaced it, six minutes of drive at a time.
Written 2026-08-23 from the open register: [FJS-386](../ISSUES.md#fjs-386),
[FJS-365](../ISSUES.md#fjs-365), [FJS-384](../ISSUES.md#fjs-384),
[FJS-387](../ISSUES.md#fjs-387), [FJS-385](../ISSUES.md#fjs-385). Every claim below was
probed against the tree rather than read off the rows, and two of the rows are wrong
about their own scope — see §0.

The rows read as five features half-finished. They are one thing: **`tenancy { }` is
declared once and asked for by four subsystems that each answer it themselves, and
three of them cannot.** `withTenantDb` knows which tenant a REQUEST is for; the cache,
the outbox relay and the queue have no request, so each falls through to something that
looks like it works. The pass is one owner first, then four callers.

---

## 0. What the probes changed

**[FJS-387](../ISSUES.md#fjs-387) does not reproduce and the litestone half is done.**
`generateJsonSchema(schema, { mode: 'create' })` over a `tenancy { strategy row }`
schema puts the stamped column in `properties` and NOT in `required` —
`jsonschema.js:442` already excludes an `auth()` default, the same branch `@system`
uses. Run against basecamp's real 59-model schema, exactly one model requires
`workspaceId` on create and it is `WorkspaceMember`, which is `@@tenant(none)` and where
the column is a genuine caller-supplied value. So the row's defect is closed and its
CONSEQUENCE is not: eight basecamp resources still carry the `stampWorkspace` hook
written to work around it, and each one is a client stating its own tenant on a create.
That is the remaining work, and it is app work.

**[FJS-386](../ISSUES.md#fjs-386) is wider than the row says.** The row calls
`strategy database` harmless on the ground that the client is per tenant. The cache is
not on the client — `resolveCache(ctx)` hangs it off `ctx.app`
([service.ts:63](../packages/junction/src/core/service.ts)) — so one process serving two
tenants shares one cache under BOTH strategies, and the database strategy leaks
identically. Whatever the fix is, it cannot be conditioned on the strategy.

---

## 1. The spine — one owner of *which tenant is this call for*

Nothing answers this question today for a caller that is not an HTTP request.
`ctx.locals.tenantId` is assigned by `withTenantDb`
([litestone.ts:2479](../packages/junction/src/core/litestone.ts)) and exists only under
`strategy database`; under `strategy row` the answer lives on the principal, as the
claim `tenancy { claim }` names, and nothing lifts it anywhere a second reader can find
it.

**`ctx.locals.tenantId` becomes the answer under both strategies**, assigned at exactly
two places and read everywhere:

- `withTenantDb` keeps its assignment (database).
- `applyClaims` assigns it when the claim it merged is the one `$tenancy.claim` names
  (row). It already holds the client, so the tenancy declaration is one throwing-property
  probe away — the shape `tenantClaimGuard` and `autoFilter` already use.

Then `tenantOf(ctx)` is a two-line accessor over one local, exported from
`core/litestone.ts`, and the three callers below stop each having an opinion. The guest
path in `applyClaims` sets nothing unless the claim name matches: a cart token is a
claim and is not a tenant.

**`RequestMeta` grows `tenant`**, set by `enterRequest`, so work with no `ctx` in hand
can still name one — this is what step 4 rides on. `withTenantDb` already honours a
STATED `ctx.locals.tenantId`; it gains `requestMeta()?.tenant` as the second source,
below the stated one and above the registry's own resolution.

Cost: one field on the request meta, one assignment in `applyClaims`, one accessor.
Nothing changes for an app that declares no tenancy — `$tenancy` is null and every
branch is skipped.

---

## 2. FJS-386 — the cache

`buildCacheKey` ([service.ts:96](../packages/junction/src/core/service.ts)) is
`{service}:{method}:{params}[:uid={userId}]`. The tenant is in neither half, and the
`uid` segment is what makes it look scoped: a cached list is keyed by the CALLER, so
two callers in one tenant share correctly and two callers in two tenants also share.
The first tenant to warm an entry decides what the rest read, and the value is real
rows that were correctly scoped when they were produced, so nothing downstream can
tell.

- A `:t=<tenant>` segment, appended by the framework and **outside** a custom `keyBy`,
  so a caller's own key function cannot opt out of correctness. `keyBy` says what makes
  two calls the same call within a tenant; it was never asked about the tenant.
- **Partitioned by default, not opt-in.** The row asks whether an app should have to
  ask for this, because a cache split N ways has a hit rate nobody budgeted for. A
  wrong answer is worse than a slow one, and an app that genuinely wants a shared entry
  is asking for a service over a model no tenant owns — which is the next line.
- **A service over a `@@tenant(none)` model is NOT partitioned.** `isRowScoped(client,
  accessor)` already answers exactly this and is already in the file
  ([litestone.ts:2538](../packages/junction/src/core/litestone.ts)); it is memoised per
  client per accessor, so the cost is one map lookup.
- `bustCache` clears the `{service}:` prefix and therefore every tenant's entries. That
  stays — over-invalidation is safe and under-invalidation is this row again — but the
  key now supports a narrower clear, which is the tenant-scoped invalidation the row
  asks for as its other half. Ship the prefix clear; leave the narrow one to an app that
  measures a need.

Test: two callers in two tenants, one service, one `cache: true`, the second read must
not be the first's rows. It belongs in junction's own suite against a real Litestone
client — a fake client is what would let this pass.

---

## 3. FJS-365 — the outbox relay reads a file nobody wrote to

`enqueueOutbox` writes through `ctx.locals.db`
([outbox.ts:109](../packages/junction/src/core/outbox.ts)), which under
`strategy database` is THIS TENANT's client; `deliverOutbox` and `sweepOutbox` read
`app.db` ([outbox.ts:197](../packages/junction/src/core/outbox.ts), `:246`). Every guard
in the path passes and the relay reports a clean pass over an empty queue forever.

Two shapes are legal and the app must be in exactly one of them:

1. **The outbox is per tenant.** The relay fans out — one pass per tenant, each claiming
   through that tenant's own client. The registry already has the machinery:
   `list()`, `ids()` for what is open in the pool, and `query(fn, { concurrency })` with
   its own fan-out ([tenant.js:427](../packages/litestone/src/tenant.js)).
2. **The outbox is schema-global**, declared into a `database` block that is not per
   tenant, which `tenant.js` already documents.

**The other shape must refuse, and this is the substance of the fix.** `ctx.enqueue`
already refuses outside a transaction, without the model and with no relay, on the
stated ground that a row nothing delivers is worse than a refusal — this is that row.
So:

- `createApp({ tenants })` + `outbox()` and no schema-global outbox → the relay fans
  out. Sweep the OPEN tenants each interval and every tenant on a slower cycle, because
  a pass per tenant per five seconds is a query per tenant per five seconds and the
  count of tenants is the thing that grows.
- `createApp({ db, tenants })` → today the relay scans a real file that is nobody's.
  Refuse at boot, naming both.
- The post-commit kick carries `ctx._outbox` row ids with no tenant attached; it gains
  the tenant off the spine so the kicked pass targets the right client.
- `/metrics`' `pending` becomes a sum over tenants, refreshed once per pass as it is
  now. A per-tenant breakdown is a bigger answer than the endpoint's shape allows;
  the sum plus `lastPassAt` is the honest one.

Test: two tenants, one enqueue each, one relay pass, both delivered — and the
`{ db, tenants }` pair refused by name at boot.

---

## 4. FJS-384 — a job has no tenant, so every job is `asSystem()`

Measured in the row: all four of basecamp's job files reach for the bypass, which drops
the gate, the row policies and the audit actor together to do work that wanted one of
them relaxed. Caravan already records WHO at dispatch (`actor_id`) and junction
re-resolves them at run through `app.runAs`. WHERE is the missing half, and it is the
same shape.

- **Caravan records `tenant_id`** — a nullable TEXT column added exactly as `actor_id`
  and `owner_id` were ([db.ts:111](../packages/caravan/src/db.ts)), taken at dispatch
  from the host the way the actor is (`host?.principal?.()`), exposed on `JobContext`
  and handed back at run.
- **Junction re-binds it**: `runAs` opens `enterRequest`, so the tenant rides
  `RequestMeta` from §1 and `withTenantDb` picks it up with no new plumbing under
  `strategy database`.
- **Under `strategy row` the resolver does the work, which is the point.**
  `membershipClaim`'s `tenantFrom(ctx)` reads a header a job does not have, so it lands
  on `{ reason: 'unnamed' }` and `tenantClaimGuard` answers 400. It gains a fallback to
  the ambient tenant, and then the membership row is **re-read for (actor, tenant) at
  run time** — which is the same argument that makes `runAs` right: an id is stored, a
  standing is re-derived, and a caller who lost the membership between asking and
  running is refused rather than replayed.
- **Storing the tenant is not storing a privilege.** It is a pointer to a set of rows;
  everything that grades the caller still runs. That distinction is why this does not
  reopen the snapshot argument `FJS-D113` settled.
- **A job with no tenant stays legal.** Cron, boot and the app's own work resolve to
  `createApp({ system })` and record nothing, exactly as they do for the actor. What
  changes is the message when such a job then touches a scoped model: `tenantClaimGuard`
  can say *this job recorded no tenant* rather than *this session carries no claim*,
  which names nothing a job author can act on.
- **Out of scope, named rather than silently skipped**: a cron that must fire once per
  tenant. That is a fan-out over the registry at the SCHEDULE, not a property of one
  job, and it wants its own row.

Then basecamp's four job files drop `asSystem()` and the audit actor comes back.

---

## 5. FJS-385 — per-tenant configuration is a feature and wants a ruling

The other four are defects with a shape. This one is not: *one deployment, many
customers, each of whom thinks it is theirs*, where the customer-facing half of
*theirs* is mostly not rows — a from-address, a bucket, a timezone, a locale, branding,
a flag default, a rate limit. Everything an app is configured WITH resolves once at
boot.

**File it as `FJS-D126` and rule it before writing code.** The three questions a ruling
has to answer, with the shape I would argue for:

1. **Where does a tenant's config come from?** A resolver, `createApp({ tenantConfig })`,
   answering a plain object per tenant id — not a declaration, for `FJS-D113`'s reason:
   the source is a row for one app, a file for another, and a control plane for a third.
   Memoised per tenant with an explicit invalidation, because it is read per call.
2. **How is it read?** `$.config` through the ambient call, resolving the current
   tenant's answer over `app.config` as the floor, so an app reads one thing and a
   tenant that overrides nothing costs nothing. `app.configFor(tenant)` for the caller
   with no ambient call.
3. **What may a tenant NOT override?** Ports, database paths, secrets, anything read at
   boot by something that has no tenant. This is the half that makes it safe, and it is
   an allow-list rather than a deny-list.

Prior art worth reading before ruling: Laravel's service-provider rebind per request
(the Orthicon case the row cites), and how it pays for it.

---

## Order, and why

1. **§1 spine** — nothing else is writable without it, and alone it changes no behaviour.
2. **§2 cache** — smallest, and the only one of the four that is a live cross-tenant
   read.
3. **§4 jobs** — the one an app is working around today in four files.
4. **§3 outbox** — silent and durable-effect-shaped, but it needs the fan-out decision
   and a refusal at boot, so it is the largest of the three defects.
5. **§5 config** — ruling first, no code.

**Drives.** `packages/junction`: `bun run test`. `packages/caravan`: `bun run test`.
`example`: `verify:jobs` for the queue path, `verify` for the request path.
`basecamp`: `bun run verify` — it is the only app in the tree that actually runs row
tenancy with a per-request claim, so it is the only drive that can see §4 work.

**Concurrent-session note.** §2 edits
[service.ts](../packages/junction/src/core/service.ts) around `buildCacheKey`, a file
another session has been changing at `createBaseService`. Targeted edits only, no
whole-file writes.
