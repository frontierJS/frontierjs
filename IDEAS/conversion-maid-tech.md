---
id: conversion-maid-tech
status: assessment
dated: 2026-09-08
---

# Assessment — Converting a live Feathers/Prisma/Svelte application onto FrontierJS

**Status: ASSESSMENT. It reads two trees and proposes nothing for the
framework.** Dated 2026-09-08; § *Running the port* was added 2026-09-12 and is a
working plan for the APPLICATION, not a framework proposal. Every count below was produced by running a command against
`/home/j/code/KOBAMI/my.maid.tech` or against this tree on that date; where a
number came from the application's database it is the **development database,
which carries production data** (148 real accounts, 113,632 clients, 109,632 form
responses), so adoption figures are real rather than illustrative. Nothing here
may be cited as behavior of either system — see `VERIFYING.md`.

The schema conversion to `.lite` was already done before this reading. This file
is everything *else*.

---

## The headline

**Nothing needs to be added to FrontierJS for any of the hard parts.** Every
Tier-1 blocker found has an owner in this tree already, and five of them are
answered better here than the application answers them itself. One genuinely
unowned problem came out of the reading and has a record of its own —
`tenant-authored-queries.md`.

The work is a list of conversion decisions, not a list of missing features. That
is the useful finding, and it is the opposite of what the reading expected to
produce.

---

## What the application is

| Surface | Scale | Stack |
| --- | --- | --- |
| `api/` | 226 files · 19,335 lines · 42 services | Feathers on Express, `@frontierjs/api` (the old line), Prisma over SQLite |
| `web/` | 478 files · 442 `.svelte` · 51,454 lines · 292 route files · 109 components · 36 resources | Svelte 5 in legacy mode, Routify v3, UnoCSS, Vite, spassr |
| `embeds/` | 81 `.svelte` · 7,664 lines · 8 widgets | Vite/Rollup → standalone IIFE, embedded cross-origin on third-party sites |
| `db/` | 25 models · 62 migrations · three SQLite files | Prisma, plus `images.db` and `logs.db` |
| `tests/` | 45 `.ts` · 2,272 lines | Playwright, Page Object Model + factories, run sequentially |

Domain rows, for weight: 148 accounts, 317 users, 113,632 clients, 109,632 form
responses, 29,046 actions, 9,355 pages across 100 sites, 302 templates, 72
reports, 71 integrations.

---

## Blockers, and what already owns each one

| Application mechanism | FrontierJS owner | Status here |
| --- | --- | --- |
| Route-glob × CRUD permission matrix, per role, overridable per tenant | `@@capabilities` · `@capability` · `Capability[]` on a Role row | shipped — ANDed with `@@gate`, refused at the Data boundary, `x-capabilities` carries the affordance |
| Stored Prisma query objects spread into `db[model]` | the `compileSegment` precedent in `example/api/src/domain/shop/custom-fields.ts` — stored terms → a litestone `where` on the caller's own accessor | built and proven by `verify:custom-fields` |
| Stored raw SQL reports | raw SQL is `asSystem()`-only (`FJS-005`) | ruled; `scoped-sql.md` records why the alternative stayed unbuilt |
| Stored JavaScript transformers in `node:vm` | **nothing** | `tenant-authored-queries.md` |
| Vite + Svelte + mdsvex + juice compiler service in the request path | `renderComponent` / `renderFile`, `target: 'email' \| 'fragment' \| 'js'` | shipped — and it removes seven build-tool packages from the api's runtime dependencies |
| `queue.js` — a hand-rolled action state machine in a second process, dispatching over its own HTTP API | caravan: named queues with concurrency, `priority`, `delay`, `maxAttempts` with `retryDelay` backoff, `unique` in-flight lock, `cancel`/`retry`, cron with timezone, heartbeat, `actor` | shipped |
| `settings.dropdowns` — per-account option lists with `replace`/`append` modes | `valueset` over a tenant-scoped model, `@values(open)` for append | shipped, proven by `verify:values` |
| `settings.customFields` — free-JSON per-account columns | `tenant-declared-fields.md` + `example`'s slot pool and `compileSegment` | partial; being worked in a separate session |
| `settings.zones` / `analytics` / `callScript` / `websiteUrl` | tenant `meta` (`tenants.meta.get`/`set`), or ordinary models | shipped |
| `handleEvents` reading `listeners.<service>_<method>` to fire actions | `$tapEvents` / `announceDataWrites` | shipped; the key rekeys from service path to model + verb |
| `addCurrentAccountToDataOrQuery` app hook + `appendAccountToRelations` prisma hook | `@@tenant`, declared | shipped |

