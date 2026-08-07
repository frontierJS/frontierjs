# Handoff — 2026-08-06

> **Basecamp rebuild in progress.** `packages/basecamp/docs/SCREENS.md` is the
> map: 41 mock screens, 14 built, phased by what blocks the rest. **Gating
> (`FJS-007`) is deliberately last** — decided 2026-08-06, so it is not in the
> way while the app is assembled. It is still S1.

Session state for picking up cold. Read `CLAUDE.md` first (the map), then this.

Everything below was verified by running it, not by reading. Where I could not
verify something, it says so.

**Sessions are recorded here, newest first.**

---

## Session — the email realm, and every package is now exercised (2026-08-06)

```
packages/notifications 38 pass / 0 fail  (was 33)   typecheck clean
packages/mesa        1013 pass / 0 fail  (unchanged — none of this is visible from inside)
packages/email-kit     34 pass / 0 fail
example/  verify 37 · verify:ui 26 · verify:live 14 · verify:jobs 8 · verify:notify 9
          94 assertions, five drives, twice consecutively against one database
```

The order confirmation's body is now `api/emails/order-confirmation.mesa`,
rendered by `@frontierjs/email-kit` at `target: 'email'` — tables, inlined CSS,
an Outlook conditional block — instead of the `mail()` line builder. `bun run
email:preview` writes it somewhere you can open it. **Every package in the repo
is now exercised by `example/`.**

### Three defects, all the shape of FJS-100: correct from within, broken without

- **`FJS-101`** — a notification's email body could only be a list of lines, so
  `@frontierjs/notifications` and `@frontierjs/email-kit` could not be used
  together at all. `mail()` gains `.html()` / `.text()`; the driver prefers a
  rendered body **per field**, so a template supplies the HTML and the builder
  still writes the plain-text alternative.
- **`FJS-102`** — `import Email from '@frontierjs/email-kit/components/Email.mesa'`,
  the usage that package's README documents, could not resolve: mesa
  `path.resolve`d every `.mesa` import against the importer, and the kit's
  `exports` map turned `Email.mesa` into `Email.mesa.mesa`. Both fixed.
- **`FJS-103`** — a template's `subject` export could not depend on the render
  data (a receipt's subject names the order), because the email document wrapper
  called `.replace()` on it. It may be a function now.

### Two drive hazards worth knowing

- **`GET /jobs` pages at 50, newest first.** The queue accumulates every job every
  drive has run, so an unbounded scan silently stops before the row it is about
  and reads as "there is no such job". Both job-aware drives pass `?limit=500`.
- **A staged failure must not outlive the run that armed it.** `POST /fail-next`
  on the mail sink is consumed by the next POST from anywhere — so when a stale
  pending job swallowed the dispatch that was meant to eat it, the 500 detonated
  in the *next* drive instead, alternating pass/fail. `DELETE /outbox` disarms it
  now, and the drive clears stale pending jobs for both order ids it uses.

---

## Session — `@frontierjs/email-kit` is the name (2026-08-06)

Ruled by the owner: the email component kit is **`@frontierjs/email-kit`**, not
`@frontierjs/mesa-email`. `FJS-D15` closed, `FJS-051` fixed, recorded in
`DECISIONS.md` § Naming.

`package.json` already carried the new name — what survived was the old one in
prose, comments, a user-facing peer-dependency error and the test filename.
Swept: README, `index.js`, `render.js`, `PROJECT_STATE.md`, mesa's docs and
state file, `example/README.md`, this file, and `mesa-email.test.js` →
`email-kit.test.js`. **`drift-report.md` keeps the old name deliberately** — it
is a dated audit, and rewriting its findings would falsify the record.

### The sweep found that the package's entire suite was failing

`PROJECT_STATE.md` said "34/34 tests pass". All 34 were failing, and had been
since mesa moved its sources into `src/`. Two causes:

- **In mesa, and this is the real one.** `renderComponent()` writes a temp
  `.mjs` and imports it, so that file must sit where `@frontierjs/mesa/runtime.js`
  resolves. `findMesaDir()` located that directory by testing
  `dirname(import.meta.url)` for a `package.json` — false once the file lived in
  `src/` — and then fell back to searching up from **`process.cwd()`**, which
  only finds mesa if you started the process inside it. Every other caller got
  the OS temp dir, where the emitted bare specifier cannot resolve at all. It
  now walks up from its own location to the nearest `package.json`. Mesa's own
  1012 tests never saw it; somebody else's suite did.
- **In email-kit**, the sibling probes still named `../mesa/render-component.js`,
  and the not-found check read only Node's phrasing while Vite says
  `Failed to load url … Does the file exist?` — so a missed candidate was
  rethrown before the specifier that works was ever tried.

`FJS-100`. email-kit 34/34, mesa **1013**, sierra 789, example unchanged.

**Guarded, not just fixed.** Mesa's suite could not see this: every test in it
runs from the mesa package root, the one cwd where the broken lookup still found
the right answer. `test/render-component.test.js` now renders in a **child
process with its cwd outside the repo** — what a consuming package does.
Reverting the fix fails it with `Cannot find package '@frontierjs/mesa' imported
from /tmp/__mesa_render_…`, checked by reverting it. The last-resort branch also
warns now instead of silently writing temp modules where nothing resolves.

**Worth taking from this**: a package's own state file claimed a number nobody
had re-run since the layout under it changed, and the suite that should have
caught the regression was structurally blind to it — it only ever ran from the
one directory where the bug was invisible. `VERIFYING.md` exists for this.

---

## Session — Basecamp: the mock, counted; then its shell (2026-08-06)

```
packages/mesa      1015 pass / 0 fail  (was 1013)
packages/sierra     789 pass / 0 fail  (unchanged)
packages/ui         64/64 compile · 25/25 render · 7/7 form  (unchanged)
packages/basecamp  verify 110/110, twice consecutively  (was 90) · 19 data tests
```

**Phase 2 landed in the same session: `/portal/` and `/activity/`** — the two
mock screens whose data already existed. Portal's split with `/admin/adapters/`
is the service's own (`find()` declares, `get(id)` pings live). Activity is the
audit trail as a narrative rather than a forensic table.

**Activity was not free, and finding out why is the result.** The application
audit trail ran on `create`/`patch`/`remove`, so **no custom action was in it at
all** — a server being drained, a release deployed, a job triggered, none of it.
The trail read as complete. It now runs `after: { all }` and decides what counts
the way Junction decides what to announce on a channel: everything but
`find`/`get`, and `ctx.dispatch = false` opts out. `servers.heartbeat` is
excluded **by name** — an agent on a timer would bury every human action, and
`dispatch = false` would have silenced the channel the live status pill needs.
Two more fell out: a custom action answers the row, not the envelope, so reading
only `.data` filed every action against `subjectId: 'unknown'`; and a write with
no session is now `actorType: 'system'` rather than the `'user'` default.

Still open from it: `AuditEvent.diff` is never written (`FJS-103` — the trail
says a server was drained, not from what state), and there is no workspace-wide
`ServerEvent` read (`FJS-104`), so the feed covers audit events only.

**The question was "what is next for Basecamp", and the answer needed a count
nobody had taken.** `docs/mock/BasecampUI.jsx` has **41 `*View` components and
13 modals**; `web/src/routes/` has 17 route files covering **12 of the 41**.
That is now `packages/basecamp/docs/SCREENS.md` and `FJS-101`, with the missing
29 grouped by what actually blocks them — and the grouping is the finding:

- **2** need nothing; **6** need a service over models that already exist;
  **15** need new models; **6** need a real outbound adapter.
- `AlertRule`+`AlertEvent`, `Network`+`ServerNetwork`+`AppNetwork` and `Secret`
  are **in the schema with no API surface at all**. Three sets of dead models.
- The largest single gap is `AppDetailView` (820 mock lines): **an App has no
  detail screen.**

So the rebuild is mostly Data- and API-realm work. Porting the JSX first would
produce more screens reading hardcoded arrays, which is what the mock already is.

**Then phase 1, the shell chrome** — ⌘K, toasts, and the attention system, over
real rows. `src/notices.js` is a **leaf module**: no imports, takes rows and
`now`, returns notices, so it runs in plain node and the shell's `NoticeBar` and
the home screen's `ActionQueue` cannot disagree about what needs attention. The
shell **subscribes rather than polls** — resource stores are module singletons
fed by the WebSocket, loaded once per workspace — and the check that pins it
posts an agent heartbeat at 95% CPU and asserts the notice appears **with no
reload**.

### Two defects, one of them in the compiler

**mesa — `prop=""` on a component compiled to `prop={true}`.** `inspectProp`
decided the valueless-boolean form (`<Table striped>`) by testing the value for
falsiness, and an explicit empty string is falsy. So `<Select placeholder="">`
— the spelling every kit component documents for *suppress this* — rendered an
`<option>` whose visible text was the word `true`. The parser had never lost the
distinction (`value: undefined` vs `value: ''`); the fix is one line and 2 tests.
Surfaced as a phantom third workspace in basecamp's switcher, caught by its
browser suite. `FJS-102`, closed.

**basecamp — `@frontierjs/ui` was never aliased in `web/config/vite.config.js`.**
The example aliases it to the workspace source and excludes it from
`optimizeDeps`; basecamp did neither and worked only because of a hand-made
symlink under `node_modules` that `bun install` would remove. Fixed the same way.

Also recorded rather than papered over: **`Server.health` has no declared
shape.** `Json?` in the schema, `Record<string, unknown>` in `HeartbeatData` —
the pressure rules read `health.cpu`/`health.memory` because that is what
`verify.mjs` posts and what the server screen renders, and an agent sending
`mem` would satisfy both types and silently raise nothing.

---

## Session — conduit + notifications, and two shapes that never met (2026-08-06)

```
packages/junction  866 pass / 0 fail  (was 842)  typecheck exactly 212
packages/litestone 1399 pass / 0 fail (was 1396)
example/  verify 37/37 (dev AND production build) · verify:ui 26/26
          verify:live 14/14 · verify:jobs 8/8 · verify:notify 8/8   ← new drive
          93 assertions, five drives, twice consecutively against one database
```

Paying an order now tells two audiences, neither inside the transition: the
customer gets an email, the staff get a row and a header bell. Both on the queue
(`api/jobs/announce-payment.job.ts`).

- **The mailer is `IMail` over Conduit** (`api/mailer.ts`). Junction's own
  `createResendMailer` holds a URL and a key in a closure and calls `fetch()` —
  outside the one outbound boundary. Over `app.conduit.send()` the provider is a
  declared target, the credential is a `ref` resolved at send time, and a failure
  is a typed `error.kind` rather than a thrown string.
- **The provider is `api/mail-sink.ts`** — a dev mail catcher on :3610 speaking
  Resend's `POST /emails` shape. A separate listener on purpose: in-process, no
  credential would resolve and no 500 could be exercised. `POST /fail-next` makes
  it fail once, which is how the retry path is a test and not a claim.
- **Two audiences, two classes.** `OrderConfirmation` (email, to a customer, who
  is not a user — `FJS-096`) and `OrderPaid` (inApp, to every staff user). The
  bell reads them back through `@@allow('read', userId == auth().id)`.
- The example raises its own login limit to 100: five drives sign in seven times
  per sweep against a 10-per-15-minute production default.

### Three defects, and the first two are one story

**junction — a session reached the Data boundary with no `id`.**
`SessionContext` says `userId`; Litestone's policy language reads `auth().id`,
its documented spelling. Nothing bridged them, so **every `@@allow` row policy in
every app matched nothing** — an empty list, no error. Gates were fine, because
`sessionGateLevel()` was written to Junction's shape, so the translated half
worked and the untranslated half failed in silence. New `toDataPrincipal()`, one
owner, both `$setAuth` call sites, 9 tests.

**litestone — fixing that broke the audit log, which is how it was found.** With
a real actor to record, `actorId Int` met a uuid: `cannot store TEXT value in
INTEGER column auditLogs_idx.actorId`, thrown out of the request. Unreachable for
exactly as long as the bug above existed (no id → null actor → NULL fits an
INTEGER column). Now `Any`, and an index whose columns no longer match the schema
is dropped **and refilled from the `.jsonl`** — dropping without refilling would
be an audit trail that silently looks shorter.

**junction — `methods:` was ignored by `createBaseService`.** The append-only
allow-list was read by `createService` and neither read nor forwarded by the
factory the loader is built around. Same declaration, two factories, one a no-op,
and the only symptom was a write that succeeded.

### If you pick this up next

- **`email-kit` is the last unexercised package.** The confirmation email's body
  comes from notifications' line builder; `@frontierjs/email-kit` would render it
  from a `.mesa` template. The sink already captures the HTML, so the drive that
  would check it exists.
- `FJS-096`: `notify()` addresses a `User`, and the email channel does not need
  one. A customer passed as a user works for email and would write an unreadable
  row if anyone added `inApp` to that `via()`.
- The five drives sign in 7× per sweep. If you add a sixth, check the budget.

---

## Session — caravan jobs in the example, and three more defects (2026-08-06)

```
packages/junction 842 pass / 0 fail   (was 836 — 6 new)   typecheck exactly 212
packages/caravan   79 pass / 0 fail   (was  67 — 12 new)  typecheck clean
example/          verify       → 37/37   (dev AND production build)
                  verify:ui    → 26/26
                  verify:live  → 14/14   (+2: a job's write reaching an idle tab)
                  verify:jobs  →   8/8   ← new drive, no browser
                  all four green twice consecutively against one database
```

`example/` now has the realm that had the least proof. The domain earns it:
`ship` moves the order and answers; booking the courier is somebody else's slow,
flaky HTTP call, so a Caravan worker does it afterwards and writes the tracking
code back **through the orders service** — which is what makes it announce. The
Tracking cell fills in, seconds later, in a tab that has been idle since before
the job was queued. That last sentence is one assertion in `verify:live`.

- `api/jobs/book-courier.job.ts` — autoloaded from `jobsDir`, queue
  `fulfilment`, 5 attempts, 1m/5m/30m backoff
- `api/jobs/sweep-abandoned.ts` — the cron (`0 3 * * *`), deliberately not
  `*.job.ts` (`FJS-094`: a job file cannot declare a schedule)
- `api/gate.ts` grew `SYSTEM` — see the hazard below
- `bun run verify:jobs` — 8 assertions, pure HTTP

### Three defects, and they were all found the same way

**junction — a PATCH applied model defaults to absent keys.** `mode: 'update'`
dropped required-ness and kept every `default`; `validate()` fills a default in
for any absent key. So `PATCH {"note":"x"}` reached the model as a whole record.
Ordinary columns were silently reset; a column under `@@transitions` answered
`409 Cannot transition order.status from 'shipped' to 'pending'`, which reads as
a broken state machine. One line (`if (mode === 'update') delete def.default`),
6 tests in `tests/patch-defaults.test.ts`.

**caravan — `unique` disagreed with its own schema, in both directions.** The
lookup said "a pending job with this key"; the column said `UNIQUE` forever. The
second dispatch after the first finished walked past the guard into the
constraint and 500'd a request. Matching any status instead fixed that and broke
the other half — a key built from a row id matched a job from a **deleted** order
whose id SQLite had reused, and the courier was silently never booked. It is now
a partial unique index over live jobs, so the guard and the constraint read the
same set, and an old `jobs.db` is migrated on open.

**caravan — a cron could be scheduled and never run.** Retry and cancel existed;
*start* did not. `POST /jobs/run/{name}` added, body becomes the job's data —
which is how `verify:jobs` exercises the sweep with a zero-day horizon instead of
waiting until 03:00.

### One gap left open on purpose

Adding `trackingCode` to the schema put a **Tracking** control in the generated
order form — correct for a form derived from the model, wrong for the domain.
Nothing in FJS can say "the system writes this column": Litestone emits
`readOnly` for computed/generated fields and Sierra reads it nowhere. The create
page now carries the repo's only hard-coded field name, marked as the workaround
it is. `FJS-095`, ruling `FJS-D22`.

### Traps this session paid for

- **A background job has no principal**, and no principal grades STRANGER(0) —
  a job writing through a service is refused by the model's own `@@gate` unless
  it passes one. `{ auth: { user: SYSTEM } }`, graded in `api/gate.ts`.
- **`verify.mjs` read the Moves column as `td:nth-child(6)`.** Adding a column
  ahead of it turned every moves assertion into `[]`, which reads as
  "@@transitions stopped reaching the browser". It finds the cell by its header
  now, and sorts rows by reference — `verify:jobs` re-creates a seeded order it
  cancels, which changes that row's id and where it sorts.
- **`jobs.db` outlives `shop.db`, and SQLite reuses row ids.** A count of jobs
  by `book-courier:{id}` includes the previous run's. Count deltas, not totals.

---

## Session — live updates, and the half of them that never worked (2026-08-06)

```
packages/junction 836 pass / 0 fail   (was 830 — 6 new)
packages/basecamp  19 pass / 0 fail   (unchanged)
example/          bun run verify      → 37/37
                  bun run verify:ui   → 26/26
                  bun run verify:live → 12/12   ← new drive
```

Two items off `example/`'s list: `FJS-086` (a chore) and `FJS-033` (the last
of phase 2). Both closed.

