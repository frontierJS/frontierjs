# Changes — example

Newest first. What this app built and what building it found; live state is `PROJECT_STATE.md`, framework defects are `../ISSUES.md`.

## 2026-08-06 — live updates, deferred work, outbound and notifications, static and islands, email

Moved out of `PROJECT_STATE.md`, which carries live state only.

### Live updates — done, and they were half-broken (`FJS-033`, closed 2026-08-06)

Phase 2 is complete. It was worth doing exactly as suspected: the seam was
half-connected in the same way the last two were.

**The drive is `web/test/verify-live.mjs`** (`bun run verify:live`, 12
assertions). A watcher tab, signed out, sitting on `/orders/` and touching
nothing; every change made from node over plain HTTP, so the watcher has no part
in it. It asserts two things separately — *did a frame arrive* (Junction's
publish path) and *did the table change without a reload* (Sierra's store
wiring). Both fail independently, which matters, because a page can look right
purely because it refetched.

**Result: broadcasts do reach a second client.** `orders created` and
`orders removed` cross to a stranger tab and the store applies them, unprompted.
The "maybe it is only seeing its own echo" worry is dead.

**But a custom ACTION announced nothing.** `pay` changed the row and published
no event at all — `callService` gated announcements on `AUTO_EVENT_MAP`, the
five CRUD writes, and an action is in none of them. The browser client had
listened for action events since it was written (`svc.on('*')` → upsert), so
only the server half was missing. **Fixed in junction**, ruled as `FJS-D21`; an
action now announces under its own name (`orders pay`) and a read-shaped action
opts out with `ctx.dispatch = false`.

**What hid it:** this app re-issued `find()` after every action. That made the
acting tab correct and every other tab stale in silence — the reason nothing
here caught it for as long as the app has existed, and the reason `verify-live`
asserts the frames and not just the pixels. Reverting the one-line junction fix
fails 4 of its 12 assertions.

Still open next door: *litestone `onEvent` has no Junction subscriber*
(`FJS-010`), which matters for any write that bypasses the service layer — a
Caravan job writing through `asSystem()` announces nothing to anyone.

### Deferred work — done (2026-08-06)

`ship` is the move plus one thing that must not happen inline. Booking a courier
is somebody else's HTTP call: slow, flaky, and worth retrying where the state
transition is not. So the action moves the order and answers; a
`@frontierjs/caravan` worker books the courier and writes the tracking code back
**through the orders service**, which is what makes it announce — the cell fills
in, seconds later, in a tab that has been idle since before the job was queued.

- `api/jobs/book-courier.job.ts` — autoloaded from `jobsDir`, queue
  `fulfillment`, `maxAttempts: 5`, retries at 1m / 5m / 30m
- `api/jobs/sweep-abandoned.job.ts` — the cron (`0 3 * * *`): cancel orders
  left `pending` past the horizon. The schedule is `cron` on its own
  `defineJob`, so autoloading the file is the whole of the wiring
- `api/src/core/gate.ts` declares `SYSTEM` and `app.ts` hands it to
  `createApp({ system })` — the principal the shop is when it acts on its own
  behalf. **Only the cron sweep reaches it.** Work a person asked for runs as
  that person: Caravan records who dispatched a job and Junction re-resolves
  them when it runs, so the courier booking is made with the standing of the
  staff member who pressed Ship, and the audit trail says so. Every job here
  used to pass `{ auth: { user: SYSTEM } }` by hand instead, which quietly gave
  a customer's checkout the authority of the shop (`FJS-093`)
- `bun run verify:jobs` — 8 assertions, **no browser**; the browser half is one
  assertion in `verify:live`, where the watcher tab already exists

**Three framework defects, one exposed gap.** Junction applied model defaults to
a PATCH, so patching one field on a shipped order answered `409 Cannot
transition order.status from 'shipped' to 'pending'`. Caravan's `unique` key
disagreed with its own schema in both directions — a raw
`UNIQUE constraint failed` out of an HTTP request one way, a courier silently
never booked the other. And Caravan's admin routes could retry and cancel a job
but not **start** one, so no cron handler anywhere could be tested without
waiting until 03:00. Details in each package's `CHANGES.md`.

### Outbound and notifications — done (2026-08-06)

Paying an order tells two people in two ways, and neither happens inside the
transition: the customer gets an email, the staff get a row in the app. Both go
on the queue (`api/jobs/announce-payment.job.ts`).

**The mailer is `IMail` over Conduit.** Junction's own `createResendMailer`
holds a URL and an API key in a closure and calls `fetch()` — outside the one
outbound boundary the framework otherwise insists on. `api/mailer.ts` implements
the same interface over `app.conduit.send()`, so the provider is a declared
TARGET: the credential is a `ref` resolved at send time (never in the registry,
a hook, or a log line), timeouts and retries and the breaker are the target's,
and a failure arrives as a typed `error.kind` instead of a thrown string.
Pointing it at the real api.resend.com is a change of `address` and `ref` in
`api/src/app.ts` and nothing else.

**The provider is `api/mail-sink.ts`** — a dev mail catcher on :8111 speaking
the shape a provider REST API speaks. A separate listener on purpose: an
in-process fake would prove the payload is built and nothing else. Over a real
socket, the credential really resolves, and `POST /fail-next` makes it answer
500 so the retry path is a test rather than a claim.

