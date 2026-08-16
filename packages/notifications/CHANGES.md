# Changes — @frontierjs/notifications

Newest first.

## 2026-08-16 — a delivery medium is a Transport, and a recipient is not a User

54 tests (was 38 — 16 new, 3 files). Typecheck clean.

Four open issues closed together, because they were four readings of one thing:
what this package addresses, and what it calls the thing it addresses it on.

**`channel` meant two things fourteen lines apart in `types.ts` (`FJS-285`).**
`FJS-D06` ruled Channel to be junction's broadcast set — wire-level, junction
owns it, the harder of the two to move — and a delivery medium to be a
**Transport**. So `Channel`/`BuiltInChannel`/`ChannelError` are `Transport`/
`BuiltInTransport`/`TransportError`, `NotificationDriver.channel` is
`.transport`, the plugin option `channels:` is `transports:`, and
`NotificationChannelNotImplementedError` is
`NotificationTransportNotImplementedError`. `app.channel(...)` in the in-app
driver is untouched: that one is a broadcast channel and always was. The old
option name is refused by name rather than ignored — an unknown key would
configure nothing and surface as a missing driver at the first send.

**`notify()` addressed a `User` and a customer is not one (`FJS-096`).** The
unit of address is now `Recipient`, whose `id` is **optional**. A shop customer
had to be passed as a `User` with an invented id (`customer:42`) — right for
email, and for `inApp` a row keyed by an id nothing will ever query, written
with no error. Each transport now states what it needs, and `notify()` checks it
eagerly: `inApp` refuses an id-less recipient by name, `email` refuses one with
no address anywhere. A registered driver is exempt — only it knows what it
addresses by. The near-miss is named too: a recipient carrying `userId` is
reported as a probable `SessionContext`, with the one-line fix in the message.

**`plugin.ts` implemented only `register()` (`FJS-049`).** It now has `boot()`,
which fails startup when the email transport is configured and `app.mail` is not
set — `requires: ['mailer']` proves the plugin is configured, not that it
installed anything — and `shutdown()`, which awaits each driver's own optional
`shutdown()`. One driver that cannot close is logged and the rest still run.
`app._db` / `app._drivers` are gone: one `Symbol.for` key, so the state does not
enumerate onto the app and `notify()` on an unconfigured app names the missing
plugin instead of throwing about `undefined`.

**`ctx.app.notify` from a service hook was never exercised (`FJS-050`).**
`tests/hook.test.ts` is a real service with a real after hook, asserting the row
it writes field by field — the shape a UI reads — plus the WS frame that follows
it and the throw a broken notification surfaces through the hook.

**The package's own runnable example could not run (`FJS-072`).**
`examples/Notification.mesa` imported `resource`, `derived` and `get` from
`@frontierjs/sierra`, which exports none of the three. It is now the resource
file `example/` actually runs: `createResource` from `@frontierjs/sierra/junction`
in a `<script module>` with no markup (Invariant 18). `examples/wiring.ts` had
the same class of error in prose — `ctx.params` (which exists nowhere in
Junction), `db.asSystem().users` (the accessor is `db.user`), and `ctx.user`
handed to `notify()` as though a `SessionContext` were a recipient.

Also: each `to*()` is called **once** per `notify()`. Validation used to format
the message to check the method existed, throw it away, and format it again to
deliver — so a formatter that rendered a template did it twice, and the message
that was validated was never the one sent.


## 2026-08-16 — `app.provide` is `app.claim` (`FJS-D06`)

38/38 tests pass. Typecheck clean.

Mechanical: the plugin claims `app.notify` through the renamed verb, and
`NotificationApp` names it. Still guarded by a presence check with a plain
assignment behind it.

`app._db` and `app._drivers` are untouched and still private-field writes onto
Junction's `App` — the metrics reach-in of that species became a declared seam
in this ruling; these two did not.


## 2026-08-06 — an email body can come from a template

38 tests (was 33 — 5 new). Typecheck clean.

`MailMessage` was `{ subject, lines, to }` and the email driver rendered `lines`
and nothing else. `lines` is a deliberately small authoring vocabulary —
greeting, paragraph, button — and it is the right one for "your password was
reset". It cannot express a receipt with a table of facts, which is what a
transactional email usually is, and it could not use `@frontierjs/email-kit` at
all: that renders a `.mesa` template to Outlook-safe table HTML and there was
nowhere in a message to put the result. **Two packages in one repo that could
not be used together.**

```ts
mail().subject(s).html(renderedHtml).text(renderedText).build()
```

The driver prefers a rendered body **per field**, not per message, because the
two halves have different best answers: a table receipt's HTML wants the
template, and its plain-text alternative is three lines the builder already
writes well. So a template can supply the HTML and leave the text to `lines`.

An unset body stays absent rather than becoming `''` — the driver's rule is
`message.html ?? renderHtml(lines)`, and an empty string would win that coalesce
and deliver a blank email. Pinned.

Driven by `example/`: `api/emails/order-confirmation.mesa` is the body of the
order confirmation, and `bun run verify:notify` asserts the delivered message is
a table document from the kit and not the builder's `<div><p>`.

