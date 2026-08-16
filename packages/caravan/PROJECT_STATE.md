# Caravan — Project State

_Verified 2026-08-02 by running the code. Everything below marked **verified** was
reproduced; anything else is labelled as unconfirmed._

> Drop this file into a fresh session to pick up Caravan cold.
> Read `../../CLAUDE.md` first for repo-wide vocabulary and landmines.

---

## What it is

`@frontierjs/caravan` v0.1.0 — a SQLite-backed job queue and cron scheduler,
exposed as a Junction plugin that attaches `app.jobs`.

Realm: **D5**. Sits beside Junction, not under it — Junction is inbound
(routing, hooks, services), Caravan is deferred work.

```
src/index.ts     createCaravan(), defineJob(), the Junction plugin, admin routes
src/db.ts        SQLite schema + queries
src/worker.ts    the polling worker loop
src/cron.ts      cron expression scheduling
src/autoload.ts  scans a directory for *.job.ts
src/types.ts     public types
tests/caravan.test.ts             queue + cron logic, direct
tests/autoload.test.ts            autoload against a real fixture directory
tests/junction-integration.test.ts  the plugin against a real booted Junction app
tests/job-context.test.ts         who a job runs as, against a real app + auth
tests/declaration.test.ts         what a job file declares: its cron, and its name
tests/fixtures/jobs/              committed *.job.ts fixtures for autoload
tests/fixtures/cron-jobs/         a job file that declares its own schedule
tests/fixtures/bad-jobs/          a job whose name disagrees with its file
```

## Verified state

| | |
|---|---|
| Tests | **92 pass, 0 fail**, 4 files (`bun run test`) — verified. See `CHANGES.md` 2026-08-06 for the three defects `example/` found, and 2026-08-16 for the job principal |
| Typecheck | **clean, 0 errors, no baseline** (`bun run typecheck`) — verified |
| Public exports | `createCaravan`, `defineJob`, plus types — verified |
| Who a job runs as | the principal recorded at `dispatch()`, **re-resolved** through `app.runAs` when it runs. Nobody asked → `createApp({ system })`. `tests/job-context.test.ts` |
| Plugin seam | `register()` claims `app.jobs`, calls `app.registerMetricsSource('jobs', …)`, and optionally mounts admin routes — all three now asserted against a real app |

Reproduce: `cd packages/caravan && bun run test && bun run typecheck`.

`bun run test` is now bare `bun test` (it used to name one file, so a new test
file would not have run).

---

## What was broken, and is now fixed (2026-08-02)

Five real defects. Two were already documented here; three more only surfaced
once the plugin was booted against a real Junction app for the first time.

### 1. `autoloadJobs()` threw `ReferenceError` — the feature had never worked

`src/autoload.ts`. `const dir` was declared **inside** the `try` and read in the
`for` loop **outside** it. Fixed by hoisting `let dir: string`.

It only ever "passed" because nothing exercised it with a non-empty directory —
an empty glob result skips the loop. `tests/autoload.test.ts` now runs it against
committed fixtures (including a nested dir and an invalid default export).
**Verified the test catches it**: reverting the hoist reproduces
`ReferenceError: dir is not defined` in 4 tests.

### 2. Admin routes 401'd on every request when a secret was set

`src/index.ts`. The guard read `ctx.params.headers['x-caravan-secret']`, but
these are raw `app.get`/`app.post` routes, so `ctx` is Junction's
`TransportContext`, where headers live on `ctx.headers` and path captures on
`ctx.route` (`params` has since been removed from both contexts entirely —
`FJS-D03`). Fixed to `ctx.headers[...]`.

### 3. Every by-id admin route 404'd — Junction uses `{id}`, not `:id`

