# @frontierjs/testing — for agents

Test a FrontierJS app against its real schema, real client and real Junction
app. It re-exports everything in `@frontierjs/litestone/testing` (the Data half:
factories, the verifiers, `phases`, the clock — read `litestone/AGENTS.md` §
Testing first) and adds the API half. **Nothing here mocks a module**; a test
passes a real client, a real plugin, or a double listed below.

```ts
import { createTestEnv, session, createTestMailer } from '@frontierjs/testing'

const env = await createTestEnv({
  schema:     'db/schema.lite',
  migrations: 'db/migrations',        // test the database a deploy produces
  autoFactories: true,
  plugins:    [appGate],
  api:        ({ db }) => buildApp(db),   // an App, or a factory handed the Data tools
})

const t    = env.phases({ as: developer })
const lead = await t.arrange(({ factories }) => factories.lead.createOne())
await t.act(() => env.as(developer).service('leads').remove(lead.id))
await t.assert(read => expect(read.lead.count()).resolves.toBe(0))
expect(env.announced('leads:removed')).toHaveLength(1)
```

Without `api` the result is litestone's env unchanged — no `as`, `http` or
`announced`.

## What `env` adds

| Name | What it is |
|---|---|
| `env.as(user).service(name)` | a service caller with the principal bound into every call — session built, `toDataPrincipal` applied, scoped client re-derived, the way a request does it |
| `env.http` | Junction's `request(app)`, no port bound: `env.http.get('/leads').auth(token)`. Auth is the app's to issue |
| `env.announced(event?)` | what the current `act` announced, as `{ event, data }` (`'leads:created'`, `'orders:pay'`); cleared when `act` begins |
| `env.app` | the built `App` |
| `listen: true` (or a port) | a real server on port 0 read back as `env.port` / `env.url`. Off by default; leave it off unless a browser needs a URL |
| `env.verifyTransportParity()` | the same call down HTTP and WS, compared |

`env.actingAs(user)` (Data tier) grades with the app's `getLevel` and never
touches Junction. `env.as(user)` is the same user through the whole API path.
A test about a hook, a plugin guard or `ctx.auth` wants `as`.

## Principals

- `session({ userId, role, isAdmin, … })` builds a `SessionContext`. A standing
  field you omit is *absent*, which grades as permissive; `verifiedAt: null` is
  what grades down to VISITOR.
- `createStubAuth({ users: [{ id: 'u1', isAdmin: true }] })` is an `IAuth`;
  `.addUser(user)` returns the bearer token (`test-token-<id>`) for
  `env.http…auth(token)`. The ladder reads `isAdmin` / `isOwner` /
  `isSystemAdmin`, not `role`: `role: 'admin'` grades 4.
- `testCtx`, `withTestMeta`, `enterCall`, `request` are Junction's own helpers,
  re-exported for a unit test of a hook or a service method.

## Doubles — three needs, one shipped

| Need | Use | Not here because |
|---|---|---|
| mail | `createTestMailer()` → `.sent`, `.last`, `.to(addr)`, `.failNext(err, n)`, `.reset()` | it is the one nothing else provided; it applies the real address and header guards |
| cache | `createMemoryCache()` from `@frontierjs/junction` | already held to the SQLite driver's contract |
| storage | `FileStorage({ provider: 'local', localPath })` from `@frontierjs/litestone/storage`; read the bytes off disk | the filesystem is the assertion surface |

## Traps

- **A runner:** `bun run test` in the package, never `bun test` from a parent.
- **A test may not name a port.** Use `listen: true` and read `env.port`.
- **An empty list is not a pass.** `as(user).service(x).find()` as STRANGER
  returns `[]`, which reads as a correct answer; if a service call is bound to
  the wrong principal nothing throws. `env.as` refuses a `ServiceCaller` method
  it does not know where to put the principal for.
- **A plugin's guard only registers once the app starts.** `createTestEnv`
  starts it eagerly; an `App` you build and start yourself should do the same.
- **A verify file is `drive()` and its steps** (`@frontierjs/testing/drive`).
  It refuses a port that already answers; never pick a port that something
  else is running on, and never write your own start-poll-kill wrapper.
- **Layout and the rest:** `CLAUDE.md` (maintainers), `README.md` (a person).
