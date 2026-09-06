# Changes — @frontierjs/testing

## `createTestMailer()` — and the two doubles that are deliberately absent

`batteries-13` asked for doubles for mail, storage and cache. Asked of the code
rather than of the list, only one of the three was missing.

`createMemoryCache()` from `@frontierjs/junction` is already an in-memory
`ICache`, held to the SQLite driver's contract by a conformance suite that runs
one body against both. `FileStorage({ provider: 'local' })` from
`@frontierjs/litestone` is already the local implementation, and its assertion
surface is the filesystem, which a test can read. A second of either would be a
second answer to the same question, and the two would drift.

Mail had nothing: no `IMail` without a mail server, and *what was sent* existed
nowhere, so any suite asking whether an invitation reached an address had to
stand up an MTA. `createTestMailer()` records `sent`, answers `last`, finds a
message by any recipient including `cc` and `bcc`, and can be made to fail —
the retry and outbox paths need failures.

Its sharp edge is what it refuses. It applies the same address and header guards
the real path does, imported from `@frontierjs/junction/mail` rather than
restated, because a double that accepts a message SMTP would reject is worse than
no double: the test is green and the send fails in production.

The other two are named in the module header rather than shipped, so that
completing the set later is a decision somebody makes rather than a gap they
fill.

## 2026-08-17 — first consumer, and it found the thing this package exists to find

`packages/basecamp/api/test/services.test.ts` is the first code anywhere to
import this package. No change here was needed to make it work, which is the
result worth recording — but mounting a real app for the first time immediately
surfaced `FJS-348` in Junction: `autoload-services` was a `needsHost` phase, so
`_startForTest` skipped it and **every app that autoloads had zero services in a
test env**. Every call answered a 404 naming the service.

Nothing below the API boundary could have found that, which is the argument for
this package stated as a defect rather than as prose.

Two things the first run confirmed work as documented: the zero-calls guard on
`verifyTransportParity` (it reports *not graded* as a row rather than returning
an empty array that looks like agreement), and the socket guard beside it. A
full parity sweep of basecamp — every derived call, as an owner and as an
anonymous caller — found **no mismatches**.

## 2026-08-17 — the first consumer, and what it found

basecamp's API tier now runs on this package (`api/test/services.test.ts`).
Until today nothing in the repo imported it, including the app built to find
out what the framework is missing.

No change here was needed, which is the result worth recording — but mounting a
real app immediately surfaced **`FJS-332`**: junction's `autoload-services`
phase was `needsHost: true`, and `_startForTest` skips those, so every app that
autoloads started with no services and every `env.as(u).service('x')` answered
`Service 'x' not found`. That is plausibly why this package had no consumers:
calling a service is the first thing anyone does with it.

Two guards in here earned their place on the first run. `verifyTransportParity`
reports an **underived call list** and a **socket that never connected** as
findings rather than returning an empty array — without both, basecamp's first
parity run would have been green while comparing nothing. It compared every
derived call for every model service, as an owner and as a stranger, and found
zero mismatches.

The one contract that bit: `announced()` clears at **act**, not at arrange, so a
read taken between the two still holds what earlier tests announced. Documented
already; worth a line because the test that got it wrong looked correct.

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
