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
bun run api     # terminal 1 — Junction + Litestone on :8110
bun run web     # terminal 2 — Sierra + Vite on :8010
```

Open <http://localhost:8010> and sign in from the header.

**Two processes, two terminals — both are required.** Vite serves the UI and
proxies `/api` and `/ws` to the API; with the API down every
one of those is a 502 and the app says so rather than rendering plausible empty
tables.

| | |
| --- | --- |
| `bun run api` | the API realm |
| `bun run web` | the UI realm |
| `bun run verify` | drive the app in headless Chrome and assert what happened (both servers must be up) |
| `bun run verify:ui` | drive the kit's behavioural components — tabs, menus, a dialog, a palette — 27 assertions |
| `bun run verify:live` | open a watcher tab that never acts, change rows from outside it, and assert what crossed the socket — 14 assertions |
| `bun run verify:jobs` | the deferred-work realm over HTTP, no browser — 10 assertions |
| `bun run verify:notify` | the outbound boundary: mail at a real server, and who can see what — 9 assertions |
| `bun run build:public` | the PUBLIC site: prerender `src/public-site/` to `web/dist/public/` |
| `bun run verify:public` | serve that build and prove its two islands come alive in a real browser — 21 assertions |
| `bun run email:preview` | render the transactional emails to files you can open |
| `bun run build` | production build to `web/dist/client/` |
| `bun run verify:build` | build, then drive **the built app** with the same 37 assertions (needs `bun run api`) |
| `bun run preview` | serve `web/dist/client/` on :8011 with `/api` `/ws` proxied — `vite preview` carries no proxy |
| `bun run reset` | delete the database and start the seed over |

Sign in as **`sam@shop.test`** (level 4) or **`alex@shop.test`** (level 5), both
with password `correct-horse-battery`. The buttons in the header do it for you.

---

## Layout

The standard FrontierJS layout at full size — one directory per realm, the
schema above both of its consumers, configuration in `config/`:

```
example/
├── db/
│   └── schema.lite             ← the seed. Read by api/ and by web/'s build
├── api/                        ← API realm — Junction + auth
│   ├── db.ts                   ← the client, the gate plugin, autoMigrate
│   ├── gate.ts                 ← the ONE place a session becomes a number
│   ├── seed.ts
│   ├── app.ts
│   └── services/
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
```

Nothing points the UI at the schema: `web/`'s Vite root is one level below the
app root, so Sierra's auto-detection finds `../db/schema.lite` — the same file
`api/db.ts` reads. The build prints which one it found.

## Read in this order

| file | what it seeds |
| --- | --- |
| [`db/schema.lite`](db/schema.lite) | everything below |
| [`api/gate.ts`](api/gate.ts) | the role → level mapping, and why it cannot be skipped |
| [`api/db.ts`](api/db.ts) | how auth's models join the schema without a second copy |
| [`api/services/orders.service.ts`](api/services/orders.service.ts) | 3 lines. CRUD, 401s, 403s and 400s are all derived |
| [`web/src/resources/Order.mesa`](web/src/resources/Order.mesa) | names one model, and nothing else — one Resource per file, named for its noun (Invariant 19) |
| [`web/src/routes/orders/create.mesa`](web/src/routes/orders/create.mesa) | a form with no field list in it |

---

## What to look at

**The form is generated.** [`orders/create.mesa`](web/src/routes/orders/create.mesa)
contains no field names, no types, no enum values, no required flags, and no
mention of the customers service. Rendered, it produces exactly seven controls:

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
[`orders/create.mesa`](web/src/routes/orders/create.mesa) follows one rule: *on
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
[orders.service.ts](api/services/orders.service.ts) reduces every move to
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
that target is [`api/mail-sink.ts`](api/mail-sink.ts) — a dev mail catcher on
:8111 speaking the shape a provider REST API speaks. A separate listener on
purpose: an in-process fake would prove the payload is built and nothing else,
while over a real socket the credential really resolves (the sink 401s without
it) and `POST /fail-next` makes the provider fail so the retry path is a test
rather than a claim. Read what the shop has sent:

```bash
curl localhost:8111/outbox
```

The mailer is [`api/mailer.ts`](api/mailer.ts): Junction's `IMail`, implemented
over `app.conduit.send()`. Pointing it at the real api.resend.com is a change of
`address` and `ref` in [`api/app.ts`](api/app.ts) and nothing else — a target
holds a credential *reference*, resolved at send time, never a key in a closure.

**The email body is a `.mesa` file.** [`api/emails/order-confirmation.mesa`](api/emails/order-confirmation.mesa)
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
saying so. A background job has no session, so `api/gate.ts` declares `SYSTEM`:
work with no caller still has a principal, graded in the one place every
principal is graded.

**The nightly sweep is run rather than waited for.** `sweep-abandoned` cancels
orders left `pending` past a horizon, at 03:00. A cron you can only observe
through `nextRuns()` is a schedule, not a behaviour:

```bash
curl -X POST localhost:8110/jobs/run/sweep-abandoned -d '{"days":0}'
```

That route did not exist until this app needed it.

---

## Verified

Nothing in this file is asserted from reading the source. `bun run verify`
drives the app in headless Chrome — navigating, signing in, typing into fields
and leaving them, filling the form, submitting, deleting, signing out — and
asserts 37 facts about what a real browser ended up showing. Five sibling drives
add 79 more — the kit's behavioural components, real-time from a second client,
deferred work, the outbound boundary, and the prerendered public site. Last run:

```
all 37 assertions passed        (dev AND the production build, 0 console errors)
all 27 assertions passed        bun run verify:ui
all 14 assertions passed        bun run verify:live
all 10 assertions passed        bun run verify:jobs
all  9 assertions passed        bun run verify:notify
all 21 assertions passed        bun run verify:public   (the built static site)