**New.** Caravan registered `/jobs/:id`, `/jobs/:id/retry`, `/jobs/:id/cancel`.
Junction's router parses params with `PARAM_PATTERN = /^\{([^}]+)\}$/`
(`src/transport/router.ts`), so `:id` parsed as a **literal static segment** and
never matched. Three of the five admin endpoints had never worked. Fixed to
brace syntax. (`app.ws`'s own docs in `core/app.ts` say "same {param} syntax as
HTTP routes" — the convention was already there.)

### 4. Guard/404 rejections surfaced as HTTP 500

**New.** Both threw `Object.assign(new Error(...), { code: 401 })`. Junction's
`toFrameworkError()` (`src/core/errors.ts`) only honours its own
`FrameworkError` subclasses plus two name-matched Litestone errors — anything
else becomes a `GeneralError`, i.e. **500**. So even after fix #2 the guard
denied with the wrong status.

**Fixed twice.** First by returning a hand-built `Response` with the right
status — correct, but a workaround. Then, once Junction's error boundary learned
to read a numeric `status`/`statusCode`/`code` off any thrown value
(2026-08-02), simplified to just throwing. That is shorter, and Caravan still
imports nothing from Junction.

If you add another admin route:
`throw Object.assign(new Error(msg), { status })`.

### 5. `app.configure(createCaravan())` did not typecheck for any consumer

**New.** `CaravanApp` carried a `[key: string]: unknown` index signature.
Junction's `App` has none, and `register(app: CaravanApp)` puts the app in a
**contravariant** position, so the plugin was not assignable to Junction's
`PluginInput`. Every TypeScript consumer got an error on the one line the README
tells them to write. Fixed by dropping the index signature and naming the four
fields Caravan actually touches (`registerMetricsSource`, `telemetry`, `jobs`,
`config`).

**If you add a field to `CaravanApp`, do not reintroduce an index signature.**

### Also fixed

- `CronSchedule.fn` was `() => void | Promise<void>`. TypeScript only discards a
  returned value when the expected type is *exactly* `void`, so any handler
  returning something — like `() => caravan.dispatch(...)` — was an error.
  Now `() => void`; `async` still assigns fine. (Conduit hit the identical bug.)
- `src/db.ts` wrapped `bun:sqlite` named-param binds behind a local
  `NamedBindStatement` interface — bun-types declares those methods
  positional-only. One cast in one place instead of three errors.
- `app.config._junction.caravan` reach-in is now typed rather than an
  `any`-flavoured chain.

---

## `app.jobs` is now a typed, augmented slot

Junction gained `export interface AppJobs {}` plus `jobs?: AppJobs` on `App`
(`src/core/app.ts`), exactly mirroring the existing `AppConduit` pattern, and
Caravan augments it in `src/index.ts`:

```ts
declare module '@frontierjs/junction' {
  interface AppJobs extends CaravanInstance {}
}
```

`app.jobs.dispatch(...)` now resolves with real types. **Augment the interface —
never redeclare `App.jobs`**: declaration merging requires identical types, so a
redeclaration is TS2717 and the augmentation silently loses, which is exactly
what used to happen to `app.conduit`. See the landmine in `../../CLAUDE.md`.

Junction's own typecheck is unchanged at its 214 baseline and its 703 tests
still pass — verified.

---

## The integration gap is closed

`tests/junction-integration.test.ts` (21 tests) boots a real app via
`createTestApp()` and covers the seams the direct tests structurally cannot:

- plugin lifecycle — `register()` attaches `app.jobs` at `configure()` time,
  `boot()` actually starts the worker (a dispatched job runs), `shutdown()`
  stops it
- `app.registerMetricsSource` — the contribution still lands, and the source's
  stats track dispatched work
- admin routes over real routing — list, by-id, schedules-not-shadowed-by-`{id}`,
  retry, cancel, custom path, and not-mounted-when-omitted
- the secret guard — admits a correct header, rejects wrong and missing ones
  with a real 401, and guards *every* route, with the mutation confirmed not to
  have run

Bugs #2, #3, #4 and #5 were all found by writing this file. Conduit's history
was identical: fake-app plugin tests passed while the real endpoint 404'd.

---

## The `junction.config.js` caravan section is whole

*`FJS-048`, closed 2026-08-16. **`FJS-039`** (autoload scoping, admin guard ctx
shape, `cancel()` revert race) is still `stale?` and unprobed in
`../../ISSUES.md`. Add a new item there, not here.*

Junction publishes `JunctionCaravanConfig` with `db`, `jobsDir`, `pollInterval`,
`cleanupAfter`, `queues` and `admin` (`src/config/index.ts`), and `register()`
honours every one of them, opts always winning.

Four of the six could not work before, and the reason was construction order:
`createCaravan()` opened the database and built the worker pool immediately, so
`db`, `pollInterval`, `queues` and `admin` were all spent before an app existed
to hand a config over. **The database now opens on first use and the workers are
built in `start()`**, after autoload — nothing reads an option until the moment
it needs it, which is what makes a config file able to set any of them.

Two things follow from that and are worth knowing:

- A dispatch or a read **before** `app.configure(createCaravan(…))` opens the
  database at the default path, and a configured path can no longer take effect.
  `register()` says so by path rather than running against a file the app did
  not name.
- `stop()` closes the database, so the pool forgets its workers — they hold that
  handle and its prepared statements. A `start()` after a `stop()` builds both
  again.

---

## Conventions that apply here

- Run tests with **`bun run test`**, not `bun test` (see `CLAUDE.md`).
- The plugin protocol is `{ name, register, boot, ready, shutdown }` —
  `packages/junction/src/core/app.ts`.
- Raw admin routes: params are `{id}`, headers are `ctx.headers`, and a denial
  is a thrown error carrying a numeric `status`. The first two were bugs; the
  third works only because Junction's error boundary was fixed to read it.
- If you add an `app.<thing>` from this package, augment an **interface**
  Junction exports; do not redeclare the property.
- `app.registerMetricsSource` is a declared seam rather than the private-field
  reach-in this used to be (`FJS-D06`). The call is still optional, because
  Caravan runs against hosts that are not Junction apps — so the integration
  test against a real app is what proves the seam is really there.

## Unconfirmed

- Whether the worker's polling loop leaks timers on `shutdown()`. The
  integration test asserts no *further jobs are processed* after shutdown, which
  is the observable behaviour; it does not inspect timer handles. The interval
  timers are `unref()`'d, so they would not hold the process open regardless.
- Whether `defineJob()`'s `__caravanJob` marker survives a bundler.
- Retry/backoff timing under real failure load is covered only by the direct
  unit tests, not end-to-end.
