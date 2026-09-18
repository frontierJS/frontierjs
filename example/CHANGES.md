# Changes — example

## 2026-09-16 — a screen the device has never opened

`verify:shell` signs in and then opens `/inventory` **offline, for the first time
in that browser, with the list cache emptied**. Nothing wrote through a `load()`,
and the cache cannot hold a question nobody asked — so the only thing left that
can answer is a table the warm filled. Removing the write-through turns it red.

The shell is 880 → **881 kB**; hydration costs 1 kB.

## 2026-09-16 — the stockroom reads from the device's own SQLite

`offline: { db: true }`. The list cache answers the exact question it was given; the ledger at
`/inventory` is now answered by a query engine, so a filter, a page or a sort nobody asked before the
outage is still answerable. Costs **880 kB** over the wire against 278 — 341 kB of that is SQLite's
wasm — recorded in `web/offline-baseline.json` as a deliberate `FJS-D302` ratchet.

**`verify:shell` grades it with the cache emptied.** Every other assertion in that drive passes with
the database absent, because the cache underneath holds the same rows for the same question: the
block that matters clears `fjs-lists` with the network already down and asks the screen again. Its
CDP calls are bounded now, so a renderer that dies fails by name rather than sitting there — which is
how `FJS-1179` was filed as a hang.

`preview.mjs` serves `.wasm` as `application/wasm`; a browser refuses to stream-compile anything else
and says so only in the console.

Newest first. What this app built and what building it found; live state is `PROJECT_STATE.md`, framework defects are `../ISSUES.md`.

## 2026-09-16 — the ledger is held before it is needed

