# PROJECT_STATE — `example/` (the kitchen sink)

**As of 2026-08-06.** Read `README.md` first for what the app *is*; this file is
what is built, what is proven, and what to pick up next.

Everything below was verified by running it. Where it was not, it says so.

---

## Status

| | |
| --- | --- |
| **Runs** | yes — `bun run api` + `bun run web`, two terminals |
| **Verified** | **938 assertions across twenty-seven drives, all passing against one database**: `verify` **56/56** (dev *and* production build, and the only place a person types money that is not a product price), `verify:ui` **35/35**, `verify:values` **14/14**, `verify:live` **17/17**, `verify:jobs` **12/12**, `verify:notify` **9/9**, `verify:pay` **22/22** (the payment provider, both directions signed, refunds included), `verify:site` **45/45** (the prerendered site, in the built output, and the price list whose baked prices an island corrects), `verify:catalogue` **35/35** (and the photograph a person uploads, chosen in a real file input), `verify:cart` **32/32** (the basket, and the itemised order it becomes), `verify:money` **107/107** (what a basket costs and why — a discount, a delivery threshold and a tax rate in one arithmetic, the race for the last redemption of a code, the five `@@check` constraints at both boundaries, and since the ledger landed the same sale read out of the BOOKS: one balanced journal per checkout whose five accounts reconstruct the receipt, and the two refusals that make it append-only — staff may neither restate nor delete an entry), `verify:stock` **41/41**, `verify:widget` **37/37**, `verify:tenants` **26/26** (many shops, one file each — and one NAME each, which is not a row), `verify:extension` **13/13** (the shop in a browser toolbar, loaded unpacked into a profile), `verify:account` **27/27** (a shopper with an account, on the static storefront — their orders, their subscriptions and their invoices, and the one move the schema lets them make), `verify:revisions` **38/38** (taking a row back, and two people editing one), `verify:users` **29/29** (user management — the roster read through a policy rather than refused by a gate, a field write declining in silence beside an admin's identical payload, a create policy that REFUSES where a read filters, and an account made whose invitation had to reach the outbox because the row alone cannot sign in), `verify:shop` **13/13** (buying something on the shop's own storefront — the buy box, the basket across a real navigation, and the checkout, all cross-origin), `verify:billing` **33/33** (a cycle renewing on a clock the drive stands at, and a dunning deadline that keeps no counter), `verify:proration` **21/21** (a change mid-cycle, every assertion a SUM — six seats at 9.99 with 19 days left splits into six lines that are each plausible and are two minor units short of what was taken), `verify:employment` **61/61** (what was true on the 12th — the as-at read written by hand, a raise that must not move a past answer, the band walk with the classic wrong answer as its negative control, and the constraint `FJS-603` closed, asserted in both tables: a second OPEN window is refused by the TABLE — through `asSystem()` and through a raw INSERT, which is what separates a rule the database holds from one a service does — while every CLOSED window is untouched, which is why the predicate is the constraint), `verify:payrun` **41/41** (one period, everybody, and the two documents — a YEAR split across periods so twelve months sum to it exactly, a cross-row invariant carrying a predicate over its child because the employer's contributions do not count toward net, and a past period reprinted identically after the salary underneath it doubled), `verify:batch` **33/33** (a pay run interrupted and resumed — one idempotent unit of work per person, only the missing payslips made, and the finish asserted against the LEDGER rather than a job count, because a job count is what a double-payment bug agrees with; plus the two jobs that choose opposite dispatch keys, `unique` for resumable work and the id for what cannot be un-sent), `verify:retro` **56/56** (a raise backdated across three already-paid periods — every closed payslip byte-identical afterwards, which `@immutable` enforces; the arrears landing as lines on a later one, named to the run each corrects; the same arrears once across a revert and again after a second backdate that corrects only the remainder; and the superseded belief found where it actually survives, in the audit log), `verify:payroll` **63/63** (the console — the roster, a salary typed in dollars into a column that holds cents, a date box that turns the same write from a raise into a correction, the as-at read answered by the server, a run calculated, approved and paid with its journal balancing on screen, and the adjustment lines badged with the run each one corrects; plus the ladder finding — payroll reads at 5, so a level below sees no screen at all and the per-transition gate never gets a chance to matter), `verify:collect` **28/28** (one call out, one signed event back, a decline as a domain answer, an event arriving out of order — and the only end-to-end run of the cycle: sweep → renew → issue → collect → present → paid, four handoffs through the real queue), 0 console errors. **Repeatable** as of 2026-08-26 — the seeder restores what the drive consumes (was single-shot, `FJS-080`), every drive that moves a global list asserts against the SEEDED rows rather than the table, and every drive that creates an order under a fixed `@unique` reference now RELEASES that reference rather than deleting the row again. Three of them did not: `Order` soft-deletes and a soft-deleted row keeps its `@unique` values, so a drive whose cleanup is a DELETE over HTTP leaves the reference held by a row no ordinary read returns, and passes exactly once per database (`FJS-546`). `db:seed` sitting in everyone's preamble is why nobody saw it — and two flakes were only reachable once the drives could run twice at all (`FJS-547`) |
| **Builds** | yes — `bun run build` → `web/dist/client/` + robots.txt + sitemap (5 URLs). The built page is now driven too; until 2026-08-04 it loaded no JavaScript at all. `bun run build:site` → `site/dist/`, the prerendered public site, driven by `verify:site` |
| **Phase** | 1 (spine), **all of 2** (state machine + live updates), **deferred work** (caravan), **outbound + notifications** (conduit, notifications), **static + islands** (the public catalogue, proven interactive in the built output), the `@frontierjs/ui` re-skin, the four screens that drive the kit's behavioural components, and the shop: a catalogue with variants and photographs, a basket a stranger owns, a currency toggle, **inventory with reservations**, **an order that records what was bought**, and a **`widgets/` surface** whose buy button runs on a page the shop does not own |
| **Committed** | **no.** `example/` is untracked; the package changes it drove are unstaged |

The app is a shop: `Product`, `Customer`, `Order`, one `db/schema.lite`, real
auth with a gate ladder, and an order state machine driven from the UI.

Packages exercised: **every one of them** — litestone, junction, auth, sierra,
mesa, css, ui, caravan, conduit, notifications and **email-kit**. Out of scope
by design: jetty (a different container) and the VS Code extension.

---

## What is proven

Each of these is an assertion in one of the eight drives, or a line in the
README's *Verified* section — not a claim.

- **A stranger can buy something.** `Cart` and `CartLine` are `@@gate("0.0.0.5")`
  reached by `@@allow('read', token == auth().cartToken)`, the claim comes from
  `createApp({ principal })` running for a caller with no session, and the token
  rides `x-cart-token` over HTTP and over the socket alike. `verify:cart` adds
  to a basket with the connection live, so the header is proven to have crossed
  a WebSocket frame and not just a request.
- **Somebody is billed every month, at the price they were sold at.** A `Plan`
  is what is on offer and a `PlanVersion` is what it cost over a WINDOW, so
  raising a price is closing one window and opening the next — never a PATCH,
  because `price` and `effectiveFrom` are `@immutable` and `asSystem()` does
  not drop that. `Subscription` names a version rather than a plan, so a
  reprice moves nobody, and the console asserts exactly that: the new window
  has no subscribers and an older one still does. An `Invoice` is a DOCUMENT —
  every figure, the number and both dates frozen at the moment it is issued —
  and the correction is a `CreditNote` beside it, which is what lets the
  renewal job run as the system without being able to restate a total. **The
  moment is now DECLARED** (`FJS-D167`): `issue: draft -> issued @seals` says
  when, `lines InvoiceLine[] @sealed` says which children go with it, and
  `issueInvoice` writes a header, adds its lines and then seals. `draft` had
  been removed from this schema because `@immutable` froze at CREATE — the
  language shaping the domain — and what the seal buys is not a visible draft
  state but the two operations `@immutable` could not reach: after it, nothing
  in this app, `asSystem()` included, can add a line to an invoice or take one
  away. `payments` deliberately carries no `@sealed`, because a payment against
  an issued invoice is exactly the row that must keep arriving.
- **A price is typed in dollars and stored in cents, on a form that names no
  field.** `PlanVersion.price` is `@money(USD)`, and `web/src/money-control.js`
  resolves a control off `x-money` on the RULE — not off a column name — so the
  box, its step and its two conversions come from the schema. `verify` types
  `31.50` into a browser and then asks the database, which answers 3150.

- **A buy button runs on a page the shop does not own.** `widgets/` is a third
  surface beside `api/` and `web/` — its own Vite root, its own host pages, its
  own static release. One `.mesa` becomes one self-contained IIFE mounted in a
  shadow root by a custom element. It is the only thing here that is
  cross-origin, so it is the only thing that needs CORS and a real preflight for
  `x-cart-token`; and because `localStorage` is per origin, the basket it starts
  cannot be read by the shop's own site. What crosses is a **one-time code** in
  the URL fragment — `carts.handoff` mints it, `carts.redeem` spends it in the
  transaction that reads it — never the token. `verify:widget` stands up four
  origins and proves all of it in a browser, hostile host CSS included.
- **This is a fleet of shops, and a shop is a FILE.** `tenancy { strategy
  database }` in the seed, `resolve subdomain` as the deployment fact, and the
  isolation is the filesystem: there is no query that reaches two shops because
  there is no connection that holds two. **The people are per shop too** — an
  account at one is not an account at another, which is the assertion a shared
  identity table would quietly get wrong. `verify:tenants` proves the data, the
  people and the session separately, over Host headers, because a browser
  cannot set one.

  A request that names no shop gets the flagship, and that fallback is the
  APP's — `resolve subdomain` deliberately has no default, so `api/src/core/db.ts`
  says which shop *nobody said* means, in one place. A host naming a shop nobody
  created is a 404.
- **The storefront's search asks the shop, and says when it could not.**
  `Product` declares `@@fts([name, description])`; the catalogue island sends
  `?$search=…&active=true` — a directive and a filter side by side, with no app
  code between them — and junction routes it to Litestone's `search()`. What
  makes it worth having rather than a demo is what an island CANNOT do: the
  products are serialised into the page at build time and descriptions are not
  among them, so `fleece` is findable by the shop and by nothing running here.
  With the shop unreachable the box filters what is on the page and says so —
  an empty list because nothing matched and an empty list because the network
  failed are two different answers, and drawing them the same way tells a
  shopper their shop is empty. `verify:site` asserts both, the second with the
  network really turned off.
- **An order says what was bought, at the price it was bought for.**
  `OrderLine` copies the SKU, the wording and the unit price at the moment of
  sale, and stores the line total rather than multiplying it back at read time —
  so the itemisation adds up to what was charged, to the penny, and a price
  edited in the catalogue tomorrow does not rewrite what a customer paid today.
  It is `@@gate("0.8.8.8")`: readable wherever the order is, written only
  through `asSystem()`, by `carts.checkout` and nothing else. `verify:cart`
  asserts the copy, the arithmetic and the 405 a caller trying to add one gets;
  `verify` reads the itemisation off the detail screen and then opens an order
  raised by hand on that same screen, which correctly has none.

  It does **not** replace the inventory ledger, and the two answer different
  questions: `InventoryMovement` is what left the shelf and is what a refund
  reads back, because it is signed and summable and survives anything anybody
  does to a line afterwards. These are what the shop billed for, which the tape
  cannot answer — it carries no prices.
- **A basket holds stock, and the hold expires on its own.**
  `ProductVariant.stock` is ON HAND; `StockReservation` is what an open basket
  has set aside; AVAILABLE is the difference and is a column nowhere.
  `api/inventory.ts` is the one module that reads any of the three or writes the
  first, and every write to `stock` is paired with an `InventoryMovement` in the
  same transaction. `verify:stock` asserts the three things that break silently:
  a hold moves available and leaves on hand alone, a shopper's own hold does not
  count against them, and the expiry is in the READ rather than in the cron —
  so `release-holds` is housekeeping and a queue outage cannot stop the shop
  selling. The ledger is `@@gate("5.5.9.9")`: update and delete are 9, which
  nothing passes including `asSystem()`, and that is what append-only is spelled
  with.
- **Every money column is `@money(USD)`, so what is stored is a whole number of
  CENTS.** Twenty-three columns across twelve models, and the identity on `Order` is
  an EQUALITY because of it — `subtotal − discount + shipping + tax = total`
  used to be a `@@check` carrying a half-penny tolerance, which is what two
  binary floats need to agree that they are equal. `pricing.ts` does two
  multiplications (a percentage and a tax rate) and rounds each as it is
  produced; every other line of it is the addition of two integers. `Payment` is
  the one model that binds `@money(field: currency)`, because a provider is
  asked in a currency and answers in one, and a JPY intent has no cent.
  `Discount.value` is deliberately `@scale(2)` and NOT `@money`: half its rows
  are a percentage, and the two readings share a scale but not a unit.
- **Prices have a currency, and it is one function.** `money()` over
  `@frontierjs/toolbelt/units`, read by five screens including the prerendered
  catalogue and the API's own email bodies. It is `fromMinor` and then
  `formatMoney` — never `/ 100`, which is right for the dollar and wrong for
  the yen. The toggle in Settings converts against a fixed table stated in
  `web/src/money.js`; `verify:ui` asserts the NUMBER moved and not only the
  symbol, because a toggle that changed the glyph alone would show one price as
  two different amounts.
- **A form takes dollars where the column takes cents**, and that is a
  contributed control rather than a special case: `web/src/money-control.js`
  registers `money` in sierra's table off `x-money` on the column — the
  declaration, not the column's name — and binds it to the kit's `Input` with
  the conversion in its `props`. Without it the generated order form offers a
  spinner stepping by one, and staff raising a telephone order for forty-two
  dollars charge forty-two cents with every screen agreeing.
- **A customer can be taken off the books and their orders cannot.**
  `Customer` is `@@softDelete` and `orders Order[] @keep` — the third fate a
  soft-deleted parent's children can have, and the one that had no spelling
  until this app needed it. Before, `Order.customerId` was `onDelete: Cascade`,
  so removing a customer DESTROYED every order they had ever placed; cascading
  the soft delete instead would only have hidden them. An order is what the
  revenue is made of, so neither is what a shop means. `Product` and `Order` are
  `@@softDelete(cascade)` and the ledger is not touched by either, because
  `InventoryMovement` hangs off the shelf rather than off the order — which is
  also the reason the catalogue had no removal story at all before: that
  relation is `Restrict`, so a product that had ever sold could not be deleted,
  correctly and with no way out. The `Orders` column on the customers screen is
  a `@from` count and is what makes `@keep` VISIBLE rather than merely true: a
  removed customer still reads 2.

  `deletedAt` is **not** a second `active`. `active: false` is *we are not
  selling this right now*; this is *it is not ours any more*. What proves they
  are different rather than differently spelled is `@unique` — a deleted product
  keeps its slug and a deleted customer keeps their email, deliberately, because
  a way back that fails when a stranger has taken the value is not a way back.
  So re-registering a removed address is a 409 naming the row that holds it.
- **Two staff cannot silently overwrite each other.** `@version` on `Product`,
  `Customer`, `ShippingMethod` and `TaxRate` — every one a row a FORM edits and
  nothing else writes. The models left out are left out on purpose and the seed
  argues each: `ProductVariant` (a person edits the price, every sale writes
  `stock`), `Order` (`@@transitions` is already a compare-and-swap on the one
  contended column, and the courier job writes `trackingCode`), `Discount`
  (`redemptions` moves inside every checkout), the basket (one shopper), the
  append-only tables. `@version` is per ROW, so where two writers touch disjoint
  columns it reports a conflict about a change nobody made — and a 409 nobody
  can act on teaches everyone to retry blindly.

  The screen half is the one a unit test cannot reach: the drawer holds the
  revision this screen READ, somebody else saves, and `resource.conflict(err)`
  answers the two numbers where `fieldErrors(err)` answers the sentence — which
  is what a *reload theirs* / *overwrite with mine* prompt needs and what a
  status cannot express.
- **One schema seeds three realms.** Tables, CRUD, 401/403, 400s, `make()`
  defaults, enum options, relation pickers, gate levels and the state machine
  all derive from `db/schema.lite`. No field list appears in any component.
- **Auth + `@@gate` work together.** Ladder: signed out 0, unverified 1,
  verified 4, verified admin 5. `api/src/core/gate.ts` is four lines and is the only
  place a role becomes a level.
- **Field-level `@allow`** — `Customer.notes` is *absent* from the response for
  non-admins, not blanked. The column appears in the table when you sign in as
  `alex`.
- **`@@transitions` end to end** — the Moves column is read back from
  `x-transitions`; `refund` carries `@gate(5)` so it renders disabled for `sam`
  and enabled for `alex`; a `shipped` order offers nothing. Buttons dispatch as
  custom service actions **over the WebSocket** (verified over CDP: zero HTTP
  POSTs when the socket is up).
- **Messages authored once.** `@label("Customer")` and
  `@required("Please select a customer from the list")` are said by the form,
  the client-side check and the API alike.
- **Live validation** — on input an error may only be *removed*, never added.
  Revealed by blur or submit. **This is no longer implemented here.** As of
  2026-08-06 the order form is `<Form resource={orders}>` from
  `@frontierjs/ui`, which owns the rule; the page lost ~90 lines of state
  machine and every one of the six live-validation assertions still passes
  against it. As of 2026-08-28 it is not on the page at all — it is the markup
  half of `resources/Order.mesa` (Invariant 18), so a create page and an edit
  page reach one definition and `orders/create.mesa` is `<Order />`. A control now resolves its own label, `required`, `type` and
  constraint attributes from the schema too, so the page states none of them —
  which is why the labels in `form.controls` are `@label`-derived rather than
  raw column names.
- **The whole UI is `@frontierjs/ui`.** Shell, both tables, the generated form
  and the home page are kit components — Alert, Badge, Button, Card, Checkbox,
  Field, Form, Input, Label, Pill, SectionHeader, Select, Table — and the same 37
  assertions pass unchanged. That is the point of the exercise: the assertions
  are written against the `@frontierjs/css` vocabulary in the DOM, so if a
  component draws the wrong thing they fail. Five kit defects and three Mesa
  defects were found this way in an afternoon.

- **The kit's behavioural half works, and is asserted.** `/orders/{id}/` is
  Breadcrumbs + Steps (the lifecycle read off `fields.status.enum`) + Tabs +
  a DropdownMenu of transitions + a Modal that asks before a move with no way
  back; `/products/` is a Combobox / MultiSelect / range Slider filter bar over
  Pagination and an EmptyState; `/settings/` is an Accordion of Switch,
  RadioGroup, NumberInput and Textarea, saved to `localStorage` and read back
  by the tables; the shell carries ⌘K. `bun run verify:ui` asserts 26 facts
  about them, including the ones only a browser can settle — roving tabindex,
  focus inside a `<dialog>`, Escape closing a menu, a toast appearing.

### Running it against the production build

The dev server is not the only thing that has to work, and it hid an inert
build for as long as this app existed. `web/dist/client/` is static; drive it
with any server that serves the SPA fallback and proxies `/api` **and `/ws`**
to :8110, then point the drive at it:

```bash
bun run verify:build        # builds, serves dist/, runs the 37 assertions
```

or by hand, which is also how to point the kit drive at the build:

```bash
bun run build
bun run preview &
UI_URL=http://localhost:8011 node web/test/verify.mjs
UI_URL=http://localhost:8011 node web/test/verify-ui.mjs
```

`vite preview` does **not** carry `server.proxy`, so it is not that server.
Leave `/ws` out and 36 of the 37 assertions still pass — the one that fails is
the delete, because the row leaves the table on the real-time event rather than
on the response.

---

## Layout

```
example/
├── db/
│   ├── schema.lite         ← the seed. Read by api/ and by web/'s build
│   └── seed.ts             ← `bun run db:seed`. 13 products, 2 customers, 3 orders,
│                             2 demo users. A SCRIPT — nothing imports it
├── api/
│   ├── index.ts            ← the entry. start(), the dev mail sink, and nothing else
│   ├── *.snapshot.md       ← surface · jobs · principal · notifications. Four
│   │                         committed artefacts about THIS surface, generated
│   │                         from here and rechecked from here by CI
│   ├── config/             ← junction.config.js — caravan, and where the services are
│   └── src/
│       ├── app.ts          ← createApp, auth plugin (+ its three services), caravan, channels.
│       │                     Exported unstarted, so `junction surface` can import it
│       ├── core/db.ts      ← client + GatePlugin + autoMigrate; appends auth's
│       │                     schema fragments rather than pasting a copy
│       ├── core/gate.ts    ← the ONE place a session becomes a number
│       ├── jobs/           ← book-courier, announce-payment, sweep-abandoned (its own cron) — all autoloaded
│       ├── providers/mail/mailer.ts      ← IMail over app.conduit.send() — the provider is a TARGET
│       ├── providers/mail/sink.ts   ← the dev mail catcher on :8111, provider-shaped
│       │                          plus the inbox it serves at /
│       ├── providers/stripe/index.ts      ← the Stripe connection, both directions
│       ├── providers/stripe/sink.ts ← Stripe standing in for Stripe, on :8114
│       ├── notifications/  ← OrderPaid (staff, inApp) + OrderConfirmation (customer, email)
│       ├── emails/         ← order-confirmation.mesa — the body, in the email
│       │                     realm + preview.mjs (`bun run email:preview`)
│       └── services/       ← 9 files; orders.service.ts has the 4 transitions
└── web/                    ← Vite root
    ├── config/             ← vite.config.js + sierra.config.js + routes.js
    ├── test/
    │   ├── verify.mjs      ← the framework drive. 37 assertions
    │   ├── verify-ui.mjs   ← the KIT drive. 26 — overlays, keyboard, stores
    │   ├── verify-live.mjs ← the REAL-TIME drive. 14 — a watcher tab that never acts
    │   ├── verify-jobs.mjs ← the DEFERRED-WORK drive. 8 — no browser at all
    │   ├── verify-notify.mjs ← the OUTBOUND drive. 9 — mail at a real server
    │   ├── preview.mjs     ← serves dist/ with the dev server's proxies
    │   └── verify-build.mjs
    └── src/
        ├── prefs.js              ← browser preferences; the only non-model state
        ├── money.js              ← BASE, the display currency, and the one
        │                           `fromMinor` this surface performs
        ├── money-control.js      ← the `money` control: a box in dollars over a
        │                           column in cents, resolved off `x-money`
        ├── resources/Order.mesa  ← .mesa, invariants 18 + 19
        └── routes/               ← index, orders/{index,create,[id]}, products,
                                    customers, cart, inventory, settings

site/                       ← the PUBLIC storefront. Its own surface (FJS-D127),
  config/                     never a routesDir inside web/: one Vite root is one
    sierra.config.js          dist/, and `vite build` empties outDir — the SPA's
    vite.config.js            build deleted it, silently, for as long as it lived
  index.html                  there
  src/
    api.js                  ← the API's ORIGIN. An island crosses one; the SPA,
                                behind Vite's proxy, never has
    money.js                ← the shop's BASE currency, and cents → what a
                                person reads. No reader, no storage
    islands/                ← CatalogList (client:load), LiveStock (client:visible),
                                LivePrices (client:load — corrects a stale price)
    routes/
      _module.mesa          ← the layout. The first this repo PRERENDERS
      index.mesa            ← the home page, three products baked in
      404.mesa              ← and the reason `404.mesa` used to break the build
      catalog/              ← index.mesa + index.meta.js — load() at BUILD time
      products/[slug].mesa  ← ONE PAGE PER PRODUCT, via getStaticPaths()
  test/verify.mjs           ← the storefront drive. 37 assertions
  deploy/                   ← serve.js + Dockerfile — the site origin
```

`bun run api` (:8110) · `bun run web` (:8010) · `bun run dev:site` (:8610) ·
`bun run verify` · `bun run verify:ui` ·
`bun run verify:live` · `bun run verify:jobs` · `bun run verify:notify` ·
`bun run email:preview` ·
`bun run build` · `bun run verify:build` · `bun run build:site` ·
`bun run verify:site` · `bun run reset`

Sign in: `sam@shop.test` (level 4) or `alex@shop.test` (level 5), password
`correct-horse-battery`. The header buttons do it.

---

## Framework changes this app forced

It found thirty-two real defects. All fixed, all with tests, and only one of
them in the example itself — which is the point of it.

The fourth wave came from prerendering the public catalogue and giving it two
islands:

| package | what |
| --- | --- |
| **mesa** | **A `.mesa` file with frontmatter was compiled as MARKDOWN.** `compileSource` routed any source beginning with `---` to the Markdown compiler whatever its extension — and a `---` block is how every Sierra route states its title and render mode. Markdown escapes what it does not recognise, so `<CatalogList client:load products={…} />` came out as a paragraph of escaped text with the props stringified into it, while `<LiveStock />` beside it compiled as a component. Only callers handing the compiler a raw file were affected, so dev and the SPA build were right and the PRERENDERER was wrong for the same file |
| **mesa** | **Every server-rendered `<input>` carried `formaction="http://localhost/"` and `formmethod=""`.** happy-dom's `cloneNode` re-derives an input's attributes from default properties, and absolutises an authored relative `formaction`. `formaction` overrides its form's action, so a prerendered form would post to whatever machine built the site — with that machine's localhost URL in a public file |
| **mesa** | **`{@attach}` ran on a DETACHED element, so every kit overlay was invisible.** VISION §10.6 says an attachment runs when the element mounts; it ran when the element was built. `el.animate(…, { fill: 'forwards' })` on a disconnected node returns an animation that never starts — the element paints at keyframe 0 for good. CommandPalette is a full-screen fixed backdrop, so **⌘K put an invisible sheet over the app that swallowed every click**. Found by the owner clicking the button; `verify:ui` was green against it because presence, not visibility, was the claim |
| **sierra** | **A prerendered page linked no stylesheet and carried no body class.** A static document is assembled by Sierra, not by Vite's HTML transform, so the CSS asset the same build emitted had no way in and the theme class stated in `index.html` had none either. The page shipped every `@frontierjs/css` class name and not one rule behind it |

The third wave came from the live-updates drive, from giving the app a queue,
and from giving it an outbound boundary:

| package | what |
| --- | --- |
| **junction** | **A session reached the Data boundary with no `id`, so every `@@allow` row policy matched nothing.** `SessionContext` says `userId`; Litestone's policy language reads `auth().id`. Nothing bridged them, so `@@allow('read', userId == auth().id)` compared a column to `undefined` — an empty list, no error. Gates were unaffected (`sessionGateLevel` was written to Junction's shape), so the translated half worked and the untranslated half failed in silence. Fixed with `toDataPrincipal()`, one owner, both call sites |
| **litestone** | **The audit log could not record a String actor id.** `actorId` was declared `Int` and the jsonl index is a STRICT table, so the first audited write with a known actor threw `cannot store TEXT value in INTEGER column` and took the request with it — and `@frontierjs/auth` issues uuid ids, so every FJS app was exposed. Masked by the defect above: with no `id` on the principal, `actorId` was always null, and NULL fits an INTEGER column. Now `Any`, with the index rebuilt from the `.jsonl` rather than abandoned |
| **junction** | **`methods:` was silently ignored by `createBaseService`.** The allow-list that makes a service append-only was read by `createService` and neither read nor forwarded by the factory the loader is built around. Same `methods: 'readOnly'`, two factories, one of them a no-op — and the only symptom was a write that succeeded |
| **junction** | **A PATCH applied the model's defaults to fields the caller did not send.** `mode: 'update'` dropped required-ness and kept every `default`, and `validate()` fills a default in for any absent key — so `PATCH {"note":"x"}` reached the model as a full record. On an ordinary column it silently reset it; on a column under `@@transitions` it answered `409 Cannot transition order.status from 'shipped' to 'pending'`, which reads as a broken state machine. Found by the courier job trying to write a tracking code |
| **caravan** | **`unique` disagreed with its own schema, in both directions.** The lookup said "a pending job with this key" while the column said `UNIQUE` forever: the second dispatch after the first finished walked into the constraint and 500'd an HTTP request. Making the lookup match any status fixed that and broke the other half — a key built from a row id matched a job belonging to a DELETED order whose id SQLite had reused, and the work silently never ran. Now a partial unique index over live jobs, with the guard reading the same set. Old databases are migrated on open |
| **caravan** | **A cron could be scheduled and never run.** The admin routes could retry and cancel a job but not start one, so the only way to reach a nightly sweep was to wait until 03:00 — every cron handler in every app was untestable, and unrunnable in an incident. `POST /jobs/run/{name}` added; the body becomes the job's data |
| **junction** | **A custom action announced nothing.** `callService` gated its one announcement point on `AUTO_EVENT_MAP` — the five CRUD writes — so `pay` changed the row and no event reached the bus or the channel. The browser client had listened for action events since it was written, so the seam had both halves and neither could see the other. Every app in the repo hid it by re-issuing `find()` after an action, which made the *acting* tab correct and every other tab stale in silence. Found by `verify-live.mjs`, whose watcher tab never acts |

