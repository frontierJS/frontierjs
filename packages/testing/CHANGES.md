# Changes — @frontierjs/testing

## 2026-08-12 — transport parity: HTTP and WS answering the same call the same way

`listen: true` binds a real port and `env.verifyTransportParity()` puts the same
call down both transports, under the same principal, and compares the answers.

```js
const env = await createTestEnv({ schema, plugins: [gate], listen: true, api })
const found = await env.verifyTransportParity({
  as: [{ label: 'member', token: 'tok-member' }, { label: 'anonymous' }],
})
```

Calls default to every CRUD method of every service registered with a `model:`,
with fixtures from litestone's new `sampleWrites` — plus a `$limit`-bearing
`find`, because directives reach the two transports by different routes.

**The oracle is two real transports**, which is what makes this worth running.
HTTP goes URL → router → `bridge.toContext()`; WS goes frame → `channels()` →
`bridge.internal()`, and everything the first derives from a request the second
lifts out of a JSON object by hand. Neither restates what the answer should be, so
a mismatch names both answers and a person decides which one is the bug.

Sabotaged against the defect that motivated it — the server reading call extras
from `params` while the client sends `meta` — it reports 15 rows across three
principals: `ctx.id` null so every patch and remove is refused as a bulk write,
and `$limit` silently ignored.

```
[verdict] member · leads.patch
  HTTP answered and WS refused with 400 — "Bulk patch is disabled on this service".
[value] member · leads.find $limit
  limit differs — HTTP 1, WS 20. Measured to be stable across two HTTP calls.
```

**An app with no `channels()` is a reported failure, not a pass.** The browser
client falls back to HTTP when no socket is live, so a runner that did not notice
would compare HTTP against HTTP and certify a transport it never spoke to. So is
an empty call list.

**Volatility is measured, not named.** A created row differs from itself run to
run — a uuid, `@default(now())`, a `@version` — so the runner makes the same call
twice over HTTP and masks every path that differs. The WS attempt goes *between*
the two HTTP ones: two back-to-back calls can land in the same millisecond, mark
`deletedAt` stable, and then the third lands a millisecond later and reads as a
transport difference. Bracketing means the HTTP pair spans at least as much time
as the HTTP↔WS gap does.

**The port is asked for as 0 and read back**, so parallel suites cannot collide.
`listen: <number>` binds a stated one. This is the `listen` start phase run on its
own — `app.start()` also loads config from the working directory, autoloads
services from beside `Bun.main` (the test runner) and installs signal handlers.

**Two junction defects on its first runs.** `FJS-196` — any status junction has no
error class for arrived as a 500, found by the falsifiability test staging a hook
that throws a 418. `FJS-197` — `ctx.id` was a string over HTTP and a number over
the socket, found by the one custom-action test, which is the method shape the
derived call set does not cover.

## 2026-08-12 — the package exists

The API tier of `createTestEnv`. Litestone's version stops at the Data boundary
because mounting a Junction app means importing Junction (Invariant 1); this
sits above Junction and is imported by nothing.

```js
const env = await createTestEnv({
  schema:  'db/schema.lite',
  plugins: [appGate],
  api:     ({ db }) => buildApp(db),
})

await env.as(developer).service('leads').remove(lead.id)
expect(env.announced('leads:removed')).toHaveLength(1)
```

Adds `app`, `as(user)`, `service(name)`, `http`, `announced()`,
`clearAnnounced()`, and a `phases()` whose `act` clears the announcement buffer.
Everything else is Litestone's env, re-exported.

**Building it found a Litestone defect immediately.** The fixture schema
declares `@@allow('read', ownerId == auth().id || ownerId == null)`, and the
unowned rows never came back: `field == null` compiled to `"col" = NULL`, which
SQLite answers NULL — never true. The JS evaluator used for `create` compares
with `===` and had always been right, so a row could be created and then be
invisible to the caller that created it. Fixed in
`litestone/src/core/policy.js`; `FJS-195`.

**`OPTS_AT` is a table, not an inference.** Where `CallOptions` sits varies per
method (`find(query, opts)` vs `patch(id, data, opts)`), an overload with a
defaulted argument makes `fn.length` lie, and *the last argument if it looks like
options* mistakes `create({ auth: … })` for a call option — which has a test. A
method a real caller has and the table does not name is refused when the caller
is built.

**`_startForTest()` runs eagerly.** Junction's `request()` defers it to the first
request; an internal service call would otherwise meet an uncompiled pipeline and
unregistered plugins, and a guard that has not registered refuses nothing.
