# Notifications — Project State

_State, not history. What is fixed and when is in `CHANGES.md`; what is open is
in `../../ISSUES.md`._

> Drop this file into a fresh session to pick up Notifications cold.
> Read `../../CLAUDE.md` first for repo-wide vocabulary and landmines.

---

## What it is

`@frontierjs/notifications` v0.1.1 — a **vertical slice**, not a horizontal
layer. One notification class fans out to several **transports**: an in-app
record, a WebSocket event, and an email.

It is the only package in the repo that spans Data → API → UI in one feature, so
it is the practical integration test of whether those three realms compose.

```
index.ts          public barrel + the AppNotify augmentation
notification.ts   the Notification base class (subclass this)
notify.ts         the fan-out engine — format, validate, deliver
plugin.ts         Junction plugin — register / boot / shutdown
state.ts          the plugin's state on the app, under one Symbol.for key
builders.ts       inApp(), mail() authoring helpers
types.ts          Transport, Recipient, NotificationDriver, the mail wire shape
errors.ts
drivers/inapp.ts  in-app record + WS event
drivers/email.ts  renders MailLine[] → text/html, hands to app.mail
examples/         WelcomeUser, PaymentReceived, wiring.ts, Notification.mesa
tests/            harness.ts + fanout.test.ts + hook.test.ts + email-render.test.ts
```

There is no `src/`. The `exports` map points at `./index.ts` and the files sit
at the package root, which is what `files:` publishes.

## Verified state

| | |
|---|---|
| Tests | **54 pass, 0 fail**, 3 files (`bun run test`) |
| Typecheck | **clean, 0 errors, no baseline** |
| Public exports | `Notification`, `notificationsPlugin`, `inApp`, `mail`, four error classes, + types |
| Plugin seam | `register()` claims `app.notify`; `boot()` checks the mailer; `shutdown()` closes drivers |
| Drive | `example`: `bun run verify:notify` — mail at a real server, plus the in-app rows each caller can and cannot see |

Reproduce: `cd packages/notifications && bun run test && bun run typecheck`.

---

## The two words

**A Transport is a delivery medium** — `inApp`, `email`, a Slack driver. **A
Channel is junction's broadcast set**, which the in-app driver publishes on
(`app.channel('notifications:user:<id>')`). `FJS-D06` ruled it; both words are
in this package and they are not interchangeable.

`inApp` and `email` are the only built-ins. **`sms` is not one**: there is no
built-in implementation, so it needs a registered driver like any other name,
and a missing one is an eager `NotificationDriverNotFoundError`.

## The unit of address

`Recipient` is `{ id?, email?, phone?, ...yours }`. **Not a `User`.** `id` is
optional because a shop customer or a mailing-list address has no account, and
each transport states what it needs:

- `inApp` needs `id` — the row is keyed by it. An id-less recipient is refused
  by name (`NotificationRecipientError`), because the alternative is a row
  nothing can ever read, written with no error.
- `email` needs `message.to` or `recipient.email`.
- a registered driver is exempt — only it knows what it addresses by.

All three checks run **before any delivery**, so a two-transport notification
cannot half-land.

## How it attaches

`register()` builds the driver registry, puts `{ db, drivers }` on the app under
`Symbol.for('frontierjs.notifications.state')`, and claims `app.notify` through
`app.claim` when Junction offers it. The state does not enumerate onto the app
surface, and `notify()` on an app that never configured the plugin names the
missing plugin rather than throwing about an undefined property.

Ordering is declared, not documented: `requires: ['mailer']` when the email
transport uses the mailer, so Junction refuses to start on the wrong order.
`boot()` then asserts `app.mail` is actually set — a mailer plugin can register
and install nothing, and `requires` cannot see that.

`shutdown()` awaits each driver's optional `shutdown()`, isolated: one that
throws is logged and the rest still run.

---

## Traps

- **Fan-out runs on the queue, after the response.** A test that asserts
  immediately after the call asserts on nothing. `example/` dispatches a job.
- **`materialise()` is a forgiveness, not a contract.** `inApp()` and `mail()`
  return builders; `.build()` is what turns one into a message. `notify()` calls
  it if a builder reaches it un-built — without that, reading the chainable
  methods as values delivered an empty payload and reported success. TypeScript
  rejects the omission; JavaScript consumers hit it silently.
- **Each `to*()` is called once per `notify()`** and the message formatted at
  validation is the one delivered. Do not reintroduce a second call.
- **The mail wire shape is not the authoring shape.** `MailMessage` carries
  `lines`; junction's `IMail` reads `{ to, subject, text?, html? }`. The driver
  renders one into the other. This package declares junction's shape
  structurally (`OutgoingMail`) rather than importing it — keep the two in sync
  by hand, and check `junction/src/mail` when either moves.
- **`userId String`, not `Int`.** `@frontierjs/auth` issues uuid ids, and an
  `Int` column dies with `cannot store TEXT value in INTEGER column`.
- **`@@gate("0.8.4.8")` — create is 8, not 9.** 9 is LOCKED, which `asSystem()`
  does not pass either, so a 9 would stop the driver from ever writing a row.
- **"You see only your own" needs two accounts to demonstrate.** One signed-in
  user cannot show it; `example`'s drive signs in twice for that reason.
- Temp databases in the test harness are reaped at **process exit**, not in
  `afterAll` — the audit-logger async-flush hazard, same as
  `packages/auth/tests/harness.ts`.

## Conventions that apply here

- Run tests with **`bun run test`**, not `bun test`.
- Model names are **PascalCase singular**; `db.notification` is the accessor.
- An `app.<thing>` from this package augments an **interface** Junction exports;
  never redeclare the property — declaration merging requires identical types,
  so a redeclaration silently loses.
- Check any public callback type for `() => void | Promise<void>`. That union
  breaks TypeScript's void-return rule, so `(x) => arr.push(x)` becomes an
  error. Declare `() => void` — it still accepts `async` functions.

## Open

Nothing package-specific is open. `../../ISSUES.md` is the register; add there,
not here. What this package still does not have is a **preferences model** (per
recipient, per transport), a **push transport** (APNs/FCM, needs a device-token
model), digest batching, and a bulk mark-as-read.