### FJS-086 — a rate-limited drive said "broken app"

`verify-ui.mjs` waited on the level badge, so a 429 from the login limiter read
as `waitFor timed out`. `verify.mjs` had detected and explained it for months;
the check is now shared, and both messages say the limiter is a per-IP
in-process `Map`, so restarting the API resets the window. Proved by injecting
the alert rather than by burning ten login attempts.

### FJS-033 — the check, and what it found

The ticket asked for one measurement: two clients, change in one, watch the
other. It is now a drive — `web/test/verify-live.mjs`, `bun run verify:live`.
A watcher tab, signed out, on `/orders/`, touching nothing; every change made
from node over plain HTTP. It asserts the WS frames **and** the rendered result
separately, because a page can look right purely because it refetched.

**Live updates do reach a second client.** `orders created` and `orders removed`
cross to a stranger tab and Sierra's store applies them. The echo worry is dead.

**A custom action announced nothing.** `pay` changed the row; no event reached
the bus or the channel. `callService` gated its one announcement point on
`AUTO_EVENT_MAP`, which holds the five CRUD writes. An action is in none of them.

The seam had both halves and neither could see the other — `client/index.ts` has
carried this since it was written:

```ts
// Custom action events (e.g. 'moved', 'archived') — treat as upserts.
// The server publishes them with the updated record, same as patch.
svc.on('*', (method, raw) => { … store.upsert(unwrap(raw), idField) })
```

The server never published one. Fixed:

```ts
const eventName = AUTO_EVENT_MAP[method] ?? (isAction ? method : undefined)
```

Ruled as `FJS-D21`: an action announces under its **own** name, no past tense
invented; `find`/`get` are excluded by name; a read-shaped action (search,
stats, export) opts out with `ctx.dispatch = false`, the existing switch, which
suppresses browsers and the bus together. The rejected alternative was opt-in
via `ctx.dispatch` — it makes the safe case the one you must remember, and a
framework whose live updates work for `patch` but not for `pay` looks broken in
the exact place it is being demonstrated.

**Why it survived this long: the example was hiding it.** `orders/index.mesa`
re-issued `orders.load()` after every action, so the acting tab looked correct
and every other tab went stale in silence. That line is gone; the table
re-grades from the broadcast, and a `store.upsert` of the returned row covers
the socketless (HTTP fallback) case. `verify:live` fails 4 of 12 if the junction
line is reverted — checked by reverting it.

### If you pick this up next

- **`FJS-010` is the neighbouring hole**: litestone's `onEvent` has no Junction
  subscriber, so a write that bypasses the service layer — a Caravan job through
  `asSystem()` — still announces nothing to anyone. Blocked on `FJS-D04`.
- The three drives share one 10-per-15-minute login window (2 + 1 + 1 per run).
  Restart the API to reset it.
- `example/`'s API is **not** started with `--watch`, so it does not notice a
  junction edit under it. Restart it or you will test the old code and believe
  the fix failed.

---

## Session — the form state machine, and the four defects building it found (2026-08-06)

```
packages/sierra   755 pass / 0 fail   (was 742 — 13 new)
packages/junction 809 pass / 0 fail   (was 806 — 3 new)
packages/ui       64/64 compile · 25/25 render · 7/7 form   (was 63/63 · 25/25)
packages/mesa    1012 pass / 0 fail   (unchanged)
example/          bun run verify       → 37/37   (dev)
                  bun run verify:build → 37/37   (production build)
                  bun run verify:ui    → 26/26
```

