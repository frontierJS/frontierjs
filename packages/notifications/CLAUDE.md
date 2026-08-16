# notifications — package map

**A vertical slice, not a layer.** A Notification class fans out to an in-app
record, a WebSocket event and an email — `app.notify`. It sits on Junction,
Litestone, conduit and (for email bodies) mesa/email-kit. `bun run test` (bun).

---

## Layout

No `src/` — the files are at the package root, which is what `exports` and
`files:` point at.

```
index.ts          public API + the AppNotify augmentation
notify.ts         app.notify — the fan-out
notification.ts   the Notification base class
builders.ts       message builders (an email body may also be a rendered template)
types.ts          Transport, Recipient, driver and payload types
plugin.ts         the Junction plugin — register / boot / shutdown
state.ts          the plugin's state on the app, under one Symbol.for key
errors.ts
drivers/
  inapp.ts        writes the record, publishes on app.channel()
  email.ts        renders lines → text/html, hands off to the mailer
examples/         wiring.ts + two notifications + Notification.mesa
tests/            harness.ts, fanout.test.ts, hook.test.ts, email-render.test.ts
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

## Proving a change

`bun run test`, then `example`: `bun run verify:notify` — mail at a real server,
plus the in-app rows each caller can and cannot see.
