# testing — Project State

_Verified 2026-09-03 by running the code. Everything below marked **verified** was
reproduced; anything else is labelled as unconfirmed._

> Drop this file into a fresh session to pick up `@frontierjs/testing` cold.
> `CLAUDE.md` is the map — what it owns, what bites, and what proves a change.
> Read `../../CLAUDE.md` first for repo-wide vocabulary.

---

## What it is

`@frontierjs/testing` v0.1.4 — the Testing realm's API tier. One `createTestEnv`
across Data and API: litestone's version owns the Data half, this owns the half
that needs a mounted Junction app, which litestone may not import (Invariant 1).

It adds `app`, `as(user).service(name)`, `http`, `announced()` and
`verifyTransportParity()` over litestone's environment, and it is imported by no
framework package — sitting above Junction is the whole of why it exists.

## Verified state

| | |
|---|---|
| Tests | **23 pass, 0 fail**, 53 `expect()` calls, 2 files (`bun run test`) — verified |
| Typecheck | **clean, no baseline** (`bun run typecheck`) — verified |
| Published | `0.1.4` on npm, the version the tree carries (`npm view @frontierjs/testing version`) — verified |
| Its one consumer | `packages/basecamp/api/test/services.test.ts` — **71 pass, 0 fail**, 200 `expect()` calls (`cd packages/basecamp && bun test api/test/services.test.ts`) — verified |
| Parity, in the wild | one call, `only: ['projects']` — verified by reading the same file |

Reproduce: `cd packages/testing && bun run test && bun run typecheck`, then the
consumer above. The consumer is the assertion that matters: two of the three
things this package binds (the principal through four derivations, a real port,
a live socket) are only exercised against a real app.

## What is NOT built

- **`example/` does not use it.** The largest surface in the repo asserts its API
  tier through browser and node drives instead, so the app written to find out
  what the framework is missing is not a consumer of the package written to ask
  the same question one layer down. Nothing is filed for this; it is a gap in
  adoption rather than a defect.
- **A full parity sweep is not run by anything.** `CHANGES.md` records one over
  the whole of basecamp on 2026-08-17 with no mismatches; the call that survives
  in the tree is narrowed to a single service, so the HTTP-against-WS comparison
  is exercised against one model per CI run. Widening it is the cheapest real
  coverage available here.
- **The runner grades what it is given and cannot see what it was not.** Its two
  guards — an empty call list, and a socket that never connected — are reported
  rows rather than silent passes, and they are the only defence against a green
  parity run over nothing. Both are tested here.
- **No `ISSUES.md` row names this package** — verified by grep over the open
  sections. That is not the same as no open work, which is what the two points
  above are.

## Picking it up next

1. Run the consumer, not just the suite. `bun run test` here mounts fixtures;
   basecamp mounts a real app with a real gate ladder and is where `FJS-348` was
   found on the day the first consumer appeared.
2. Drop `only:` from basecamp's parity call and read what comes back. If it is
   still empty, the narrowing can go; if not, that is a real finding about the
   two transports.
3. Get one `example/` service onto `env.as(user).service(…)`. It is the second
   consumer this package has never had, and a second consumer is what turns
   `OPTS_AT` from a hand copy into a checked one.

Anything touching the principal binding also needs `basecamp`: `bun run verify` —
the largest gate ladder in the repo, and the only place a standing resolves per
workspace.

## Unconfirmed

- Whether `verifyTransportParity` still finds zero mismatches across the whole of
  basecamp. The 2026-08-17 sweep in `CHANGES.md` is the only record of one and it
  was run against an app that has grown since.
- Whether an installing app's resolution of the declared peers is what this
  package expects. The ranges (`junction ^0.1.0`, `litestone ^1.1.0`) do resolve —
  the registry serves junction 0.1.4 and litestone 1.1.5, both inside them
  (verified) — but nothing here has been run against an installed copy rather than
  the workspace symlink.
