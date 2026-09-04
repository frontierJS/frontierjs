# The kitchen sink

One shop. One `db/schema.lite`. As much of FrontierJS as a single coherent app
can carry — and a place to break things without a real domain fighting back.

This is deliberately **not** a gallery of feature demos. The framework's claim is
one mental model across three realms, and a tabbed showcase of disconnected
snippets would prove the opposite. Every feature here is earned by the domain:
orders have states, so there is a state machine; customers have staff-only
notes, so there is field-level access; refunds need authority, so there is a
gate ladder.

```bash
fli dev         # both, after checking the ports and the database
```

Open <http://localhost:8010> and sign in from the header. `bun run stop` when
you are done; `bun run dev` is the same pair without the preflights, and the two
halves still run on their own:

```bash
bun run api     # terminal 1 — Junction + Litestone on :8110
                # DEVTOOLS=1 bun run api  adds the console on :8503
bun run web     # terminal 2 — Sierra + Vite on :8010
```

**Two processes — both are required.** Vite serves the UI and proxies `/api` and
`/ws` to the API; with the API down every one of those is a 502 and the app says
so rather than rendering plausible empty tables.

**Start them through `fli dev` when you can.** A port that is already answering
is the failure worth catching: `bun --watch` prints EADDRINUSE and keeps
watching, so the process stays alive and nothing that waits on it ever returns,
and a stale API still holds the old database open — including one `bun run
reset` has already deleted, so the reset appears to do nothing while every
request is answered by the ghost.

| | |
| --- | --- |
| `fli dev` | both realms, after the port and database preflights |
| `bun run dev` | both realms, no preflight |
| `bun run stop` | stop whichever of them is running |
| `bun run api` | the API realm |
| `bun run web` | the UI realm |
| `bun run verify` | drive the app in headless Chrome and assert what happened (both servers must be up) |
| `bun run verify:ui` | drive the kit's behavioural components — tabs, menus, a dialog, a palette — the preferences that change what every other screen shows, and a refund a person performs by clicking — 35 assertions |
| `bun run verify:live` | open a watcher tab that never acts, change rows from outside it, and assert what crossed the socket — 14 assertions |
| `bun run verify:jobs` | the deferred-work realm over HTTP, no browser — the courier booked off the request, the outbox, the abandoned-basket sweep, and the RETENTION pass the schema declares, which plants a row older than the window and asks whether the job can tell it from today's — 12 assertions |
| `bun run verify:notify` | the outbound boundary: mail at a real server, and who can see what — 9 assertions |
| `bun run verify:stripe` | a REAL vendor over the same boundary: form-encoded bodies, a bearer key, a pinned API version and Stripe's own `t=…,v1=…` webhook scheme. Its negative control is the feature — the same connector against a target with `encoding` removed is refused by name. Plus a decline that is a domain answer rather than a retry, a major-unit amount refused before anything reaches the wire, and a webhook secret ROTATION, where two signatures ride one header. Starts and stops its own API and Stripe on the test ports — 12 assertions |
| `bun run verify:pay` | money: an HMAC-signed conduit target the provider VERIFIES, and a signed webhook that drives the order state machine with no session anywhere — plus the four separate ways a webhook is refused, and the fifth that is a redelivery. Then refunds: the only @gate(5) move in the app, a partial that must not move the order, an idempotency key on the one call where a retry costs real money, and the shelf coming back out of the ledger — 22 assertions |
| `bun run verify:catalogue` | the catalogue end to end — a `File` column's bytes reaching an `<img>` that decoded, the variant grid, an aggregated price range, and **a photograph somebody uploads**: chosen in a real file input, submitted through a form that names no field, refused for a stranger and refused for a type `@accept` does not admit — 35 assertions. Starts and stops both servers itself |
| `bun run verify:money` | **what a basket costs, and why**: `subtotal − discount + shipping + tax = total`, with one owner for the arithmetic and every screen rendering it rather than re-deriving it. Its two headline assertions exist nowhere else — a code that takes a basket back under the free-delivery threshold, so applying a discount puts the shipping charge back; and two checkouts of a one-redemption code in flight at once. It also proves the five `@@check` constraints — the rules that read a SECOND column of the same row, so none of them can be a field validator — at both boundaries, which for three of the five is only the Data one, because the columns they read are `@system` and no request can reach them. **Since the ledger landed it reads the same sale twice** — off the order and out of the BOOKS — and the five accounts reconstruct the receipt rather than merely agreeing with it, because the identity rearranged IS debits equal credits. Two refusals nowhere else: staff may read the books and neither restate nor delete an entry — 108 assertions. Starts and stops both servers itself |
| `bun run verify:cart` | a **stranger** fills a basket and buys: a token-scoped row policy, a claim on a caller with no session, a per-call header crossing a WebSocket frame, and the itemised order the basket becomes — 32 assertions. Starts and stops both servers itself |
| `bun run dev:widgets` | the widgets surface live, on :8210 — how a widget is WRITTEN |
| `bun run build:widgets` | → `widgets/dist/embeds/BuyButton.js`, one self-contained script |
| `bun run serve:widgets` | the widget ORIGIN on :8310, with the CORS and cache headers it deploys with |
| `bun run verify:widget` | the buy button on a page the shop does not own: four origins, a real preflight, shadow isolation against hostile CSS, the one-time code that hands a basket between them, and what a shopper is told when they arrive with a spent one — 37 assertions. Starts and stops everything itself |
| `bun run verify:account` | a SHOPPER, not staff: the ledger answering 401 to a stranger and one order to the person who asks for all of them, a sign-in island on the static storefront, a session on the storefront's own origin, and a brand-new account that can see none of the shop — 18 assertions. Needs `build:site` |
| `bun run build:extension` | → `extension/dist/chrome/` — a manifest, a service worker, a popup and a content script |
| `bun run verify:extension` | the shop in a browser toolbar: an extension loaded into a throwaway profile, a harbor holding the only connection, a Mesa popup signing in through `/auth/login`, an order paid elsewhere arriving with nothing refreshing, a transition run from the toolbar, and a content script on the shop's own prerendered storefront — 13 assertions. Needs `build:site`; starts everything else itself |
| `bun run verify:tenants` | many shops: a second one created for the run, its own catalogue, its own staff, and a token from one that is not a session at the other, and the fourth thing a shop is — its own NAME and from-address, which are not rows — 26 assertions. The API must be up |
| `bun run verify:stock` | the shelf: a hold moving AVAILABLE and not ON HAND, a second shopper refused by name, a shopper's own hold not counting against them, an expiry that is in the read rather than in a cron, and the ledger every stock write is paired with — 41 assertions. Starts and stops both servers itself |
| `bun run build:site` | the PUBLIC site: prerender `site/src/routes/` to `site/dist/` |
| `bun run verify:site` | serve that build and prove its islands come alive in a real browser, including a price MOVED in the database after the build and a search that asks the shop — 39 assertions |
| `bun run email:preview` | render the transactional emails to files you can open |
| `bun run build` | production build to `web/dist/client/` |
| `bun run verify:build` | build, then drive **the built app** with the same 37 assertions (needs `bun run api`) |
| `bun run preview` | serve `web/dist/client/` on :8011 with `/api` `/ws` proxied — `vite preview` carries no proxy |
| `bun run db:seed` | put the demo catalogue, customers, orders and users in. **Run this first** |
| `bun run reset` | delete the database and seed it again |

**Seeding is a step, not something a boot does for you.** It used to be awaited
at module scope in `app.ts`, which meant every import of the app wrote to the
database — including `junction surface`, whose job is to describe the app
without acting on it. A second run adds only what is missing, so repeating it is
safe, and an API started against an empty database says so rather than serving
empty lists that read as a broken query.

Sign in as **`sam@shop.test`** (level 4) or **`alex@shop.test`** (level 5), both
with password `correct-horse-battery`. The buttons in the header do it for you.

---

## Layout

The standard FrontierJS layout at full size — one directory per realm, the
schema above both of its consumers, configuration in `config/`:

```
example/
├── db/                         ← Data realm — Litestone
│   ├── schema.lite             ← the seed. Read by api/ and by web/'s build
│   └── seed.ts                 ← `bun run db:seed`. A script; nothing imports it
├── api/                        ← API realm — Junction + auth
│   ├── index.ts                ← the entry. Starts the app and assembles nothing
│   ├── config/                 ← junction.config.js, incl. where the services are
│   └── src/
│       ├── app.ts              ← the construction site. Exported unstarted
│       ├── inventory.ts        ← the ONE owner of the shelf: holds, availability, the ledger
│       ├── core/
│       │   ├── db.ts           ← the client, the gate plugin, autoMigrate
│       │   ├── gate.ts         ← the ONE place a session becomes a number
│       │   ├── cart-claim.ts   ← a header → a claim a stranger holds
│       │   ├── settle.ts       ← the ONE owner of "this order has been paid for"
│       │   ├── psp.ts          ← the payment provider: the target out, the verifier in
│       │   └── psp-sink.ts     ← that provider, standing in for a real one. :8112
│       └── services/
└── web/                        ← UI realm — Sierra + Mesa. The Vite root
    ├── index.html
    ├── config/                 ← vite.config.js lives HERE, not at the root
    ├── public/
    ├── test/
    │   └── verify.mjs          ← drives a real browser; see "Verified" below
    └── src/
        ├── main.js  App.mesa  session.js
            ├── resources/           ← .mesa files (invariant 18): data in <script module>, markup is the default form
        └── routes/
├── widgets/                    ← a THIRD surface — embeddable scripts. Its own
│   ├── config/                   Vite root, its own host pages, its own release
│   ├── src/Embeds/BuyButton.mesa  one .mesa → one self-contained IIFE
│   ├── test/                     a host page per widget, with hostile CSS
│   └── deploy/                   serve.js + Dockerfile — the widget origin
└── extension/                  ← a FIFTH surface — a browser extension. Not a
    ├── config/jetty.config.js    Vite config at all: the build emits a MANIFEST,
    │                             and `--browser=both` makes one source two builds
    ├── src/harbor/index.js       the service worker — the only connection here
    ├── src/dock/App.mesa         the popup
    ├── src/islands/              content scripts, FLAT — a subfolder throws
    ├── test/verify.mjs           loads it into a browser profile
    └── deploy/                   two web stores, two review queues
```

Nothing points the UI at the schema: `web/`'s Vite root is one level below the
app root, so Sierra's auto-detection finds `../db/schema.lite` — the same file
`api/src/core/db.ts` reads. The build prints which one it found.

## Read in this order

| file | what it seeds |
| --- | --- |
| [`db/schema.lite`](db/schema.lite) | everything below |
| [`api/src/core/gate.ts`](api/src/core/gate.ts) | the role → level mapping, and why it cannot be skipped |
| [`api/src/core/db.ts`](api/src/core/db.ts) | how auth's models join the schema without a second copy |
| [`api/src/services/orders.service.ts`](api/src/services/orders.service.ts) | 3 lines. CRUD, 401s, 403s and 400s are all derived |
| [`api/src/providers/psp/index.ts`](api/src/providers/psp/index.ts) | both directions of one third party, and why they are two credentials |
| [`api/src/services/payments.service.ts`](api/src/services/payments.service.ts) | what a webhook may act on, and why the claim and the effect are one transaction |
| [`web/src/resources/Order.mesa`](web/src/resources/Order.mesa) | one Resource per file, named for its noun (Invariant 19) — and the model's default form, with no field list in it |
| [`web/src/routes/orders/create.mesa`](web/src/routes/orders/create.mesa) | a create page with no form on it |

---

## What to look at

**The form is generated, and it is not on the page.** It is the markup half of
[`Order.mesa`](web/src/resources/Order.mesa) — a Resource is the model's whole
client-side surface, its default form included (Invariant 18) — so
[`orders/create.mesa`](web/src/routes/orders/create.mesa) is `<Order />` and the
three things a screen decides: the button's wording, where Cancel goes, where a
save lands. An edit page renders the same tag with a different `method`, which is
the reason the form is written where it is. Neither file contains a field name, a
type, an enum value, a required flag or a mention of the customers service.
Rendered, it produces exactly seven controls:

```html
<input  type="text"   maxlength="20">      <!-- @length(3, 20)        -->
<select>pending paid shipped refunded cancelled  <!-- enum, via $ref   -->
<input  type="number" min="0" step="any">  <!-- @gte(0)               -->
<input  type="text">                       <!-- note String?          -->
<select>Acme Corp Globex                   <!-- x-relations → Customer -->
```

