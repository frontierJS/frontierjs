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
bun run api     # terminal 1 — Junction + Litestone on :3600
bun run web     # terminal 2 — Sierra + Vite on :5274
```

Open <http://localhost:5274> and sign in from the header.

**Two processes, two terminals — both are required.** Vite serves the UI and
proxies `/api`, `/auth`, `/session` and `/ws` to the API; with the API down every
one of those is a 502 and the app says so rather than rendering plausible empty
tables.

| | |
| --- | --- |
| `bun run api` | the API realm |
| `bun run web` | the UI realm |
| `bun run verify` | drive the app in headless Chrome and assert what happened (both servers must be up) |
| `bun run verify:ui` | drive the kit's behavioural components — tabs, menus, a dialog, a palette — 26 assertions |
| `bun run build` | production build to `web/dist/client/` |
| `bun run verify:build` | build, then drive **the built app** with the same 37 assertions (needs `bun run api`) |
| `bun run preview` | serve `web/dist/client/` on :5310 with `/api` `/auth` `/session` `/ws` proxied — `vite preview` carries no proxy |
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
        ├── resources/           ← .mesa files (invariant 18), no markup
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
| [`web/src/resources/shop.mesa`](web/src/resources/shop.mesa) | names three models, turns three flags on |
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

Each button is a custom service action: `POST /api/orders/{id}` with an
`X-Service-Method: pay` header. Nothing in the app registers that route, and
[orders.service.ts](api/services/orders.service.ts) is four one-line functions
calling `db.order.transition(id, name)` — which states a move is legal from,
what it moves to and what level it needs all live in the schema.

---

## Verified

Nothing in this file is asserted from reading the source. `bun run verify`
drives the app in headless Chrome — navigating, signing in, typing into fields
and leaving them, filling the form, submitting, deleting, signing out — and
asserts 37 facts about what a real browser ended up showing. Last run:

```
all 37 assertions passed        (3 consecutive runs, 0 console errors, 0 exceptions)
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

An example is only worth having if it can fail. Eight things this one settled,
five more the day its markup moved onto `@frontierjs/ui`, and eight more from
the screens built to use the components a render test cannot reach:

| | |
| --- | --- |
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
| **`caravan` jobs, `conduit` outbound, `notifications`** | Fulfilment as background work; order confirmation as an email. The hooks are already named in [`api/app.ts`](api/app.ts) — `onPasswordResetRequested` and `onEmailVerificationRequested` are where a mailer goes. |
| **Live updates** | Services declare `channel:`, the WebSocket connects (the header pill goes `live`), and every connection joins all three channels. Nothing re-renders from a channel event yet. |
| **`@frontierjs/ui`'s 63 components** | The UI here is raw `@frontierjs/css` vocabulary. The component kit has never been opened in a browser, and rebuilding these screens on it is where the bugs are. |
| **`static` / islands target, email previews** | Build-mode wings off this same app rather than separate projects. |
| **jetty, the VS Code extension** | Different containers. Out of scope for a single app, by design. |