Started as a review of ten problems every fullstack framework has to answer,
checked against the tree rather than accepted. Most of the list either already
ships here or was already filed. **Item 7 — form state, validation, submission
and server-error mapping — was the one where FJS had the hard half done and the
easy half missing**, so it got built. Everything else in the list went into the
registers.

### The payload pipeline is on by default

`createResource`'s `coerce`, `blankToNull` and `validate` were opt-in. Each
answers something the DOM does that the schema has already said no to — every
control hands back a string, an untouched box submits `''` where SQLite wants
NULL, and without the check the first "no" is a 400 you still have to map.

The evidence they were the wrong default is that **every app in the repo set all
three**: all three resources in `example/`, eight of nine in `packages/basecamp`.
The one that did not is `audit`, which is append-only and never writes; `portal`
is the ninth and has no model at all — it reports on configuration, not rows.
Those flags are now deleted from both. A flag every app turns on is a default.

The test is `!== false`, not `?? true` — a prop threaded through a component that
never set it must read as "not stated", not silently disarm the check.

### One owner for "a thrown value → per-field messages"

New: `toFieldErrors(err)` in `sierra/src/junction/field-rules.js`, also reachable
as `resource.fieldErrors(err)`. Three shapes arrive because each hop adds a
wrapper — `err.errors` (the browser said no), `err.data.data` (a server 400
through the browser client, and the double `data` is real), `err.data` (one
shallower). Returns `{ fields, message }`; `message` is empty when the failure
was entirely per-field, so a form does not say everything twice.

In the leaf module on purpose: it stays usable from plain Node, and `<Form>` in
`@frontierjs/ui` calls it without knowing what a `ResourceValidationError` is.

### `<Form>`, and nine controls that resolve their own facts

`packages/ui/components/forms/Form.mesa`. Takes a resource; owns in-flight
state, dirty tracking, double-submit refusal, the error map, and the
live-validation rule. Publishes `$context.form`; `Field`, `Input`, `Textarea`,
`Select`, `NumberInput`, `Combobox`, `MultiSelect`, `FileUpload` and `Button`
read it. A stated prop always wins, including `required={false}`. An absent form
resolves to `undefined` and every fallback is what the control did standing
alone.

`novalidate` is on by default — kit controls put a real `required` on the input,
so the browser refuses to fire submit and shows its own bubble instead, silently
in a headless browser. That narrows `FJS-055` to hand-written `<form>` only.

**The live-validation rule moved in rather than being re-specced away.** One
rule: *on input an error may only be removed, never revealed.* A field is
revealed by leaving it having typed in it, or by submitting. Client and server
messages are kept apart — a server message survives until its own field is
edited. The reveal listener is `blur` in the **capture** phase, not `focusout`:
capture runs root-to-target regardless of bubbling, so one listener on the
`<form>` sees an event that by definition does not bubble.

### `example/`'s order form rewritten onto it

`web/src/routes/orders/create.mesa` lost about 90 lines — `errors` / `shown` /
`typed` / `visible`, a `check()`, an `onInput`, an `onLeave`, a `saving` flag, a
`failed` string, and a `save()` that coerced, validated, revealed everything and
unwrapped a `ResourceValidationError` by hand. All correct; none of it about
orders. It also dropped every `label=`, `required=`, `type=` and `maxlength=`.

All six live-validation assertions pass against the component's implementation.
One assertion was re-specced deliberately: `form.controls` labels are now
schema-derived, so `Customer` rather than `customer`.

### The four defects, all found by running it

**`FJS-087` — a Mesa component cannot expose a method.** `export function
submit()` is **dropped from the compiled output entirely** (`compiler.js:5998`
skips every `ExportNamedDeclaration` in the instance script; only `export let` is
handled before it), so `<Form>`'s own `on:submit={submit}` threw `ReferenceError`
on the first click. VISION §10.2 and RULE 36 document `counterRef.reset()` as
supported. The obvious workaround is worse: `export let submit = async () => {…}`
emits `$runtime.get(sig) = true` for every assignment in the body — reads inside
a prop initialiser are rewritten, assignments are not — and does not parse.
**No render test could have caught the first half**: SSR never dispatches an
event. Several `@frontierjs/ui` components document `bind:this` methods that do
not exist. `<Form>` hands its API out through an `onready` callback instead.

**`FJS-075` — an unpicked relation picker silently selected the first row.**
`Select`'s placeholder `<option>` was `disabled`, and a disabled option cannot
hold the selection. A select whose options arrive late — which is every relation
picker — lost the placeholder the moment the list repopulated and landed on the
first real row. An unpicked "customer" became customer #1 and the order was filed
against them with nothing on screen saying so. The previous handoff entry records
`verify` at 37/37; it was 36/37 on 2026-08-06, and stashing this session's work
reproduced the failure, so it predates today. **Fixed and closed.**

**`FJS-077`, second half — a control shadowed the schema's `@label`.** `Select`
and `Textarea` computed `nameToLabel(name)` and passed it to `<Field>` as an
explicit label, so a rule's `title` could never win: `@label("Customer")`
rendered as "Customer Id" and the annotation was unreachable through the kit.
Both fixed; every other control that wraps `Field` still has it.

**`FJS-080` — this drive could only be run once per database.** It deletes an
order, and `seed()` guarded everything on `product.count() > 0`, so the orders
ran out and no restart brought them back. The second run failed in ways that read
as a regression in whatever you had just changed — which is how it was hit.
Per-table guards now, and the three seeded orders are restored by reference with
their expected status. **Demonstrated**: a restart against a table with *zero*
orders brought all three back, and the drive then passed three times
consecutively. **Fixed and closed.**

Also fixed: **a `service_error` frame dropped the field list.** The server sends
`FrameworkError.toJSON()`; the client took `message` and `code` and discarded
`data`. WebSocket is the default transport, so that was the shape a form saw in
production while the HTTP fallback it was developed against looked correct. Now
shaped to match HTTP exactly, so one unwrapper serves both. Three tests, and I
confirmed they fail without the fix.

### Registers

**Closed:** `FJS-075`, `FJS-076`, `FJS-080`.

**Filed:** `FJS-081` (a `render: static` route can publish gated data as public
HTML — `prerender.js` is 352 lines with no occurrence of *gate*, *auth* or
*level*, so the hole is confirmed shipped behaviour) · `FJS-082` (`load()` has no
staleness discipline — `store.set(rows)` unconditional) · `FJS-083` (`page` has
no `query`; search params are not reactive) · `FJS-084` (the browser client
cannot ask for a relation — the bridge parses `$populate`, `FindParams` has no
field for it) · `FJS-086` (`verify-ui` reports a rate-limited sign-in as a
timeout) · `FJS-087` · `FJS-088` (the inbound idempotency key is plumbed and
**inert** — and Conduit *sends* `Idempotency-Key` outbound and treats it as
licence to retry, so FJS asks other APIs for a guarantee its own accepts the
header for and does not honour) · `FJS-089` (no commit-scoped hook phase: an
`after` hook that sends an email runs, a later `after` hook throws, and the
client sees a rejected create whose email has gone) · `FJS-090` (a Caravan job's
name is stated up to three times and `autoload.ts` never checks the filename
against the definition) · `FJS-091` (nothing calls `routePaths()`; `FJS-012` is
what that costs).

**New `IDEAS/`:** `client-data-lifecycle.md` (request staleness, optimism and
entity identity are one missing owner, not three features),
`declared-semantics.md` (`@version`, `Money`, bitemporality, and the resumable
*process* noun `@@transitions` is not), `forms-from-the-seed.md` (scoped down to
what is left after `<Form>` — the field *list*), `form-actions.md`,
`server-only-boundary.md`. `overview.md` re-derived: rows 0.8, 1.1a, 2.10, 4.4c,
4.14, 4.15, and 4.4 promoted to a defect with an id.

**`DECISIONS.md`, three rulings.** Signal and Event are two words for two things,
both legal — §2 listed *signal* as a banned synonym for Event, which was aimed at
"signal" meaning *notification* and accidentally outlawed the word Mesa's runtime
uses for its core primitive. Policy keeps exactly two meanings and a third was
refused. Projection adopted for a read model only. `ARCHITECT.md` §2 updated.

Corrected: `IDEAS/state-machines.md` still opened *"Nothing here is built. No
`@@transitions` attribute exists"* two days after it shipped.

### Two operational traps, learned the hard way

- **`pkill -f <pattern>` matches this shell's own command line.** Twice a kill
  and a restart in one command killed the shell instead (exit 144, no output).
  Put the kill in its own call, or make sure the pattern appears nowhere else on
  the line.
- **Login is rate limited to 10 per 15 minutes** and each drive signs in twice,
  so roughly five runs per quarter hour. `verify.mjs` detects the 429 and says
  so; `verify-ui.mjs` dies on a `waitFor` timeout that reads like a broken app
  (`FJS-086`). Restarting the API resets the window.

**Not done:** `FJS-077`'s remaining controls (`Checkbox`, `Switch`,
`RadioGroup`, `Slider`, `DatePicker` still resolve nothing from the form
context) · `FJS-078` (`Select` does not derive options from `fields.x.enum`,
so every enum select in the repo still maps it by hand) · nothing from the new
`IDEAS/` files · and **nothing is committed**, which remains the single most
important fact for a new session.

---

## Session — seven imported proposals, and the two defects checking them found (2026-08-05)

```
packages/litestone  1370 pass / 0 fail   (was 1362 — 8 new)
packages/mesa       1012 pass / 0 fail   (was 1003 — 9 new)
```

Seven design concepts (signal-granular hydration, server-owned signals, free
time travel, auto suspense, static client/server boundary analysis, stable
component identity, compiler-enforced policy boundaries) were checked against
the tree rather than accepted. Four were kept, three were not, and **checking
them turned up two defects that were nobody's proposal**:

- **`FJS-073`** — `<mesa:boundary>` watched *every* async value in the
  component, not the ones its body reads (`compiler.js:3079` said so in a
  comment). One hanging `await` held unrelated content in `pending`, and two
  boundaries in one component always fired together.
- **`FJS-074`** — **`updateMany` / `deleteMany` wrote no audit entry at all**
  on an `@@log` model. Probed, not read: two creates logged, the bulk update
  and bulk delete that followed absent. Both called `fireQuery` and never
  `emitLogs`. An append-only trail that omits the most destructive operation
  in the API is worse than none, because it is trusted.

**Both are fixed and closed.**

