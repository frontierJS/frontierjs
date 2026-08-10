# notifications — package map

**A vertical slice, not a layer.** A Notification class fans out to an in-app
record, a WebSocket event and an email — `app.notify`. It sits on Junction,
Litestone, conduit and (for email bodies) mesa/email-kit. `bun run test` (bun).

---

## Layout

```
src/
  index.ts          public API
  notify.ts         app.notify — the fan-out
  notification.ts   the Notification base class
  builders.ts       message builders (an email body may also be a rendered template)
  types.ts          channel names and payload types
  plugin.ts         the Junction plugin
  errors.ts
  drivers/
    inapp.ts        writes the record
    email.ts        hands off to the mailer
  examples/         wiring.ts + two notifications + Notification.mesa
```

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
- **"You see only your own" needs two accounts to demonstrate**; one signed-in
  user cannot show it. `example`'s drive signs in twice for that reason.

## Proving a change

`bun run test`, then `example`: `bun run verify:notify` — mail at a real server,
plus the in-app rows each caller can and cannot see.