---

## What the data says, and how much it resizes the work

Three features that read as large in the source are small in the database. Two
read as small and are large. Reading the code alone gets all five wrong.

**The tenant-configurable permission matrix serves two accounts, and one of them
is empty.** Of 148 accounts, exactly two carry `settings.permissions`; one is
`{}` and the other defines a single role — "Site Manager", which is the shipped
defaults plus `/pages/*`. The mechanism that looked like the deepest blocker in
the audit is one named role. That converts to a capability grant and nothing
else.

**Delegations have zero rows.** The cross-account delegation feature — its own
model, its own service, a branch in `getLevel`, and a stated *TODO: this doesn't
work with delegations* on `getPermissions` — has never been used. It is a
deletion, not a port.

**Per-account dropdowns are used by 92 of 148 accounts.** This is the opposite
mistake: a JSON key that looks incidental is the most widely adopted
customization in the product. It is also the one with the cleanest owner —
`valueset` sourced from a tenant-scoped model, with `@values(open)` covering the
`append` mode. Getting this wrong is visible to 62% of the customer base.

**The sites/pages CMS is load-bearing**: 100 sites, 9,355 pages. The audit's
first pass suggested checking whether it was still alive. It is, and it is the
second consumer of the compiler service.

**Custom fields: 3 accounts. Tenant CSS themes: 1 account** — that one storing
raw CSS in a settings blob, injected into the page. Both are small enough to be
decisions rather than projects, and the second wants a *does this survive*
answer before anything is built for it.

---

## Free upgrades — code deleted rather than ported

- `addCurrentAccountToDataOrQuery` and `appendAccountToRelations` → `@@tenant`
- `omit: ['password', 'resetToken', 'token']` arrays in the model layer → `@secret` / `@guarded`
- the `softDelete` hook and its nine-case `disableSoftDelete` exception list → `@@softDelete` with `@keep`
- `stringifyModelFields` / `parseModelFields` prisma hooks → real `Json` columns
- Action status strings parsed by convention across 29,046 rows → `@@transitions`
- `$limit: 10000` and `paginate.max: 1000000` → the window, `$after` / `more()`
- 36 hand-written resource forms → `<Form {resource} />`, which shipped
- no audit trail exists today → one with protected-field redaction, for free
- the api sheds `vite`, `rollup`, `svelte`, `unocss`, `esbuild`, `mdsvex` and `juice` as **runtime** dependencies

**Passwords survive the move.** Feathers' local strategy stores bcrypt;
`@frontierjs/auth` hashes with `Bun.password.hash({ algorithm: 'bcrypt' })`.
Existing hashes verify unchanged, so there is no forced reset for 317 users.

**The query shapes survive too.** Litestone carries nested `include` with `where`
and `select`, relation filters (`some` / `none` / `every`), `_count`,
`aggregate`, `groupBy`, `upsert`, and `@@softDelete` with `restore`. The
`$include` blocks in the application's 36 resource files port close to
one-for-one — which was the single biggest unknown going in.

**The resource files are already the FJS shape.** 36 files, one per model,
PascalCase singular, a module script exporting `store` / `service` / `make` and a
form in the markup half. That is Invariants 18 and 19 written out by an
application that had never read them.

---

## The UI port, measured

Svelte 5 running in legacy mode: 297 files use `export let`, 155 use `$:`. Mesa
mirrors both, which makes this far cheaper than a framework change usually is.
The deltas, counted by file:

| Pattern | Files | Mesa |
| --- | --- | --- |
| `on:x` **on a component** | 62 (89 sites) | a compile error by rule — `onclick={fn}` prop |
| `createEventDispatcher` | 47 | `$.emit` |
| `use:action` | 89 | `{@attach}` — different contract, no `update()` |
| `$$restProps` | 52 | `$attributes` |
| `svelte/store` `writable`/`derived` | 10 | plain JS module + a `$:` path watch |
| `transition:` / `in:` / `out:` | 16+ | `$.fade` / `$.slide` / `$.fly`, or View Transitions |
| `svelte:component` / `self` / `window` / `head` | 8 / 3 / 4 / 10 | `mesa:element` / `mesa:window` / `mesa:head` |
| `<script context="module">` | every resource | `<script module>` |

**The one that is dangerous is `$:`, and it is dangerous because it compiles.**
Svelte re-runs a reactive statement when anything it read changes; Mesa's `$:` is
a watch-and-effect system with explicit forms, and `const` is an auto-derived
memo. A file that ports cleanly can therefore behave differently with nothing
reported at build time. 155 files sit in that class and want reading rather than
rewriting mechanically. Everything else in the table above fails loudly.

