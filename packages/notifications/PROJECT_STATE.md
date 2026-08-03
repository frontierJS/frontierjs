# Notifications — Project State

_Audited **and fixed** 2026-08-02 by running the code: 18 fan-out probes against a
real Junction app (db + WS + mail). Four defects found and fixed; the probes are
now 19 permanent tests. Everything marked **verified** was reproduced._

> Drop this file into a fresh session to pick up Notifications cold.
> Read `../../CLAUDE.md` first for repo-wide vocabulary and landmines.

---

## What it is

`@frontierjs/notifications` v0.1.0 — a **vertical slice**, not a horizontal
layer. One notification class fans out to several channels: an in-app record, a
WebSocket event, and an email.

It is the only package in the repo that spans Data → API → UI in one feature, so
it is the practical integration test of whether those three realms actually
compose.

```
index.ts          public barrel
notification.ts   the Notification base class (subclass this)
notify.ts         the fan-out engine
plugin.ts         Junction plugin — attaches app.notify
builders.ts       inApp(), mail() authoring helpers
drivers/inapp.ts  in-app record + WS event
drivers/email.ts  renders MailLine[] → text/html, hands to app.mail
types.ts          User, NotificationDriver, MailMessage wire shape
errors.ts
examples/         WelcomeUser, PaymentReceived, wiring
tests/email-render.test.ts
```

## Verified state

| | |
|---|---|
| Tests | **27 pass, 0 fail**, 2 files (`bun run test`) — was 8 in 1 file |
| Typecheck | **clean, 0 errors, baseline removed** — was 8 |
| Public exports | `Notification`, `notificationsPlugin`, `inApp`, `mail`, + types — verified |
| Plugin seam | `register()` only — attaches `app.notify`, stashes `_db` and `_drivers` on the app |

Reproduce: `cd packages/notifications && bun run test && bun run typecheck`.

**The empty-email-body bug is fixed** (per CLAUDE.md, 2026-08-01): the email
driver now renders `lines` → `text`/`html`. `drivers/email.ts` exports
`renderText()` and `renderHtml()`, and the 8 tests are that rendering. Not
re-derived from scratch this session, but the code matches the claim.

---

## How it attaches (read this before changing anything)

`plugin.ts` implements **only `register()`** — no `boot`, `ready` or `shutdown`.
That is a deliberate-looking choice but has consequences worth knowing:

- `app.notify` is set synchronously at `configure()` time. Good.
- `opts.db` and the driver registry are stashed as `app._db` and `app._drivers`
  — **private-field writes onto Junction's `App`**, same species as
  `app._metricsProviders`. Nothing type-checks that seam.
- There is no `shutdown()`, so nothing releases driver resources on `app.stop()`.

Ordering matters and is enforced only at runtime: the email channel throws
`"Email channel requires mailerPlugin to be configured before
notificationsPlugin"` (`drivers/email.ts:67`). A fresh session should decide
whether that belongs in `boot()` as a fail-fast check instead of at first send.

---

## What was broken, and is now fixed

All four were found by sending a real notification through a real app. None was
visible to the 8 pre-existing tests, which fed hand-built `MailLine[]` arrays
straight to `renderText`/`renderHtml` — no builder, no driver, no app.

### 1. The drivers never called `builder.build()` — silent empty delivery

`inApp()` and `mail()` return chainable **builders** whose values live in
private fields. The drivers read the message as a plain object, so they got the
chainable **methods** instead:

| driver read | actually was | result |
|---|---|---|
| spread of `message.data` | a function | `data: {}` — payload lost |
| `message.title` / `body` / `action` | functions | serialised to nothing |
| `message.contextType` / `contextId` | functions | stored `null` |
| `message.lines` | `undefined` (field is `_lines`) | `?? []` → **empty email** |
| `message.subject` | a function | **no subject** |
| `message.to` | a function → truthy | the "no recipient" guard never fired |

`notify()` reported success throughout.

**Scope, stated precisely:** `README.md` and `examples/` call `.build()`, and
that path always worked. The **JSDoc `@example` blocks omitted it**, and those
are what an editor shows on hover. TypeScript rejects the omission
(`InAppBuilder` is not an `InAppMessage`, TS2322/TS2741 — verified), so this
reached JavaScript consumers and JSDoc-followers, not typed code that compiles.