*Mesa* — the watch set is what the body reads (interpolation, block header,
attribute, component prop, `@const`, all pinned). The collection
over-approximates on purpose: under-watching shows content before its data
arrived. Two cases keep the whole-component union — a body that reads nothing
async (the only way to say "gate this region on everything") and one that
renders a snippet defined elsewhere, whose reads are not in the subtree.

*Litestone* — five paths were uninstrumented, not two: `removeMany`, `restore`
and `upsertMany` as well. All five log now, and on a logged model the bulk
statement takes `RETURNING` so the entry can name its rows. That also fixed
`createMany`, whose entry named **no** rows — an `@id @default(autoincrement())`
row has no id until SQLite assigns one, and the entry was built from the
pre-insert data. `upsertMany` splits its batch into a `create` entry and an
`update` entry by looking up which conflict keys exist *before* writing.
Unlogged models pay nothing — every `RETURNING` path is behind `tableHasAnyLog`.
`docs/audit-logging.md` claimed bulk entries existed without snapshots; corrected.

What is still open from this: a bulk entry names its rows but does not snapshot
them, so a bulk delete is now *visible* but not *invertible*. That is the
remainder recorded on wave 0.7 and the thing 4.13 has to answer.

Docs, in the same pass. New files: `IDEAS/time-travel.md` (named checkpoints over the audit trail —
snapshot is the truth, the log is the narrative, and replay never reconstructs
a redacted value, so Invariant 7 holds), `IDEAS/derived-suspense.md`.
Extended: `static-safety.md` (classify every route as prerenderable /
server-needed / pure client, don't only check the ones that claim `static`),
`live-queries.md` (grade the fan-out per subscriber — the server holds the row,
the socket's level and the declared requirement at the same moment),
`one-mental-model.md` (why per-edge hydration is available to whoever builds
hydration, and why that is not now). `IDEAS/overview.md` re-derived: rows 0.6,
0.7, 4.4b, 4.12, 4.13.

Rejected, with the reasoning kept where it belongs rather than as a row:
signal-graph time travel (state is in closures, effects are not invertible —
the real version is one realm down), stable identity without keys (already true
within a page, false across navigation), compiler-enforced policy/mechanism
(the reactive graph cannot see a module edge — that is `fli doctor`'s job).

**Not done:** anything in wave 4 — 4.12 (derived boundary *placement*) and 4.13
(checkpoints) are features, not repairs, and neither was started.

---

## Session — `example/` on `@frontierjs/ui`, and the twelve defects that found (2026-08-04 → 08-05)

```
packages/mesa     975 pass / 0 fail   (was 960)
packages/sierra   742 pass / 0 fail
packages/ui       63/63 compile · 25/25 render
example/          bun run verify     → 37/37   (framework drive)
                  bun run verify:ui  → 26/26   (kit drive — NEW)
                  bun run verify:build → 37/37 (production build — NEW)
jetty             422 pass / 1 fail  — the pre-existing phase8 import.meta failure, unchanged
```

**Nothing is committed.** `example/` is still untracked and the package changes
are unstaged; repo-wide `git status --porcelain` is ~465 paths. That remains the
single most important fact for a new session.

### What was done

`example/`'s markup moved onto `@frontierjs/ui`, and then four screens were
added specifically to drive the components a compile test and a static render
cannot reach:

| screen | components |
| --- | --- |
| `/orders/{id}/` (new) | Breadcrumbs, Steps, Tabs/TabList/TabPanel, DropdownMenu, Modal, Tooltip, StatCard, Skeleton |
| `/products/` filter bar | Combobox, MultiSelect, range Slider, Pagination, EmptyState, Table's loading state |
| `/settings/` (new) | Accordion, Switch, RadioGroup, NumberInput, Textarea, Progress |
| the shell | CommandPalette (⌘K), Toaster |

**28 of the kit's 63 components are now verified in a browser**, up from zero.
`web/test/verify-ui.mjs` is the second drive — roving tabindex, focus inside a
`<dialog>`, Escape closing a menu, a toast appearing, ⌘K filtering and running a
command — and both drives pass against the dev server AND the production build.

The build needed a server of its own to do that (`web/test/preview.mjs`):
`vite preview` carries no `server.proxy`, and `/ws` must be proxied or the
delete assertion fails, because a row leaves the table on the real-time event
rather than on the response.

### ⚠ The three that would cost a day each

- **A click inside `<mesa:portal>` never reached its handler.** Delegated
  handlers are `__click` properties, found by walking from the event target up
  to a *registered* root; `mount()` registers only the app's container, and a
  portal appends to `document.body`, outside it. Every menu item,
  command-palette row and toast dismiss button in the kit was inert — correct
  markup, correct ARIA, no console error, and a click that did nothing at all.
  Portals now register their target, reference-counted so two open portals
  sharing `document.body` cannot tear each other's listener down.
- **All four `@frontierjs/ui` stores were inert.** `toasts`, `commandPalette`,
  `alert` and `theme` wrote `this.x = …` on a plain object. A component watches
  a plain object through `watchProxy`, and only a write **through that proxy**
  notifies — the rule `example/web/src/session.js` documents. Toasts queued
  correctly and the Toaster never rendered one; ⌘K flipped a boolean nothing was
  listening to.
- **Sierra's `mesa-plugin` ignored `analysis.errors`.** It forwarded warnings
  only, so a component the compiler had *correctly rejected* was served anyway:
  a settings screen with five diagnosed `bind:` errors rendered, looked right,
  and collected nothing. Now the transform throws. Ruled in `DECISIONS.md`.

### The rest of the ledger

Mesa (all six compiled clean and failed in a browser):

- `{#snippet}` inside a component tag never reached the component — VISION §9.5
  documents them as same-name props; they fell into the default slot.
- A snippet's arguments were read once and frozen. Arguments are getters now.
- An assignment inside a component prop compiled to a signal READ:
  `<Modal onclick={() => open = false}>` threw `Invalid left-hand side in
  assignment`, so a dialog's Cancel button did nothing.
- `$: fn(), handler` spliced its output out of the wrong string
  (`$$set_high(sa'`, taken from an import statement); and it threw
  `Assignment to constant variable` when the watched function was a `const`,
  which is now a compile error naming the fix.
- An attribute depending only on a `{@const}` was written once and never
  updated — a completed step kept `aria-current="step"`.
- `<C aria-label="x">` emitted `{aria-label: 'x'}`, a syntax error in generated
  code. And `$attributes` was every prop unfiltered.
- `<Table striped>` compiled to a reference to a variable named `striped`.

`@frontierjs/ui`: `Field` toned the wrapper (`--bg-mix` is `inherits: false`, so
**no validation message in the kit was ever red**); `Input` swallowed `oninput`,
had no `maxlength`, and turned a cleared number field into `0`; `Select`'s
placeholder submitted its own label; `DropdownMenu` rendered a `children`
snippet its own docs never pass, so every menu opened empty; `Table`'s loading
skeleton threw `array.map is not a function`; `RadioGroup` ignored its `id`;
`Label` emitted `for=""`; the `exports` map could not resolve the import its
README documents.

`example/`: **the production build loaded no JavaScript at all.** `index.html`
mentioned a literal body tag inside a comment, and Vite injects the built script
at the first match without skipping comments — so the tags landed *inside* the
comment. Clean build, plausible `dist/index.html`, empty console. Nobody had
ever opened the built page.

### Two hazards now in `CLAUDE.md`

- **A running dev server does not notice that the compiler changed under it.** A
  `.mesa` module is transformed once and cached for the process's life. A server
  left running from before a fix serves output from before the fix, and the app
  fails exactly as it did — which reads as "the fix did not work". Start the
  server the run will test, and refuse a port that already answers. (Another
  session on this machine also wanted :5274; the second one silently tested the
  first one's app.)
- **Vite injects the built `<script>` at the first body-tag match and does not
  skip comments.** A build that succeeds is not a page that runs.

### Where to pick up

1. **Commit.** Same as the last three sessions, now with more to lose.
2. **Live updates** — `example/PROJECT_STATE.md` § Next. It is narrower than it
   was: with `/ws` unproxied the delete assertion fails, so a `removed` event
   does reach the store today. What is untested is a SECOND client — every
   observation so far is the originating tab, which may be seeing its own echo.
3. **The other 35 kit components** — `DatePicker` (1200 lines) is the biggest
   unknown, then `Drawer` / `Popover` / `ConfirmationPopover` / `FileUpload`.
   The way in is a screen that needs them, not a gallery.
4. **`{...$attributes}` is applied to 8 of 63 components.** The other 55 still
   cannot take an `id` or an `aria-label`. One line each, worth a sweep.

---

## Earlier sessions — handoff as written on 2026-08-04

Session state for picking up cold. Read `CLAUDE.md` first (the map), then this.

Everything below was verified by running it, not by reading. Where I could not
verify something, it says so.

**Sessions are recorded here, newest first.** The `website/`/`IDEAS/` session
touched no package source and ran alongside the island + CSS-scoping session
below it; before those, SSR_SPEC W3 in `packages/mesa`, one across mesa + sierra,
one entirely in `packages/css`, and junction/litestone, which starts at
*Where things stand*. **Its prose is still true; its numbers are not** — they were
superseded by later sessions and re-verified 2026-08-02. For any current count or
baseline, `CLAUDE.md`'s package table is the source of truth.

---

## Session — Basecamp: the UI realm, phases 0–6 (2026-08-04)

`packages/basecamp/web/` went from a 12,557-line React mock that had never made
a request to a Sierra SPA covering every service. `bun run verify --reset` drives
the whole thing in a real browser over CDP and asserts **80 facts**; the phases
and what each found are in `packages/basecamp/docs/UI_PLAN.md`.

**What it exercises:** first-run setup → login → workspace switching → Projects
→ Environments → Apps → deployments with a live step timeline → the server fleet
(drain/reboot/sync, event trail, agent heartbeat) → jobs with run history →
admin (members, audit trail, adapters).

### Framework bugs this found, all fixed

- **Junction dropped the workspace on the WebSocket.** The browser client routes
  CRUD over the socket once one is open, and the frame carried no
  `X-Workspace-Id` — the server only ever sees the UPGRADE request's headers, so
  a per-call value cannot arrive that way. Any header-scoped app worked until it
  went live, then answered `workspace_id required` on every call. The client now
  sends `meta.workspaceId` and `transport/channels.ts` merges that ONE key onto
  `ctx.client.headers` — identity stays with the connection, since a frame that
  could set arbitrary headers could set `Authorization`. Three tests in
  `junction/tests/client-transport.test.ts`.
- **Basecamp's channels had never delivered anything**, for two independent
  reasons: the connection joined `workspace:${session.workspace_id}` (the field
  is `workspaceId`, and auth never populates it — connections now join every
  workspace the user is a member of, by query), and both engines called
  `channel.publish()`, which does not exist — `publish()` is on the manager, a
  Channel has `send()`. Their own guards made it a silent no-op.
- **`POST /workspaces` was unreachable.** `autoValidate` demanded `accountId`
  and `ownerId`, which `create()` takes from the session on purpose. Stamped in
  a `before/create` hook, which runs ahead of the derived validation.

### Two patterns worth generalising — see `packages/junction/PROJECT_STATE.md` §Open

- **`createService({ model })` has no read-only mode.** A service declaring only
  `find()` still answers writes through the base service. `/audit` is an
  append-only trail and an admin could forge a row into it — verified — until
  four `MethodNotAllowed` stubs were added by hand. Opt-out safety with no
  warning; wants `methods: [...]` or `readOnly: true`.
- **A custom method that returns a partial row breaks its callers**, four times
  over here. The return value is also the channel payload, so a projection
  without an `id` cannot be matched to the row it describes.

### Also

`db/seed.js` — an example fleet (4 users, 2 workspaces, 9 servers, 80
deployments with steps, 30 jobs with runs, secrets, audit events), idempotent,
`--force` to re-seed. `db/schema.lite` now declares `database main`, which
immediately caught 4 tests silently opening the DEVELOPMENT database: a
declaration wins over `createClient({ db })` with no warning.

**Still open:** no `@@gate` in the schema (Invariant 6), no invitation flow —
`/auth/register` creates a user with no account or workspace, so the only way in
is the setup wizard, and services publish on reads as well as writes.

---

## Session — Basecamp: Data + API realms rebuilt (2026-08-03 → 2026-08-04)

**Next session is the UI. Read `packages/basecamp/docs/UI_HANDOFF.md` — it is
written for exactly that and has the API contract in it.**

Basecamp went from "cannot start" to an app that boots and serves. It is now a
workspace member (`bun run --filter '@frontierjs/basecamp' test` → 19 green).

**Data realm.** `db/schema.lite` is the seed: 24 models, 15 enums, 0 errors/0
warnings. `db/migrations/001_initial_schema.sql` is **generated** by
`bun db/generate.js` (`--check` fails CI on drift) — never hand-edited. Identity
moved onto `@frontierjs/auth`'s fragments, so `User`/`Credential`/`Session`/
`Verification` are load-bearing names. Two forced renames: `service` → `App`
(the noun VISION forbids overloading) and `credential` → `Secret` (auth owns
`Credential`). `Secret.data` is `@encrypted` — verified absent from
`strings basecamp.db`.

**API realm.** All 8 services + both engines converted to Litestone accessors —
**zero raw SQL in `api/src`**. `@frontierjs/auth` replaces the hand-rolled HMAC;
`basecamp-auth.ts` deleted. `api/src/core/` holds `app/db/env/hooks/resource`.
Verified over HTTP on a clean db: setup → login → project → environment → app →
env var → job → deployment, with the deployment engine completing 6 steps
through Caravan and the job engine recording JobRuns.

### Bugs found in Basecamp

- **Nothing enforced roles.** Services read `ctx.params.user.user_id` and
  `ctx.params.headers` — **a ServiceContext has no `ctx.params`** (verified:
  `'params' in ctx` → false). Every read was `undefined`, so the role guards hit
  their `if (!userId) return` and passed everyone. `workspaces` had the same
  hole by a different route: its role hook read a `workspaceId` that only
  `requireWorkspace()` sets, which that service never runs — so **any user could
  delete any workspace**.
- `servers.heartbeat` sat behind `before: { all: [authenticate] }` with a
  comment claiming exemption, so the agent could never check in.
- `002_server_agent.sql` was never valid SQLite (`ADD COLUMN IF NOT EXISTS`).
- `setMemberRole` could demote the last owner; `EnvironmentTier` had 3 values
  while the service offered 5; `env.PORT`/`HOST` were declared and never read.

### Framework fixes this shook out

- **litestone — audit log leaked protected fields.** `@@log(audit)` wrote
  `@encrypted`/`@guarded`/`@secret` values as PLAINTEXT into `auditLogs.jsonl`
  while the row was correctly ciphertext. Now `[redacted]`, both field-level and
  in `before`/`after` snapshots. 8 tests; 5 fail if reverted. **Any audit file
  written before 2026-08-03 may contain secrets in the clear.**
- **litestone — `FrontierGateGetLevel` graded every real session VISITOR(1).**
  It tested `!user.verifiedAt`, collapsing "app does not model verification"
  (absent) into "unverified" (`null`), so any app without a verification flow
  403'd its own API once `@@gate` auto-installed the resolver. Also checked
  `role` before `isSystemAdmin`/`isOwner`/`isAdmin`, so a sysadmin with no role
  string graded CREATOR(3). Both fixed; **1289 tests, 0 fail**.
- Known-unfixed: **`@encrypted` on a `Json` field silently destroys the value**
  (round-trips as `"[object Object]"`). Use `String @encrypted`.

### Open

- **Gates.** `db/schema.lite` declares no `@@gate` — a gap against Invariant 6,
  not a decision (the 2026-08-04 ruling excusing it was withdrawn). The blocker
  is a per-workspace `getLevel` mapping `WorkspaceMember.role` onto 0–7;
  intended levels are kept in `packages/basecamp/db/README.md`,
  pattern in `example/api/gate.ts`.
- **Auth** — deferred to last by the user. Bearer tokens work; no OAuth.
- **UI** — `web/` is a 12,557-line React mock with 0 `fetch` calls. Not ported,
  not portable: read it for information architecture, rebuild in Sierra + Mesa +
  `@frontierjs/css`.

---

## Session — `@@transitions`: state machines in the schema (2026-08-04)

```
packages/litestone  1286 pass / 0 fail (was 1253)
packages/sierra      724 pass / 0 fail (was 707)
packages/junction    781 pass / 0 fail (unchanged — downstream check)
chain proof:         litestone jsonschema over a .lite file → x-transitions with
                     gate: 5 on the model def → sierra resource.transitions()
```

An `Order` goes `pending → paid → shipped` and never back, and only an admin
refunds. That used to live in whatever service handler was written first. It is
now declared on the model, enforced at the Data boundary, and readable by the
browser.

```prisma
model Order {
  status OrderStatus @default(pending)
  @@transitions(status,
    pay:    pending         -> paid,
    ship:   paid            -> shipped,
    refund: paid            -> refunded @gate(5),
    cancel: [pending, paid] -> cancelled)
}
```

### Two thirds of this already existed — attached to the wrong noun

Litestone shipped `enum X { transitions { pay: pending -> paid } }`: parsing,
enforcement with optimistic-lock `WHERE` narrowing, `db.order.transition(id, name)`,
a `transition` event, three error classes, ~20 tests. What it could not do:

1. **Authorize.** No gate anywhere.
2. **Reach the browser.** It emitted `x-litestone-transitions` onto the *enum*
   `$def` and **nothing in sierra or junction read it** — zero hits outside
   litestone.
3. **Differ per model.** `buildTransitionMap()` indexed by enum name and
   attached the machine to every model with a field of that type, so two models
   sharing one `Status` were stuck with one machine — and would have been stuck
   with one authority level.

(3) is why the gate had nowhere to hang. The machine moved to the model, beside
`@@gate` and `@@allow` where every other access declaration lives. The enum block
is kept as shorthand for the common case and **desugars into `@@transitions` at
parse time** (`resolveTransitions()` in the parser, beside `resolveTraits`), so
there is one enforcement path and one thing downstream. Its 20 tests pass
untouched — that is the proof the shorthand still means what it meant.

### What to know

- **`@gate(N)` is a floor on top of `@@gate`'s update level**, which had to pass
  to reach the write at all. Shipping an order and refunding one are not the
  same authority. Under-level throws `TransitionGateError`, which carries its
  own `status: 403` — junction maps it with no registration.
- **`ctx.levelFor(model, ctx)` is new.** GatePlugin's per-request level cache was
  private; client.js needed it for the gate check. GatePlugin publishes it in
  `onInit` and stays the single owner of the 0–9 scale.
- **A gated transition auto-installs a level resolver** when the app configures
  no GatePlugin, same as `@@gate` does — and inherits that hazard whole: the
  shipped `FrontierGateGetLevel` grades a bare session at `VISITOR(1)` and tops
  out at `CREATOR(3)`. Verified, and pinned by a test asserting `err.got === 1`.
  Anything real passes its own `getLevel`.
- **`x-litestone-transitions` is gone from the enum `$def`** (breaking). The
  resolved machine is `x-transitions` on the model, keyed by field. Two sources
  would drift the moment one model narrowed.
- **`remove()` does not enforce transitions** — it never did, despite
  `docs/soft-delete.md` saying so for who knows how long. `checkTransitions()`
  has exactly one call site, inside `update()`. Left as is and the doc corrected;
  use `@@deny('delete', …)` to require a state before deletion (verified: it
  returns `null` rather than throwing, because a policy filters).

### Three docs described syntax that never existed

None of them matched the implementation, and no two matched each other:
`docs/schema.md` documented a `@from(pending)` attribute on enum *values*;
`docs/roadmap.md` listed `@@transitions([{name, from, to}])` as "under
consideration"; `docs/soft-delete.md` used that same array form. All corrected.
Worth assuming the same of any litestone doc not recently exercised.

### Not done

The Junction hop. `resource.transitions(row, level)` tells the UI which buttons
to draw; firing one is still a hand-written service method in the app. Deferred
deliberately — that's the `actions` seam `CLAUDE.md` flags as still under review.

---

## Session — nested islands, and a double-dispatch bug in Mesa (2026-08-03)

```
packages/mesa     941 pass / 0 fail / 27 skipped   typecheck clean
packages/sierra   707 pass / 0 fail (34 files)     typecheck clean
browser proof:    npx vite build --config tests/fixtures/island-site/vite.config.js
                  node tests/fixtures/island-site/verify.mjs      → 25 assertions
```

Closed both items the previous session left open on islands — nested islands now
build end to end, and three components carry CSS so the `<style>` assertions pin
ordering and not just the dedupe. The fixture change then turned up a bug in
Mesa that has nothing to do with islands.

### ⚠ Mesa: a handler ran once per ancestor delegation root

`mount()` registers the anchor's parent element as a delegation root, and each
root's listener walked `composedPath()` from the target up to **its own** root,
dispatching every `__click` on the way. Nest two roots and the event passes
through both: the inner listener fires, the event keeps bubbling, the outer
listener walks the same path and calls the same handler again. **One click, two
increments**, in the deeper tree only.

Roots nest whenever two mounted trees sit at different depths — on a static page
every island registers its own parent element, so one island inside a wrapper
`<div>` and another outside it is enough. The old fixture happened to put every
island in the same `<main>`, which is the only reason this was not already
visible. Fixed by giving the event to the **nearest** registered root; pinned in
`runtime.test.js`. See DECISIONS → UI substrate (Mesa).

### Nested islands: defer to the ancestor, do not race it

On the client there is no nesting to honour — `island()` short-circuits when
`_isClient`, so a mounted island renders its `client:*` children **directly**,
live, before their own directives fire. The loader now defers to that in three
places (`packages/sierra/src/islands/loader.js`):

1. A scheduled callback checks `open.isConnected` before touching the registry,
   so a subsumed island **downloads nothing**. It also stops the old symptom: the
   inner island reached `mount()` with a detached anchor, threw, and was logged
   as `<Inner> failed to load or mount` — a working island announced as broken.
2. Mounting removes the range **as it stands now**, not `island.nodes` from scan
   time. A descendant that mounted first has replaced its own markup; removing
   the stale list would strand its live nodes beside the fresh render.
3. A descendant that got there first is disposed rather than leaked.

`findIslands` links each island to its `parent`. `client:static` under a live
ancestor warns (a live parent renders its children, so it cannot be honoured); a
`client:static` **parent** never mounts and so subsumes nothing.

**`isConnected`, not `parentNode`** — removing an ancestor leaves the inner
marker's `parentNode` pointing at the removed node, so a `parentNode` check reads
as "still there" and mounts the component into a subtree nobody will ever see.
That version passed the browser check and failed the unit test, which is the
argument for having both.

### The browser harness was measuring the wrong thing

`client:visible` below the fold reported as never mounting about **4 runs in 5**,
and it was the harness. Under `--virtual-time-budget`, Chrome gives the page a
rendering lifecycle around load and then effectively none, and
IntersectionObserver only delivers records during one — so a scroll late in the
probe lands after the last frame that will ever happen. Neither
`--run-all-compositor-stages-before-draw` nor pumping `requestAnimationFrame`
fixed it (rAF itself stalls after one or two frames, and awaiting one hangs).

What works, 5/5: **scroll before the first lifecycle**. `Below` now sits in its
own `overflow: auto` box so scrolling it does not push `Seen` out of the viewport
before intersections are first computed, and the "not fetched until visible"
claim is asserted at the moment of the scroll rather than by the clock. 15 runs
since: 14 clean, one failure straight after a build that has not reproduced in
the 10 runs since.

### Also worth knowing

- **jetty's `phase8` fails** — `islands/demo.js` (a browser-extension content
  script, unrelated to Sierra islands) contains `import.meta` and MV3 content
  scripts are classic scripts. **Pre-existing**: verified by reverting the Mesa
  change and re-running. jetty is 422 pass / 1 fail, not green.
- Mesa's suite is **941 passing**, not the 929 in `CLAUDE.md` — the count was
  already stale before this session's one new test.

---

## Session — `website/` and `IDEAS/` (2026-08-02 → 08-03)

**Touched no package source.** Wrote the public site and a set of design records.
Ran in parallel with the island work below; the two do not overlap.

**`IDEAS/` — new directory, one idea per file.** Design records for work not yet
started. All are marked unbuilt at the top, per `VERIFYING.md`.

| File | What it argues |
| --- | --- |
| `slices.md` | Installable full-stack modules. Folder-as-manifest (`model/` `service/` `resource/` `suite/`), partial install, link-vs-eject |
| `framework-shape.md` | Realm-by-realm gap assessment. #1 is schema→UI derivation |
| `offline-first-and-release.md` | Offline-first / portable / self-hosted as Release constraints; conflict policy belongs in the schema |
| `one-mental-model.md` | Where concepts repeat vs only appear to. Includes the full extension-point catalogue (§5) and the Junction/Conduit plugin review (§5q) |
| `ecosystem-gaps.md` | vs Laravel — tier-1 blockers (OAuth, billing, storage, i18n), tier-2 batteries, and a Laravel Shift equivalent |
| `operational-edge.md` | vs Encore — provisioning, preview environments, tracing |

**`website/`** — one-page overview plus five feature pages (`showroom`,
`showroom2` walkthrough, `showroom3` ripple, `showroom4` loop, `showroom5` stack),
an interactive `journey.html`, and eight dedicated package pages. `bun run dev`,
`build`, `preview`. Styled entirely by `@frontierjs/css`, which makes the site its
second consumer. Details and the publication gate in `website/README.md`.

### Findings that affect packages

- **`@frontierjs/css` — `.btn.outlined` fails AA in all six themes** (1.99–4.40:1).
  Measured in headless Chrome. `buttons.css` already documents the cause in the
  `.ghost` comment and applies the fix there but not to `.outlined`. Recorded in
  that package's `PROJECT_STATE.md`.
- **`fli admin:generate` has drifted from the stack** — emits `.svelte` into
  `web/src/routes/`, generates `_layout.svelte` not `_module.mesa`, documents a
  lowercase-plural `users` model. Almost certainly non-functional. See
  `IDEAS/ecosystem-gaps.md`.
- **`@frontierjs/auth` has no OAuth and no TOTP.** The `Credential` model already
  carries `accessToken` / `refreshToken` / `scope` columns, so the schema
  anticipated it. The website describes both as shipped — deliberate, per its
  launch-voice brief, but gated in `website/README.md`.
- **Corrected in `CLAUDE.md`:** litestone 1.1.0 **is** published and npm `latest`
  points at it (verified via dist-tags and by unpacking the tarball). The dialect
  trap is closed. Two stale claims fixed.
- **Corrected an earlier review of mine:** `app.provide()` already exists
  (`core/app.ts:659`) and throws on collision; Caravan uses it. Conduit's raw
  `app.conduit = instance` is the outlier.

### Three analyses now point at the same hole

`framework-shape.md` (item 3), `offline-first-and-release.md` and
`operational-edge.md` each arrived independently at **Release being the only realm
with no package**. That is the recommendation with the most support behind it.

---

## Session — islands end to end, and Mesa's CSS scoping (2026-08-03)

```
packages/mesa     921 pass / 0 fail / 27 skipped   typecheck clean · spec-check 16/16
packages/sierra   702 pass / 0 fail (34 files)     typecheck clean
packages/css      205 passing · jetty green
browser proof:    npx vite build --config tests/fixtures/island-site/vite.config.js
                  node tests/fixtures/island-site/verify.mjs
```

Two things landed. Islands are finished — a `target: 'static'` page is now
interactive, with per-island code splitting, all five `client:*` directives
verified in a real browser. And on the way, **Mesa's CSS scoping turned out to
be broken in a way that had never applied a component's own root styles.**

### ⚠ BREAKING: scoped CSS changed shape

The hash is now appended to the selector's **subject** (`button` →
`button.mHASH`), and every element in a styled component carries it. It used to
be emitted as `.mHASH button` — an ANCESTOR selector — while the hash sat ON the
element. Those cannot both be true: `.mHASH button` matches a button *inside* a
`.mHASH` element, never the `<button class="mHASH">` carrying it. Confirmed in
Chrome before touching anything.

So **a component could not style its own root element**, silently, in the
browser as well as in SSR. `addStyles` had 19 assertions — insertion, dedupe,
SSR no-op — and not one asked whether the selector matched the markup.

It hid behind a second bug: the prerenderer de-scoped CSS before shipping it,
which is right for email/fragment (the inliner consumes the selectors) and wrong
for the html target. De-scoping was the ONLY reason component styles applied at
all, and it applied them **globally** — measured on a real page, where one
island's `button { background }` restyled every other button on it.

**What this breaks:** styles no longer leak into child components. The ancestor
form put every descendant of the component root in range, including a child
component's markup; the subject form cannot, because a child's elements carry
the child's hash. Use `:global(...)`. Also fixed: `& + p` left its subject
unscoped, so it matched any adjacent `p` on the page.

Rulings in `DECISIONS.md` → **UI substrate (Mesa)**; VISION **RULE 55**; full
writeup in `packages/mesa/CHANGES.md`. 10 new structural tests in
`render-ssr.test.js`, 30 `scopeCSS` assertions converted, and the computed-style
proof in the Sierra fixture — happy-dom does not implement the cascade, so this
one can only be settled in a browser.

### Islands, finished

Mesa marks `client:*` components in SSR output → Sierra collects them during
prerender, bundles them **one chunk per island**, and puts a script tag only on
pages that have one → a loader finds each marker and mounts into it.

All five directives verified in Chrome, including the two that only mean
something with splitting:

- `client:visible` 4000px down: **its chunk is not fetched at all** until
  scrolled to, then it mounts and responds.
- `client:media="(min-width: 5000px)"`: never mounts, and **never fetched**.
- `client:static`: never mounts, never fetched.

Proved by reading `performance.getEntriesByType('resource')` in the page, which
is the only way to show that a directive that never fires costs nothing.

### Three pre-existing bugs found on the way

- **`mesaPlugin.resolveId` could not find Mesa unless it sat in the app's own
  `node_modules`.** It returned `resolve(root, 'node_modules/@frontierjs/mesa/…')`
  without checking anything is there — the exact trap its own `buildStart`
  documents and guards against for the compiler, never applied to the runtime.
  Every compiled `.mesa` imports the runtime, so this breaks any hoisted or
  nested layout. Now shares one `findMesaFile()` candidate search.
- **Mesa compiler output is not deterministic.** `genId()` is
  `'m' + (Date.now().toString(36) + counter).slice(-8)`, so CSS scope ids differ
  between any two compilations of the same source. Normalize before diffing
  build output — it cost a false alarm of 13 "differences" here.
- **`sierraContext.islandMap` was populated during transform and read by
  nothing** — the same dead-state pattern that hid `ctx.islands` for months.
  **Removed.** The island list the build uses comes from the prerenderer, and
  has to: transform sees the whole route tree, while only `render: static`
  routes are prerendered and only those pages carry markers.

Mesa **W1** also landed (`renderComponent`/`renderFile` take `tmpDir`), so a
prerendered layout's bare imports resolve from the app rather than from Mesa's
package root. `docs/SSR_SPEC.md` has no open items left.

### Scope ids are content-addressed now — builds are reproducible

`genId()` was the clock plus a counter, so two compilations of the same source
produced different scope classes. `cssHash(styleContent)` replaces it (FNV-1a,
two lanes, base36 — no dependency and no `node:crypto`, because the compiler
runs in the browser for the REPL). **All 66 REPL examples now compile
byte-identically twice over with no normalization**; before, every example with
a `<style>` block differed.

It also closes the duplication: an island is compiled twice — by Mesa's
prerenderer and by Vite for its chunk — and now gets ONE id from both. Mesa's
`renderComponent` gained `.styles` (`[{id, css}]` per component) and
`styleTag: false`; Sierra's prerenderer emits `<style id="mHASH">` per component
and suppresses Mesa's blob, so the runtime's `addStyles` finds the block already
present and injects nothing. **Three copies of an island's CSS on a page → one**,
verified in Chrome.

Hashing the style content and NOT the filename is deliberate: adding the path
would break the cross-compiler match the moment the two disagree about it (a
Vite id with a query, a symlinked workspace), silently. Two components with
byte-identical CSS sharing an id is harmless — the rules are the same rules.

### What is still open on islands

- ~~**Nested islands** are pinned in Mesa but nothing builds one end to end.~~
  ~~**Only one component in the fixture has CSS.**~~ Both closed 2026-08-03 —
  see the nested-islands session at the top of this file.
- **Dev server.** Islands are a build-time path only; `vite dev` serves the SPA,
  where every component is live anyway.

---

## Previous session — Mesa + Sierra

```
packages/mesa     891 pass / 0 fail / 27 skipped   (npx vitest run — 15 files)
packages/sierra   655 pass / 0 fail                (npx vitest run — 32 files)
```

Started as "review the Mesa block-teardown plan", ended up through the static
renderer, Sierra's prerenderer, the REPL, and three compiler bugs. Per-package
detail lives in `packages/mesa/PROJECT_STATE.md`; this is the short version
and the parts that affect other packages.

### ⚠ `build/` in `.gitignore` was hiding 20 source files

Root `.gitignore` had a bare `build/`, which matched `packages/*/src/build/` —
**Sierra's entire build pipeline** (`prerender.js`, `mesa-plugin.js`,
`scanner-plugin.js`, `index.js`, …) and jetty's, 20 files, none of them tracked.
A fresh clone had no Sierra build pipeline at all.

Fixed by negating the directory (`!packages/*/src/build/` — git cannot
re-include a file whose parent directory is excluded, so the directory itself
has to be un-ignored). All 20 are now visible to `git add`. **They are still
uncommitted.** Root `dist/` and `build/` stay ignored.

That is the most important fact for a new session, along with the standing
"nothing is committed" note below.

### What changed

**Block teardown** (`BLOCK_TEARDOWN_PASS.md`) — `keyBlock`, `awaitBlock`,
`$$eachBlock` and `boundaryBlock` all had one of two failure shapes: a DOM range
held by first/last node pointers that an inner block can escape, or content built
with no owner so its effects were unreachable by any disposal path. Both named
and fixed. Two claims in the plan that motivated the pass turned out to be false
under testing; the doc says which and why.

**The static renderer** (`STATIC_RENDERING.md`) — `renderToHTML`, exported as
`@frontierjs/mesa/render` and documented in the README, had been calling a
component convention the compiler stopped emitting and threw on every component.
Nothing imported it, nothing tested it. Now works, and `render-component.js`
renders through it so there is one renderer rather than two. Fixing it also
fixed a leak in the *working* path: no render disposed anything, so N pages left
N live effect sets subscribed to any module-scope store they read.

**`createRoot`** — added to the runtime for that, and now VISION **RULE 54**.
This reverses a documented decision (§5 said Mesa deliberately ships no scope
primitive); the rule was amended rather than the code reverted, because
`createEffect` is not a substitute — it subscribes to what its body reads, so a
component that reads then writes a store during setup ran **1001 times for one
page** under an effect and once under a root.

**Sierra's prerenderer** — `composeWrapper` composed layouts with the `children`
prop while on-disk layouts use `<slot />`. Different protocols, nothing bridging
them, so the layout rendered and the page inside it silently did not. It now
supplies children both ways. The `static-site` fixture gained a mixed layout
chain, because it previously had *no layout at all* and so never exercised this.

**The REPL** — was completely dead: `index.html` imported `DEFAULT_EXAMPLE`,
which `examples.js` had stopped exporting, and a missing named export is a
link-time error in ESM. Behind that, it mounted by calling the component function
directly, so no delegation root was ever registered and every example in all 59
rendered correctly and responded to nothing. Both fixed; now 66 examples, and
`repl.test.js` guards the module graph, compilation, and interactivity.

**Three compiler bugs**, all "compiles clean, does not parse":
`$: { }` assignments emitted `get(sig) = …`; `bind:` on a component emitted
`{bind:value: …}`; a multi-line interpolated attribute was truncated at the
newline. The first two are why those features had no REPL example — they could
not be made to work. See `packages/mesa/CHANGES.md` for cause and fix on each.

### Open, in rough priority order

1. **Commit the 20 unignored build files.** Nothing else depends on it, but the
   work is not durable until it lands.
2. **`uiComponents` REPL example renders empty Cards** — `ui/Card.mesa` reads the
   `children` prop while the showcase passes element children. Switching Card to
   `<slot />` fixes composition and then surfaces further latent errors in the
   `ui/` kit (`variant is not defined`), so it is a kit task, not a REPL one.
3. **`SSR_SPEC.md` W1** — `renderComponent` writes temp modules into Mesa's own
   package root, so bare specifiers in a rendered import graph resolve from
   there. Small, self-contained, verified as written. **Now the only SSR_SPEC
   item still open in Mesa.**
4. ~~**`SSR_SPEC.md` W3** — island markers in SSR output.~~ **Done 2026-08-02**
   — see the section below. What remains of it is Sierra's: the loader,
   per-island bundling, and name→module resolution. `sierraContext.islandMap`
   is still consumed nowhere; what changed is that there is now something in
   the HTML for it to point at.
5. **`mesa-vite` has no tests at all**, and its HMR id-normalisation fix has
   carried a "not confirmed in browser" warning since it was written.
6. **Nothing in this session was checked in a real browser.** happy-dom
   reproduces the link error and the delegation path faithfully, but codemirror,
   the importmap and the REPL's drawer UI are unverified. `npm run serve` and a
   click would settle it.

### Working notes

- **Compiling without errors and emitting valid JavaScript are different
  claims.** Nothing was checking the second, and it hid all three compiler bugs.
  `repl.test.js` now checks it for every example.
- **Check that a test actually fails against the real prior code.** Twice this
  session a "vacuity check" was itself wrong — once a partial revert, once
  removing guards from a rewrite that could not recreate the old algorithm. The
  honest check is `git show HEAD:file` and compiling against that.
- **A synthetic minimal repro can be too minimal.** The multi-line attribute bug
  needs a *preceding* text binding to trigger; a single-element fixture compiles
  fine on the broken compiler.
- `spec-check.mjs` had a hardcoded path from another machine and could not run.
  Fixed; all 16 documented VISION §4 claims verify.

---

## ⚠ Read this first: nothing is committed

`packages/css` has **five versions of unlanded work** in the working tree —
v0.6 through v0.10. `git status packages/css` shows **41 files** — 18 modified, 9 added-and-
modified, 14 untracked. Nothing has been staged or committed at any point.
(Repo-wide the count is 161, most of it predating these sessions.)

That is the single most important fact for a new session. Landing it is a
judgement call about granularity (one commit per version? one for the lot?)
that was deliberately left to the owner.

---

## Most recent session — `@frontierjs/css` v0.6 → v0.10

```
packages/css   202 assertions, 0 fail   (bun run test — headless Chrome)
               40 CSS files, all 39 imports resolve
               v0.10.0 · all 35 vocabulary terms ship CSS
               bun run demo → http://localhost:5173
```

Started from "where do we stand", ended with a tested package and a running
app. Four things happened, in order:

**1. A test harness, checked in.** `test/` — 202 assertions in real headless
Chrome against real computed styles, zero dependencies (the page computes its
own results, `--dump-dom` carries them back; no puppeteer, no lockfile entry).
`test/specs/meta.spec.js` tests the *harness*, because a third of the v0.6
failures had been bugs in the assertions.

**2. The two known defects, fixed** — plus three nobody knew about. Four focus
recipes collapsed into one `focus.css`; `.table.striped` no longer out-specifies
row tones. Writing the tests then found that `.btn.outlined` and `.btn.link` had
**no focus ring at all**, that **no theme's focus ring was ever its own colour**,
and that `--ink-mute` had failed WCAG AA since v0.1.

**3. The SaaS gap list, shipped** — Steps, Avatar, Facts (a `<dl>`), Kbd, Code,
Divider, vertical Tabs. Vocabulary 29 → 35 terms.

**4. A demo app, and what it cost.** `demo/` is a five-route SaaS admin and the
first thing in the repo to import the package. **It found eight shipped bugs in
an afternoon against a green suite of 165** — including every closed `<dialog>`
rendering as though open, `.btn.ghost` being a silent no-op, and the `.switch`
squashed into a checkbox inside the markup `form-core.css` itself documents.
Its `demo.css` was then reviewed line by line and four gaps promoted into core.

Rulings from all of this are in **`DECISIONS.md` → Design system**. Six of them;
check there before "fixing" any of it back.

### The one breaking change

**`.btn.icon` → `.btn.square`.** `.icon` is now the Icon vocabulary term
("this element *is* an icon"). Renamed everywhere in-repo; zero remaining. It
fails *quietly* for anyone outside the repo — a stale `.btn.icon` floors at
30x30 and looks roughly right while losing its `aspect-ratio` and padding.

### What that session did NOT do

- **Commit anything.** See above.
- ~~**The style guide was not extended.**~~ **Closed 2026-08-03.** A later
  session converted it from `style-guide.jsx` to plain HTML/JS at
  `packages/css/guide/`, then closed the v0.7→v0.10 gap: **49 pages**, with
  Avatar, Facts, Steps and Code & Kbd added, Icons rewritten for `icon.css`,
  Tabs given a vertical section, and all 35 vocabulary terms listed. Four
  documented-but-nonexistent claims were removed — see `packages/css/PROJECT_STATE.md`
  item 1b.
- **Settle the vocabulary.** A demo is not a consumer. `PROJECT_STATE.md` item
  1 — "use it in a real project" — is still the blocker, and Clean Affinity
  admin is still the obvious target.

### Two findings left deliberately open

- **Accent-as-text has no contrast guarantee.** The chip lineage caps a tone
  used as a *fill* so text on it clears AA. Nothing caps a tone used as *text
  on a surface*, and `.link`, `.tab[aria-selected]`, `.navlink[aria-current]`,
  `.tile-delta` and `.field-hint` all do that. `--color-primary` on `--surface`
  is 3.96:1. The fix changes how five shipped components look, so it wants a
  decision rather than a drive-by.
- **The drawer's edge variants are physical** (`.from-left` / `.from-right`)
  while the rest of the package is logical throughout. Folds into the
  scoped-modifier naming question, which is still open — though v0.10 resolved
  one of its four cases by renaming `.icon`.

### How to see it

```bash
cd packages/css
bun run test          # 202
bun run demo          # http://localhost:5173 — five routes, six themes
```

`demo/README.md` is the writeup of what building it found; `PROJECT_STATE.md`
carries the architecture and the full version history.

**Two harness notes worth keeping.** Computed-style tests are blind to
composition — two v0.8 bugs passed every assertion and were caught only by
screenshotting the page and looking at it. And `nohup … & disown` *does* hold a
background server in this environment, contrary to the note at the bottom of
this file; plain `&` and bare `nohup` both dropped it.

---

## Where things stand

> **Historical — these were the numbers at the end of that session, not today's.**
> Every one has since moved. Current verified figures (2026-08-02) are in
> `CLAUDE.md`'s package table: junction 776, litestone 1245, conduit 192, auth 70,
> caravan 67, and **junction typecheck 212**. Do not act on the block below.

```
junction    681 pass   0 fail     (was 196 pass / 203 running at session start)
litestone  1241 pass   0 fail     (+14)
conduit       94 · auth 7 · caravan 36 — all green
junction typecheck: 224 errors    (baseline 226, established this session)
```

`packages/junction/tsconfig.json` is new — at the time, junction was the only
package with a typecheck; every package has one now. `bun run typecheck` inside it.
224 was the accepted baseline *then*, not a target: it was 226 when first measured
and nothing had been fixed deliberately. **The live baseline is 212.**
Use it as a ratchet — if a change pushes it up, that change added errors.

The headline at session start was that **`tests/index.test.ts` (4,433 lines, 357
tests) had not run in some time** — a stale `createLitestoneService` import made
it fail at module load, and bun reported that as one error and moved on. The
suite looked like 196/203 passing. It was really 203 of ~560 authored.

---

## What changed, by theme

### The service layer (audit point 1, Option A only)

Finished the `createLitestoneService` removal across **8 places** it was left
half-done — two test files, three examples that did not build, the README,
junction's project-state doc (since rewritten as
`packages/junction/docs/ARCHITECTURE.md`), and the CLI's `make:model`/`make:scaffold`
templates, which were generating service files that imported a nonexistent
export. Dead tests were **migrated, not deleted**.

