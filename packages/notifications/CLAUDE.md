# notifications — package map

**A vertical slice, not a layer.** A notification fans out to an in-app
record, a WebSocket event and an email — `app.notify`. It sits on Junction,
Litestone, conduit and (for email bodies) mesa/email-kit. `bun run test` (bun).

---

## Layout

No `src/` — the files are at the package root, which is what `exports` and
`files:` point at.

```
index.ts          public API + the AppNotify augmentation
notify.ts         app.notify — the fan-out
define.ts         defineNotification — a notification with no class
loader.ts         where *.notification.ts live, and the file-name-is-the-type rule
notification.ts   the Notification base class (the older shape; still supported)
builders.ts       message builders (an email body may also be a rendered template)
types.ts          Transport, Recipient, driver and payload types
plugin.ts         the Junction plugin — register / boot / shutdown
state.ts          the plugin's state on the app, under one Symbol.for key
errors.ts
drivers/
  inapp.ts        writes the record, publishes on app.channel()
  email.ts        renders lines → text/html, hands off to the mailer
examples/         wiring.ts + two notifications + Notification.mesa
tests/            harness.ts, fanout.test.ts, hook.test.ts, email-render.test.ts,
                  define.test.ts + fixtures/notifications/
```

---

## The two words

**Transport = delivery medium** (`inApp`, `email`, a Slack driver). **Channel =
junction's broadcast set**, which the in-app driver publishes on. Both are in
this package; `FJS-D06` ruled which is which. A `channels:` plugin option is
refused by name.

**A Recipient is not a User.** `id` is optional, and `inApp` refuses a recipient
without one rather than writing a row nothing can read (`FJS-096`). `email` is
the transport that needs no account.

---

## What bites here

- **Two packages once owned different message shapes** and email bodies were
  dropped silently — an empty email is the failure this package exists to make
  impossible. Any change to the message shape is a cross-package change: check
  `junction/src/mail` and conduit at the same time.
- **An email body may be a rendered template**, not just builder lines — the
  order confirmation in `example/` is a `.mesa` file in the *app*, which is what
  proved a consumer outside email-kit could import its components at all.
- **Fan-out runs on the queue, after the response.** A test that asserts
  immediately after the call asserts on nothing.
- **Formatting happens once.** `notify()` builds each transport's message during
  validation and delivers that one; a second call would run a template render
  twice.
- **"You see only your own" needs two accounts to demonstrate**; one signed-in
  user cannot show it. `example`'s drive signs in twice for that reason.
- **The type is a FILE NAME, and it is persisted data.** `defineNotification`
  states none; the loader stamps `OrderPaid.notification.ts` as `OrderPaid`,
  verbatim, and that string is written to `notifications.type` and read by the
  browser to choose a renderer. So renaming the file renames the type and the
  rows already written keep the old one — `type:` on the definition is the way
  to hold it still, and a divergence is warned about rather than accepted in
  silence, because a deliberate rename and a typo look identical from here.
- **A definition the loader never saw throws on first send.** It is the one
  failure mode this shape adds: an unnamed notification would otherwise write
  rows under `undefined`, which nothing can ever read back. Two ways in — a file
  outside the notifications directory, or an app whose entry is not what the
  probe assumed, which is every test runner and every drive that imports the app
  module. `example` therefore DECLARES `notifications:` rather than being probed
  for, exactly as it declares `autoload`.
- **`app.notifications` is READ-ONLY at runtime, not only in the types.**
  `Object.freeze` does nothing to a Map's internal slots — the first probe of
  this passed `Object.isFrozen` and then accepted a `set()` on the next line —
  so `set`, `delete` and `clear` are replaced with throws naming why. What a
  build can send is decided at boot by the files in its notifications
  directory; a type added after that makes the app disagree with its own
  snapshot and with every reader of it.
- **The registry has a committed artefact and needs one.** `junction
  notifications --app <module>` writes `notifications.snapshot.md`, and the
  `snapshots` CI phase rechecks it — a registry nothing commits is `FJS-327`'s
  shape. It is generated from JUNCTION, duck-typing `app.notifications` exactly
  as `junction jobs` duck-types `app.jobs`: this package must not become a
  dependency of that one.
- **`app.notify` reads three members and never asks which shape produced them** —
  `notificationType`, `via(recipient)`, `getMessageFor(transport, recipient)`.
  That is why the class and `defineNotification` coexist with no adapter, and
  why a plain object satisfying those three has always worked.

## Proving a change

`bun run test`, then `example`: `bun run verify:notify` — mail at a real server,
plus the in-app rows each caller can and cannot see.

For a change to `define.ts` or `loader.ts`, `verify:notify` alone is not enough:
it sends through an app whose notifications directory is DECLARED. `verify:pay`
and `verify:collect` import `api/src/app.ts` directly, which makes the drive
file the entry — the shape a probe gets wrong.