**Fixed** by `materialise()` in `notify.ts`: if a message still has `build()`,
call it. That is what `builders.ts` already claimed ("called internally by the
driver") and never did. Already-built messages pass through untouched. The
JSDoc examples now show `.build()` too.

### 2. A driver registered for `inApp` was accepted and then ignored

`plugin.ts` skipped only `email`/`sms` when building the registry, so an
`inApp` driver was stored — and `deliverChannel`'s switch ran the built-in
first, so the override never ran. Explicit configuration lost to a default,
silently.

**Fixed**: a registered driver now wins for any channel, built-ins are the
fallback.

### 3. SMS was unimplementable

`sms` was in `BUILT_IN_CHANNELS` (so validation passed) and hardcoded to
`throw new Error('SMS channel is not yet implemented.')` at delivery — while
`plugin.ts` refused to register an `sms` driver at all. There was no way to
provide one.

**Fixed**: `sms` is no longer a built-in, so it needs a driver like any other
channel. Supply one and it works; omit one and you get an eager
`NotificationDriverNotFoundError` instead of a bare `Error` mid-delivery.

### 4. `app.notify()` did not typecheck for any consumer

Junction declares `AppNotify` as an empty augmentable interface and its own
doc comment says this package fills it in. Nothing here ever did, so
`app.notify(user, n)` was **TS2349, "this expression is not callable"** for
every TypeScript consumer. The package never noticed because it type-checks
against its own structural `App` in `types.ts`, not Junction's.

**Fixed**: `index.ts` now augments `AppNotify` with the real call signature.
Augment the interface — never redeclare `App.notify`; see the `AppConduit`
landmine in `../../CLAUDE.md`.

### Also corrected: the documented schema could not store an auth user id

`README.md` and `examples/wiring.ts` documented `userId Int`, but
`@frontierjs/auth` issues **String uuid** ids, so the in-app channel died with
`cannot store TEXT value in INTEGER column notification.userId` — verified.
Both now document `userId String`. For the repo's own vertical slice, failing
to compose with the repo's own auth package was the more interesting bug.

---

## Verification

Each fix was confirmed by reverting it:

- disable `materialise()` → the 2 un-built-builder tests go red (and only those,
  which is what pins the scope claim above)
- let the built-in win over a registered driver → the `inApp` override test goes red

`tests/fanout.test.ts` (19) covers the full fan-out against a real
`createTestApp()` + `channels()` + a capturing mailer + a real Litestone db:
payload contents on all three channels, eager validation, channel isolation
(a failing email still persists the in-app row), driver overrides, and the
uuid round-trip. `tests/email-render.test.ts` (8) is unchanged apart from
giving its fixture users the `id` the `User` type requires.

Temp databases are reaped at **process exit**, not in `afterAll` — same
audit-logger async-flush hazard documented in `packages/auth/tests/harness.ts`.

---

## Typecheck: clean, no baseline

Was 8. The 7 test errors were fixture users missing the `id` that `User`
requires (the type was right, the tests were wrong) and the 1 source error was
an unsound double assertion in `getMessageFor()`, now a single `unknown` hop
plus a checked `.call(this, user)` — which also fixes a real `this`-binding
loss. `package.json` no longer passes `--baseline`.

`types.ts:66` `User` is deliberately minimal (`id` required, `email`/`phone`
optional, open index signature) so an app can supply a richer type. Requiring
`id` is correct — fix the tests, not the type.

`getMessageFor(channel, user)` does convention dispatch to `to<Channel>()`. The
cast is how it reaches a dynamically-named method. Worth tidying since it is
public API, but no consumer sees a wrong type.

---

## Conventions that apply here

- Run tests with **`bun run test`**, not `bun test` (see `CLAUDE.md`).
- Model names are **PascalCase singular**; `db.notification` is the accessor.
- If you add an `app.<thing>` from this package, augment an **interface**
  Junction exports; do not redeclare the property — redeclaring silently loses.
  See the `AppConduit` note in `CLAUDE.md` for the pattern that works.
- Check any public callback type for `() => void | Promise<void>`. That union
  breaks TypeScript's void-return rule, so `(x) => arr.push(x)` becomes an
  error. Declare `() => void` — it still accepts `async` functions. Conduit and
  Caravan both had this bug.

## Now confirmed (previously unconfirmed)

- **The WS event does reach a subscribed client** — a connection joined to
  `notifications:user:{id}` receives `notification:created` carrying the full
  record. Verified with a fake connection against the real channel manager.
- **Channel isolation holds** — a failing email still persists the in-app row,
  and the aggregate `NotificationDeliveryError` names the failed channel.
- **The WS push really is optional** — with no `channels()` plugin,
  `app.channel?.()` is undefined and the row still persists without error.

## Still unconfirmed

- Whether `app.notify` is reachable from a service hook via `ctx.app.notify` as
  `plugin.ts`'s doc comment claims. Not probed; `ctx.app` was never exercised.
- Whether the in-app record shape matches what any UI expects — still no
  consumer of this package in the repo.
- `plugin.ts` still implements only `register()`. There is no `boot()`, so the
  "mailerPlugin must be configured first" requirement is still discovered at
  first send rather than at startup, and no `shutdown()` releases driver
  resources. Both are unchanged by this pass and worth a decision.