The second wave came from the screens built to use the kit's behavioural
components (`/orders/{id}/`, the products filter bar, `/settings/`, ⌘K):

| package | what |
| --- | --- |
| **mesa** | **A click inside `<mesa:portal>` never reached its handler.** Delegation walks from the event target up to a registered root, and only the app container is one; portalled content is appended to `document.body`, outside it. Every menu item, palette row and toast dismiss button in the kit was inert — no error, correct markup, correct ARIA |
| **mesa** | An assignment inside a component prop compiled to a signal READ — `<Modal onclick={() => open = false}>` threw `Invalid left-hand side in assignment`, so a dialog's Cancel button did nothing |
| **mesa** | `$: fn(), handler` spliced its output from the wrong string (`$$set_high(sa'`, taken from an import statement) — and threw `Assignment to constant variable` when the watched function was a `const`. Fixed, and the const case is now a compile error |
| **mesa** | An attribute depending only on a `{@const}` was written once and never updated: a completed step kept `aria-current="step"` while its class said otherwise |
| **mesa** | `<C aria-label="x">` emitted `{aria-label: 'x'}` — a syntax error in generated code. And `$attributes` was `$$option.props` unfiltered, so forwarding it wrote every declared prop onto the DOM |
| **ui** | **All four stores were inert.** `toasts`, `commandPalette`, `alert`, `theme` wrote `this.x = …` on a plain object, which notifies no watcher: toasts queued and never rendered, ⌘K flipped a boolean nobody read |
| **ui** | `DropdownMenu` rendered a `children` snippet its own docs never pass, so every menu opened empty; `Table`'s loading skeleton threw `array.map is not a function`; `RadioGroup` ignored its `id`; `Label` emitted `for=""` |
| **sierra** | `mesa-plugin` read compiler *warnings* and ignored compiler *errors*, so a page with five diagnosed `bind:` errors was served and silently collected nothing |