116 assertions, six drives, twice consecutively against one database.
```

`verify:public` is the one with no application in it. `web/dist/public/catalog/
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
asked who had sent it:

| | |
| --- | --- |
| **A watcher tab proved a rename nobody meant to make.** | The `@system` work moved the courier job off `patch` and onto a `recordTracking` action, and a custom action **announces under its own name** — so the live event stream said `orders recordTracking` where `verify:live` expected `orders patched`. Nothing else could see it: junction's suite, `verify` and `verify:jobs` were all green, because a broadcast's NAME is only observable from a second tab. The expectation was updated rather than the code — the new name is the correct one, and it is now the drive's record of a design decision rather than of a mechanism. |
| **Every overlay in the kit was invisible, and the palette froze the app.** | `{@attach}` ran when an element was BUILT rather than when it mounted, so the attachment saw a detached node — and `el.animate(…, { fill: 'forwards' })` on a disconnected element returns an animation that never starts, even once it is connected. Every kit overlay painted at keyframe 0. CommandPalette is `position: fixed; inset: 0; z-index: 9000`, so clicking **Search ⌘K** put an invisible sheet over the page that swallowed every click: "nothing happens and the app is unresponsive". Reported by the owner, not by a drive — `verify:ui` was 26/26 green against it, because every assertion asked whether the DOM was there. It now opens the palette by clicking the button and asserts opacity, hit-testing and size. `FJS-114`. |
| **A `.mesa` route was compiled as MARKDOWN — but only by the prerenderer.** | Mesa routed any source beginning with `---` to its Markdown compiler, and a `---` block is how every Sierra route states its title. Markdown escapes what it does not recognise, so `<CatalogList client:load products={…} />` came out as a paragraph of ESCAPED TEXT with the props stringified into it, while `<LiveStock />` beside it compiled as a component and mounted correctly. Sierra's Vite path strips frontmatter first, so dev and the SPA build were right and the static build was wrong **for the same file**. The extension decides the language now. `FJS-106`. |
| **Every prerendered `<input>` carried `formaction="http://localhost/"`.** | happy-dom's `cloneNode` re-derives an input's attributes from default properties, so each instance of a template gained the build machine's own URL. `formaction` overrides its form's action — a prerendered form would post to whoever built the site. Mesa parses per instance on the server now. `FJS-107`. |
| **A prerendered page linked no stylesheet and had no theme.** | It shipped every `@frontierjs/css` class name in the app and not one rule behind them, because a static document is assembled by Sierra and Vite's HTML transform never runs on it. The SPA built from the same source looked right, which is why nobody had seen it. `document: { bodyClass }` plus automatic linking of the build's CSS assets. `FJS-108`. |
| **A prerendered page could publish gated data, and nothing checked.** | Adding one `render: static` route to this app found a fail-OPEN hole in the check being built to stop exactly that. `importCompanion` swallows an import error and returns null, so a `.meta.js` that *throws on import* was indistinguishable from a route with no companion and was waved through as "reads nothing" — which is what happened on the first `bun run build:public`, run under Node, where the companion's db import died on `bun:sqlite`. The page was emitted anyway. A companion that exists but could not be read is now UNKNOWN, which is the one case the check exists to refuse. `ISSUES.md` FJS-081; `web/src/public-site/catalog/` is the route. |
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
| **A Mesa component cannot expose a method.** | `export function submit()` in an instance script is dropped from the compiled output entirely, so `<Form>`'s own `on:submit={submit}` threw `ReferenceError` on the first click — and VISION §10.2 documents `counterRef.reset()` as a supported API. The obvious workaround, `export let submit = async () => {…}`, emits `$runtime.get(sig) = true` for each assignment in the body and does not parse. **No render test could catch either half**: SSR never dispatches an event. `ISSUES.md` FJS-087. |
| **An unpicked relation picker silently selected the first row.** | The kit's placeholder `<option>` was `disabled`, and a disabled option cannot hold the selection. A select whose options arrive late — which is every relation picker — lost the placeholder the moment the list repopulated and landed on the first real customer. The form then filed the order against them with nothing on screen having said so. Had been failing this drive's `form.customerStartsEmpty` for days. |
| **A control shadowed the schema's `@label`.** | `Select` and `Textarea` computed `nameToLabel(name)` and passed it down as an explicit label, so a rule's `title` could never win: `@label("Customer")` rendered as "Customer Id" and the annotation was unreachable through the kit. |
| **This drive could only be run once per database.** | It deletes an order, and `seed()` guarded everything on `product.count() > 0` — so the orders ran out, no restart brought them back, and the second run failed in ways that read as a regression in whatever you had just changed. A verification that only works once is not one; the seeder now guards per table and restores the seeded orders by reference. |
| **A click inside a portal never reached its handler.** | Mesa delegates events from the target up to a registered root, and only the app's container is one. `<mesa:portal>` appends to `document.body`, outside it — so every dropdown item, command-palette row and toast dismiss button in the kit was inert. Correct markup, correct ARIA, no error, nothing happens. **Fixed** in mesa: a portal registers its target as a delegation root, reference-counted so two open portals cannot tear each other's listener down. |
| **Every store in `@frontierjs/ui` was inert.** | `toasts.add()` queued correctly and the Toaster never rendered; ⌘K flipped a boolean nothing was listening to. A plain object is watched through `watchProxy`, and only a write through that proxy notifies — the rule this app's own `session.js` documents. All four kit stores now write through a handle. |
| **`<Modal onclick={() => open = false}>` threw on click.** | An assignment inside a COMPONENT prop was rewritten as a signal read: `$runtime.get($$sig_open) = false`. `on:click` on an element had always been handled; the component path had not. |
| **`$: fn(), handler` emitted spliced garbage** — and threw on a `const`. | The post-call hook mixed two coordinate systems and produced `$$set_high(sa'`, sliced out of an import statement; Vite said only "contains invalid JS syntax". Separately, the hook replaces the function binding, so a `const` (`const { get: rows } = useStore(…)`) threw `Assignment to constant variable` at mount. Both fixed; the second is now a compile error that says what to do instead. |
| **A completed step kept announcing itself as the current one.** | An attribute whose only dependency was a `{@const}` was classed static and written once, while the class binding beside it stayed reactive. |
| **Compiler errors were being ignored.** | Sierra's mesa-plugin forwarded `analysis.warnings` and dropped `analysis.errors`, so a settings screen with five correctly-diagnosed `bind:` errors rendered anyway and silently collected nothing. |
| **The kit could not take an `id` or an `aria-label`.** | Its own README documents `<Button square aria-label="Delete">`. `$attributes` was every prop unfiltered, so forwarding it wrote `tone="danger"` onto the DOM; it now means what VISION says — what the caller passed that the component did not declare. |
| **`DropdownMenu` opened empty, `Table`'s loading state threw, `RadioGroup` ignored its id.** | Three kit bugs of the same kind: a `children` snippet its own docs never pass, `{#each { length: n }}` where an each needs an array, and a declared prop that reached no element. |

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
| **The default still cannot reach ADMIN(5).** | It grades standing from `isAdmin` / `isOwner` / `isSystemAdmin` — booleans auth's `toContext()` does not emit — and reads `role` only as a presence check, never interpreting the string. Deliberate: `'admin'` means whatever an app decides, and guessing would hand out level 5 on a string match. So an app that grades by role says so in one place, and that place is [`api/gate.ts`](api/gate.ts). Without it, `role: 'admin'` creates fine and is refused DELETE at level 4. |
| **`sessionGateLevel()` is a hand copy of `FrontierGateGetLevel`.** | Litestone cannot import Junction (dependency direction), so the same function exists on both sides of the boundary. Change one, change both — a fix applied to only one of them is a gate that grades differently depending on which side asked. |
| **An unverified email cannot write anything.** | `emailVerified` defaults to `false` → `verifiedAt: null` → VISITOR(1) → every create 403s. Correct by the documented rule ("null means the app models this stage and this user has not reached it"), but it reads as a broken app. [`api/seed.ts`](api/seed.ts) marks the demo users verified and says why. |
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
| **A real mail client** | The confirmation email is rendered by `@frontierjs/email-kit` now and asserted to be a table document — but nobody has opened one in Outlook, Gmail or Apple Mail. `bun run email:preview` writes it to a file; `curl localhost:8111/outbox` gets the delivered copy to forward to yourself. |
| **`static` / islands** | `web/src/public-site/` prerenders a catalogue. What is unproven is an island rehydrating in the built output. |
| **`@frontierjs/ui`'s remaining 35 components** | 29 of 64 are now driven in a browser. `DatePicker` (1200 lines), `Drawer`, `Popover`, `ConfirmationPopover` and `FileUpload` are compile-only. The way in is a screen that genuinely needs one, not a gallery. |
| **`static` / islands target, email previews** | Build-mode wings off this same app rather than separate projects. |
| **jetty, the VS Code extension** | Different containers. Out of scope for a single app, by design. |