The status `<select>` is the interesting one: Litestone emits an enum field as
`{"$ref":"#/$defs/OrderStatus"}`, so those five values only exist if the browser
resolves that reference against the same definition table the build shipped. The
customer `<select>` is the other one — `customerId` is a plain integer on the
wire, and the only reason the UI knows it is a reference is `x-relations`.

**The preferences on /settings/ are edited twice, over one object.**
[`settings/index.mesa`](web/src/routes/settings/index.mesa) is the only screen
here with nothing in `db/schema.lite` behind it — a preference is a fact about
this browser — which is exactly the shape `<Json editable>` is for: no schema
means no field list to generate controls from, so the editor is the document's
own structure. The tree and the form controls above it are two editors of ONE
object. Change *rows per page* with the spinner and the tree follows; change it
in the tree and the spinner follows, because `onchange` writes back through the
same `adopt()` the file restore uses. Add a key the screen does not own and it
is dropped **out loud** — the document is rebuilt from five fields on the next
render, so an unowned key would otherwise vanish between two frames with nothing
to distinguish it from a control that did not work. `verify:ui` asserts both.

**A column appears when you sign in as admin.** [`/customers/`](web/src/routes/customers/index.mesa)
renders a `Notes` header only when the field is present in the response, and
`Customer.notes` carries `@allow('read', auth().role == 'admin')`. Signed out or
signed in as `sam`, the field is **not in the response at all** — not blanked,
absent. No service code says so.

**The delete button is disabled until you are an admin.** `@@gate("0.4.4.5")`
wants level 5 to delete; `orders.can('delete', session.level)` asks before
rendering. That is an affordance, not a boundary — the server refuses either
way, and you can watch it: as `sam`, `DELETE /api/orders/1` is a 403.

**Type a lower-case reference.** `reference String @upper` means `ord-cdp-1`
stores as `ORD-CDP-1`. Leave `note` empty and it stores `null`, not `''` — that
is `blankToNull` on the resource, and it is what keeps a second blank-`barcode`
product from violating a UNIQUE constraint nobody wrote.

**The wording is written once, in the schema.** `Order.customerId` carries
`@label("Customer")` and `@required("Please select a customer from the list")`,
and `reference` carries its own sentence on `@length`. That one string is what
the form shows, what the client-side check says before the request, and what
the API answers with — verified in all three. Before it, the form said
`customerId is required` under a label reading *customer*, because a message
authored in `.lite` never left the Data boundary and required-ness had no
message slot at all.

**Validation answers while you type — but only ever to say "fixed".**
The order form ([`Order.mesa`](web/src/resources/Order.mesa)) follows one rule: *on
input an error may only be removed, never added*. Type two characters into
`reference` and nothing complains. Leave the field and `@length(3, 20)` speaks
up. Type the third character and it goes quiet on that keystroke — no blur, no
submit. Tabbing through a field you never typed in stays silent; submitting is
what reveals those. The alternative — `on:input` runs `validate()` — lights up
"status is required" on fields you have not reached yet, because `validate()`
judges the whole record.

**The Moves column is the state machine.** `Order` declares `@@transitions`,
and the buttons come from reading it back — there is no list of moves in
[orders/index.mesa](web/src/routes/orders/index.mesa). A `pending` order offers
*pay* and *cancel*; paying it re-grades the row to *ship*, *refund*, *cancel*;
a `shipped` order offers nothing, because nothing leaves `shipped`.

`refund` carries `@gate(5)`. Signed in as `sam` it renders disabled and as
`alex` it does not — a **per-move** gate, which no model-level `@@gate` can
express. Everything is disabled signed out, because a transition is an update
and the model wants level 4 for that.

Each button is a custom service method: `POST /api/orders/{id}` with an
`X-Service-Method: pay` header. Nothing in the app registers that route, and
[orders.service.ts](api/src/services/orders.service.ts) reduces every move to
`db.order.transition(id, name)` — which states a move is legal from, what it
moves to and what level it needs all live in the schema.

**The Tracking cell is filled in by a job, in a tab you are not using.** Press
*ship* and it says *booking…*: the order has moved and the courier has not been
called. A `@frontierjs/caravan` worker calls it off the request and patches the
result back **through the orders service**, so the write announces on the same
channel every other change uses. Open two tabs on `/orders/`, press *ship* in
one, and watch both fill in. That the job goes through the service rather than
`db.asSystem().order.update(…)` is the whole point: a write at the Data boundary
announces nothing (`FJS-010`) and every open tab keeps the stale row.

**Paying an order records its announcement rather than dispatching it.** `pay`
runs inside a transaction and calls `ctx.enqueue(announcePayment, …)`, which
writes an outbox row in the app's own database as part of the move; the relay
(`app.configure(outbox())`) hands it to the queue afterwards. A plain dispatch is
a second thing that happens after the move commits, so a process dying in
between leaves an order that is paid and a customer nobody ever told — with no
row anywhere saying the announcement was owed (`FJS-D35`). The `unique` key this
used to carry is gone and nothing replaced it: the state machine already refuses
paying a paid order, and what a key on the job could never cover is a job that
was never queued.

**Paying an order sends an email, and the email is checked.** The customer's
confirmation goes out through `@frontierjs/conduit` to a declared target, and
that target is [`api/src/providers/mail/sink.ts`](api/src/providers/mail/sink.ts) — a dev mail catcher on
:8111 speaking the shape a provider REST API speaks. A separate listener on
purpose: an in-process fake would prove the payload is built and nothing else,
while over a real socket the credential really resolves (the sink 401s without
it) and `POST /fail-next` makes the provider fail so the retry path is a test
rather than a claim. Read what the shop has sent — **open <http://localhost:8111/>
for the inbox**, which is the half a JSON array is not: an email is the one thing
in an app nobody looks at, rendered on a server and read in a client you do not
control, and a subject line fished out with `curl | jq` says nothing about what a
person opens. The body renders in an `<iframe srcdoc>`, so an email's own
`<style>` — written for a mail client and scoped to nothing — cannot restyle the
inbox around it.

```bash
open http://localhost:8111/           # the inbox
curl localhost:8111/outbox            # the same thing as JSON, what the drives read
curl localhost:8111/outbox/<id>/html  # one message as a document
curl -X DELETE localhost:8111/outbox  # empty it
```

**And there is a second provider, which is the point of having a first.**
[`api/src/providers/stripe/index.ts`](api/src/providers/stripe/index.ts) is a Stripe connection over
the same boundary, beside `psp.ts` rather than instead of it. `psp.ts` speaks
this project's own conventions and was designed alongside conduit, so it can
agree with conduit by accident; Stripe disagrees in every way a connector can —
`application/x-www-form-urlencoded` bodies against JSON, a bearer key against an
HMAC, a pinned `Stripe-Version`, and a webhook signed as `"<timestamp>.<raw
body>"` under `Stripe-Signature` rather than as this project's canonical string.
Two providers against one boundary is the only thing that shows whether the
boundary is generic, which no single connector can (`FJS-D153`).

It is in the app and not in `@frontierjs/conduit` deliberately, and not in
`@frontierjs/conduit-stripe` yet: conduit owns the mechanism, a connector owns
the vendor, and one instance cannot design the connector interface. It moves
when a second exists to argue with it.

Building it is what found `FJS-556` — conduit `JSON.stringify`d every body with
no way past it, so it could not speak to a form-encoded API at all, while
`Content-Type` was overridable. A caller could ask for `form` and still send
JSON.

```bash
bun run verify:stripe        # 12 assertions, starts and stops everything itself
curl localhost:8114/intents  # what the dev Stripe holds
curl localhost:8114/events   # what it has sent the shop, and what the shop answered
```

The mailer is [`api/src/providers/mail/mailer.ts`](api/src/providers/mail/mailer.ts): Junction's `IMail`, implemented
over `app.conduit.send()`. Pointing it at the real api.resend.com is a change of
`address` and `ref` in [`api/src/app.ts`](api/src/app.ts) and nothing else — a target
holds a credential *reference*, resolved at send time, never a key in a closure.

**The email body is a `.mesa` file.** [`api/src/emails/order-confirmation.mesa`](api/src/emails/order-confirmation.mesa)
is rendered by `@frontierjs/email-kit` through the same Mesa compiler the
browser uses, at `target: 'email'` — tables, inlined CSS, an Outlook conditional
block. Not the `mail()` line builder: that vocabulary is greeting / paragraph /
button, which is right for "your password was reset" and cannot express a
receipt. The subject is a **function of the render data** in the template's
`<script module>`, so the wording and the layout are decided in one file.

```bash
bun run email:preview     # writes the HTML and the text where you can open them
```

**The staff hear about it in the app.** Signed in, the header grows a bell with
a count. Those rows come back through the model's own
`@@allow('read', userId == auth().id)` — sign in as `sam` and you see sam's
copy, not alex's, and neither the service nor the component contains a line
saying so. A background job has no session, so `api/src/core/gate.ts` declares `SYSTEM`:
work with no caller still has a principal, graded in the one place every
principal is graded.

**A basket holds stock, and the hold expires on its own.** Add something to a
basket and `/inventory/` shows the shelf split into three:
`ProductVariant.stock` is ON HAND, the holds against it are HELD, and AVAILABLE
is the difference. Only the first is a column, and the third is what every buy
button in the shop is graded against.

The two obvious designs are both wrong, in opposite directions. Decrementing
`stock` on add is unrecoverable — the thing that would put it back is a person
who has closed the tab. Leaving it until checkout oversells the last one: two
shoppers both see `1 left`, both add it, and the second finds out at the till.
A hold is the third answer, and it is a row with a clock on it so nothing has to
come back and undo it.

Three things fall out of that, and each is a way to break this silently:

- **A hold is a row about the SHELF, not a column on the line.** `CartLine`
  already names a variant and a quantity, and an `heldUntil` column there would
  have been three characters of schema. It is wrong because the line is scoped
  by the shopper's own token, so summing holds from their client answers a sum
  over their own basket — always plausible, usually zero, never the number
  asked for.
- **A shopper's own hold must not count against them.** Holding 2 of the last 5
  and raising the line to 3 is a legal request, and summing every hold refuses
  it — which looks exactly like a stock shortage and is not one.
- **The expiry is in the READ.** Every availability sum filters on
  `expiresAt > now`, so a hold is dead the moment it passes. `release-holds`
  deletes the rows and is housekeeping: the queue can be down for a week and
  every price and every button is still right, where a sweep that "releases"
  stock by putting a number back means a queue outage quietly stops the shop
  selling.

`api/inventory.ts` is the one module that reads any of the three or writes the
first, and every write to `stock` is paired with an `InventoryMovement` in the
same transaction — signed, with both ends of the shelf on the row. The ledger is
`@@gate("5.5.9.9")`: an administrator reads it and files a receipt, and update
and delete are **9**, which nothing passes including `asSystem()`. That is what
append-only is spelled with; a comment saying the same thing is a comment.

There is no authorisation code in `inventory.service.ts`. `receive` and `adjust`
write the movement through the caller's own client, so the model's create gate
is what grades them — and the one movement written any other way is `sold`,
which a shopper at level 0 causes and the shop records for itself through
`asSystem()`.

**A buy button on somebody else's blog.** `widgets/` is a third surface beside
`api/` and `web/`, and it earns one because every answer differs from the SPA's:
its own Vite root, its own host pages, its own static release on the cadence of
the pages that embed it. One `.mesa` becomes one self-contained IIFE with its
runtime and its CSS inside it, mounted in a shadow root by a custom element. A
host page writes one tag and one script:

```html
<fjs-buy-button data-sku="FJS-TEE-NVY-M"></fjs-buy-button>
<script defer src="https://widgets.example.test/BuyButton.js"></script>
```

Three things here are not true anywhere else in this app:

- **CORS is real.** The SPA is served by Vite, which proxies `/api`, so every
  call it makes is same-origin and no preflight ever happens. A widget is a
  guest: it needs `x-cart-token` past a preflight, which works because the app
  declares that header once under `http.callHeaders` and both the CORS
  allow-list and the WebSocket frame merge read it. And `origins: ['*']` is the
  right answer, because **CORS is not an access control** — it stops a page
  reading a response the browser attached credentials to, and this app attaches
  none.
- **One call, not three.** An embed's budget is round trips on a page it does
  not own, so `product-variants.embed` answers the product, the price, the
  photograph and what may be SOLD (available, not on hand) in one request,
  addressed by the SKU a merchant pastes.