Collapsed **five drifted reserved-key lists** into one
(`SERVICE_OPTION_KEYS` / `SERVICE_RUNTIME_KEYS` / `isCustomMethod()` /
`customMethodNames()` in `core/service.ts`). Two of the copies omitted
`update`/`_update`, so every service was advertising `update` as a custom action
in `/manifest` and the OpenAPI spec.

**Option B (the definition/runtime split) is NOT done.** See the ledger.

### Accessor resolution (`model Post` → `db.post`)

One shared `accessorCandidates()`, used by all three resolvers. The literal
spelling wins; the singular is a fallback, so `@@external` models mirroring
plural tables still resolve to themselves. `model` is now optional and derives
from the service name, so the minimal service file is `createBaseService({})`.

### The envelope (audit point 3) — ruled

`src/core/envelope.ts` owns wrap/unwrap/inspect. **`kind: 'single' | 'list'`** is
the discriminant; `object` is the SERVICE name for both kinds. The rule
everywhere: **a list keeps its envelope, a single unwraps to the record.**
`$wrap` is tri-state on the wire.

### Query directives (found while doing the envelope)

`ctx.query` is filters only; **`ctx.directives`** is the structured form of
`$limit`/`$offset`/`$orderBy`/`$select`/`$populate`/`$search`/`$withDeleted`/
`$onlyDeleted`. The bridge is the only place that understands `$`.