Routify v3 is the other UI-side cost: 292 route files using `$goto('/leads/[leadId]', { leadId })`,
`$params`, `beforeUrlChange`, `context.last`, and a `props(context, fn)` preload
contract, plus the `_Name.svelte` sibling convention, which is Routify's and not
Sierra's.

---

## Infrastructure

**Runtime.** The application pins Node 18–22 and npm, runs jest with
`--experimental-vm-modules`, pins `node-fetch` to an old major *because* of that,
and uses `patch-package` in a postinstall. Junction is Bun-only. This is a
one-way move for the whole test estate.

**Deploy.** Three CapRover apps with `captain-definition` files, `prisma migrate
deploy` run inside `deploy-api.js`, and litestream replicating the production
database to S3 — which must be stopped around migrations, with a sudoers entry
on the server to allow it. `fli deploy` is a different pipeline with a journal, a
release digest and a revert. Litestream beside litestone migrations wants a
stated answer rather than an assumed one.

**Three SQLite files.** Litestone supports a second `database` block. The winston
`libsql` log transport issues its own `CREATE TABLE` outside any schema, so
`logs.db` is a table nothing declares.

---

## Two security items found while reading

Both are true of the application as it runs today. Neither is created by any
migration, and both want triage on their own timetable.

1. **The report transformer is not sandboxed.** `runReportTransformer` builds a
   `node:vm` context and runs a stored JavaScript body in it. Probed directly on
   Bun 1.3.11, code inside that context reaches `process.env` (89 keys, including
   the database URL, the JWT signing secret and provider API keys), the process's
   working directory, and the `Bun` global — one expression, no import. The
   `timeout` option does not apply to asynchronous work. Thirteen of the 72
   report rows carry a transformer. Detail and the probe are in
   `tenant-authored-queries.md`.

2. **The report query path reaches the unscoped client.** `db[model].findMany(query)`
   takes both the model name and the where clause out of a database row and runs
   them without an accessor, so no gate, no row policy and no tenant scope apply.
   Twenty-two rows carry a non-empty query object.

Separately, and lower stakes: `.env`, `.state.json` (which holds a live JWT) and
`api/config/default.json` (which holds `authentication.secret`) are all tracked
in git.

---

## The decisions, in the order they unblock each other

1. **Roles → capability grants.** Which capabilities exist, who holds them, and
   what becomes of "Site Manager". This one determines every `@@gate`, every
   `@@capabilities` and every service hook, so it comes first.
2. **The report catalog.** Which of the 72 become declared `view`s, which become
   a stored segment compiled to a `where`, which die. The 62 SQL reports are all
   `@system/*` cross-account administrative reads and want `asSystem()` behind an
   admin gate.
3. **Transformers.** Kill them, or replace with a fixed catalog. See
   `tenant-authored-queries.md` before choosing.
4. **`Action` as a domain model** with `@@transitions`, caravan as the executor.
   Decide where staged dependencies and `pausedAt` live — they belong on the row,
   not in the queue.
5. **Split the settings blob four ways** — valueset, tenant-declared fields,
   tenant meta, ordinary models — and decide whether the one tenant's raw-CSS
   `theme` survives at all.
6. **Templates.** Which surfaces render through `renderComponent`, and who is
   permitted to author one. The application stores components in a
   tenant-scoped table and assumes staff-only; that assumption wants stating.
7. **The `params` bus** → `ctx.transients` / `$` / `asSystem()`. Eight flags,
   decided once, applied across 42 services.
8. **UnoCSS or `@frontierjs/css`.** Uno is supported as an opt-in app layer, so
   it may stay — but `@frontierjs/ui` components are tone-and-treatment styled
   and will not match. Running both is two design systems in one app.
9. **Delegations: delete the rows, keep the requirement.** Zero rows, and the
   reason is that it never worked — `getLevel` reads `delegation?.level` off a
   model whose column is `role`, so every delegate resolved to `undefined`
   standing, and `getPermissions` carries its own *TODO: this doesn't work with
   delegations* because it reads the permission table off the CURRENT account's
   settings rather than off the delegation row. Both are the class
   `membershipClaim` exists to remove — the tenant AND the standing off one row,
   one read, before the Data boundary scopes the client (`FJS-D113`), with a
   per-tenant capability grant on the same row (`FJS-D149`). Drop the table; if
   cross-account access is wanted again, it is a resolver rather than a feature.

