# PROJECT_STATE — `example/` (the kitchen sink)

**As of 2026-08-04.** Read `README.md` first for what the app *is*; this file is
what is built, what is proven, and what to pick up next.

Everything below was verified by running it. Where it was not, it says so.

---

## Status

| | |
| --- | --- |
| **Runs** | yes — `bun run api` + `bun run web`, two terminals |
| **Verified** | `bun run verify` → **37/37**, `bun run verify:ui` → **26/26**, 0 console errors, dev server **and** production build |
| **Builds** | yes — `bun run build` → `web/dist/client/` + robots.txt + sitemap (5 URLs). The built page is now driven too; until 2026-08-04 it loaded no JavaScript at all |
| **Phase** | 1 (spine), the first half of 2 (state machine), the `@frontierjs/ui` re-skin, and the four screens that drive the kit's behavioural components |
| **Committed** | **no.** `example/` is untracked; the package changes it drove are unstaged |

The app is a shop: `Product`, `Customer`, `Order`, one `db/schema.lite`, real
auth with a gate ladder, and an order state machine driven from the UI.

Packages exercised: litestone, junction, auth, sierra, mesa, css, **ui**.
Not yet: caravan, conduit, notifications, email-kit.

---

## What is proven

Each of these is an assertion in `web/test/verify.mjs` or a line in the README's
*Verified* section — not a claim.

- **One schema seeds three realms.** Tables, CRUD, 401/403, 400s, `make()`
  defaults, enum options, relation pickers, gate levels and the state machine
  all derive from `db/schema.lite`. No field list appears in any component.
- **Auth + `@@gate` work together.** Ladder: signed out 0, unverified 1,
  verified 4, verified admin 5. `api/gate.ts` is four lines and is the only
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
  Revealed by blur or submit.
- **The whole UI is `@frontierjs/ui`.** Shell, both tables, the generated form
  and the home page are kit components — Alert, Badge, Button, Card, Checkbox,
  Field, Input, Label, Pill, SectionHeader, Select, Table — and the same 37
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
with any server that serves the SPA fallback and proxies `/api`, `/auth`,
`/session` **and `/ws`** to :3600, then point the drive at it:

```bash
bun run verify:build        # builds, serves dist/, runs the 37 assertions
```

or by hand, which is also how to point the kit drive at the build:

```bash
bun run build
bun run preview &
UI_URL=http://localhost:5310 node web/test/verify.mjs
UI_URL=http://localhost:5310 node web/test/verify-ui.mjs
```

`vite preview` does **not** carry `server.proxy`, so it is not that server.
Leave `/ws` out and 36 of the 37 assertions still pass — the one that fails is
the delete, because the row leaves the table on the real-time event rather than
on the response.

---

## Layout

```
example/
├── db/schema.lite          ← the seed. Read by api/ and by web/'s build
├── api/
│   ├── db.ts               ← client + GatePlugin + autoMigrate; appends auth's
│   │                         schema fragments rather than pasting a copy
│   ├── gate.ts             ← the ONE place a session becomes a number
│   ├── seed.ts             ← 4 products, 2 customers, 3 orders, 2 demo users
│   ├── app.ts              ← createApp, auth plugin, channels, GET /session
│   └── services/           ← 3 files; orders.service.ts has the 4 transitions
└── web/                    ← Vite root
    ├── config/             ← vite.config.js + sierra.config.js + routes.js
    ├── test/
    │   ├── verify.mjs      ← the framework drive. 37 assertions
    │   ├── verify-ui.mjs   ← the KIT drive. 26 — overlays, keyboard, stores
    │   ├── preview.mjs     ← serves dist/ with the dev server's proxies
    │   └── verify-build.mjs
    └── src/
        ├── prefs.js              ← browser preferences; the only non-model state
        ├── resources/shop.mesa   ← .mesa, invariant 18
        └── routes/               ← index, orders/{index,create,[id]}, products,
                                    customers, settings
```

`bun run api` (:3600) · `bun run web` (:5274) · `bun run verify` · `bun run verify:ui` ·
`bun run build` · `bun run verify:build` · `bun run reset`

Sign in: `sam@shop.test` (level 4) or `alex@shop.test` (level 5), password
`correct-horse-battery`. The header buttons do it.

---

## Framework changes this app forced

It found twenty-one real defects. All fixed, all with tests, and only one of
them in the example itself — which is the point of it.

The second wave came from the screens built to use the kit's behavioural
components (`/orders/{id}/`, the products filter bar, `/settings/`, ⌘K):

