# @frontierjs/testing — package map

**The Testing realm's environment, above Junction.** One `createTestEnv` across
Data and API. Litestone's version owns the Data half; this owns the half that
needs a Junction app, which Litestone may not import (Invariant 1).

`bun run test` (bun). `bun run typecheck` — baseline 0.

---

## Layout

```
src/index.ts          createTestEnv, session, OPTS_AT, the `listen` port
src/parity.ts         verifyTransportParity — HTTP vs WS, over a real socket
test/testing.test.ts  the vertical, against a real client and a real app
test/parity.test.ts   the runner, and the ways it can be worthless
test/fixtures/schema.lite
```

`index.ts` is one file on purpose — a composition of two packages' testing
surfaces plus a principal binder, where splitting would be three files of
re-exports. `parity.ts` is separate because it is the only thing here that binds
a port, opens a socket and owns a comparison.

---

## What it owns

- **`api:`** — an `App`, or a factory handed `{ db, system, factories, schema, path, dir }`.
  The factory is the usual shape, because an app is built over a client and the
  client does not exist until `createTestEnv` is called.
- **`env.as(user)`** — the principal bound into every service call.
- **`env.announced()`** — the announcement buffer, cleared when `act` begins.
- **`session()`** — a `SessionContext` from the fields a test states.
- **`listen: true`** — a real port, `env.url` and `env.port`. Off by default.
- **`env.verifyTransportParity()`** — the same call down HTTP and WS, compared.

It deliberately owns **no HTTP helper**. `env.http` IS `request(app)` from
`@frontierjs/junction/testing`.

---

## What bites here

- **`_startForTest()` is called eagerly, not lazily.** Junction's `request()`
  calls it on the first request; an internal `env.as(u).service('x')` call would
  otherwise meet a pipeline that had not compiled and plugins that had not
  registered — so a plugin's guard refuses nothing and the test passes.
- **`OPTS_AT` is a hand copy of Junction's `ServiceCaller` signatures.** Change
  one, change both. The check runs when a caller is built and names any method it
  does not know; there is no guessing fallback, because a call bound at the wrong
  argument runs anonymous and an empty result reads as a correct answer.
- **The announcement filter drops `app:*` and `junction.*`** — lifecycle and
  telemetry, not announcements. A new prefix on the bus lands in `announced()`
  until it is named here.
- **`env.close()` is async here and sync in the Data-realm env.** It stops the
  app first.
- **A test that never mounts an app gets Litestone's env back unchanged**, `app`
  undefined. That path has a test, because a silent partial env is worse than a
  missing one.
- **Parity against an app with no `channels()` compares HTTP against HTTP.** The
  browser client falls back when no socket is live, so it would agree on
  everything and certify a transport it never spoke to. The runner reports the
  unconnected socket as a row; do not make that row quiet.
- **`listen` runs the `listen` start phase on its own, not `app.start()`.**
  `start()` also loads config from the working directory, autoloads services from
  beside `Bun.main` — the test runner — and installs process signal handlers.
- **`close()` force-stops the server before `app.stop()`.** Bun's graceful stop
  never closes a WebSocket and one never drains on its own, so shutting down with
  a live socket waits the whole drain window (5s) and reads as a hang.
- **The WS attempt is deliberately sandwiched between the two HTTP ones.** That is
  what makes the volatility calibration sound for anything moving with the clock;
  reordering it makes `deletedAt` a spurious mismatch roughly half the time.

---

## Proving a change

`bun run test`. Anything touching the principal binding also needs `basecamp`:
`bun run verify` — the largest gate ladder in the repo, and the only place a
standing resolves per workspace.