Sequencing note: the api is the smaller number (19k lines) and the harder work;
the web is the larger number (51k) and the more mechanical. The decision that
moves the estimate most is whether `tables-from-the-seed.md` lands before the web
port starts, because 292 of those route files are a list, a detail and a filter
bar over one model.

---

## Running the port

*Added 2026-09-12. Nothing here has been started.*

### Before anything: the converted schema is not in either repository

The `.lite` conversion this reading took as done — 840 lines, beside a
`discovery/` directory — was never committed to `my.maid.tech`. On 2026-09-12 it
existed only in a Claude session scratchpad:

```
/tmp/claude-1000/-home-j-code-FRONTIER-frontierjs/3563cce0-769b-417f-a069-95004955af44/scratchpad/maid/
```

`/tmp` is cleared on reboot. If that path is gone, the conversion is redone from
`my.maid.tech/db/prisma/` and this section's first step costs a day more.

### The repository

**A fresh repository, scaffolded, never assembled by hand.** It sits outside both
trees (`~/code/KOBAMI/maid-fjs`), so the framework repo carries no client code
and the running application's history is left alone. Scaffold with THIS
workspace's `fli` and local sources, so a framework fix reaches the app with no
publish in between:

```
bun ~/code/FRONTIER/frontierjs/packages/cli/bin/fli.js new maid-fjs --source local
```

A globally installed `fli` is a different build of the command (see
`packages/cli/CLAUDE.md`). `--source local` symlinks `@frontierjs/*` to
`packages/`; `core/vendor.js` is what makes that containerizable when it is time
to deploy.

### The session

**Start Claude in the new repository and add the other two as directories:**

```
claude --add-dir ~/code/FRONTIER/frontierjs --add-dir ~/code/KOBAMI/my.maid.tech
```

The framework's hazard skills live in `frontierjs/.claude/skills/`. Whether an
added directory's skills load is unverified; symlinking that directory into the
new repo's `.claude/skills` does not depend on the answer.

The new repo's `CLAUDE.md` carries five lines and no more:

- the specs are frontierjs's root `CLAUDE.md` and each package's `CLAUDE.md`
- the reference is `my.maid.tech`, and it is **read-only**
- the plan is this file — read it rather than re-auditing
- `my.maid.tech/db/development.db` is **production data**: query a copy, write to nothing
- a framework defect is fixed in frontierjs or filed in its `ISSUES.md`, never
  worked around in the app — being the second independent consumer is the value
  recorded below, and a workaround spends it

### The order

**Data, then API, then UI — the realm order — with three corrections.**

1. **The schema is not finished until decisions 1, 2 and 5 above are made.**
   Roles-to-capabilities sets every `@@gate` and `@@capabilities`; the report
   catalog decides which `view`s exist; the settings split decides which models
   exist. The existing conversion predates all three, so it is a starting point
   rather than the Data realm done.
2. **One thin slice before going wide.** One model — `Client` is the weight —
   through schema, service and one screen, deployed. That proves the scaffold,
   the tests and `fli deploy` against this app before 25 models and 42 services
   are built on an unproven pipeline. Then realm by realm.
3. **The web port waits on `tables-from-the-seed.md`.** See the sequencing note
   above; hand-porting the list routes first ports work that record would delete.

**Moving the data is a track of its own.** Production rows go from Prisma's
tables into Litestone's, rehearsed on a copy, and the litestream question under
§ Infrastructure is answered before the cutover rather than during it. The first
milestone that track owns: the new API boots against a copy of production and
answers the same reads the old one does.

**The two items under § Two security items do not wait for any of this.** They
are live in the running application.

---

## What this application is worth to FrontierJS

It is a second, independent consumer for three records that each had one:

- **`tables-from-the-seed.md`** — 292 route files of exactly the three surfaces
  that record designs, over a schema whose wire inputs already all reach the
  browser.
- **`tenant-declared-fields.md`** — tenant-declared columns in production use,
  built the way that record argues against, which makes it a negative control
  rather than a restatement.
- **`tenant-authored-queries.md`** — the record this reading produced.

And it is the first application read here that was **not** built on this
framework and **not** a schema import. `proving-grounds.md`'s corpus half answers
*give me a `.lite`*; this answers the question after it, which is what an
application still has to decide once the schema is done. Every one of the nine
decisions above is a question a converting app will ask, and none of them is
answered by anything currently in the tree.

---

## See also

- `tenant-authored-queries.md` — the one unowned problem, with the sandbox probe
- `tables-from-the-seed.md` · `tenant-declared-fields.md` — both being worked in separate sessions
- `scoped-sql.md` — why the SQL half is a refusal rather than a design
- `proving-grounds.md` — the corpus half, which this sits after
