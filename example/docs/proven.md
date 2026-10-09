# What is proven — `example/`

Each of these is an assertion in one of the eight drives, or a line in the
README's *Verified* section — not a claim.

- **A stranger can buy something.** `Cart` and `CartLine` are `@@gate("0.0.0.5")`
  reached by `@@allow('read', id == auth().cartId)`, the claim comes from
  `bearerClaim` running for a caller with no session — which reads the token's
  digest off `CartGrant` and puts the BASKET'S ID on the principal — and the
  token rides `x-cart-token` over HTTP and over the socket alike. `verify:cart` adds
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
  renewal run as the system without being able to restate a total. **The
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
  field.** `PlanVersion.price` is `@money(USD)`, and sierra's control table
  answers the kit's `money` box off `x-money` on the RULE — not off a column
  name — so the box and its two conversions come from the schema. `verify` types
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
  `Product` declares `@@fts([name, description])`; the catalog island sends
  `?$search=…&active=true` — a directive and a filter side by side, with no app
  code between them — and junction routes it to Litestone's `search()`. What
  makes it worth having rather than a demo is what an island CANNOT do: the
  products are serialized into the page at build time and descriptions are not
  among them, so `fleece` is findable by the shop and by nothing running here.
  With the shop unreachable the box filters what is on the page and says so —
  an empty list because nothing matched and an empty list because the network
  failed are two different answers, and drawing them the same way tells a
  shopper their shop is empty. `verify:site` asserts both, the second with the
  network really turned off.
- **An order says what was bought, at the price it was bought for.**
  `OrderLine` copies the SKU, the wording and the unit price at the moment of
  sale, and stores the line total rather than multiplying it back at read time —
  so the itemization adds up to what was charged, to the penny, and a price
  edited in the catalog tomorrow does not rewrite what a customer paid today.
  It is `@@gate("0.8.8.8")`: readable wherever the order is, written only
  through `asSystem()`, by `carts.checkout` and nothing else. `verify:cart`
  asserts the copy, the arithmetic and the 405 a caller trying to add one gets;
  `verify` reads the itemization off the detail screen and then opens an order
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
  so `holds-release` is housekeeping and a queue outage cannot stop the shop
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
  catalog and the API's own email bodies. It is `fromMinor` and then
  `formatMoney` — never `/ 100`, which is right for the dollar and wrong for
  the yen. The toggle in Settings converts against a fixed table stated in
  `web/src/lib/money.js`; `verify:ui` asserts the NUMBER moved and not only the
  symbol, because a toggle that changed the glyph alone would show one price as
  two different amounts.
- **A customer can be taken off the books and their orders cannot.**
  `Customer` is `@@softDelete` and `orders Order[] @keep` — the third fate a
  soft-deleted parent's children can have, and the one that had no spelling
  until this app needed it. Before, `Order.customerId` was `onDelete: Cascade`,
  so removing a customer DESTROYED every order they had ever placed; cascading
  the soft delete instead would only have hidden them. An order is what the
  revenue is made of, so neither is what a shop means. `Product` and `Order` are
  `@@softDelete(cascade)` and the ledger is not touched by either, because
  `InventoryMovement` hangs off the shelf rather than off the order — which is
  also the reason the catalog had no removal story at all before: that
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

- **The kit's behavioral half works, and is asserted.** `/orders/{id}/` is
  Breadcrumbs + Steps (the lifecycle read off `fields.status.enum`) + Tabs +
  a DropdownMenu of transitions + a Modal that asks before a move with no way
  back; `/products/` is a Combobox / MultiSelect / range Slider filter bar over
  Pagination and an EmptyState; `/settings/` is an Accordion of Switch,
  RadioGroup, NumberInput and Textarea, saved to `localStorage` and read back
  by the tables; the shell carries ⌘K. `bun run verify:ui` asserts 26 facts
  about them, including the ones only a browser can settle — roving tabindex,
  focus inside a `<dialog>`, Escape closing a menu, a toast appearing.