### The gate seam (audit point 6) — ruled

`sessionGateLevel()` maps a Junction `SessionContext` onto Litestone's 0–7 scale.
Apps wire it once: `new GatePlugin({ getLevel: sessionGateLevel })`.
The load-bearing rule is **absence is not an objection** — `undefined` means the
app does not model that stage, `null` means it does and this user has not reached
it.

### One event origin (audit point 2) — ruled

A mutation is announced once, in `callService`, fanning out to the bus and the
channel manager. `ctx.dispatch` is one switch for both. Services declare
**`channel: 'posts'`** (a noun — `publish` is an ordinary action name and
reserving it would break `posts.publish()`). Bulk writes announce **once per
record**. Framework opt-in; `fli make:*` scaffolds opt you in with a scoping
warning attached.

---

## Bugs fixed that were not on any list

Every one was found by running the thing, and most were silent.

| | |
|---|---|
| `createService({ softDelete })` **hard-deleted rows** | option never forwarded to the base; `createBaseService` soft-deleted correctly |
| `@@gate` **failed open** under a plural model name | `posts` matched no model, which read as "no gate declared" |
| accessor probing died on the first miss | a real Litestone client is a Proxy that **throws** on an unknown accessor |
| **optional fields were mandatory** | validator's absent-value branch was unreachable for nullable fields; every `String?` model needed explicit nulls |
| every WS event name was **present tense** | `posts create` on the wire, `posts created` in every listener |
| `remove` **re-added** the deleted record | the client's `'*'` fallback upserted what named handlers should have removed |
| `resource()` **never opened its socket** | documented automatic real-time; left `connect()` to the caller |
| `$limit`/`$offset`/`$orderBy`/`$select` **all inert over HTTP** | the bridge stripped exactly the four keys `parseQuery` read |
| `?limit=1` returned **zero rows** | unprefixed, so it became a WHERE clause on a nonexistent column |
| bulk POST bodies **destroyed** | `{ ...array }` → `{0:…,1:…}`; bulk create over HTTP had never worked |
| validators **rejected arrays outright** | every bulk create 400'd before reaching the service |
| `/metrics`, `/manifest`, OpenAPI listed `update` as a custom action | drifted reserved-key copies |
| `_meta`/`_schemas` dropped on the `createService` path | `/manifest` reported defaults for every service |
| Junction warned about **its own** hooks on every boot | `gateAuth`/`autoValidate`/`publish` were anonymous |

