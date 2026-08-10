# conduit — package map

**The outbound boundary.** Every call that leaves the process goes through a
*declared target* — `app.conduit.send()`. v0.1.0, deliberately narrow.
`bun run test` (bun).

---

## Layout

```
src/
  conduit.ts        the core — declare targets, send, apply policy
  router.ts         target resolution
  plugin.ts         the Junction plugin (app.conduit)
  credentials.ts    credential resolvers — a target names one, never inlines it
  resilience.ts     per-target load shedding
  trace.ts          trace-context propagation
  types.ts          the target/message types
  testing.ts        test factory
  transports/       http · websocket · unix · stub · not_implemented · base
  stores/           sqlite · memory
```

---

## What bites here

- **A target is declared, not constructed at the call site.** That is the whole
  point of the package: one place lists what this process may talk to, with what
  credential, under what policy.
- **`stub` and `not_implemented` are different answers.** A stub transport
  succeeds with a canned response; NotImplemented refuses. Do not use the first
  as a placeholder for a transport you meant to write.
- **The credential must really resolve.** `example`'s drive posts to a dev mail
  sink on :3610 precisely so the request leaves the process carrying a resolved
  credential and can really answer 500 — an outbound path that is only ever
  mocked is the easiest thing in a framework to believe in and never check.

## Proving a change

`bun run test`, then `example`: `bun run verify:notify` — the mail path runs over
conduit to a real server.