And the first wave, from moving the existing markup onto the kit:

| package | what |
| --- | --- |
| **mesa** | A `{#snippet}` written inside a component tag never reached the component. VISION §9.5 documents them as same-name props; they fell into the default slot, were hoisted into that slot's scope, and nothing called them — so a `<Table>` with a `row` snippet drew a head and an empty body, silently |
| **mesa** | A snippet's arguments were read once, when its DOM was built. The table drew its first rows and then ignored the store: paying an order changed the database and the pill still said `pending`. Arguments are getters now |
| **mesa** | A valueless attribute on a component (`<Table striped>`) compiled to a reference to a variable of that name, not to `true` — a `ReferenceError`, or worse, a silent wrong value where such a local existed |
| **ui** | `Field` put the error tone on `.field-group`, and `--bg-mix` is `inherits: false` — so no validation message in the kit was ever red. Plus: `Input` had no `oninput` and no `maxlength`, an emptied number field became `0`, and `Select`'s placeholder option submitted its own label |
| **sierra** | The unexported-snippet warning counted only block directives as nesting, so every kit component's snippet was reported as a route-level mistake, on every build |
| **example** | `web/index.html` mentioned a literal body tag inside a comment. Vite injects the built script at the first match and does not skip comments, so the tags landed in the comment and **the production build loaded no JavaScript** — a clean build, a plausible `dist/index.html`, an empty console |
| **mesa** | Component function name collided with a `<script module>` export or a reserved word — clean compile, fine in dev, dead at `vite build` |
| **sierra** | `make()` defaulted a relation key to `0`, so "no customer picked" was `500 FOREIGN KEY constraint failed` instead of "customer is required" |
| **sierra** | `resource.service.action()` did not exist — a custom action could not be called at all, and the pipeline routed non-CRUD through the WS-only escape hatch |
| **sierra** | `title` was read off a `$ref` target, so enum fields named themselves after their type |
| **litestone** | Validator messages never left the Data boundary; `required` had no message slot; no field label |
| **litestone** | Transition errors had no `status` → 500 instead of 409/400 |
| **junction** | `action()` and `restore()` ignored a live socket, against the documented rule |
| **junction** | The HTTP fallback recursed forever for custom actions — async, so it never settled and nothing pointed at it |
| **junction** | Startup banner said nothing about the Data realm |