| package | what |
| --- | --- |
| **mesa** | **A click inside `<mesa:portal>` never reached its handler.** Delegation walks from the event target up to a registered root, and only the app container is one; portalled content is appended to `document.body`, outside it. Every menu item, palette row and toast dismiss button in the kit was inert — no error, correct markup, correct ARIA |
| **mesa** | An assignment inside a component prop compiled to a signal READ — `<Modal onclick={() => open = false}>` threw `Invalid left-hand side in assignment`, so a dialog's Cancel button did nothing |
| **mesa** | `$: fn(), handler` spliced its output from the wrong string (`$$set_high(sa'`, taken from an import statement) — and threw `Assignment to constant variable` when the watched function was a `const`. Fixed, and the const case is now a compile error |
| **mesa** | An attribute depending only on a `{@const}` was written once and never updated: a completed step kept `aria-current="step"` while its class said otherwise |
| **mesa** | `<C aria-label="x">` emitted `{aria-label: 'x'}` — a syntax error in generated code. And `$attributes` was `$option.props` unfiltered, so forwarding it wrote every declared prop onto the DOM |
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
- **The store refreshes by re-issuing `find()` after an action** rather than
  reacting to the `svc updated` broadcast. Correct but wasteful, and it is the
  visible half of the live-updates gap below.
- **`bun run verify` signs in twice per run** against a 10-per-15-min limit, so
  ~5 runs per quarter hour. The drive says so plainly rather than timing out.
- **Transition names are written twice** — in `@@transitions` and as service
  action names. A mismatch is a clean 404/400, not a silent no-op, but it is a
  seam worth watching.

---

## Next: live updates

The planned phase-2 remainder, and the seam most likely to be half-connected in
the same way the last two were.

**What already exists:** every service declares `channel: 'orders'` etc.;
`api/app.ts` joins every connection to all three channels; the socket connects
and the header pill reads `live`; `callService` is the single announcement point
for both the bus and channels.

**What does not:** nothing subscribes *explicitly*. `useStore(orders.store)` is
populated by `load()` and by the client's own event handling, and no component
asks for more.

**One measurement from 2026-08-04, which narrows it:** driving the production
build through a preview server that proxied `/api` but NOT `/ws`, 36 of the 37
assertions passed and the one that failed was the delete — the row stays in the
table when the socket is down and leaves when it is up. So a `removed` event
does reach the store today. What has NOT been tested is a second client: every
observation so far is the originating tab, which may be seeing its own echo.

**The check to run first:** open two tabs, create an order in one, and watch the
WS frames in the other. If the broadcast arrives and the store ignores it, the
gap is in Sierra's store wiring. If it never arrives, it is in Junction's
channel publish path. `CLAUDE.md` already records one open item here —
*"litestone `onEvent` has no Junction subscriber"* — which matters for any write
that bypasses the service layer.

**After that**, in rough order of value:

1. ~~**`@frontierjs/ui`** — 63 components, never opened in a browser.~~ **28 of
   63 done, 2026-08-04.** Twelve carry the ordinary routes; the order detail,
   the products filter bar, `/settings/` and the ⌘K palette drive sixteen more,
   asserted by `bun run verify:ui`. **35 remain compile-only** — `DatePicker`
   (1200 lines, the biggest unknown), `Drawer`, `Popover`,
   `ConfirmationPopover`, `FileUpload`, `AlertProvider`, and the small display
   components. Two interactions the drives still do not reach: dragging a
   `Slider` handle, and `Popover` placement flipping. The way in is the same as
   last time — a screen that genuinely needs one, not a gallery.
2. **caravan jobs** — fulfilment as queued work. The realm with the least proof.
3. **conduit + notifications** — order confirmation email. The hooks are already
   named in `api/app.ts` (`onPasswordResetRequested`,
   `onEmailVerificationRequested`).
4. **`static`/islands target and email previews** — build-mode wings off this
   same app, not separate projects.

Out of scope by design: jetty (a different container) and the VS Code extension.

---

## Working notes for a cold start

- **Two processes.** With the API down, Vite answers `/api`, `/auth`, `/session`
  with an empty-bodied 502 and the app says which process is missing rather than
  rendering plausible empty tables.
- **`bun run reset`** deletes the database; the seed runs again on next boot.
  Do this if a run leaves the data changed — `verify` itself is idempotent.
- **The drive is the spec.** If you change a screen, `web/test/verify.mjs` is
  where the claim lives. Never return a bare `null` from a probe (CDP omits
  `value`, so it reads back as `undefined`), and never start an evaluated
  expression with `return` followed by a newline (ASI makes it `return;`).
- **`bun install` copies workspace deps.** Edits to a package's source are
  invisible here until reinstall. That is the thing most likely to fool you
  while changing the framework and watching this app.
- **The API is the source of truth for a gate.** `x-gate`, `x-transitions` and
  `can()` are affordances; every one of them is graded again on arrival.