- **The basket cannot be shared, so it is handed over.** `localStorage` is per
  origin: a basket started on somebody's blog is invisible to the shop's own
  site and no amount of wanting changes that. Sending the shopper to checkout is
  handing a capability across an origin — and the token must not be what
  travels, because a URL goes into history, into `Referer` and into every log on
  the way. So `carts.handoff` mints a **one-time code**, the link carries it in
  the FRAGMENT (never sent to a server), and `carts.redeem` exchanges it for the
  token and clears it in the same transaction that read it. Worth one basket,
  for two minutes, once.

`bun run verify:widget` stands up four origins — the API, the shop, the widget
origin and a host page — and proves all of it in a real browser, including that
the host page's `button { background: red !important }` does not reach in and
that the widget's own font does not come from the host's `<body>`.

**The nightly sweep is run rather than waited for.** `sweep-abandoned` cancels
orders left `pending` past a horizon, at 03:00. A cron you can only observe
through `nextRuns()` is a schedule, not a behaviour:

```bash
curl -X POST localhost:8110/jobs/run/sweep-abandoned -d '{"days":0}'
```

That route did not exist until this app needed it.

---

## Verified

**Every drive checks the process it is about to test is the one this tree
describes.** `web/test/lib/preflight.mjs` asks reachability and freshness
together — `/health`'s `uptime` against the newest mtime under `api/` and `db/`
— because a port that answers is not evidence the right process is on it:
`bun run api` spawns a child, so killing the wrapper leaves the app holding its
ports and the next start exits `EADDRINUSE` into a log nobody reads. A drive
run against that process reports on code that is not in the tree, and it is
wrong in both directions (`FJS-740`).

Nothing in this file is asserted from reading the source. `bun run verify`
drives the app in headless Chrome — navigating, signing in, typing into fields
and leaving them, filling the form, submitting, deleting, signing out — and
asserts what a real browser ended up showing. The sibling drives add the rest —
the kit's behavioural components, declared value sets, real-time from a second
client, deferred work, the outbound boundary, the prerendered public site, the
catalogue's photographs, a stranger buying something, the shelf that stranger
bought it off, a buy button on a page the shop does not own, and the recurring
half: a cycle renewing on a moved clock, a change mid-cycle asserted as sums,
and a provider's answer driving a state machine. Last run:

```
all 56 assertions passed        (dev AND the production build, 0 console errors)
all 35 assertions passed        bun run verify:ui
all 14 assertions passed        bun run verify:values
all 17 assertions passed        bun run verify:live
all 12 assertions passed        bun run verify:jobs
all  9 assertions passed        bun run verify:notify
all 22 assertions passed        bun run verify:pay
all 45 assertions passed        bun run verify:site      (the built static site, and the price list)
    35 passed, 0 failed         bun run verify:catalogue
    32 passed, 0 failed         bun run verify:cart
   108 passed, 0 failed         bun run verify:money    (the discount, the delivery, the tax and the books)
    41 passed, 0 failed         bun run verify:stock
    37 passed, 0 failed         bun run verify:widget
    26 passed, 0 failed         bun run verify:tenants   (a second shop, its own file)
    13 passed, 0 failed         bun run verify:extension (loaded into a browser profile)
    27 passed, 0 failed         bun run verify:account   (a shopper, on the static site)
    38 passed, 0 failed         bun run verify:revisions (taking a row back, and two people editing one)
all 23 assertions passed        bun run verify:billing   (a cycle crossed on a clock the drive stands at)
all 21 assertions passed        bun run verify:proration (a change mid-cycle, asserted as sums)
all 58 assertions passed        bun run verify:employment (what was true on the 12th, and the bands)
all 41 assertions passed        bun run verify:payrun     (one period, everybody, two documents)
all 33 assertions passed        bun run verify:batch      (interrupted, resumed, nobody paid twice)
all 56 assertions passed        bun run verify:retro      (a backdated raise, three closed periods)
all 62 assertions passed        bun run verify:payroll    (the console — one audience, in a browser)
all 28 assertions passed        bun run verify:collect   (one call out, one signed event back — and the whole cycle through the queue)

904 assertions, twenty-six drives, against one FLEET — twenty-five of them against the flagship shop, and one that makes a second.
```

`verify:site` is the one with no application in it. `site/dist/catalog/
index.html` is a file with the whole catalogue already in it and one module
script; the drive asserts that a crawler sees every product, that nothing gated
is in the file, that typing in the search box filters rows **after** the island
mounts, that the below-the-fold island's chunk is not fetched until it is
scrolled to, and that it then asks the running API what can be sold today.

`verify:live` is the one that watches a client which did **not** make the
change — a signed-out tab on `/orders/`, while node changes rows over HTTP:

```
watcher.sawCreate        appeared: true          ← no reload, no session
watcher.sawPay           status: paid            ← a custom ACTION, the case that was broken
watcher.movesRegraded    ship refund cancel      ← the record was replaced, not a cell patched
watcher.sawDelete        left: true
watcher.events           orders created · orders pay · orders removed
```

Including, in the browser:

```
customers.headersAnon    ['Name', 'Email']              ← notes absent
customers.headersAdmin   ['Name', 'Email', 'Notes']     ← same page, same code
form.controls            reference:text status:select total:number note:text customer:select
form.statusOptions       pending paid shipped refunded cancelled
form.customerOptions     Acme Corp, Globex
signedIn.badge           alex@shop.test · level 5       ← graded by the server
stored.record            { reference: 'ORD-CDP-1', total: 42.5, note: null, status: 'pending' }

live.noErrorWhileTyping  { reference: null, customer: null }      ← 2 chars, untouched elsewhere
live.errorOnLeave        reference must be at least 3 characters  ← and ONLY reference
live.clearsOnInput       null                                     ← on the keystroke that fixes it
live.untypedStaysQuiet   null                                     ← tabbed through, never typed
live.submitRevealsRelation  Please select a customer from the list ← @required, from db/schema.lite

moves.anon    ORD-1001 pending  pay(disabled) cancel(disabled)   ← a move is an update
moves.user    ORD-1002 paid     ship  refund(disabled)  cancel   ← @gate(5) on refund alone
moves.admin   ORD-1002 paid     ship  refund            cancel
moves.admin   ORD-1003 shipped  —                                ← nothing leaves shipped
moves.afterPay  before ['pay','cancel'] → after ['ship','refund','cancel']
moves.illegalStatus  { status: 409, name: 'Conflict' }           ← was 500
```

and the API, for the same field and the same rule:

```
POST /api/orders {"reference":"ORD-M1"}   → 400  customerId: Please select a customer from the list
POST /api/orders {"reference":"X",…}      → 400  reference: A reference is 3 to 20 characters, like ORD-1001
POST /api/orders {"total":-1,…}           → 400  total: total must be at least 0     ← nothing authored
```

That last line is three separate claims at once: `@upper` uppercased the
reference, `coerce` made `42.5` a number rather than the string the DOM handed
back, and the blank note stored as NULL.

And over HTTP, against the same running pair:

```
GET    /api/orders                      → 200   3 seeded rows, public read
POST   /api/orders          (anon)      → 401   @@gate wants 4 to create
POST   /api/orders          (user)      → 201
DELETE /api/orders/1        (user)      → 403   "Order.delete" requires level 5, user has level 4
DELETE /api/orders/1        (admin)     → 200
POST   {"status":"gold"}                → 400   status must be one of: pending, paid, …
POST   {"reference":"X"}                → 400   reference must be at least 3 characters
POST   {"price":-5}                     → 400   price must be at least 0
GET    /api/customers       (anon)      → no `notes` key at all
GET    /api/customers       (admin)     → "notes":"Net-30. Always disputes shipping."
PATCH  /api/orders/3 shipped → pending  → 500   Cannot transition order.status from 'shipped' to 'pending'
```

`bun run build` emits the bundle and the post-build artifacts (robots.txt,
sitemap.xml with 5 URLs) to `web/dist/client/`, resolving the schema at
`../db/schema.lite`.

The one line above that is **wrong and known to be wrong** is the last: an
illegal state transition is a client error and comes back 500. See below.

---

## Found by building this

An example is only worth having if it can fail. Nine things this one settled,
eight the day it grew a job queue, an outbound boundary and a watcher tab that
never acts,
five more the day its markup moved onto `@frontierjs/ui`, eight more from the
screens built to use the components a render test cannot reach, four the day
its order form was rewritten onto `<Form>`, three the day its public page
grew an island, one the day somebody clicked ⌘K, and one the day a job was
asked who had sent it, one the day a custom method was asked what it
accepts, three the day one column grew a declared list, eight the day it grew
a shop — a catalogue with photographs, a basket a stranger can buy from, and a
currency toggle — three the day the shop grew a warehouse, four the day one
of its buttons moved onto somebody else's page, two the day its orders
learned to say what was in them and its storefront learned to ask, three
the day the shop moved into a browser toolbar, three the day its
customers got accounts, two the day its orders learned to carry a discount,
a delivery charge and a tax, three the day a row could be taken back, three the day what the schema
DECLARES was asked whether it holds, three the day somebody uploaded a
photograph and then opened the storefront in dev, three more the day
somebody looked at the storefront and said it was ugly, and three the day it
turned out you could not buy anything on it, three the day its
checkout link grew a credential of its own, three the day its money
stopped being a Float, seven the day it learned to bill somebody every month — on a schedule, at a price with a lifetime, on three surfaces — two the day it learned to STOP billing them, two the day it learned to charge somebody who is not there, two the day a bank asked to speak to them, six the day somebody asked whether it had user management, and three the day a shop tried to declare one of its own columns through the API instead of through the client:

| | |
| --- | --- |
| **Password reset minted a token and emailed nobody, and the route said 200 either way.** | `requestPasswordReset` mints; SENDING is `onPasswordResetRequested`, a callback the app supplies — and this app supplied none, with a comment in `api/src/app.ts` saying so. The failure is silent by construction: the endpoint answers 200 whatever happens, deliberately, so as never to reveal whether an address is registered. So *reset works* and *reset mints a row nobody will ever see* are the same response, and nothing short of reading the outbox can tell them apart. Measured: `POST /api/auth/password-reset/request` → 200, outbox empty. Found because a created account can only get in through a link, and the link had nowhere to go |
| **`ctx.result` inside a hook is the ENVELOPE, so an `afterCommit` read `undefined` and the invitation silently never went out.** | A service result is `{ kind, object, data }` until the transport unwraps it, so `ctx.result.email` is `undefined` — no error, no warning, and the account is made either way. The hook fired, the mailer was configured, the reset route worked when called directly, and the invitation still never arrived. `resultData()` is exported for exactly this and the fix is one call; what cost the time is that every part in isolation was correct |
| **The one column separating a shopper from a member of staff was written by the seed and by no person, ever.** | `db/user.lite` declared `isStaff Boolean @allow('write', auth().isAdmin)` the day tenancy landed, and across five surfaces, twenty-six drives and 904 assertions nothing had a screen for it. The app demonstrated the gate ladder on every page and administered it nowhere: the only thing that changed who you were was two hardcoded palette entries. What the missing screen was hiding is that auth ships `User` reading at USER(4) with NO read policy — right for an app whose only people are its staff, and wrong here, because a shopper who registers on the public storefront grades USER(4) too. **The shipped default handed every shopper the entire roster**, and no test could see it because nothing ever asked (`FJS-624`) |
| **Every tool that reads `db/schema.lite` reads a different schema from the one the app runs.** | An app appends a package's fragments in memory — `authSchemaFragments()` — so a file scan cannot see `User`, `Session` or `Credential`. Two readers, failing opposite ways, which is why neither had been noticed. `fli check` reported a correct `users.service.ts` as naming a model that does not exist, which is a rule people baseline. `fli admin:generate` generated a whole admin panel with **no Users screen in it**, silently, which is the one screen an admin panel is most about. Fixed for both with one owner; the half that cannot take that fix is the sharper one — `db/access.snapshot.md`, the artefact whose whole job is *who may do what*, does not mention the identity model at all (`FJS-625`, `FJS-626`) |
| **Nothing in this repo had ever executed a generator, and opening its output found three defects in ninety minutes.** | A service name is a FILENAME — junction autoloads the directory, so the app serves `shipping-methods` and the generator derived `shippingMethods`: five screens calling a URL that does not exist, each a 404 with the page rendering normally around it. A model with no service was generated and then warned about, which is the wrong half. And filtering those out of the targets was not enough — the nav is built from the full list on purpose, so the panel went on advertising two sections that had never been written. All three are invisible to reading and obvious to one page load (`FJS-372`, `FJS-625`) |
| **A job dispatched under an id built from a row id could never run again for that row — and the row id is reused.** | The collection was `dispatch(collect, …, { id: 'collect:' + invoiceId })`. A dispatch id is the jobs table's PRIMARY KEY, so a taken one is a no-op **for all time**: once `collect:56` exists, invoice 56 can never be presented again — and a soft decline leaves an invoice issued and owed, so *presented again* is the ordinary case. `unique` is the option that means what the line meant, because it frees itself at a terminal state. The key cannot be built from a row id under either, since SQLite reuses a rowid once the row is gone, and that is what made it visible: the drive's own cleanup deletes invoices, so the fourth run collided with the first — three green runs, then two assertions failing with the renewal visibly having worked (`FJS-609`) |
| **A migration that BLOCKED a column reported success, and the app then ran against a table missing a column its own seed declares.** | SQLite cannot add a `NOT NULL` column with no default, so `autoMigrate` refused — and answered `{ state: 'migrated' }` with the reason inside a SQL comment nobody reads. Every write of that column was then stripped by mass-assignment protection, so a required field read back `undefined` and the failure surfaced three steps downstream as a 500 about a collision. Deliberately blocked whether or not the table holds rows: migrating an empty one and refusing a populated one migrates on every developer's machine and blocks at the deploy (`FJS-604`) |
| **…and `@default(now())` on a new column threw `near "(": syntax error` out of `autoMigrate` at boot, naming nothing.** | `ALTER TABLE ADD COLUMN` takes a CONSTANT default and `CREATE TABLE` takes an expression, so the same declaration is fine on a fresh database and fatal on a populated one — which is every developer's machine against every deployed one. An expression default forces a table rebuild now, and *is this an expression* is a literal test rather than a `startsWith('(')` guess, because SQLite's own pristine read drops the parentheses (`FJS-605`) |
| **A `slot="actions"` child wrapped in `{#if}` turned the generated field list off, and the form rendered with no controls in it.** | `<Form>` decides whether to generate from `auto ?? !$slots.default`, and `slot=` is an attribute on an ELEMENT — so an `{#if}` around one puts the BLOCK in the default slot and the caller is read as having written the form themselves. Every field disappears, the form still submits, and the page looks like a component that failed to load. Found on the one screen where a person types money, where it failed as *no `[name="price"]`* rather than as anything about forms (`FJS-607`) |
| **Two job handlers declared `{ attempts: n }`, which is not an option.** | The name is `maxAttempts`. Nothing rejects an unknown key at runtime, so the retry ladder those files meant to set was never set and the default quietly stood in for it. Invisible to every test — the default is what they were asking for — and visible to `fli typecheck` the moment the app was typechecked at all, which is the argument for running it on an APP and not only on the packages |
| **A derived column moves when a CHILD row is written, and nothing announces the parent.** | `Plan.currentPrice` is `@from(PlanVersion, max: price, where: "effectiveTo IS NULL")`. Repricing writes a `PlanVersion`, so the `Plan` row does not move, so no broadcast names it — and the tile on the screen that just made the change held the old price. A live store cannot help: there is no event. The screen that made the change is the one place that knows to re-read, which is what `record().refresh()` is for |
| **A `Map` that is mutated is not a `Map` that was assigned.** | `held.set(id, n)` on a rendered Map left every subscriber count reading 0 — which looks exactly like a plan nobody is subscribed to, on the screen whose whole point is that repricing moves nobody. The same shape as `arr.push()`, on a count rather than on a list, and the fix is the one this repo already uses in its islands: count into a local and assign once |
| **`@@unique` takes no predicate, so the constraint effective dating is built on cannot be declared.** | A plan's price is a row with a window, and *at most one OPEN window per plan* is the rule that makes `currentPrice` answerable at all. `@@index([cols], where: …)` exists and emits a partial index; `@@unique` has no counterpart. The near miss is what makes it worth filing rather than working around: `@@unique([planId, effectiveTo])` is refused BY NAME because two NULLs never compare equal, and the refusal offers `nullsDistinct: true` — which is the correct declaration of the exact opposite, *these rows are deliberately unconstrained*. SQLite writes `CREATE UNIQUE INDEX … WHERE` and litestone already parsed, validated and emitted that predicate for the non-unique case. **Fixed** (`FJS-603`) — `@@unique([planId], where: effectiveTo == null)`, one word over two node kinds, and this app declares three of them. It did not reach every instance: `PaymentMethod.isDefault` wants the same declaration and collides with the model's own `@@index([customerId])`, because an index is named for its columns alone (`FJS-614`) |
| **A price typed into a generated form was stored at a hundredth of itself, and every screen agreed.** | `@money(USD)` stores CENTS, so `Order.total` reaches the browser as an integer and the control table gave it what it is: a number spinner stepping by one. Staff raising a telephone order for forty-two dollars would have charged forty-two cents, with the list, the receipt and the payment provider all consistent about it. The fix is the extension point the docs already described — `registerControl` off `x-money`, `registerFormControl` onto the kit's `Input`, with the conversion in `props` — and writing it turned up why nobody had: `x-money` and `x-scale` were not carried onto a field rule, so the only way to resolve that control was a column name ending in `Cents` (`FJS-582`) |
| **The shop in the toolbar printed a pound sign on a dollar amount, at a hundredth of it, for its whole life.** | `extension/src/dock/App.mesa` had ``£${(pennies / 100).toFixed(2)}`` against a column holding dollars, so an $87.00 order read `£0.87`. `verify:extension` watches the order arrive, move and leave the queue and never reads the figure — 13/13 throughout. Two hand-rolled conversions in one line, which is what one owner of *cents → what a person reads* removes (`FJS-581`) |
| **A `@@check` that says what it means could not be written until the columns were integers.** | The receipt identity was `abs(total - (subtotal - discount + shipping + tax)) < 0.005` — a tolerance, because two binary floats need one to agree that they are equal, and `verify:money` asserted that a thousandth of drift was ACCEPTED. In cents it is `total = subtotal - discount + shipping + tax` and the nearest wrong answer, one cent, is refused like any other. The drive asserts that instead |
| **A checkout link carried an order id and nothing else, and the leak was the DIFFERENCE between two answers.** | A hosted checkout is reached with no session, so `payments.start` had nobody to grade and read the order as the shop for whatever id arrived. The money could never be redirected and the row could never be read — but the reply carried the order's total and the refusal named its status, so counting from 1 was an existence, amount and status oracle over the whole ledger. Neither half is visible from either code path alone: the read is correct, the answer is correct, and the pair is the hole (`FJS-497`) |
| **`@guarded` plus a generated `@default()` made a model uncreatable by anybody but the system.** | The obvious fix above was a stored credential column, exactly like `Cart.handoffCode`. It could not be created: litestone merged its own `@default(nanoid())` into the payload and then graded the guard against what it merged, so the column refused its own stamp — a server-minted secret nobody may read or write, which is precisely what the pairing is for, could not be expressed at all, `@secret` included. The refusal now grades what the CALLER sent, and the pairing works. The checkout code is still derived rather than stored, for its own reasons — a link that must keep working while the order is payable has no lifecycle to hold, and no column means nothing to strip from a read (`FJS-565`, `FJS-497`) |
| **An app migrated its live database to a schema file edited after it booted, on an ordinary `curl`.** | The API had been up since the previous day and correctly answered 405 to a method added that morning — it holds the old code. The tenant database had the morning's column, added minutes earlier by a health check. `openShop()` runs `autoMigrate` on first open per process, and the schema it migrates TO is read later than the schema the app is serving, so the database moves ahead of the code with nothing saying so and the next boot inherits a migration it never ran (`FJS-566`) |
| **An island in a LAYOUT hangs `vite build`, with no error and no output.** | The storefront's header wanted a basket count, which on a prerendered page can only be an island. `_module.mesa` is composed into every route, and a marker inside it stops the prerender dead on the first one: the client bundle finishes and prints its chunk table, then nothing, forever. It reads as a compiler that crashed rather than a build that will never end, and every diagnosis costs a full build cycle. The same island on a page is fine (`FJS-549`) |
| **…and so does importing `@frontierjs/sierra/junction` into a prerendered island.** | Narrowed from the above by stubbing one import at a time. That module is the SPA's client singleton — the obvious thing to reach for when three islands need to share one client, and nothing says no. The basket store takes its client now rather than importing one, which is what lets the same 390 lines run behind the console and behind the storefront instead of being copied (`FJS-550`) |
| **A drive's own regex replaced every letter `s` with a space, and it looked exactly like a rendering bug.** | A CDP probe is carried to the browser inside a template literal, and `\s` is not an escape JavaScript knows — so `.replace(/\s+/g, ' ')` arrives as `.replace(/s+/g, ' ')`. `Basket (1 item)` came back as `Ba ket (1 item)`, survived removing the em dash and collapsing the markup to a single expression, and was two edits away from being filed against Mesa |
| **The public storefront shipped with no gap, no border and no radius, and every drive was green.** | Thirteen of the fifteen tokens its style blocks read were invented — a Tailwind-shaped `--space-4`, `--radius`, `--border` against the ladder `@frontierjs/css` actually ships (`--space-2xl`, `--card-radius`, `--rule`). An undefined custom property is invalid at computed-value time, so the browser drops the **declaration** rather than the value: no gap, not a wrong gap. Nothing says so — the stylesheet is in the bundle and every selector matches — and `verify:site` passed 39/39 throughout, because a drive asserts what a page SAYS. A second layer under it was invented class names: `.list` for `.rows divided`, `.input` for `.field`, `.button` for `.btn`. `fli check`'s `css-token-undefined` is the guard, reading the token table off whatever CSS the app installs (`FJS-545`) |
| **Three drives passed exactly once per database, and two of them had never been run twice.** | `verify:ui` and `verify:pay` create orders under fixed `@unique` references and clean up with a DELETE — which SOFT-deletes, and a soft-deleted row keeps its `@unique` values, so the reference is still held by a row no ordinary read returns. The second run's create is a 409 nobody checks, an undefined order id, and thirty assertions against `/orders/undefined`. `FJS-530` had already found and fixed this exact shape in `verify:notify`; nothing was looking for the others (`FJS-546`) |
| **Two drives asserted a fact in the tick a different fact arrived.** | `verify:site` waited for the catalogue island by element identity, and the node is captured after the navigation returns — so on a warm cache the island has already mounted and the comparison can never become true. One run in six. `verify:ui` read the refund's event trail in the render the refunded amount appeared, which is one render early, and failed saying the refund wrote half of what it writes. Both only reachable once the drives could run twice (`FJS-547`) |
| **`vite dev` on the storefront ran the build-time loader in the browser.** | A `render: static` route's `load()` runs in Node and reads this app's own database, and the client route table kept its import — so the dev router called it, got `Module "fs" has been externalized`, swallowed the throw into a warning, and drew an empty shop. Vite followed the same import into the browser graph and reported eight un-analyzable dynamic imports out of the migration engine and the service autoloader, which reads as a broken install. The rule is per ROUTE now: a prerendered route's loader is build-time by definition and is not shipped to the browser at all, and Sierra says once per route why the page is empty. `FJS-543`. |
| **No browser had ever uploaded a file to a Junction app.** | A multipart boundary is case-sensitive — RFC 2046 says so about this parameter by name — and `parseBody` lowercased the whole `content-type` header before reading it out. Chrome sends `----WebKitFormBoundary…`; lowercased it matches nothing in the body, so no part is found, `ctx.data` is empty, and the create answers **`Request body is required` about a request that plainly has one**. What kept it alive is that everything else generates a lowercase-hex boundary: curl, undici, and Bun's own `new Request({ body: form })` — which is what junction's existing multipart test used, and that test asserted the body's TYPE and never its contents. It took a real file input in a real browser, which is a thing only this drive does. `FJS-542`. |
| **`get(id)` ran no plugin read hook, so a photograph was a URL in a list and a JSON blob on the page beside it.** | `findFirst`, `findMany` and `findManyAndCount` all end with `plugins.afterRead(...)`; `findUnique` did not, on either path — while calling `beforeRead`, which made the gap look like plugin support rather than half of it. `ExternalRefPlugin` resolves a stored file reference into a public URL in that hook, so the same column answered two different shapes depending on which read asked, and an edit form was handed the storage handle instead of the photograph. A `@@log` model was also recording reads through every path but the most common one. Neither is visible unless the two reads are compared, which is what the drive does now. `FJS-541`. |
| **The retention sweep killed the API on the first night it actually removed a row — and the request that caused it answered 201.** | `database audit { … retention 90d }` was a declaration nothing had ever run twice until it got a job (`FJS-521`), and a job nothing had ever driven until this drive. A jsonl table keeps a companion index of byte offsets; a compaction rewrites the file, so it deletes that index and says it is *rebuilt lazily*. Nothing rebuilt it — the driver caches the handle for ever, and SQLite marks a connection readonly once its file is unlinked underneath, so the next append threw out of the audit path. **Which is fire-and-forget and deferred a tick**, so the write that triggered it had already answered: `POST /api/discounts` → 201, then no API, and nothing in the request log. Not a race but a CLOCK — the sweep removes nothing until the oldest row is past the window, so it fires the first night a deployment's retention period elapses, at 04:00. Latent for as long as the driver has had an index, and invisible to litestone's own jsonl retention test, which compacts and never writes again. `FJS-540`. |
| **The seeder could not reseed once a drive had removed a row, and the error named a table.** | Six models declare `@@softDelete`, so a drive deleting a seeded order over HTTP HIDES it — and a hidden row keeps its `@unique` values by design, because `restore()` has to be able to bring it back. `db/seed.ts` looked for its rows with a plain `findFirst`, which excludes them, so it neither found `ORD-1001` nor might create one: `SoftDeletedUniqueError: Order: a soft-deleted row still holds reference = "ORD-1001"`, which is the Data boundary being exactly right and is not a sentence anybody running `bun run db:seed` can act on. **`bun run reset` is what hid it** — it deletes the database file first, so the path everybody runs by hand never saw it, while the five drives that reseed as their own first act all failed at once, under a node stack trace naming the seeder rather than the constraint. A regression from the `@@softDelete` work against the property this app had already paid for once: the seeder restores what a drive consumes (`FJS-080`). Once removal is something the schema can express, RESTORING the row is what that property means. `FJS-538`. |
| **A retention probe measured the check that skips the sweep.** | `database audit { … retention 90d }` is a policy the seed states, and proving it needed a row older than the window — so the drive appended one and the job reported `done` having removed nothing. Not a bug: `compactJsonl` reads the FIRST line and returns if it is inside the window, because an append-only log is oldest-first and this runs on every boot over a file that grows for the life of the deployment. The right optimisation, and it makes the obvious test measure the pre-check rather than the sweep — a job that looks broken while being correct, which is the same silence `FJS-521` was filed about wearing the other face. A log that has genuinely aged has its old rows at the TOP, which is what the drive plants now. |
| **A soft-deleted parent's children had two fates and needed three.** | `@@softDelete(cascade)` stamps them, `@hardDelete` on the relation field destroys them, and *the child stays live on purpose* could be produced but not SAID — it is what a plain `@@softDelete` already does, and the parser warns about it, because forgetting the cascade and meaning it look identical from the outside. `Order.customerId` is `onDelete: Cascade`, so removing a customer DESTROYED every order they had ever placed; cascading the soft delete instead would only have hidden them. An order is what the revenue is made of, so neither is what a shop means, and the only way to stop the warning was to stop being right. `orders Order[] @keep` says it now, the warning names all three ways out, and it covers the whole subtree beneath that child — if the order survives, its lines survive with it. |
| **`<Form record={row}>` was a 403 about a column that is not on the screen.** | `@system`, `@generated`, `@from` and `@version` reach the browser as `readOnly`, and two things read that already: a generated form does not offer the control, and `make()` does not seed the value. Neither covers an EDIT form — it is handed a row the SERVER wrote, carrying every column the caller could read, and writes the whole record back. The Data boundary then refuses `@system` **by name**, correctly, so the customers screen showed *`Customer.userId` is @system…* under a form whose every visible control had been filled in legitimately. Unreachable from the create path, which is why nothing here had seen it: a create starts from `make()`, and `make()` skips exactly these columns. `stripReadOnly` runs first in the resource's write pipeline now — with a KEEP list rather than a blanket drop, because `@version` is marked read-only and is the one the server requires back. `FJS-526`. |
| **`bun run reset` reseeded the shop and left the job queue.** | The queue is a separate SQLite file, so a `book-courier` row enqueued by an earlier run survived the reseed that deleted the staff member it recorded, and retried forever with *no such principal*. Caravan's `unique` is a lock on work still owed and a `pending` row holds it, so the key was held against every later `ship` of that order and the dispatch became a silent no-op. What that reads as is the reason it is worth writing down: `verify:jobs` fails `job.wroteTracking` while `job.record` **passes**, because the row the drive finds is the previous run's — evidence for a framework bug that is not there. `FJS-527`. |
| **A `readOnly` column with a default made its model uncreatable through any service.** | Junction's validator fills a default in for any absent key, and it carried one for every property — including the ones Litestone marks `readOnly` because the caller may not write them. So `POST /api/discounts` with a perfectly ordinary body reached the Data boundary carrying `redemptions`, which is `@system` and therefore refused BY NAME: **403 quoting a column the request did not contain**, with nothing the caller could do about it — naming it in `system: [...]` is the opposite of what was meant, and there was nothing to omit. The sibling rule had been fixed and stopped one line short: `mode === 'update'` already dropped every default, for the same reason a patch must not invent values. Found by declaring one column on one new model. `FJS-504`. |
| **A `$:` watch on a value with no depth switched that variable's reactivity off, silently — twice, in this app.** | The discount box's Apply button is disabled while the code box is empty. It stayed disabled: the box filled, `bind:value` wrote through, and nothing re-rendered. The bare `$: a` form is the DEEP-watch opt-in — it changes the variable's accessor from a signal read to a proxy read — and a primitive cannot be proxied, so every read compiled to a plain local and the render effect subscribed to nothing. Value right, screen stale, no error and nothing in the console. A sweep of all 313 components found the second one in this same app and it was live: `$: (handoffError)` on the basket screen meant a spent or expired checkout link showed a shopper **nothing at all** — the API refusal had a drive and the screen had none. Refused at compile now, because the declaration is redundant rather than merely broken: a local `let` is already a signal. `FJS-505`. |
| **The shop's customers and orders were public.** | `GET /api/orders` with no token answered every order; `GET /api/customers` answered every name and email. Six models carried `@@gate("0.4.4.5")` and four of them are catalogue, where read-at-0 is correct and load-bearing — the prerendered storefront reads them with no session. `Customer`, `Order` and `OrderLine` are not catalogue. `api/src/core/gate.ts` documented the opposite in its own ladder. Found looking for somewhere to put a buyer's identity, which is the thing that makes *whose order is this* answerable at all. `FJS-498`. |
| **No browser on another origin could sign in to a Junction app.** | `cors()` patches the router's registration methods, so it reaches routes registered after it — and every raw route a plugin mounts is registered during `configure()`, long before the `cors` start phase. Services were fine; `/auth/login` was not. The preflight answers 204, the POST answers 200 and creates the session, and the browser discards the response: what the page sees is `Failed to fetch`. It could only be found by putting a sign-in on an origin that is not the API's, which is what a static storefront is. `FJS-496`. |
| **A row policy cannot reach through a relation.** | `@@allow('read', order.userId == auth().id)` is a parse error at the dot. There is no other form — a policy compares columns on its own model, and `@from` crosses a relation only to aggregate. So *the lines of my own orders* is a denormalised column, and this shop now carries the same id in three places, written in one transaction because nothing in the schema can keep them together. Stated in `OrderLine`'s own header rather than hidden. `FJS-499`. |
| **jetty could not talk to a real Junction, and had not been able to since it was written.** | `default-adapter.js` says *placeholder*, and the gap is wider than that word: its envelope is `{ kind: 'call' }` and Junction's is `service_call`. So every jetty app in existence spoke to a mock. Writing `extension/` is what made that a blocker rather than a note — the harbor here holds the only connection in the surface, and there was nothing for it to hold. The adapter is over `@frontierjs/junction/client`, which is the client Sierra already uses, so the transport, the token and the reconnect have one implementation. Two spellings had to be settled: jetty's `url` field is written `wss://` and the client wants an http origin (handed one over unchanged it builds `wsss://` and a socket that never opens), and SIGN-IN is not a service — Junction has no service called `auth`, so the pseudo-service the placeholder invented would shadow the methods of an app that has one. `FJS-279`. |
| **A row that has left the list stays in it.** | The dock loads `{ status: 'paid' }` and ships one; the order comes back on the channel as `orders ship` and jetty's store upserts whatever arrives, so the despatch queue keeps showing an order that has gone. Sierra had exactly this and answered it with `matchesQuery` — `true` upsert, `false` REMOVE, `null` *undecidable, reload*, because there is no other event for a row leaving a filter — and that function is pure but lives where jetty may not import it. Same shape as `FJS-059`, whose answer was to move the pure halves into `@frontierjs/toolbelt`. The dock filters on render and says so. `FJS-493`. |
| **`fli make:extension` gave every app port 8400.** | Which is dev/ext/project-0 — right for a fresh scaffold and wrong for every app that has a number, so two apps' extensions could not have their dev servers up at once and jetty's reload push would reach whichever bound first. `make:widget` beside it already derived the port; this one had the literal. Found because `example` is project 1 and its extension should be 8410. |
| **`++n` on a reactive variable evaluated to `undefined`, and `n++` compiled to `++n`.** | The storefront's search box guards against an out-of-order answer the ordinary way: `const mine = ++inflight`, and drop the response if a newer keystroke has taken a newer ticket. `mine` was `undefined`, so `mine !== inflight` was true for every response and **every answer the shop gave was discarded** — an empty list, no error, and a box that reads as a server that is not replying. Two defects in one emit: `$$runtime.set` returned nothing, so the whole expression was undefined (`n += 1` and `--n` too), and prefix and postfix compiled to the same string, so `n++` would have answered the new value once it answered one at all. It survived because all five tests on the pair asserted the emitted TEXT, and both things wrong with it are only visible in a value. `FJS-485`. |
| **A Vite hash with a hyphen in it was not recognised as a hash.** | `site/serve.js` decides which files may be cached forever with a pattern over the name. The hash is base64url and may contain `-`, and one that does — `island-CatalogList-C_TQPJ-f.js`, which this site's own build emitted — was read as unhashed and served `must-revalidate`. Quiet, and on the files a site is mostly made of. It only surfaced because `verify:site` grades the FIRST `.js` in the assets directory and directory order changes when the files do, so which asset it checked was luck. The same pattern was written twice, in the site server and the widget server, and both copies had it. `FJS-484`. |
| **A caller with no session could not hold a claim, so a guest basket had nowhere to live.** | `Cart` says who owns it in the schema — `@@allow('read', token == auth().cartToken)` — and `createApp({ principal })` was the only seam that could put `cartToken` on a principal, and it ran only for a caller who already had one. Extending it was easy; the part worth knowing is what it must NOT do. `sessionGateLevel` grades any object handed to it, and a claims-only principal sets no standing flag while leaving `verifiedAt`/`activatedAt` **undefined — silence, not null** — so promoting the claim to a session would have graded every anonymous shopper USER(4), in every app that adopted a resolver. `ctx.auth.user` stays null and the claims reach the Data client alone. |
| **An app could not send a caller-varied header over the socket at all.** | The workspace had needed one since it was written, so it was built as one hardcoded name on each side, with a comment explaining that merging a client-supplied header map wholesale would let a frame carry its own `Authorization`. Right reasoning, one name too narrow: it is an allow-list. A basket token is the second case and it is the harder one, because it comes into existence *after* the socket is already up. Undeclared, the shop worked until the WebSocket connected and then every basket call answered 404 — with nothing anywhere reporting it, because a policy filters rather than refuses. `FJS-428`. |
| **A CRUD method written on a base service was dropped on the floor.** | `carts` writes its own `get`, which assembles a basket with its lines, its count and its total. `createBaseService` spread the generated row-by-id over it and never called the author's, so the basket screen rendered empty against a 200. Not an error at any layer — a plausible wrong SHAPE, which is the worst way for it to fail. `FJS-426`. |
| **A minified widget lost every stylesheet it imported.** | `widgetCssPlugin` deletes Vite's emitted `style.css` and swaps its text into the entry at a placeholder, so a widget ships as one file. The matcher knew `"` and `'` — its own comment names the class — and **esbuild writes backticks when it minifies**, which is the default and what every app ships. The asset was deleted, the swap missed, and the widget carried the literal `@sierra-widget-css` into its shadow root as its stylesheet. Only IMPORTED css was hit, because a widget's own scoped `<style>` goes through Mesa's shadow-aware runtime — so it looked styled and nothing said otherwise. It survived because the fixture builds with `minify: false`, for a good reason: the one working case was the only one under test. `FJS-448`. |
| **A deep link lost its anchor on every direct load.** | The router's boot navigation passed `pathname + search` and rewrote the address bar with `replace: true`, so the fragment was erased: `/docs/#install` became `/docs/`, did not scroll, and left the reader with a URL that no longer says where they were. Clicking the same link inside the app carried it, so it failed only for the person who pasted one. Found because the handoff code arrives in `#h=` and was gone before the basket screen could read it — with no error anywhere, just an empty basket. `FJS-447`, and fixing it uncovered `FJS-446`: a URL with a query AND a fragment wrote the fragment twice and glued it onto the query value. |
| **`fli make:widget` wrote project 0's ports into every app.** | 8200 and 8300 — the Vite port, the host page's `<script src>`, `deploy/serve.js` and the Dockerfile's `EXPOSE`. Right for a fresh scaffold and wrong for every app with a number, and `packages/cli/core/ports.js` is explicit that the numbers are derived rather than chosen. `strictPort` turns the collision into a refusal rather than a silent hop, so it surfaces as a second widget server that will not start, naming a port nobody picked. `FJS-445`. |
| **A redeemed basket came back empty, with a 200.** | `carts.redeem` answers the basket it hands over, and it built that view through the CALLER's client like every other method here — where `@@allow('read', token == auth().cartToken)` is what makes a basket private. The caller redeeming a code holds no claim yet: the claim rides a header on the NEXT request. So the lines were filtered out and the shopper landed on the shop's own site looking at an empty basket. The one place in this service where reading as the shop is correct, because the code IS the proof. |
| **A guest could not take a line out of their own basket.** | `CartLine` was `@@gate("0.0.0.5")` — read, create and update at 0, delete at 5 — with `@@allow('delete', token == auth().cartToken)` written underneath it saying what was meant. So `removeLine` and `setQuantity(0)` answered 403 to every shopper in the shop, for as long as the basket had existed, and nothing noticed: the two drives that fill a basket only ever added to it. A gate answers *what kind of caller* and a policy answers *which rows*, and taking a line out of a basket is an ordinary thing a stranger does. Found by the first drive that removed one. |
| **Two of these drives could not run in a row.** | The self-hosting ones start `npx vite`, which is a launcher: SIGTERM to the process the drive is holding kills the launcher and leaves vite itself on 8010. The next drive then refuses the port and reports that a dev server is running from an earlier run — which it is, and nothing said which run or that the previous drive was supposed to have stopped it. `detached: true` and signalling the process GROUP. Worth having because running them in sequence is what anybody proving a change does. |
| **The preview proxy re-labelled decoded bytes as gzip.** | `bun run preview` forwards `accept-encoding` upstream, Junction compresses a response past a size threshold, and `upstream.arrayBuffer()` hands back the DECODED bytes — which the proxy then answered with the original `content-encoding: gzip` header. The browser says `ERR_CONTENT_DECODING_FAILED`, for whichever response happens to cross the threshold, so it surfaces as `verify:build` failing at sign-in with *Failed to fetch* and reads as a regression in whatever grew a payload last. |
| **A `File` column read through an `include:` was raw JSON.** | The same column answered a public URL when read directly. A basket line joins line → variant → product → images, so the thumbnail's `src` was `{"key":"storage/…"}`. Both are strings; nothing reports the difference and it fails only where the value is finally used. `FJS-425`. |
| **`toFieldErrors` was unreachable, and a checkout is exactly the case it exists for.** | Sierra re-exports it from `resource.js` with a comment saying `sierra/junction` is the one import for resource work — and the index dropped it. `resource.fieldErrors(err)` hid the gap, because it only shows for a form with no resource behind it: a form over a custom method, which is what `validateInput`'s `input:` was built to make possible. `FJS-429`. |
| **A conditional block stopped tracking the variable its condition reads.** | The payments panel lists each payment's event ledger, filtered from a separately-fetched list. After a refund the payment's status and amount updated and the ledger block never appeared — while the count beside it, reading the same variable in the same row, said 2. Isolated in mesa's own harness: of three readers in one row, only the `{#if}` stops. `FJS-468` — and nothing had stopped tracking: the block above it shared its anchor, so the sibling's teardown removed content this block had just built. Fixed in the compiler, with `FJS-512`. The panel renders the list unconditionally either way, which is better markup — an empty list renders no rows on its own. |
| **Adding one member to an enum broke every write of it, and everything upstream said it was fine.** | `PaymentStatus` grew `refunded`. The DDL snapshot regenerated with the new member, `fli check` was clean, the app booted, and the first webhook to write it died on `CHECK constraint failed: status` — inside a transactional method, so the ledger row and the payment update rolled back together and the symptom was *the order did not move*. SQLite has no ENUM type, litestone enforces one with a CHECK, and the migration engine had never compared one, despite its own header listing *change CHECK* as a rebuild trigger. `FJS-466`. |
| **A write that never went through a service announced nothing — in every app, since the day the feature shipped.** | `announceDataWrites` finds the service for a model through one index, and that index was keyed by the SERVICE name while the lookup used the MODEL name. Every service in every app is named in the plural, so it missed for all of them: `FJS-010` (a job's `asSystem()` write reaching an open tab) and `FJS-307` (a bulk write announcing `changed`) were both dead on arrival. The unit tests could not see it because they all declare `model: 'Order'` by hand, which is the one shape no real service file has. Two more fell out of the same pull: `createBaseService` was dropping four of the options it accepts, so a declared `idField` was REPORTED to the devtools and ENFORCED as undefined (`FJS-464`, `FJS-462`). |
| **A state transition made from another service moved the row and told nobody — and then told everybody twice.** | `payments.record` settles an order from a webhook, so the move happens through a Litestone client rather than through the orders service. The write tap dropped `transition` events outright, so the seller's open tab stayed on `pending` with a 200 and nothing logged. Announcing it then produced TWO frames for one write — `update` and `transition` both fire — which is the double broadcast the framework refuses on the service path. Litestone now stamps the update with the move's name, and only when the move is really going to be announced (`FJS-463`). |
| **A prerendered page could not import its own neighbour, and the build stayed green about it.** | Giving the shop a currency toggle put `import { money } from '../../money.js'` in an island. `renderComponent` writes the compiled module to a temp directory, so the relative path resolved against the temp directory and the page stopped being built — reported as one warning among the bundler's own, after which the build exited 0 and said *no route declares `render: static`* about a page that declares exactly that. Two fixes, one each side: mesa rewrites a relative non-Mesa import to an absolute path (`FJS-438`), and sierra fails a build whose prerender threw instead of warning about it (`FJS-439`). `verify:site` is what caught it. |
| **Money was written five ways here and with no currency at all in two emails.** | `` `£${n.toFixed(2)}` `` in the products list, the product page, the basket, the Banked tile and the prerendered catalogue — and `order.total.toFixed(2)` in two notification bodies, an amount with no currency in the one place a reader is being told what they were charged. Same shape as `FJS-408` and the same answer: one owner in `@frontierjs/toolbelt/units`, which is where it has to live because the API formats the same amounts and cannot import anything under `web/`. `FJS-440`. |
| **The compiler emitted `$$runtime.get($$runtime.get(fn))` and said nothing.** | A derived `const` called inside a nested callback, on the right-hand side of an assignment to a reactive `let`, comes out wrapped twice — the component throws at mount, half-built, with the message naming neither the file nor the identifier. Two lines above, in the same block, the same kind of call compiles correctly. Worked around here with a plain `for` loop; open as `FJS-424`, un-reduced, because four attempts at a minimal fixture compiled the block away instead. |
| **The same compiler defect, worked around four times in one file, was never the shape it was written down as.** | A derived `const` on the right of an assignment to a reactive `let` came out `$$runtime.get($$runtime.get(cellFor))(…)`, and the runtime CALLS a function it is handed — so the derived was invoked with no arguments and the result called, throwing at mount with the page half-built and nothing naming the line. This page hit it on the size picker, then again when it grew stock availability, and the workarounds record a shape that is wrong in three ways: not a nested callback, not `$:`, not `find` versus `reduce`. A bare `pick = derived(1)` in a plain function does it. What made it look narrow is that a derived holding a VALUE double-wraps harmlessly, so only the ones holding functions ever spoke. All four workarounds are gone and the page reads as it was written. `FJS-424`. |
| **A declared value set was invisible to every CLI tool, and the app was fine.** | `valueset ProductColour { source Colour  value name  scope current }` parsed, enforced and worked in the browser — and `litestone ddl`, `jsonschema`, `access` and `release` each refused this schema with *no valueset 'ProductColour' in this schema*, about a declaration forty lines above the binding. `parseFile` rebuilds the schema key by key to resolve `import "…"` and had no line for value sets, so they were dropped from imported files **and from the root one**. `createClient` parses the text it is handed, which is why the running app never saw it and no unit test could. `FJS-435`. |
| **A colourway the shop had retired came back as `UNIQUE constraint failed`.** | `@values(ProductColour, open)` means a merchant may type a colourway that is not on the list and it joins it. `Ochre` is on the list and out of the set's `@@scope`, which is a different thing — and `open` treated both as missing, created a row, and hit `Colour`'s own `@unique`. The caller got SQLite's sentence about a table they had not named, saying the opposite of what happened. The `open` path asks one unnarrowed read first now and refuses with *Ochre is in Colour but is not offered by ProductColour*, creating nothing: growing a shared list as a side effect of a write that never landed is worse than the refusal. `FJS-434`. |
| **Every litestone refusal reached a form as a banner, never under its control.** | Two boundaries write a per-field error and they spell the field differently — junction's validator says `field`, litestone's `ValidationError` says `path: ['colour']` — and `toFieldErrors` read only the first. Litestone is the half carrying every rule a browser cannot pre-check, because the check needs a query or a stored row: a value set, a `@@transitions` move, a soft-deleted `@unique`. All of them rendered away from the box they name, with `<Form>` unable to mark it invalid. Found by refusing one save in a real browser. `FJS-436`. |
| **The one column a job writes had no shape, and a `type` in the seed lost its own wording.** | `recordTracking` read `$.data as { trackingCode?: string }` — a cast that asserts three things and checks none, which is what every CUSTOM METHOD in every FJS app was doing, because `autoValidate` derives from a model and covers only CRUD. Declaring `type TrackingUpdate { … }` here and naming it with `methods: [{ method, input }]` closed that. Wiring it found the second half: a `type` field emitted its structure and none of its presentation, so `@label("Tracking")` and an authored `@length` message were carried for a model column and silently dropped for the identical declaration inside a type — the 400 said `trackingCode is required` where the schema had written `Tracking`. Litestone had one presentation block reachable only from the model path (`FJS-401` is what it still does not cover). |
| **A watcher tab proved a rename nobody meant to make.** | The `@system` work moved the courier job off `patch` and onto a `recordTracking` action, and a custom action **announces under its own name** — so the live event stream said `orders recordTracking` where `verify:live` expected `orders patched`. Nothing else could see it: junction's suite, `verify` and `verify:jobs` were all green, because a broadcast's NAME is only observable from a second tab. The expectation was updated rather than the code — the new name is the correct one, and it is now the drive's record of a design decision rather than of a mechanism. |
| **Every overlay in the kit was invisible, and the palette froze the app.** | `{@attach}` ran when an element was BUILT rather than when it mounted, so the attachment saw a detached node — and `el.animate(…, { fill: 'forwards' })` on a disconnected element returns an animation that never starts, even once it is connected. Every kit overlay painted at keyframe 0. CommandPalette is `position: fixed; inset: 0; z-index: 9000`, so clicking **Search ⌘K** put an invisible sheet over the page that swallowed every click: "nothing happens and the app is unresponsive". Reported by the owner, not by a drive — `verify:ui` was 26/26 green against it, because every assertion asked whether the DOM was there. It now opens the palette by clicking the button and asserts opacity, hit-testing and size. `FJS-114`. |
| **A `.mesa` route was compiled as MARKDOWN — but only by the prerenderer.** | Mesa routed any source beginning with `---` to its Markdown compiler, and a `---` block is how every Sierra route states its title. Markdown escapes what it does not recognise, so `<CatalogList client:load products={…} />` came out as a paragraph of ESCAPED TEXT with the props stringified into it, while `<LiveStock />` beside it compiled as a component and mounted correctly. Sierra's Vite path strips frontmatter first, so dev and the SPA build were right and the static build was wrong **for the same file**. The extension decides the language now. `FJS-106`. |
| **Every prerendered `<input>` carried `formaction="http://localhost/"`.** | happy-dom's `cloneNode` re-derives an input's attributes from default properties, so each instance of a template gained the build machine's own URL. `formaction` overrides its form's action — a prerendered form would post to whoever built the site. Mesa parses per instance on the server now. `FJS-107`. |
| **A prerendered page linked no stylesheet and had no theme.** | It shipped every `@frontierjs/css` class name in the app and not one rule behind them, because a static document is assembled by Sierra and Vite's HTML transform never runs on it. The SPA built from the same source looked right, which is why nobody had seen it. `document: { bodyClass }` plus automatic linking of the build's CSS assets. `FJS-108`. |
| **A prerendered page could publish gated data, and nothing checked.** | Adding one `render: static` route to this app found a fail-OPEN hole in the check being built to stop exactly that. `importCompanion` swallows an import error and returns null, so a `.meta.js` that *throws on import* was indistinguishable from a route with no companion and was waved through as "reads nothing" — which is what happened on the first `bun run build:site`, run under Node, where the companion's db import died on `bun:sqlite`. The page was emitted anyway. A companion that exists but could not be read is now UNKNOWN, which is the one case the check exists to refuse. `ISSUES.md` FJS-081; `site/src/routes/catalog/` is the route. |
| **Signing out never told the server, in this app and in basecamp.** | Sierra's `logout()` dropped the local token and closed the socket; nothing anywhere in the repo called `POST /auth/logout`, so the `Session` row stayed valid for its full 30 days and a token that had leaked was still a session. The route existed, `onLogout` existed, the audit event existed — and none of it had ever run outside a test. It was invisible because the UI behaves identically either way: you are signed out on this machine, which is what a person checks. The cause was that there was no developer-facing auth API in the browser at all, so both apps hand-rolled one and each stopped where it looked finished. `FJS-D20`. |
| **Every row policy in the framework matched nothing.** | `@@allow('read', userId == auth().id)` is the shape `@frontierjs/notifications`' own README ships. It returned an empty list for every signed-in caller, and the rows were plainly there under `asSystem()`. Junction's `SessionContext` names the caller `userId`; Litestone's policy language reads `auth().id` — its documented spelling — and nothing bridged the two, so the predicate compared a column to `undefined`. **Gates were fine**, because `sessionGateLevel()` was written against Junction's shape; the half that was translated worked and the half that was not failed in silence, which is why an app with `@@gate` and no `@@allow` would never notice. `FJS-097`. |
| **Fixing that broke the audit log, which is how it was found twice.** | With a real `id` on the principal, the audit trail finally had an actor to record — and its `actorId` column was declared `Int` while `@frontierjs/auth` issues uuids. The first audited write after signing in threw `cannot store TEXT value in INTEGER column auditLogs_idx.actorId` and took the request with it. It had been unreachable for exactly as long as the bug above existed: no id meant a null actor, and NULL fits an INTEGER column. Two defects, one masking the other, both in one afternoon. `FJS-098`. |
| **An append-only service that was not.** | `methods: ['find','get','patch']` on the notifications service answered `403` from the model's gate instead of `405` — because `methods:` was read by `createService` and neither read nor forwarded by `createBaseService`, the factory the loader is built around. The same declaration that makes an audit trail append-only through one factory did nothing at all through the other. `FJS-099`. |
| **A PATCH of one field rewrote the whole record.** | Junction's update-mode validation dropped required-ness and kept every field's `default`, and a default is applied to any absent key — so `PATCH /orders/3 {"note":"x"}` arrived at the model as `{ note: 'x', status: 'pending', total: 0, … }`. On an ordinary column that silently reset it. On a column under `@@transitions` it came back `409 Cannot transition order.status from 'shipped' to 'pending'` — a state machine correctly refusing a move nobody asked for. Found by the courier job, whose whole purpose is to patch one field on a shipped order; the job's own retries are what made it visible. |
| **Every background write in the app was signed `system`.** | Three jobs, and each one opened with the same two lines: a module-level app reference, because a Caravan handler took one argument and it was the job, and `{ auth: { user: SYSTEM } }`, because an in-process call had no principal and no principal is STRANGER(0). Both were documented as hazards and worked around rather than fixed, so the workaround was invisible — until the audit trail was read. **Booking a courier for one customer's order was recorded as an act of the shop**, at SYSADMIN(7), with no way to answer who had asked for it. The gate was doing its job; the app had simply been told to hand every job the widest principal it had. A job now runs as whoever dispatched it, re-resolved when it runs, and `api/app-ref.ts` is gone. `FJS-093`. |
| **A queue key that meant two opposite things.** | Caravan's `unique` looked for a *pending* job with the key while the column was `UNIQUE` forever. Dispatching the same key after the first job finished walked past the guard into the constraint — `500 UNIQUE constraint failed: jobs.unique_key`, out of an ordinary request. Matching any status instead fixed that and broke the other side: `book-courier:4` matched a job belonging to a **deleted** order whose id SQLite had reused, and the courier was silently never booked. Both readings met in one afternoon. It is a lock on work in flight now, enforced by a partial unique index over live jobs so the guard and the constraint cannot drift again. |
| **A job file could say everything about itself except when it runs.** | `defineJob`'s options were `{ queue, maxAttempts, retryDelay }`, and `queue.schedule(name, expr, handler)` was the only way to register a recurring job — so the sweep was half in `api/jobs/` and half in `app.ts`, and this app deliberately named the file `sweep-abandoned.ts` to keep it out of the autoload glob, because a job that autoloaded and then never fired would be worse than both. `cron` is a registration option now, registered in `handle()` rather than in `schedule()` — which is what makes it reachable from a file at all, since `handle` is the only call autoload makes. The file is `sweep-abandoned.job.ts` and `app.ts` says nothing about it. `FJS-094`. |
| **A cron could be scheduled and never run.** | Caravan's admin routes could retry a job and cancel a job, but not *start* one — so the only way to reach a nightly sweep was to wait until 03:00. Every cron handler in every app was untestable, and unrunnable during an incident. `POST /jobs/run/{name}` exists now, and the body becomes the job's data. |
| **A generated form offered a human a box the system owns.** | Adding `trackingCode` to the schema put a *Tracking* control in the order form — correct behaviour for a form derived from the model, and wrong for the domain: whatever you typed would be overwritten by a worker a second later. Nothing in FJS could say "the system writes this column", so the create page carried the only hard-coded field name in the app, marked as the workaround it was. **Fixed 2026-08-15**: `@system` on the column says it in the schema, the control table has no control for a `readOnly` field, and the page carries no field name at all. The courier job writes it through a `recordTracking` action naming the column — `system: ['trackingCode']` — which keeps the gate and the audit actor that `asSystem()` would have dropped. `FJS-D22`. |
| **A custom action told nobody it had changed anything.** | Every live-update observation this app had ever made was the tab that made the change, so none of them could tell a broadcast from an echo. A watcher tab that never acts settles it: `orders created` and `orders removed` do cross to a stranger and the store applies them — and the `pay` between them was never published at all. `callService` announced only the five CRUD writes; the browser client had been listening for action events since the day it was written. **What hid it was this app**: it re-issued `find()` after every action, so the acting tab looked right and every other tab went quietly stale. Fixed in junction, ruled as `FJS-D21`, and the refetch is gone — the table re-grades from the broadcast now. `bun run verify:live`, 14 assertions, 4 of which fail if the fix is reverted. |
| **A Mesa component cannot expose a method.** | `export function submit()` in an instance script is dropped from the compiled output entirely, so `<Form>`'s own `on:submit={submit}` threw `ReferenceError` on the first click — and VISION §10.2 documents `counterRef.reset()` as a supported API. The obvious workaround, `export let submit = async () => {…}`, emits `$$runtime.get(sig) = true` for each assignment in the body and does not parse. **No render test could catch either half**: SSR never dispatches an event. `ISSUES.md` FJS-087. |
| **An unpicked relation picker silently selected the first row.** | The kit's placeholder `<option>` was `disabled`, and a disabled option cannot hold the selection. A select whose options arrive late — which is every relation picker — lost the placeholder the moment the list repopulated and landed on the first real customer. The form then filed the order against them with nothing on screen having said so. Had been failing this drive's `form.customerStartsEmpty` for days. |
| **A control shadowed the schema's `@label`.** | `Select` and `Textarea` computed `nameToLabel(name)` and passed it down as an explicit label, so a rule's `title` could never win: `@label("Customer")` rendered as "Customer Id" and the annotation was unreachable through the kit. |
| **This drive could only be run once per database.** | It deletes an order, and `seed()` guarded everything on `product.count() > 0` — so the orders ran out, no restart brought them back, and the second run failed in ways that read as a regression in whatever you had just changed. A verification that only works once is not one; the seeder now guards per table and restores the seeded orders by reference. |
| **A click inside a portal never reached its handler.** | Mesa delegates events from the target up to a registered root, and only the app's container is one. `<mesa:portal>` appends to `document.body`, outside it — so every dropdown item, command-palette row and toast dismiss button in the kit was inert. Correct markup, correct ARIA, no error, nothing happens. **Fixed** in mesa: a portal registers its target as a delegation root, reference-counted so two open portals cannot tear each other's listener down. |
| **Every store in `@frontierjs/ui` was inert.** | `toasts.add()` queued correctly and the Toaster never rendered; ⌘K flipped a boolean nothing was listening to. A plain object is watched through `watchProxy`, and only a write through that proxy notifies — the rule this app's own `session.js` documents. All four kit stores now write through a handle. |
| **`<Modal onclick={() => open = false}>` threw on click.** | An assignment inside a COMPONENT prop was rewritten as a signal read: `$$runtime.get($$sig_open) = false`. `on:click` on an element had always been handled; the component path had not. |
| **`$: fn(), handler` emitted spliced garbage** — and threw on a `const`. | The post-call hook mixed two coordinate systems and produced `$$set_high(sa'`, sliced out of an import statement; Vite said only "contains invalid JS syntax". Separately, the hook replaces the function binding, so a `const` (`const { get: rows } = useStore(…)`) threw `Assignment to constant variable` at mount. Both fixed; the second is now a compile error that says what to do instead. |
| **A completed step kept announcing itself as the current one.** | An attribute whose only dependency was a `{@const}` was classed static and written once, while the class binding beside it stayed reactive. |
| **Compiler errors were being ignored.** | Sierra's mesa-plugin forwarded `analysis.warnings` and dropped `analysis.errors`, so a settings screen with five correctly-diagnosed `bind:` errors rendered anyway and silently collected nothing. |
| **The kit could not take an `id` or an `aria-label`.** | Its own README documents `<Button square aria-label="Delete">`. `$attributes` was every prop unfiltered, so forwarding it wrote `tone="danger"` onto the DOM; it now means what VISION says — what the caller passed that the component did not declare. |
| **`DropdownMenu` opened empty, `Table`'s loading state threw, `RadioGroup` ignored its id.** | Three kit bugs of the same kind: a `children` snippet its own docs never pass, `{#each { length: n }}` where an each needs an array, and a declared prop that reached no element. |
| **A transition declared `@system` is byte-identical in the committed access snapshot to one anybody may ask for.** | `db/access.snapshot.md` exists so *what did this branch do to who may do what* is a diff. Moving `Subscription.cancel` to `@system` is the widest narrowing a state machine can make — from *any caller at the update level, subject to the row policies* to *no caller, ever, the application included* — and the file did not change: its transitions table carries the `@gate(n)` and nothing else, so `@system` renders as `—` exactly as an ungated move does. Measured by generating it from two schemas differing in that one token; the output differs in the filename in its own header and nowhere else. `db/jsonschema.snapshot.md` has the same hole from the client's side, which is what a screen derives its buttons from (`FJS-613`) |
| **A screen resolved a related row on the line after `await`, and lost the race about half the time.** | The subscription detail page reaches its `Plan` THROUGH the version, and read `version.planId` immediately after `await watchVersion(…)`. A record view fills in through its subscribe callback, so `version` was still null, `watchPlan(null)` cleared the plan, and nothing called it again. The price tile beside it rendered correctly the whole time, and the one thing on that screen a `Plan` row cannot say — *this plan now sells at something else* — never appeared. Watched off `version` now. Silent in the direction that matters: the screen looks finished |
| **A provider's webhook can beat the reply to the call that caused it, so charging inside the create is a race the shop loses in silence.** | An off-session charge is one call at every real provider — Stripe's `confirm: true` — and the event saying *paid* arrives on the provider's own connection. If the `Payment` row is written from that call's REPLY, the webhook can reach `payments.record` first, find nothing, and answer `unknown-payment` with a 200: money taken against a row that does not exist. Minting the intent and presenting the card are two calls here, and the write sits between them. The pair falls out symmetrically as well — the shopper's confirm is unsigned because a person at a browser is the authorisation, and the shop's is signed because there is nobody there |
| **An invoice with no card on file was indistinguishable from a card that kept saying no.** | `chargeInvoice` minted an intent nobody would ever confirm, so the invoice sat `issued` — the same state a soft decline leaves it in — and dunning then ran its full twenty-one days at somebody who had never been asked for a card. It is its own answer now, `retryable: false`, because no number of attempts produces an instrument, and it mints nothing: an intent with no way to pay it is a row somebody reconciles by hand against a provider that will never hear about it again |
| **A flag and a status are not a style choice, and the rule is how many readers have to grade it.** | Two features one section apart went opposite ways on purpose. *Cancel at the period end* is a `Boolean @system`: one job reads it, at one instant, and a fifth state would have made *is this live* a set-membership question in `dueForRenewal`, `unpaidInvoices`, the dunning read and both row policies — the shape that goes wrong in one caller and nowhere else. *The bank wants the cardholder* is a STATUS: a collection must not present again, dunning must not read it as a card saying no, and a screen has to send somebody somewhere. Having both in one domain is what makes the distinction teachable instead of folklore |
| **A hook that DERIVES a `@system` column was refused by the app's own Data boundary, so every customer create over HTTP was a 403.** | `Customer.slots` is a slot-keyed mirror of the shop's own custom fields, rebuilt by a hook from `ctx.data.fields`. A hook shapes the payload and the write happens downstream on the caller's client, so the derived value arrived at the boundary indistinguishable from one the caller sent — and a `@system` column refuses that by name. litestone's hatch is `system: ['col']` on the call and junction's derived `create`/`update`/`patch` never passed it; `ctx.system.add('slots')` is the seam that closes it (`FJS-644`, `FJS-D178`). The app's own half was a MISDECLARATION: the column was `@guarded(all)`, which locks both directions and has no hatch by design, while every word of its comment argues for `@system` — the values in it are a re-keying of `fields`, which anyone who may read the customer already reads |
| **The custom-field feature was unreachable over HTTP in three separate ways, and the drive that proves it could not see any of them.** | `verify:custom-fields` is a bun drive that calls the pure functions and the client directly, so nothing between an HTTP request and them had ever run — the exact shape its own headline warns about. A method on a service definition is handed the CONTEXT, and both `custom-fields.create` and `customers.segment` were written with Feathers' `(data, params)`, so `POOL[ctx.type]` was `undefined` and both were a **500** for the life of the feature. Behind the second sat `findMany({ take })`, where litestone's option is `limit` — reachable only once the first was fixed. The `create` override went away entirely: it existed only to name a `@system` column, which a hook now does (`FJS-662`) |
| **A `PUT` to any model carrying `@version` is a 400 naming the field the request just sent.** | Junction validates `update` against the CREATE-mode schema, and `@version` is emitted for update and omitted for create — so the validator strips the version the caller sent and the Data boundary refuses the write for not carrying one. `FJS-335`'s defect exactly, one method along, unfixed because nothing here drives a `PUT` on a versioned model. Measured on a service with no hooks at all: `PUT /api/tax-rates/1` carrying the version read one request earlier is refused; the identical payload through `PATCH` is a 200. **Fixed** and ruled `FJS-D179`: `update` is `patch` with an id required, and Feathers' full replace is retired because the write never did it. Create mode's only contribution was requiredness, over a write that merges — measured, a `PUT` stating only `title` leaves `subtitle` where it was — and three layers already agreed, since the write merges, sierra grades a form for `update` exactly as for `patch`, and a sierra resource never issues `update` at all. What stays is the id, so a REST client's `PUT` can never become a bulk write (`FJS-663`) |
| **The plan said the vendor's SDK would run on a page the shop serves. It must not, and the question then does not arise.** | SCA was scoped as the first third-party script on `site/`, which is a CSP question and a static-safety question at once. It is neither: the challenge belongs to the CARD NETWORK, run by the issuer, so the shop redirects to the provider's own origin and there is nothing third-party to admit to a prerendered storefront. Hosting it would have put somebody else's script on the shop's own pages to collect the one thing every other line in this app is arranged not to see. The drive asserts where the link GOES, which is the whole of it |

And the re-skin's five:

| | |
| --- | --- |
| **A snippet inside a component tag never reached the component.** | Mesa's VISION §9.5 documents them as same-name props; they fell into the default slot instead and nothing called them. `<Table>{#snippet row(r)}…{/snippet}</Table>` drew a head and an empty body, with no error — the child's `{@render row?.()}` optional-chained over an undefined prop. **Fixed** in mesa. |
| **A snippet's arguments were frozen at first render.** | With the above fixed the rows appeared and then never changed: `{@render row(r)}` read `r` once, while the block was built. Paying an order updated the database and the pill still said `pending`. Arguments are now getters. **Fixed** in mesa. |
| **`<Table striped>` threw `striped is not defined`.** | A valueless attribute on a component compiled to a reference to a variable of that name, not to `true` — and where a local of that name existed, it silently passed that value instead. **Fixed** in mesa. |
| **The kit's field errors were not red.** | `Field` put the tone on `.field-group`, but `--bg-mix` is registered `inherits: false`, so a tone on a wrapper colours nothing inside it. Every validation message rendered in hint grey. **Fixed** in `@frontierjs/ui`, along with a swallowed `oninput`, a missing `maxlength`, a cleared number field becoming `0`, and a placeholder `<option>` whose value was its own label. |
| **The production build loaded no JavaScript at all.** | `web/index.html` mentioned a literal `<body>` tag *inside a comment*, and Vite injects the built script at the first match without skipping comments — so `<script src=…>` landed inside the comment. `bun run build` succeeded, `dist/index.html` looked right, and the page was inert with an empty console. Nobody had opened the built page. `bun run verify` now runs against it too. |

And the original eight:

| | |
| --- | --- |
| **`@@gate` + `@frontierjs/auth` works.** | The repo's `CLAUDE.md` said it could not — "the shipped resolver rejects every Junction/auth session … a verified user, and even `role: 'admin'`, both grade 1". Out of date: `FrontierGateGetLevel` was fixed on 2026-08-04 to stop reading an *absent* `verifiedAt` as "unverified", so the auto-installed default now grades a verified auth session `USER(4)` with no `getLevel` supplied at all. Verified by running it. |
| **The default still cannot reach ADMIN(5).** | It grades standing from `isAdmin` / `isOwner` / `isSystemAdmin` — booleans auth's `toContext()` does not emit — and reads `role` only as a presence check, never interpreting the string. Deliberate: `'admin'` means whatever an app decides, and guessing would hand out level 5 on a string match. So an app that grades by role says so in one place, and that place is [`api/src/core/gate.ts`](api/src/core/gate.ts). Without it, `role: 'admin'` creates fine and is refused DELETE at level 4. |
| **`sessionGateLevel()` is a hand copy of `FrontierGateGetLevel`.** | Litestone cannot import Junction (dependency direction), so the same function exists on both sides of the boundary. Change one, change both — a fix applied to only one of them is a gate that grades differently depending on which side asked. |
| **An unverified email cannot write anything.** | `emailVerified` defaults to `false` → `verifiedAt: null` → VISITOR(1) → every create 403s. Correct by the documented rule ("null means the app models this stage and this user has not reached it"), but it reads as a broken app. [`db/seed.ts`](db/seed.ts) marks the demo users verified and says why. |
| **`createClient({ db })` is silently ignored** when the schema declares `database main`. The declaration wins. Passing `db: ':memory:'` does not give you an in-memory database — it writes the declared file path and tells you nothing, so an "in-memory" probe accumulated state across runs and failed with `EmailTakenError` on the second. |
| **`$setAuth(user)` returns a scoped client; it does not mutate.** `db.$setAuth(u)` followed by `db.customer.create(…)` grades as *anonymous* — `getLevel` receives `null` — with no warning. It is `const userDb = db.$setAuth(u)`. |
| **`@guarded` is not a level.** `@guarded(5)` does not parse: `@guarded` is a system-context lock taking only `(all)`. Per-role read access to a column is field-level `@allow('read', auth().role == 'admin')`, which is what `Customer.notes` uses. |
| **The encryption key is parsed as hex.** A 64-*character* key is not a 64-hex-character key: `'dev'.padEnd(64, '0')` decodes to one byte and is rejected with `must be 32 bytes (got 1)`, which says what but not why. |
| **A `.mesa` file may not export its own filename.** | Mesa names the component function after the file, so `leads.mesa` carrying `export const leads` in `<script module>` emitted a redeclaration — clean compile, fine in dev, `vite build` fails. Same shape as the older `new.mesa` reserved-word bug, and it became the *ordinary* case the moment resources became `.mesa` (a resource file is named after what it exports). **Fixed** in `packages/mesa/src/compiler.js`, both cases, with 5 regression tests in `test/emission.test.js`. This app escaped it only by luck — `shop.mesa` exports `orders`. |
| **`make()` invented customer #0.** | A required relation key defaulted to `0`, and `0` is not "no customer" — it is customer #0. Unlike a bad enum value it passes every rule the schema can state (it is a perfectly good integer), so `coerce` kept it, `validate` approved it, and SQLite was the first thing to object: `500 FOREIGN KEY constraint failed` where the user expected "customer is required". The code already argued against exactly this for enums three lines above. **Fixed** — `x-relations[].fields` now default to null in `sierra/src/junction/resource.js`, with 5 tests including one pinning that `0` slips past validation and `null` does not. |
| **An illegal transition is a 500.** `PATCH` from `shipped` to `pending` is correctly refused at the Data boundary, but surfaces as `GeneralError` / 500 rather than 409 or 422. Same class as the constraint-violation-as-500 in Sierra's example: nothing maps Litestone's own error classes onto client-error statuses. **Not fixed** — it is a Junction error-mapping question, not an example one. |

Three smaller ones worth knowing while playing:

- **`on:blur` works, though it looks like it should not.** Mesa delegates events
  to one root listener and `blur` does not bubble — but it keeps a
  `NON_DELEGATED_EVENTS` set (`focus`, `blur`, `scroll`, `resize`) and binds
  those straight to the element. I assumed the trap and wrote `focusout`; both
  work.

- **Login is rate-limited to 10 per 15 minutes** by `createAuthPlugin`'s
  defaults. Run `bun run verify` eleven times in a quarter hour and sign-in
  starts answering 429. That is the limiter working, not a bug.
- **`bun install` resolves `workspace:*` to a copy**, not a symlink, so edits to
  a package's source are invisible here until you reinstall. If you are changing
  the framework and watching this app, that is the thing that will fool you.

---

## What is not here yet

This is phase 1 — the spine. It carries Data, API and UI with real auth and real
gates, end to end, verified. Deliberately absent:

| | |
| --- | --- |
| **A real mail client** | The confirmation email is rendered by `@frontierjs/email-kit` now, asserted to be a table document, and readable in a browser at <http://localhost:8111/> — but a browser is not a mail client, and nobody has opened one in Outlook, Gmail or Apple Mail. `bun run email:preview` writes it to a file; `curl localhost:8111/outbox/<id>/html` gets the delivered copy to forward to yourself. |
| **`static` / islands** | `site/src/routes/` prerenders a catalogue. What is unproven is an island rehydrating in the built output. |
| **Live availability across shoppers** | A hold another shopper takes does not move the number on your product page until you act; the page re-asks after each of your own actions. It is a decision, not an omission: a hold would have to travel on a channel to get there, a broadcast does not re-check the gate, and `StockReservation` is `@@gate("5.…")` for reads — so publishing them would hand every open browser exactly the rows the Data boundary refuses it. The buy box can be one hold stale; the server refuses regardless and says which of *sold out* and *in other baskets* it is. |
| **`@frontierjs/ui`'s remaining 35 components** | 29 of 64 are now driven in a browser. `DatePicker` (1200 lines), `Drawer`, `Popover`, `ConfirmationPopover` and `FileUpload` are compile-only. The way in is a screen that genuinely needs one, not a gallery. |
| **`static` / islands target, email previews** | Build-mode wings off this same app rather than separate projects. |
| **jetty, the VS Code extension** | Different containers. Out of scope for a single app, by design. |