Details are in each package's `CHANGES.md` (all dated 2026-08-04) and in the
README's *Found by building this* table.

---

## Known-imperfect, deliberately

- **Anonymous callers get 403 on a custom action, not 401.** CRUD answers 401.
  Not chased; the affordance is disabled either way.
- ~~**The store refreshes by re-issuing `find()` after an action.**~~ Gone
  2026-08-06 — it re-grades from the broadcast now. That refetch turned out to
  be the *mask* over the live-updates gap, not merely wasteful: it made the
  acting tab look right while every other tab went stale (`FJS-033`).
- **`bun run verify` signs in twice per run** against a 10-per-15-min limit, so
  and the other drives sign in once each (`verify:notify` twice, to show two
  users) — a full sweep of all five costs 7 logins. The example raises its own
  limit to 100 in `api/src/app.ts` for exactly that reason, and says why. Both drives now say so plainly rather than timing out (`FJS-086`,
  closed 2026-08-06) — the limiter is a per-IP in-process `Map`, so restarting
  the API resets it.
- **Transition names are written twice** — in `@@transitions` and as service
  action names. A mismatch is a clean 404/400, not a silent no-op, but it is a
  seam worth watching.

---

## Live updates — done, and they were half-broken (`FJS-033`, closed 2026-08-06)

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

