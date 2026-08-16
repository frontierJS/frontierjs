# @frontierjs/testing

**The Testing realm's environment.** One `createTestEnv` across the Data and API
realms — a migrated database, factories, a principal, a mounted Junction app, and
the announcements a mutation made.

```js
import { createTestEnv, session } from '@frontierjs/testing'

const env = await createTestEnv({
  schema:     'db/schema.lite',
  migrations: 'db/migrations',
  plugins:    [appGate],
  api:        ({ db }) => buildApp(db),
})

const developer = session({ userId: 'u1', role: 'developer' })

test('a developer archives a lead', async () => {
  const t = env.phases({ as: developer })

  const lead = await t.arrange(({ factories }) => factories.lead.createOne())
  await t.act(() => env.as(developer).service('leads').remove(lead.id))
  await t.assert(read => expect(read.lead.count()).resolves.toBe(0))

  expect(env.announced('leads:removed')).toHaveLength(1)
})
```

## Why this is not `@frontierjs/litestone/testing`

Litestone's `createTestEnv` owns the Data half and cannot own more: mounting a
Junction app means importing Junction, and the dependency direction is
`Litestone ← Junction ← Sierra` (Invariant 1). This package sits above Junction
and is imported by nothing.

The half it adds is not a convenience. A Data-realm test grades its caller with
the app's own `getLevel` and stops. Above the boundary there is more derivation
than that:

| Step | Owner | What goes wrong when it breaks |
| --- | --- | --- |
| principal → `SessionContext` | the auth provider | the standing fields are absent and everyone grades down |
| `SessionContext` → `sessionGateLevel()` | `junction/core/litestone.ts` | a gate refuses or admits the wrong tier |
| `SessionContext` → `toDataPrincipal()` | same | `userId` never becomes `id`, every row policy matches nothing, and the screen is empty with a 200 |
| `ctx.auth.user` → the scoped client | `withLitestoneDb` | the service queries unscoped |

`env.as(user).service('leads')` puts a user through all four — the path a request
takes, minus the socket.

## What it gives you

Everything `@frontierjs/litestone/testing` exports, re-exported — including the
four executed checks (`verifyGateLadder`, `verifyConstraints`,
`verifyFieldProtection`, `mutationScore`), which work unchanged here because they
ask the Data boundary directly — plus:

| | |
| --- | --- |
| `env.app` | the Junction app, started through every phase that does not need a port |
| `env.as(user).service(name)` | a service caller with the principal bound into every call |
| `env.service(name)` | the same with no principal — STRANGER(0), which is what an unauthenticated caller is |
| `env.http` | Junction's own `request(app)`, unchanged. Auth is the app's to issue |
| `env.announced(event?)` | what `callService` announced since the current act began |
| `env.clearAnnounced()` | for a test not using `phases()` |
| `env.url` · `env.port` | the bound origin, with `listen: true`. Null without |
| `env.verifyTransportParity()` | the same call down HTTP and WS, compared |

`env.close()` is **async** here — it stops the app's plugins before closing the
client.

## Transport parity

A Junction service is reachable two ways, and the two paths share almost nothing:
HTTP goes URL → router → `bridge.toContext()`, WebSocket goes frame →
`channels()` → `bridge.internal()`. Everything the first derives from a request —
the id, the filters, the `$`-directives, the method — the second lifts out of a
JSON object by hand. This puts the same call down both and compares the answers.

```js
const env = await createTestEnv({ schema, plugins: [gate], listen: true, api })

const found = await env.verifyTransportParity({
  as: [{ label: 'member', token: 'tok-member' }, { label: 'anonymous' }],
})
expect(found).toEqual([])
```

Calls default to every CRUD method of every service registered with a `model:`,
with fixtures derived from the schema, plus a `$limit`-bearing `find`. Pass
`calls:` for a custom method or a narrower run, `only:` to name services.

**Neither transport is treated as right.** A mismatch names both answers:

```
[verdict] member · leads.patch
  HTTP answered and WS refused with 400 — "Bulk patch is disabled on this service".
[value] member · leads.find $limit
  limit differs — HTTP 1, WS 20. Measured to be stable across two HTTP calls.
```

**Your app must `configure(channels())`.** Without it the client falls back to
HTTP, and the runner says so rather than comparing HTTP against itself and
agreeing on everything.

**The port is asked for as 0**, so parallel suites cannot collide. `listen: 8110`
binds a stated one, for a test something external was told about in advance.

## The act is the announcement window

`callService` is the one origin of a mutation announcement (Invariant 4) and puts
every one on `app.events` as `<service>:<past>`. This buffers them, and clears
the buffer when `act` begins — so `announced()` answers *what this act
announced*, not *everything since the test started*.

Which also makes the cost of arranging below the boundary visible: `arrange`
writes through `asSystem()`, no service runs, and nothing announces. That is
correct and it is worth a test saying so.

## `session()`

Fills the three required `SessionContext` fields and **invents nothing else**.
The standing fields grade a caller through `sessionGateLevel()`, where absent
means *the app does not model this stage* and only `null` grades down — a helper
that defaulted `verifiedAt: null` would silently drop every session it built to
VISITOR(1).

## Binding the principal

`OPTS_AT` states which argument of each `ServiceCaller` method carries
`CallOptions`. It is a table rather than an inference because the position varies
(`find(query, opts)` vs `patch(id, data, opts)`), an overload with a defaulted
argument makes `fn.length` lie, and *the last argument if it looks like options*
mistakes `create({ auth: … })` for a call option.

A method on a real caller that the table does not name is **refused when the
caller is built**, naming it. Guessing is not an option available here: a call
bound at the wrong argument runs anonymous, and an empty result reads as a
correct answer.

## Running

```bash
bun run test        # bun
bun run typecheck
```
