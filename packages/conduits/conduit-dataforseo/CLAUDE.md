# conduit-dataforseo — package map

`src/index.ts` target, `postTasks`, `live`, `tasksReady`, `getTask`, `toMicros`,
`envelope` (the C4 validator), `translate` (the one reader of `error.raw`) ·
`src/types.ts` · `sink.ts` · `test/dataforseo.drive.ts`.

## What bites

- **Every accepted task bills and nothing collapses a replay.** A post is
  unkeyed and unreplayable; a lost one is resolved by the caller's `tag`
  through `tasksReady`, so a caller that posts without a tag cannot find it.
- **A 200 can be a refusal.** `envelope` refuses a top `status_code` that is
  not 20000; a TASK's refusal rides inside an OK envelope as its own `kind`.
- **Cost is micros**, not minor units: a task is $0.0006 and cents round it to 0.
- **The credential is `login:password`** under one ref; a per-agency login is
  `perCaller: true` and `getFor`, never a resolver reading the tenant ambiently.
- **Pacing is the app's.** The vendor refuses past 2,000 calls a minute per
  login and conduit has no outbound pace; serpgrid's per-agency slot is the
  prior art and is not here.

## Proving a change

`bun run drive`: 12 rows.