## Deferred work — done (2026-08-06)

`ship` is the move plus one thing that must not happen inline. Booking a courier
is somebody else's HTTP call: slow, flaky, and worth retrying where the state
transition is not. So the action moves the order and answers; a
`@frontierjs/caravan` worker books the courier and writes the tracking code back
**through the orders service**, which is what makes it announce — the cell fills
in, seconds later, in a tab that has been idle since before the job was queued.

- `api/jobs/book-courier.job.ts` — autoloaded from `jobsDir`, queue
  `fulfilment`, `maxAttempts: 5`, retries at 1m / 5m / 30m
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

## Outbound and notifications — done (2026-08-06)

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

## Static + islands — done (2026-08-06)

`bun run build:site` prerenders `site/src/routes/` into
`site/dist/catalog/index.html`: the whole catalogue in the file, one
module script, and nothing else. `bun run verify:site` serves that directory
and drives it — **21 assertions, no sign-in, so it costs nothing against the
login limiter.**

Two islands, because one directive proves less than two:

- **`CatalogList` (`client:load`)** is the list itself. Its rows are a PROP,
  serialised into the marker at build time from what `load()` read through the
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

## The email realm — done (2026-08-06)

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

## Working notes for a cold start

- **Two processes.** With the API down, Vite answers `/api`
  with an empty-bodied 502 and the app says which process is missing rather than
  rendering plausible empty tables.
