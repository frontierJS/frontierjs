# Changes — @frontierjs/notifications

Newest first.

## 2026-09-05 — the model ships

`db/notification.lite`, exported as `./schema.lite` and packed by `files:`
([`FJS-910`](../../ISSUES.md#fjs-910)). The model this package writes to existed
only in the README: every app typed it out, and a column `drivers/inapp.ts`
started naming that an app's copy did not have was detectable by nothing.
`fli check`'s `package-model-drift` now RUNS against any app with this package
installed, instead of skipping with *no dependency ships a .lite file*, and
names a missing column with its line.

**Appended, not imported.** The gate does not vary between apps, which is the
usual argument for importing — but `userId`'s TYPE follows the app's own `User`
key (`String` under `@frontierjs/auth`, `Int` under a rowid identity), and a
column's type is the one thing `extend model` cannot change. An imported model
would be wrong for a whole class of apps with no way for them to fix it, and
wrong silently until the first insert.

The file carries the reasoning that used to be spread across a README section
and a reference model in litestone — why there is no `title`/`body`, no
`channel`/`sentAt`, no `dismissedAt`, and what to do about `contextType`, which
`fli check`'s `polymorphic-subject` asks every app to decide. That reference
model is deleted: it existed because this package shipped nothing, and two
copies of one model is the failure it was written to document.

## 2026-09-01 — a notification without a class, and the file names it

70 tests (was 54 — 16 new, 1 file, 4 fixtures). Typecheck clean.

**`defineNotification` is additive and nothing had to be adapted**, because the
class was never the boundary. `notify()` reads three members and asks nothing
else — `notificationType`, `via(recipient)`, `getMessageFor(transport,
recipient)` — so a plain object satisfying those has always worked. The class is
one implementation of that shape; this is a second, and both are supported.

```typescript
// api/src/notifications/OrderPaid.notification.ts
export default defineNotification<Order>({
  via:   () => ['inApp'],
  inApp: (order) => inApp().title('Order paid').body(order.reference),
})
```

**The type is the file name.** `notificationType` is written into
`notifications.type` and read by the browser to choose a renderer, so it is
persisted data — and the class derived it from `this.constructor.name` when
`static type` was absent, which makes renaming a class orphan every row already
written under the old name. The loader stamps it from
`<Type>.notification.ts`, verbatim, the rule `<name>.job.ts` already follows;
no case conversion is invented, so `OrderPaid.notification.ts` keeps the exact
string existing rows hold. `type:` survives for the case derivation cannot
serve — a file that must be renamed while the rows keep the old value — and a
divergence is reported, because a deliberate rename and a typo are
indistinguishable from the loader.

**A formatter may be async, which retires a whole shape.** `materialise()` now
awaits, so `email:` can render a template where it is read. Under the class,
`toEmail()` was synchronous, so `example`'s order confirmation needed a
`static async build()` behind a private constructor holding the rendered
subject, html and text as three fields — machinery that existed only to move an
await earlier than the value was wanted. Validation stays eager: every transport
is formatted and checked before any is delivered.

**`via` takes the payload rather than closing over it**, which is the whole
reason for that argument: a definition can be asked what it supports with no
payload in hand. `factory.type`, `factory.transports` and `app.notifications`
answer a preferences screen and a devtools panel without sending anything.

**Where they are found is PROBED, and a stated path is never probed around** —
`notifications/` then `src/notifications/` beside the entry, junction's own
`FJS-458` reasoning one package over. The failure this shape adds is real and is
loud: a definition the loader never saw throws on first send rather than writing
rows under `undefined`. It bites wherever the entry is not the app — a test
runner, and a drive that imports the app module — so `example` declares
`notifications:` exactly as it declares `autoload`.

**`app.notifications` is sealed, and it is committed.** The registry was a
plain `Map` behind a `ReadonlyMap` type — a probe of it passed `Object.isFrozen`
and accepted a `set()` on the next line, because freezing does nothing to a
Map's internal slots. `set`/`delete`/`clear` now throw naming why: what a build
can send is decided at boot, and a type added after that makes the app disagree
with its own snapshot. That snapshot is `notifications.snapshot.md`, written by
`junction notifications --app <module>` and rechecked by the `snapshots` CI
phase — a registry with nothing committed is `FJS-327`'s shape, and the failure
here is louder than a schedule's: a notification that stops being registered
throws at the moment somebody was owed a message. The generator lives in
JUNCTION and duck-types `app.notifications`, exactly as `junction jobs`
duck-types `app.jobs`; this package is not a dependency of that one and must not
become one. Proven by removing a notification and watching the check exit 1.

**The test harness had never run a boot phase.** It stopped at `configure()`,
so `register()` ran and nothing else; every fan-out test passed because drivers
land in `register`. Adding `await app._startForTest()` immediately failed:
the harness set `app.mail` by hand instead of configuring `mailerPlugin`, so
`requires: ['mailer']` — which this plugin declares and junction checks at
startup against presence *and* configure order — had nothing to find. An app
wired the way the harness wired one is refused at `start()`.

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