`InventoryMovement`'s resource declares `offlineQuery: { directives: { limit: 40,
orderBy: '-id' } }` — the question `/inventory/` opens on, character for
character, because the cache is keyed by the QUESTION and a warm under a
different `limit` fills a slot that screen never reads (`FJS-D307`).

**And `web/src/main.js` imports that resource at boot**, after `virtual:sierra`,
which is what builds the client every resource is created against. A declaration
is registered when its module is evaluated and a route's modules are code-split,
so without the line the screen nobody has opened declares nothing — which is the
one case the declaration exists for. Which resources are worth the entry chunk is
the app's decision, so it is a line here rather than a glob in the framework
(`FJS-1178`). Measured: the shell stayed at 277 kB.


## 2026-09-16 — the ledger and the count sheet say `append`

`FJS-D304` gave `@@sync` a word for what both models' comments were already describing in prose.
`InventoryMovement` and `StocktakeCount` are `@@sync(append)`: a movement and a shelf count are rows
that are added and never edited, so there is no collision to resolve rather than one resolved by the
server. `StocktakeSheet` stays `server` — it is closed by a patch.

The offline shell went 276 → **277 kB** and the budget stopped the build (`FJS-D302`), which is the
mechanism working: the kilobyte is the `APPEND_ONLY` refusal naming the model, the method and what to
do instead, and paying for it is recorded here rather than absorbed.

## 2026-09-16 — the shell has a number, and wa-sqlite was weighed against it

`web/offline-baseline.json` — **276 kB over the wire** (317 gzip, 982 raw), adopted and now graded on
every build (`FJS-D302`). A build that grows fails with both numbers.

**And the thing the budget exists to decide was measured** (`wa-sqlite@1.0.0`, `IDEAS/homestead.md`
phase 4). The figure quoted when `FJS-D305` was ruled — *~1.2MB of wasm* — is the RAW size of the
asyncify build, which the OPFS path does not need. The engine an app would actually ship is the sync
build with `AccessHandlePoolVFS`: **254 kB brotli**, smaller than the shell this app already serves.
The async VFSs cost 349-353 kB, so the VFS choice is a third of the engine's weight and not only a
correctness question.

The engine does not stay out of the shell either: a dynamic import keeps it off the first visit, but an
app that reads offline must have it cached before the network goes, so this baseline would roughly
double. That is the budget working — the doubling is a line in a file somebody approves rather than
something discovered on a train.

## 2026-09-16 — the shop opens with no network — `verify:shell`

`offline: true` in `web/config/sierra.config.js` is the whole of the app's side. The build now prints
what it costs: **89 files, 980 kB precached**, which is the byte question in
`IDEAS/offline-first-and-release.md` becoming a number.

A new drive, `bun run verify:shell` (23 assertions, test tier 7011). It is separate from
`verify:offline` because a service worker only exists in a BUILD, and registering one against the dev
server would fight vite's HMR — the trap that drive already spent two wrong conclusions on. So this one
builds, serves `dist/` through the same `preview.mjs` `verify:build` uses, and drives that.

**Its sharpest assertion is the negative one**: with the network down, a request under `/api` must
FAIL. A shell that has quietly become a cache in front of the server is worse than an error page, and it
has no symptom.

**Two findings in `example` itself.**

`/inventory` loaded the computed levels and the ledger in one `try`, levels first. Fine on a network and
wrong with none: levels is a join and a clock that nothing can keep, so it threw and the ledger below it
was never asked for — the screen showed nothing when half of it was on the device the whole time. They
now fail separately, and the alert only appears when both went.

And the drive's rebuild block passed while proving nothing: a reproducible build gives unchanged sources
the same hashes, so it printed one cache digest twice and called it a new shell. It now writes a real
file into `public/` for one build — a `.js`, because the shell is code and pages and a `.txt` is
precached by nothing — and removes it in `finally`.

## 2026-09-16 — and a photograph of the damage, taken where there was no signal

`StocktakeCount.damage` is a `File?`, and `verify:offline` is now **44 assertions**: a count and its
photograph are made with nothing reachable, the row lands first and the bytes follow as a patch naming
it, and the assertion is that **a browser decodes what comes back** — a ref with no object behind it
answers a URL, and a URL is not a photograph.

**`File?` and not `File`, and the advisor is what says so.** A held write replays the row without its
bytes, so a required column would arrive empty and be refused — offline, the model could not be created
at all.

**The finding this cost: a `@@sync` model carrying a `File` needs `patch` on its service.** The bytes
arrive on that verb. `stocktake-counts` was declared append-only — `find`, `get`, `create` — which is
right about counts and wrong about their photographs: the second half of every held write came back
405 and the photograph sat in the device's queue with nothing saying why. Worth an `fli check` rule,
which is the layer that can see a service and a schema at once.

**And the screen reads the file on CHANGE, not out of the DOM at submit.** The form re-renders after
every count lands, so a submit handler reaching for the input finds a fresh one holding nothing and the
photograph vanishes with no error. That cost a debugging round.

## 2026-09-16 — a stocktake, counted in a room with no signal

`StocktakeSheet` and `StocktakeCount` — the shape phase 1 could not prove. A correction to the ledger
is one flat row nothing references, so its key can be assigned whenever the server finally sees it. A
stocktake is a sheet and its counts, written in the same minute in a stockroom, and the count has to
name the sheet before anything has been inserted anywhere.

Both declare `String @id @default(uuid())` beside `@@sync(server)`, which is what makes that
expressible: litestone crosses `x-mint`, sierra states the key on the create, and `/stocktake/`
advances on a key the browser made rather than on a server answer. `InventoryMovement` keeps `Int @id`
and is right to — nothing references a movement.

**`verify:offline` is 38 assertions and the new ones are about the REFERENCE**: the id on screen with
no server reachable is the id the server ends up holding, every count names it, and the counts arrive
against a sheet that was queued ahead of them. Closing posts one `adjusted` movement per shelf that
disagreed, and a second close answers 409 — a stocktake posted twice is a shop that has invented
stock.

**The drive counts one more than the shelf holds, read fresh.** A fixed number passed once and then
posted nothing on every later run, because the close it had just made had moved the shelf to exactly
the number it counts — the same non-rerunnable trap phase 0 hit, in a new place.

## 2026-09-16 — the ledger may be written with no server, and `verify:offline` inverted

`InventoryMovement` declares `@@sync(server)`: a correction is made where the stock is, in a
stockroom on a phone with one bar of signal, so a write to the ledger is held on the device and
replayed when a server is reachable. It is safe to say on THIS model because a movement is
appended — two people counting one shelf produce two movements, which is the truth about what
happened, where two people editing one row would produce a conflict.

**`verify:offline`'s two `LOST` assertions inverted, which is what phase 1 was for.** A correction
made with the socket severed now arrives once the network returns; and one made in a page that then
navigated away with the network still down arrives too, which is the assertion an in-memory queue
cannot pass — it needed real storage, and it is the one that says a phone may sleep in a stockroom.

**The inventory screen moved onto the resource.** It called `getClient().service('inventory')`,
which reaches the same server method and passes through none of the resource pipeline — so the
queue never saw the write, and the drive kept reporting a loss with the feature built. The raw
client is the documented escape hatch and taking it costs the queue along with the hooks; that is a
capability line, since a replay has to send the post-hook payload and the raw client has none.
`movements.service` is the same call on the paved road.

## 2026-09-16 — `verify:offline`, and a socket that had not noticed

Phase 0 of the Homestead work (`../IDEAS/homestead.md`): the drive that measures what this app does
with no server reachable, written before any of the engine exists. `web/test/lib/offline.mjs` puts
a real Chrome offline over CDP for the duration of a block and restores it on the way out, throw or
not. 21 assertions, green.

**A write made offline is lost. There is no retry anywhere in the client, and the drive spent two
wrong conclusions finding that out.** Chrome's `Network.emulateNetworkConditions` refuses new
connections and carries frames on a socket that is already open, so the first version reported the
write arriving by itself once the network returned. That looked like a retry. It was the Junction
client's WebSocket, which is same-origin in dev because the dev server proxies `/api` and `/ws` —
and the harness severed sockets by ORIGIN, to spare vite's HMR channel, so it skipped the only
socket that mattered and reported *nothing to cut*. One flawed rule produced two confident
findings, neither true. Vite's socket is told apart by its subprotocol, `vite-hmr`, and never by
where it points.

So the drive takes **three readings of one act**, and the contrast is what it is for: with the
socket severed the correction is lost; with the socket left open the outage is **masked** — the
write lands when the network returns and the screen is never told anything was wrong; across a
reload it is lost again. The middle reading is a requirement phase 1 inherits: **a queue entry
clears on an acknowledgement, never on a send.**

The write is a real one on a real screen — the adjustment form on `/inventory`, whose reason list
already says *Stocktake correction* — rather than a `fetch` from the page, because a raw fetch
would still be lost after phase 1 and the control would never invert. It is paired with the same
submit made with the network up, so *lost* cannot be read off a selector that stopped matching.

**Drive hygiene cost more than the capability.** The first version took one off the same shelf every
run and the fourth run was refused with `has 0 on hand`, which reads exactly like a lost write; the
shelf is chosen now — the variant with the most on hand — and the writes are paired, +1 with the
network up and -1 with it down. A successful adjust reloads the shelves and holds `ajBusy` across
that reload, so a fill landing mid-re-render sets a variant the option list does not hold yet and
the submit button stays disabled forever: the fill re-applies inside the enable poll, and each
offline block waits for the previous write to settle first.

## 2026-09-15 — staff draft automations, and an administrator watches theirs

`db/schema.lite` narrows orion's USER(4) create to staff —
`extend model Flow { @@deny('create', auth().isStaff != true) }` — because a storefront shopper
grades 4 exactly as staff do ([`FJS-1169`](../ISSUES.md#fjs-1169)), and the Automations link
shows for `isStaff` rather than level 4. `verify:automations` asserts Robin sees no link and is
refused a draft, Sam drafts one, and Alex activates Sam's flow and watches its run arrive on the
open runs screen and complete — the screen half of
[`FJS-1170`](../ISSUES.md#fjs-1170), which the row policy reading `auth().level` closed. `verify:ui`'s
palette row expects the five commands `ord` matches (`FJS-1168`).

## 2026-09-15 — `verify:automations`

The drive for orion's screens (`DRIVES.md`), and a nav link to them at USER(4). `joinChannels`
joins orion's `flows` and `runs`, so a run started by a write elsewhere reaches an open runs
screen. **Found by it**: five framework defects (`FJS-1162`–`FJS-1166`), and that orion's runs
and flows were readable by every USER(4) — here a shopper read another customer's row out of
`/api/runs` that `/api/customers/:id` refused her ([`FJS-1167`](../ISSUES.md#fjs-1167)). Ruled
[`FJS-D295`](../DECISIONS.md#fjs-d295) and fixed in orion; the drive now asserts staff and a
shopper read nothing of the administrator's flow or its run. Alongside
it, `verify:ui`'s palette row turned out stale ([`FJS-1168`](../ISSUES.md#fjs-1168)).

## 2026-09-15 — automations

Orion is installed. `db/schema.lite` imports `@frontierjs/orion/orion.lite`, so each shop's
file holds its own flows, runs and waits (`FJS-D294`); `api/src/app.ts` configures
`orion({ level: shopGateLevel })` after the queue; and `web/src/routes/automations.mount.js`
mounts orion's screens at `/automations/` by one line (`FJS-D282`). **Found by installing it**:
orion's services graded an administrator by junction's `sessionGateLevel`, under which a shop's
`role: 'admin'` is USER(4) though every model here grades it 5 — hence `level`, and `FJS-1161`
for junction's own method gate, which has the same split. The screens build and are in the route
snapshot; no drive runs them yet.

## 2026-09-14 — a billing period is DAYS (`FJS-D288`)

The interim the entry below left: a period was still an instant, `advancePeriod`
clamped month ends in UTC, and `/orders/`' *Today* was the viewer's day. All
three are gone, and none of it needed new grammar — `String @date` already
validates `YYYY-MM-DD`, reaches the browser as `<input type="date">` and orders
correctly as text.

**What moved.** `Subscription.currentPeriodStart`/`End`, `Invoice.periodStart`/
`End`, `InvoiceLine`'s narrower pair, and `Invoice.dueAt` — now `dueOn`, because
a day called `…At` reads as an instant. `issuedAt` and `paidAt` stay instants:
they are when a document was written and when money arrived.

**Why.** Measured for a New York shop, advancing an instant by a month in UTC:
the evening of 30 March became 29 April, 30 January became 27 February, and a
period crossing a clock change moved by an hour as well. A plain date has no zone
to be read in, so the same period is the same two days everywhere.

**The zone is now spent at two crossings and nowhere else.** `plainDateIn` turns
the instant of a change into the shop's day; `startOfDay` turns a day into the
instant a screen filters by. Between them there is none — which is why
`describeSpan` takes no zone any more, and why the line text and every screen
read the same two strings by construction rather than by agreement.

**Three rules follow.** A period is `[start, end)`, so *due* is
`currentPeriodEnd <= today` in the shop's calendar and the text names the LAST
day covered — `30 Aug – 28 Sept`, not `29 Sept`, which the next period charges
for. Proration counts whole days, so every instant of a day is the same slice;
by milliseconds an evening upgrade was cheaper than a morning one. Terms are
days from the shop's day of issue, so seven days from 23:30 in New York is the
7th day on its calendar.

**`/orders/`' date filter is the shop's day too.** The picker speaks the
browser's calendar, so a picked day is read back in the viewer's zone and turned
into the shop's window; *Last 7 days* was `today − 6 × 24h`, an hour out across
a clock change.

Payroll's effective-dated rates and pay windows are the same shape and are not
converted — `FJS-1152`. Drives: `verify:billing` 34/34 (with
`renew.periodIsPlainDates`), `verify:proration` 35/35 (`span.namesTheDaysItCovers`,
`slice.theShopsDayDecidesIt`, and every-instant-of-a-day), `verify:collect`
49/49, `verify` 66/66, `verify:account` 44/44, `verify:tenants` 28/28,
`verify:jobs` 12/12.

## 2026-09-14 — a shop keeps a calendar (`FJS-1149`)

An invoice page named two days for one period. The line text is frozen with the
row and `describeSpan` froze it in UTC; the header above it, and seven other
screens, read the same instants in the viewer's zone through eight copies of one
`toLocaleDateString` helper. At UTC-7 that was *For Aug 29 – Sep 28* over *30 Aug
– 29 Sept*.

**The calendar is the shop's, and it is configuration.** `timeZone` joins
`name` and `mail.from` in `tenantConfigKeys`, over `TIME_ZONE_FLOOR` (`UTC`) in
`api/src/core/db.ts`. `describeSpan` takes it as an argument all the way down —
`periodLines`, `prorate` and `changePlan` each state one, and `renewSubscription`
takes it as a second argument — so the domain reads no ambient config and every
drive states the calendar it bills in. `shopfront.settings` answers it;
`web/src/datetime.js` reads it once before `main.js` mounts and owns `day()`,
which the eight screens import; the site's Account island asks for it with the
rows it dates. Names stay in the reader's locale, because the order of a day and
a month is theirs and which day it is belongs to the shop.

A shop that sets nothing writes exactly what it wrote before: the kit's `D MMM`
in en-GB and the old `toLocaleDateString` agree on all twelve months, on node and
on bun. The flagship sets nothing, so an existing database's invoices stay
consistent without a reseed.

**Interim, and C replaces it.** A billing period is still an instant, `advancePeriod`
still clamps month ends in UTC, and `/orders/`' *Today* filter is still the
viewer's day. Each is `FJS-D143`'s — a declared plain date and a zoned window —
and not configuration.

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