- **`bun run reset`** deletes everything derived and runs `bun run db:seed`. A
  boot no longer seeds — the seed is a script, so nothing writes to the database
  by being imported.

  **It clears `db/public/` too, and that one is about size rather than
  correctness.** Object storage for `File` columns is content-addressed, so every
  seed run uploads the same eight images from `db/seed-media/` under fresh keys
  and nothing removed the old ones. Measured before it was added to the list:
  **3,871 files and 817MB on disk against 19 rows the shop actually
  references** — 99.5% orphaned, accumulated over roughly two hundred seed runs.
  Nothing was broken by it; it was 800MB of dead bytes in every working tree,
  and a fresh clone earned its own within a week of running the drives.
  Do this if a run leaves the data changed — `verify` itself is idempotent.

  **It deletes `db/jobs.db` too, and that is not tidiness.** The queue is a
  separate SQLite file and it used to survive a reset, so a `book-courier` row
  enqueued by an earlier run stayed `pending` with *no such principal* — the
  staff member it recorded went with the reseeded database. Caravan's `unique`
  is a lock on work that is still owed, so `book-courier:5` held its key against
  every later run, and `ship` on order 5 dispatched nothing at all. What that
  reads as is `verify:jobs` failing `job.wroteTracking` **while `job.record`
  passes**, because the row the drive finds is the previous run's. The same
  thing took `verify:notify`'s `announce-payment` down. Both are green from a
  reset that includes the queue.
- **The browser drives default to `http://localhost:8010` — check who is
  answering it.** Another app on this machine wanted the same port, and a drive
  pointed at somebody else's dev server reports `home.heading: "Sign in"` and an
  empty nav, which reads exactly like this app being broken. Every drive takes
  `UI_URL=`, so start Vite on a free port (`bun run web -- --port 5284
  --strictPort`) and pass it. `verify:site` is unaffected — it serves the
  built directory itself.
- **The drive is the spec.** If you change a screen, `web/test/verify.mjs` is
  where the claim lives. Never return a bare `null` from a probe (CDP omits
  `value`, so it reads back as `undefined`), and never start an evaluated
  expression with `return` followed by a newline (ASI makes it `return;`).
- **`bun install` copies workspace deps.** Edits to a package's source are
  invisible here until reinstall. That is the thing most likely to fool you
  while changing the framework and watching this app.
- **The API is the source of truth for a gate.** `x-gate`, `x-transitions` and
  `can()` are affordances; every one of them is graded again on arrival.