**Two audiences, two classes.** `OrderConfirmation` is email-only and addressed
to a customer, who is not a user — so its recipient carries an email and **no
id**, which is what makes `inApp` refuse it by name if anybody adds that
transport, rather than writing a row nobody could read (`FJS-096`).
`OrderPaid` is inApp-only and addressed to every staff user; the header bell
reads them back through the model's own `@@allow('read', userId == auth().id)`,
so *neither* the service nor the component says "only mine".

`bun run verify:notify` asserts 9 facts, every one of them either a message that
arrived at a server or a row a specific caller could see.

**Three framework defects, all of the same family: two shapes that never met.**
A Junction session reached the Data boundary with no `id`, so every row policy
in every app matched nothing (`FJS-097`). That masked the audit log's `actorId`
being declared `Int` while `@frontierjs/auth` issues uuids (`FJS-098`). And
`methods:` — the allow-list that makes a service append-only — was read by one
service factory and ignored by the other (`FJS-099`). Details in each package's
`CHANGES.md`.

### Static + islands — done (2026-08-06)

`bun run build:site` prerenders `site/src/routes/` into
`site/dist/catalog/index.html`: the whole catalog in the file, one
module script, and nothing else. `bun run verify:site` serves that directory
and drives it — **21 assertions, no sign-in, so it costs nothing against the
login limiter.**

Two islands, because one directive proves less than two:

- **`CatalogList` (`client:load`)** is the list itself. Its rows are a PROP,
  serialized into the marker at build time from what `load()` read through the
  app's own Litestone client — so a crawler sees every product, the page makes
  no request, and the search box works the moment the chunk runs. The drive
  asserts `apiCalls()` is empty for exactly that reason.
- **`LiveStock` (`client:visible`)** sits below the fold and asks the running API
  what can be sold today, through the Junction browser client. Its chunk is not
  fetched until it is scrolled to — asserted against resource timing, before and
  after — and its `$onMount` is what keeps it from running during the build.

The static-safety check (`FJS-081`) is what makes this publishable rather than
merely emitted: `Product` reads at level 0, the build says so in a table, and
pointing `load()` at a gated model fails the build.

**Three framework defects, and the shape is the usual one — correct from within,
broken from without.** Mesa compiled a `.mesa` route with frontmatter as
MARKDOWN, so a component call with props became escaped text in the prerendered
page while dev was fine (`FJS-106`). happy-dom's `cloneNode` invented
`formaction="http://localhost/"` on every server-rendered `<input>`
(`FJS-107`). And a prerendered page linked no stylesheet and carried no theme
class, so the public site was unstyled while the SPA built from the same source
was not (`FJS-108`).

One trap filed rather than fixed: `find({ limit: 100 })` puts `limit` in the
FILTER, and an unknown filter key answers `200` with an empty list rather than a
400 — so the island rendered "0 of 0 products" and reported nothing wrong
(`FJS-109`).

### The email realm — done (2026-08-06)

The confirmation email's body is `api/emails/order-confirmation.mesa`, rendered
by `@frontierjs/email-kit` through the same Mesa compiler the browser uses, at
`target: 'email'` — tables, inlined CSS, an Outlook conditional block. Not the
`mail()` line builder: that vocabulary is greeting / paragraph / button, which
is right for "your password was reset" and cannot express a receipt — and a
receipt is what an order confirmation is.

The subject lives in the template's `<script module>` as a **function of the
render data**, so what the email says and what it looks like are decided in one
file. `bun run email:preview` writes the HTML and the text somewhere you can
open them; `verify:notify` asserts the delivered body is a table document from
the kit and not the builder's `<div><p>`.

**Three defects, all the shape of `FJS-100` — correct from within, broken from
without.** A notification's email body could only be a list of lines, so the kit
and the notifications package could not be used together at all (`FJS-101`). A
`.mesa` import naming a package could not be resolved, which is exactly the
usage the kit's own README documents (`FJS-102`). And a `subject` export could
not depend on the render data, because the document wrapper called `.replace()`
on it (`FJS-103`).

**Every package in the repo is now exercised by this app.**

**Next**, in rough order of value:

1. ~~**`@frontierjs/ui`** — 63 components, never opened in a browser.~~ **28 of
   63 done, 2026-08-04.** Twelve carry the ordinary routes; the order detail,
   the products filter bar, `/settings/` and the ⌘K palette drive sixteen more,
   asserted by `bun run verify:ui`. **35 remain compile-only** — `DatePicker`
   (1200 lines, the biggest unknown), `Drawer`, `Popover`,
   `ConfirmationPopover`, `FileUpload`, `AlertProvider`, and the small display
   components. Two interactions the drives still do not reach: dragging a
   `Slider` handle, and `Popover` placement flipping. The way in is the same as
   last time — a screen that genuinely needs one, not a gallery.
2. ~~**caravan jobs**~~ **done 2026-08-06** — the courier booking and the
   nightly sweep.
3. ~~**conduit + notifications**~~ **done 2026-08-06** — the confirmation email
   through a declared target, and the staff bell.
4. ~~**email previews**~~ **done 2026-08-06** (`bun run email:preview`).
   ~~**`static`/islands**~~ **done 2026-08-06** — see below. An island in the
   BUILT output is proven interactive by `bun run verify:site`.
5. **The confirmation has never been opened in a real mail client.** The kit
   renders Outlook-safe markup and nobody has looked. `curl
   localhost:8111/outbox` is where to get one to forward to yourself.

Out of scope by design: jetty (a different container) and the VS Code extension.

---