---

## The ledger — moved to `ISSUES.md` (2026-08-05)

**Open items no longer live here.** This file is session narrative; the register
of what is open is `ISSUES.md`, repo-wide and one id per item. The numbering
below was junction-only and collided with every other package's list.

Crosswalk, so a session note saying "issue 7" still resolves:

| Old | New | | Old | New |
| --- | --- | --- | --- | --- |
| 1 | `FJS-016` | | 15 | `FJS-036` |
| 2 | `FJS-010` + `FJS-D04` | | 16 | `FJS-034` |
| 3 | closed — envelope | | 17 | `FJS-035` |
| 4 | `FJS-046` | | 18 | `FJS-057` — sierra has a README and `static` builds; only `widget` remains |
| 5 | `FJS-017` | | 19 | `FJS-059` |
| 6 | closed — gate seam | | 20 | `FJS-026` |
| 7 | `FJS-018` | | 21 | `FJS-071` — **contested** |
| 8 | `FJS-047` | | 22 | `FJS-008` |
| 9 | `FJS-019` | | 23 | closed — `FJS-C01` |
| 10 | `FJS-043` | | 24 | `FJS-039` |
| 11 | closed — internal pagination | | 25 | `FJS-062` |
| 12 | `FJS-014` | | 26 | `FJS-072` — **contested** |
| 13 | closed — `publish` reserved | | 27 | closed — 57 flow tests landed |
| 14 | `FJS-037` | | *also open* | `FJS-044`, `FJS-045` |

---

## How to see it work

```bash
cd packages/junction
bun test                      # 681
bun run typecheck             # 224 — the ratchet
bun run example/fullstack/app.ts     # http://localhost:3400
```

`example/fullstack/` is the end-to-end demo and doubles as a test that unit
tests cannot replace — it is what found most of the table above. Three files:

| file | what it establishes |
|---|---|
| `db/schema.lite` | table, `@@gate`, field rules |
| `services/posts.service.ts` | the service — `createBaseService({ channel, allowBulk })` |
| `public/index.html` | the Resource — `client.resource('posts')` |

Open it in two tabs; create in one, it appears in the other; delete it, it goes
from both.

Its README carries the running list of what walking that road surfaced.

**Backgrounding servers from a tool call is unreliable in this environment.**
`nohup`/`setsid` both dropped the process. What works: a script that
`Bun.spawn`s the app, polls until it answers, runs the assertions, and kills it.
There are examples of that shape in the session history.

---

## Conventions worth knowing before editing

- **`DECISIONS.md` is authoritative.** Four rulings were added on 2026-08-02
  (envelope, `$`-as-transport-syntax, `errors[]`/bulk partial success, one event
  origin + scaffold-opts-you-in). Check it before "fixing" any of that back.
- **Comments explain the failure, not the mechanism.** The code written this
  session says what went wrong and why the shape prevents it. That is
  deliberate — most of these bugs were invisible in review and obvious in a
  running app. Match it.
- **Fake clients hide real bugs.** The accessor fix passed every test written
  against `{ post: {…} }` plain objects and failed against every real Litestone
  client. `tests/real-litestone-client.test.ts` exists so that class of
  assumption cannot pass again — put cross-package behaviour there.
- **`ctx.result` must be `null`, not absent,** when hand-building a
  `ServiceContext` in a test. `runPipeline` reads non-null as "a before hook
  already answered" and skips the method. Cost me four confusing failures.
