# Changes — example

## 2026-09-30 — `User` polices `email` and `accountId` (`FJS-1591`)

The pasted `User` moved with `@frontierjs/auth`'s fragment. Before, a shopper's `PATCH /users/<own id>` could change their own address, which password reset mails to, while `emailVerified` stayed true. Now `email` and `accountId` are admin-written like `role`, and a shopper's write drops them. `verify:users` passed every boundary check over HTTP, 67 in all. Its screen section stopped twice with *Inspected target navigated or closed* inside `packages/mesa/src/drive.js`, which another session has uncommitted edits in, so the screen half was not proved. It ran on 7115/7015 with its own mail and psp sinks on 7116/7117, because another session's API held 8110 through 8112.

## 2026-09-29 — Every browser drive here runs on `@frontierjs/mesa/drive` (`FJS-1588`)

The other 18 drives that launched Chrome themselves now open `openChrome`: fourteen in `web/test`, three in `site/test` and the extension's. `lib/chrome-profile.mjs` is deleted, since the driver's sweep does what it did. Each drive keeps its own console policy through `browser.on`, because most fail on every error or warning and not only on a `[Mesa]` one. `verify:live` counts frames the same way. The expression-form drives keep a one-line `evaluate` that returns `(expr)`. `verify:extension` and `verify:account` had used fixed debugging ports, 9224 and 9225, which are gone. The extension loads through `args` plus the handle's browser-level `send`.

`verify:money` had never reached its screen half since `FJS-361`. That change inserted the profile import after the first `import` line in the file, which is inside a `bun -e` template string, so the drive died on a `ReferenceError` at `chromeProfile`. The import is now at the top, and the drive passes 107.

Results, run one at a time on fresh servers:

- **Green:** reports 14, payroll 64, automations 72, `verify:ui` 35, cart 34, catalog 39, stock 41, users 98, money 107, widget 40, shop 13, extension 20.
- **Failing the same way at HEAD, so not this change:**
  - `verify` (`FJS-1376`)
  - `verify:live` (`FJS-1371`)
  - `verify:revisions`, one step earlier than `FJS-1382` records
  - `verify:values` (`FJS-1366`)
  - `verify:site`: `pricing.agreed` and `pricing.saidSo`. The baked `site/dist` is older than one price.
  - `verify:account`: its invoices step.
- **Flaky:** automations failed twice in six runs with *Inspected target navigated or closed*, which is `FJS-1086`, another session editing `web/src` under vite. Widget hung once, and then passed three times.

## 2026-09-29 — `verify:offline` and `verify:shell` run on `@frontierjs/mesa/drive` (`FJS-1588`)

Both drives launched Chrome themselves and took the network away through `web/test/lib/offline.mjs`. They now open `openChrome` and `createNetwork` from the driver, and `offline.mjs` is deleted. Each keeps a one-line `evaluate` that answers an expression. `lib/chrome-profile.mjs` stays until the other verify files move. `verify:offline` passes 55 and `verify:shell` 30. `verify:shell` was run with the baseline file written for that one run and then restored, because the shell is 933 kB against a 930 kB baseline from uncommitted `web/src` work.

## 2026-09-29 — `verify:automations` drives the flow canvas (`FJS-1198`)

The drive drags a node and reloads to find it where it was left, with no
version written. It adds a node, connects a port to it and removes it again,
and each step is read back from the definition JSON the compiler grades.

## 2026-09-29 — the offline-shell baseline is 930 kB (`FJS-1272`)

The shell had grown past its 899 kB baseline, so `verify:build` and
`verify:shell` failed at the build. The growth is accepted and the baseline
rewritten: 926 kB was already committed, the kit's money control added 3 kB,
and other uncommitted work 1 kB.

## 2026-09-29 — `money-control.js` is gone; the kit draws the money box (`FJS-1582`)

`web/src/money-control.js` registered a `money` control that the kit now ships
(`FJS-D555`), so it and its import in `main.js` are deleted. `verify`'s
`form.totalMin` became `form.totalBox`, which asserts a text box in USD: the
kit's box has no native `min`, and `@gte(0)` is judged on the stored cents.

## 2026-09-29 — the caravan comment in `api/src/app.ts` names `work()` (`FJS-D551`)

`boot()` loads the job files and `work()` starts the workers. The comment said
`boot()` did both.

## 2026-09-28 — a drive's Chrome profile is removed however the drive ends (`FJS-1531`)

The 20 drives that launch Chrome take their profile from `web/test/lib/chrome-profile.mjs` instead of `mkdtempSync`, and none removes it itself. At exit or on a signal the helper kills every process holding the profile, waits, and removes it; a SIGKILLed run's profile is reaped by the next run past an hour. Before this every run left its profile in `/tmp`, green runs included, which reached 33GB and filled the disk. Probed with real Chrome under node and bun; no drive was run end to end.

## 2026-09-28 — the product page's selected thumbnail reads `--color-primary` (`FJS-1432`)

`.active` in `site/src/routes/products/[slug].mesa` set `background: blue`, which `css-raw-literal` now reports. It reads the primary tone token instead, so a theme switch reaches it.

## 2026-09-28 — the seed and `startSubscription` start every row at its `@default` (`FJS-1257`)

Litestone now refuses a create that names any state but the column's `@default`, for `asSystem()` too (`FJS-D470`), and holds the machine for a system principal (`FJS-D502`). The seed created `ORD-1002` `paid` and `ORD-1003`/`ORD-2001` `shipped`. It now creates them `pending` and walks them there by `pay` and `ship`. Two resets reach a state no move leads to: an order moved on by a drive, and `SUB-3001` revived from `cancelled`. Both now go through `sys.sql`, the bypass that says it is one. `startSubscription` takes `status` out of the data, creates at `trialing` and makes the `activate` move when `active` is asked for. Six verify drives call it that way. Checked by seeding an empty copy twice, then re-seeding after moving an order to `shipped` and the subscription to `cancelled`. `verify:billing` passes.

## 2026-09-28 — no `.mesa` `<style>` holds a raw color or length (`FJS-1430`)

`css-raw-literal` reported 130 across thirteen files. On `web/` and `site/` a spacing or type literal is its rung (`.75rem` → `--space-lg`), the hero's scrim is `color-mix()` over the `--surface-sunken` it already declared, and a layout measure with no rung — a gallery track, a thumbnail, a card minimum — is a property named for what it is on the element that uses it, so a media query moves one value (`--thumb` in the cart) instead of restating the grid. The extension's dock and the `BuyButton` widget load no `@frontierjs/css`, and a custom property inherits into a shadow root from a stranger's page, so each declares its values once on its root under the package's own token names. `verify:site` passes; `verify:widget` and `verify:extension` were not run here, since port 8110 was held.

## 2026-09-27 — `verify:replicate`: a missing key nobody stated is refused (`FJS-D501`)

`verify.refusesAMissingKeyNobodyStated` — no key, no terminal, no `--without-key` — exits 1 naming the flag and creates nothing; the keyless pass now says `--without-key`. 33 assertions.

## 2026-09-27 — `verify:replicate` drives `restore --verify` (`FJS-1395`)

Seven rows over a copy holding one `@secret` value, sealed through the app's own tenant client: without a key the verify passes and names `Credential.accessToken` among the columns it could not read, with the key it passes, under another key it fails naming the model and keeps the copy, a kept copy's directory is refused as a destination, and no live path is created by any of it. 32 assertions.

## 2026-09-27 — `verify:replicate` restores with `litestone restore` (`FJS-552`)

The restore half is one command now, onto an empty disk, with the audit trail from a `litestone backup`. Four refusals are driven, each asserting nothing was written — an empty replica, files already in place, a logger with no backup, a tenant whose replica was deleted — plus `--force`, `--at` an instant between two writes, and the time-travel window read off litestream's own startup line.

## 2026-09-27 — `verify:replicate`: stream every file, lose the disk, restore, compare (`FJS-1389`)

A drive over copies of the seeded shop: SeaweedFS's S3 gateway on 7116 in docker, `litestone replicate` against it, a tenant created mid-run through `litestone tenant create`, a write a moment before a graceful stop, then the registry and every tenant restored with `litestream restore` and compared to the source table by table, and `litestone backup` graded the same way. Needs litestream v0.5 or newer — `LITESTREAM_BIN` when PATH has the 0.3.x distributions ship. It found `FJS-1389` (tenant files uncopied), `FJS-1390`, and `FJS-1391`: `jobs.db` and `db/public/storage/` are outside both commands.

## 2026-09-26 — the boot imports put the ledger before the variants (`FJS-1279`)

The warm no longer writes in declaration order, so `web/src/main.js` imports
`InventoryMovement` before the `ProductVariant` it references, and
`verify:shell`'s hydration section is the real-browser proof that a child
declared first still lands.

## 2026-09-25 — `perShopAuth` reads `requestMeta()?.caller` (`FJS-D392`)

Junction renamed `ctx.client` to `ctx.caller`; this follows it.

## 2026-09-25 — `verify:mcp` grades `find`'s filters, and a guarded name per model

Four rows: `orders_find` names `status` with its values, a plain and an operator
filter both pass the SDK's validator, and a mistyped `limit` is refused naming
the field. The protected-column search matched by NAME across every tool, which
read `providerRef` — `@guarded` on `PaymentMethod`, an ordinary column on
`Payment` — as a leak the moment `payments_find` listed its columns. A name open
on some other model is graded by a pair now: absent from `paymentMethods_find`'s
filters, present in `payments_find`'s.

## 2026-09-25 — the basket's hold countdown ticks

[`FJS-1062`](../ISSUES_ARCHIVE.md#fjs-1062). The timer was `const tick = setInterval(() => { now = Date.now() })`.
The callback writes `now`, which made the `const` a lazy derivation, and `tick` was read only in
`$.onDestroy` — so the interval started at teardown and was cleared on the same line, and the countdown
drew the minute it was rendered with and never moved. It is a `var`. `verify:cart` now reads the countdown
twice with nothing else moving, and fails with the `const` put back.

## 2026-09-23 — an invoice reminds its customer before it falls due

Step 7 of `IDEAS/ontology.md` § 6 ([`FJS-D370`](../DECISIONS.md#fjs-d370)).
`Invoice.reminded` is a Boolean machine beside `status`, `remind: false -> true
@system`, owed three days before `dueOn` while the invoice is `issued`. The
`Invoice.remind` hook in `api/src/core/commitments.ts` enqueues
`invoice-remind` on the move's transaction, and that job sends
`InvoiceDue.notification.ts` to the customer by email, skipping an invoice paid
or voided since. The lead time is a literal, not a stamped column: it is the
shop's habit rather than a term the customer was given. The invoice page shows
the date as an info alert.

Building it found [`FJS-1315`](../ISSUES_ARCHIVE.md#fjs-1315): litestone refused a
second `@@transitions` on one model.

Proof: `verify:jobs` 19, with a new section that plants due, paid and not-yet
invoices, sweeps, and reads the mail sink; removing the hook turns both of its
assertions red. `verify` 70, where `invoice.owedDates` now includes the
reminder and turns red if the page hides it. `verify:billing` 40, with the
reminder owed on the third day before and not the fourth. `verify:collect` 49,
`verify:account` 44, `verify:proration` 35, `verify:notify` 11, `verify:ui` 35.
Needs `bun run reset`: `invoice` gained a column.

## 2026-09-23 — a renewal is a period closing

Step 6 of `IDEAS/ontology.md` § 6 ([`FJS-D367`](../DECISIONS.md#fjs-d367)).
`SubscriptionPeriod` is one cycle — `startsOn`, `endsOn`, `open -> closed` —
with `@@commitment(close, on: endsOn)`, and junction's `commitments()` closes it
at its end. The hook in `api/src/core/commitments.ts` runs in that close's
transaction ([`FJS-D368`](../DECISIONS.md#fjs-d368)): `renewPeriod` issues the
next invoice and opens the next period, cancels a subscription flagged
`cancelAtPeriodEnd` instead, and does nothing after a subscription dunning
already ended; the collection is dispatched after the commit.
`subscriptions-renew` and `subscription-renew` are deleted, and with them the
last `occurrenceKey` in renewal — the period's state is the once-ness, and
`@@unique([subscriptionId], where: status == 'open')` refuses a second open
period at the database.

**`Subscription.currentPeriodStart`/`End` are `@from` the latest period**, so
the window has one origin; every screen reads the same two fields. A
subscription is started with `startSubscription` (the row and its first period
in one transaction), and the console's *New subscription* opens the first period
in its create's transaction — it had been refused for the two `@system` columns
it could not send, and would otherwise have made a subscription that never
renews. A move to a yearly plan ends the open period on the day and opens a year
from there (`reanchorPeriod`), closed without the hook so the change is billed
once.

Proof: `verify:billing` 39, firing periods through junction's own
`fireCommitment` with fixtures started 230 days back, so each renewal is due on
the real clock — not opening the next period turns seven red.
`verify:jobs` 17: a period planted to end yesterday is closed by the live
sweep, its invoice issued and the new window read back over HTTP, and nothing
more on a second sweep; with the hook removed from the app both go red.
`verify:collect` 49 now crosses sweep → fire → close → collect → provider →
paid. `verify:proration` 35, `verify:account` 44, `verify` 70, `verify:ui` 35.
The shop's file needs `bun run reset`: the two columns left `subscription`.

## 2026-09-23 — what the system owes, on screen

Step 5 of `IDEAS/ontology.md` § 6. `abandon` left the order screen's buttons in
step 3 because it is `@system`; it comes back as *If it is still unpaid, it is
abandoned on Oct 5, 2026*, off `orders.commitments(order)`. The invoice screen
says when its subscription lapses and is cancelled, reading that subscription
as the commitment's target — so the second of two unpaid invoices does not
claim a lapse the first already made — and says nothing until that read has
answered. The subscription screen shows the soonest of each across its
invoices, as tiles beside *Renews*. The sentence is each screen's; the date is
derived. The invoice screen's *dunning counts from the oldest unpaid invoice*
went with the job it described.

Proof: `verify` 70, whose four new assertions compute the expected dates in
node from the API's rows with plain day arithmetic and the from-states written
out, never through the function the screens call. Corrupting the date in
Sierra turns it red. `verify:ui` 35, `verify:billing` 38, `verify:jobs` 15.
`verify:build` is refused by the offline shell budget at 911 kB against 899:
this change is 1 kB of it, measured by building without it (910).

## 2026-09-23 — dunning is two `@@commitment`s, and `recover` is billing's

This is step 4 of `IDEAS/ontology.md` § 6. `Invoice` carries `graceDays` and
`dunningDays` (`Int @unit(d) @immutable`), stamped by `issueInvoice` from
`GRACE_DAYS` and `DUNNING_DAYS`. It declares:

```
@@commitment(subscription.lapse,  on: dueOn + graceDays,   while: status == 'issued')
@@commitment(subscription.cancel, on: dueOn + dunningDays, while: status == 'issued')
```

`subscriptions-dun.job.ts` is gone. The shop's terms travel with each document,
so changing a number moves no deadline already given. The daily 06:00 fire
became `commitment-sweep`'s minute, and `commitments()` reads the shop's zone,
because `dueOn` is a day.

**`recover` moved first** ([`FJS-D363`](../../DECISIONS.md#fjs-d363)). It is a
reaction and not a commitment, and now lives in `recoverIfClear(client,
subscriptionId)` beside `unpaidInvoices`. `settleInvoice` calls it, and so does a
new `voidInvoice`, which the `invoices.void` method goes through. The rule is *no
issued invoice remains*. It runs on the caller's client: a staff settle
recovered through `@@allow('update', auth().isStaff)` with nothing widened, and
that is the condition the ruling carried.

**Drives.**
- `verify:billing` no longer runs a job. It checks the frozen terms, what `due()`
  owes either side of each deadline, recovery on a settle and on a void, and a
  subscription with one of two invoices paid staying `pastDue`: 38 assertions.
- `verify:jobs` plants three subscriptions in the shop's file and runs the sweep
  (lapsing, past the deadline, and a control), then settles and voids as staff
  over HTTP: 15 assertions.

**Pre-alpha: `bun run reset`.** The two columns are required, and an existing
`db/shops/*.db` has invoices without them.

## 2026-09-22 — an abandoned order is a `@@commitment`, not a job

`Order` declares `abandon: pending -> cancelled @system` and
`@@commitment(abandon, on: createdAt + 14d)`, and `app.ts` configures
junction's `commitments()` after the queue. `abandoned-orders-sweep.job.ts` and
`ABANDON_AFTER_DAYS` are gone, and the 03:00 fire is now a sweep every minute
with each row moved at its own due time. This is step 3 of
`IDEAS/ontology.md` § 6, the first app to use the feature.

**`verify:jobs` no longer cancels every pending order.** The old section 6 ran
the sweep with a zero-day horizon, which cancelled the seed's pending orders
and then re-created them. It now places two orders, sets one's `createdAt` back
fifteen days in the shop's file, runs `commitment-sweep`, and asserts that the
aged order ends `cancelled` and its twin stays `pending`. 12 assertions pass.
With `commitments()` removed, 3 fail.

**The orders screens leave `@system` moves off the buttons.** Before that,
`abandon` showed as a disabled button on every pending order, and there is no
standing at which it could be pressed. `verify` (66) and `verify:ui` (35) pass,
and each fails on the move lists when the filter is removed.

**Adopting it found two things.** The plugin-absent refusal did not grade this
app, because it asked only `app.db`. It now also asks the tenant registry's
schema (`packages/junction/CHANGES.md`), and this app refuses to boot without
the plugin. The audit row for an abandon also did not name the move
([`FJS-1294`](../ISSUES_ARCHIVE.md#fjs-1294)). The trail now carries `transition`, and
`verify:jobs` reads it back from `db/audit/auditLogs.jsonl` after the sweep as
`commitment.trailNamesTheMove`, 13 assertions.

## 2026-09-22 — `bun run stop` stops only this app's servers

It was `pkill -f 'bun.*api/inde[x].ts'`, which matches any bun process whose command line ends in
`api/index.ts` — another project's dev API, another session's drive — so stopping this app stopped
theirs ([`FJS-1285`](../ISSUES_ARCHIVE.md#fjs-1285)). It now kills a matching process only if its working
directory, read with `lsof`, is this app's root. Found in basecamp, which had the same line.

## 2026-09-22 — `verify:automations` runs beside another project's dev server

It started its own vite on a hard-coded 8010 and refused to run while another
project held that port — the ninth drive of that shape, missed by the morning's
eight because its Chrome port was already 0. It now reads `UI_PORT` (7010) and
passes `API_PORT`/`UI_PORT` to both servers, as `verify:stock` does; the API
stays on 8110 for [`FJS-1271`](../ISSUES.md#fjs-1271). 63 assertions pass.

## 2026-09-22 — prices, pay and tax bands declare their windows

`PlanVersion`, `PayWindow` and `PayRate` declare `@@effective(from:
effectiveFrom, to: effectiveTo)` — ASKED, which is what adopting them decided
([`FJS-D352`](../DECISIONS.md#fjs-d352)). Imposed, it would have broken this app
in four places and said nothing: `subscription-renew` and billing's two
proration reads follow a pointer to the version a subscriber was SOLD at, which
is usually a closed one, and the subscription screen reads it through
`planVersions.record(id)`. Asked, a read stating no moment gets every row, so
none of them changed.

**`coveringAt` is gone.** It was *the one place the half-open rule is written*,
exported so a second reader could not spell the interval another way; the
schema is that place now, and `payAsAt`, `payAsAtMany`, `ratesAsAt` and
`allRatesAsAt` state their day as `asOf`. `verify:employment`'s
`interval.isSpelledOnceAndExported` became two assertions about the declaration
— a read stating no day is the history, one stating a day is the window on it.
The drive already read Dana's whole window history with no day and asserted it
had two rows, which an imposed window would have failed.

**`Discount` does not declare one, measured.** Both of its reads want the row
out of its window, because *not valid yet* and *has expired* are different
sentences to a shopper and a filter can produce neither. `discountProblem` keeps
them.

The DDL is unchanged: three declarations over columns the models already had.

## 2026-09-22 — every drive lets Chrome pick its own debugging port

Seven more drives were pinned to a fixed one — `verify-cart`, `verify-catalog`,
`verify-widget`, `verify-money` and `verify-offline` on 9222, `verify-users` and
`verify-shell` on 9223 with each other. Only the first Chrome binds a fixed
port; every later one starts, fails to bind, and `GET /json/version` is answered
by the browser already there, so the drive attaches to somebody else's session
and grades their screen. It is `FJS-740` one layer over, and it can pass — two
runs that happen to agree are green. All seven now pass
`--remote-debugging-port=0`, read the port back off Chrome's own stderr, and run
in a `mkdtempSync` profile removed on exit, so neither the port nor a sign-in
outlives the run ([`FJS-1265`](../ISSUES_ARCHIVE.md#fjs-1265), closed).

**The dev server moved with them, and the API deliberately did not.** Seven
drives start their own pair and take `UI_PORT` at 7010, because the case that
blocks them is another project's vite on 8010 — there is no earlier run to stop.
The API stays on 8110: a `File` ref stores the `publicBase` it was uploaded
against, so moving it left every seeded photograph pointing at a port nothing
was on, which is [`FJS-1271`](../ISSUES.md#fjs-1271) and was measured here as
`ECONNREFUSED 127.0.0.1:8110` inside a browser whose API answered on 7110.

Two more fell out of the move and both were the drive's own to fix.
`verify:users` now passes `SHOP_CONSOLE_URL`, since the password-reset link is
minted by the API and points at the CONSOLE. `verify:widget` rewrites
`data-shop` in the host page the way it already rewrote the widget origin — the
committed fixture names the dev origins so it can be opened by hand, and
Checkout navigates to whatever it says.

Proved by running all eight: cart 32, catalog 39, widget 40, money 107,
offline 55, users 98, stock 41, shell 30 — the last against a scratch baseline
lent for the run, because its build is blocked by
[`FJS-1272`](../ISSUES.md#fjs-1272).

## 2026-09-22 — the hold expiry is a declaration

`StockReservation` declares `@@expires(expiresAt)`, and the four
hand-written `expiresAt: { gt: nowIso() }` clauses in
`api/src/domain/shop/inventory.ts` are gone with the `nowIso` helper that fed
them.

**The two reads that deliberately did NOT filter now say so.** `hold()` revives
the shopper's own dead row on purpose and `release()` purges the lot; both state
`withExpired: true`, where before an unfiltered read beside three filtered ones
was indistinguishable from one that had forgotten. `releaseExpired` takes
`onlyExpired` and an optional `asOf` in place of a `before` cutoff — which is
now the only way to spell it, since a hard delete applies the window.

The DDL is unchanged: the declaration names a column the model already had.

**`verify:stock` gained three fixes of its own, all found by running it.** It
takes its ports from `API_PORT`/`UI_PORT` with the 8xxx literals as defaults and
runs on the TEST tier, so it no longer refuses to start because something else
holds the dev tier. It takes a `mkdtempSync` profile, so a run that dies after
signing in does not leave the next one signed in. And it asks Chrome to PICK the
CDP port rather than pinning 9222: on the fixed port a second Chrome cannot
bind, `/json/version` is answered by whichever browser got there first, and the
drive attached to another run's session — reading *a signed-out visitor is told
it is not for them* as false against a header saying **Sign out**, then dying
three assertions later on a button that was not there ([`FJS-1265`](../ISSUES_ARCHIVE.md#fjs-1265)).

## 2026-09-22 — three relationships say whether they repeat

`@@relator` (`FJS-D350`). `CartLine` and `StockReservation` read `once` — the
comments above both already said so in prose, and now the declaration is what
emits the key. `Subscription` reads `many`, which is the one that had to be said
out loud: the same customer may hold the same plan version twice — churn, then
come back — so there is no key over the pair, and a `once` there would refuse
the returning customer at the database.

`StockReservation` gets no reverse index, and that is correct: its
`@@index([variantId, expiresAt])` already leads with the column, and an index is
prefix-matched. The emitted SQL is byte-identical to before.

## 2026-09-21 — a job file is named for its subject

**Every other kind-suffixed file in this tree is named for its noun** — `orders.service.ts`,
`Order.mesa`, `OrderConfirmation.notification.ts`, `model Order` — and jobs were the one
exception, named verb-first. Ten of the eleven moved: `payslip-calculate` and `payslip-send`
now sort together, as do `subscription-renew`, `subscriptions-dun` and `subscriptions-renew`,
which is the whole argument — a domain's deferred work is one block in the only listing
anybody reads. `retention` keeps its bare noun, having no verb. **The filename is the job's
name**, so every dispatch site, cron registration and drive moved with it.

## 2026-09-21 — `verify:shell` watches the warm rather than reading it back

`FJS-D337` stops the warm writing a list-cache slot for a model the device keeps, and that slot
was two things here: the fallback the hydration block emptied, and the SIGNAL that the warm's
`find` had come back. With it gone the call itself is the only fact, so the drive taps the app's
socket before its first script runs and reloads under the tap — one attached afterwards is one
that missed — and waits for the `inventory.find` frame to settle. `warmOffline` awaits the
write-through, so a settled call means the rows are on the device rather than in flight to it.

The ruling gets an assertion of its own in a real browser: no `fjs-lists` key mentions the
service after a warm. Removing the condition in sierra turns exactly that one red.

The two cache-emptying probes now answer *empty* for a store that was never created as well as
for one cleared here, which after the ruling is the ordinary case rather than a failure.

## 2026-09-21 — `verify:offline`'s header caught up with its own assertions

The file was committed with a header written during Homestead phase 0 — *there is no retry in
the Junction client, a write made offline is lost* — and its body asserted the opposite on the
line beneath the one that said so. The reading it described was superseded before the file was
first committed; phase 5 was appended later and the header was not touched either time.

What the drive proves is now what the header says: a write held and replayed, bytes draining
behind the row they belong to, a write surviving the page that made it, a stocktake walked under
a browser-minted key, and two writers on one row merging per column. The section banner *(today:
lost)* and the reading variable named `lost` went with it — a write that is held and replayed is
not a lost one, and a name is the first thing a reader believes.

55 assertions, unchanged in count and in behavior. Nothing under `src/` moved.

## 2026-09-20 — `verify:automations` types an expression

Seven more assertions, and the pair that matters is what each field does with the shape it holds:
`id` is a `ref` and the grammar can spell one, so the field is the line `$.trigger.record.id`;
`data` is an `object` and the shared grammar has no syntax for one, so it stays the document it was.
The honest half is asserted rather than left to be noticed.

Typing `record.id` shows the parser's own sentence — *'record' is not defined here* — and the
definition underneath is read back to prove nothing was written while it does not parse. Typing
`upper($.trigger.record.id)` puts the compiled `fn` node into the document, which is also what makes
the serialize assertion beside it sharper: a flattening serialize would lose the nesting as well as
the type. 63 assertions from 56.

## 2026-09-20 — the basket is opened by a GRANT, not by a token in a column

`FJS-D343`, and the first app to be re-modelled onto `bearerClaim`.

`Cart.token` is gone and `CartGrant` is here: the shopper holds a token, the row
holds its digest, and junction's resolver trades one for the basket's ID before
any policy runs. So `@@allow('read', id == auth().cartId)` compares a number to
a number, and the shopper's secret appears in no column of this schema, no query
and no log line.

**`CartLine.token` is gone with it, and that is the point.** It was a copy of
the parent's secret on every child row — a copy that could not be `@guarded`,
since the guest writing their own line has to write it; that a line carried for
ever; and that no revocation could have reached. The claim is the basket's id
now, so the column the policy needs is the foreign key that was always there.

**`redeem` mints a SECOND grant rather than re-answering the first token**,
which the shop could not do if it wanted to: there is no token stored anywhere.
The origin a buy button runs on gets its own way in, and revoking either leaves
the other working — which is what a row buys over a column. `verify:widget` now
asserts the BASKET (same id, same line) rather than a shared string, and that
the two tokens differ.

**The audit trail names the grant** (`FJS-D342`): a guest's basket write used to
be filed as `actorType: 'user'` with a null id, which is a session whose id went
missing. It is `bearer` now, with the grant row as the actor.

Drives: `verify:cart` 32, `verify:money` 107, `verify:stock` 41, `verify:widget`
40, `verify:pay` 24. One migration, which is destructive by design — the two
token columns hold live baskets and a dev database is reseeded rather than
carried.

## 2026-09-20 — `ProductVariant` declares `@@sync(field)`, and the schema's own note said why

`FJS-1202`. The `@version` note at the top of `schema.lite` listed this model as
the case a row-wide revision gets WRONG: a person edits the price, and every
sale, delivery and stocktake writes `stock`, so the column would report a
conflict about a change nobody made. `@@sync(field)` is what answers that — the
revision says the row moved, the per-column comparison says whether the two
writers actually contended — so the variant gains `@version` and the policy, and
the note is rewritten rather than left stating an argument that now has an
answer.

**`move()` passes the revision it already read.** It is the one place `stock` is
written and it is read-modify-write, so a second movement landing between the
read and the write would be computed from a total that had already moved. The
boundary refuses that now instead of losing the movement.

**It costs 18 kB and the budget stopped the build.** `deviceSchema()` keeps the
`@@sync` models plus what they reference, so declaring the policy put
`ProductVariant` on the device: 3 models to 4, and the shell went **881 → 899 kB**
(`FJS-D302`). Confirmed by asking `deviceSchema()` rather than assumed from the
number. Recorded deliberately — a shop that wants its variant rows mergeable in
the stockroom pays for holding them there.

**And it found a defect on the way in** (`FJS-1210`). With the variant table on
the device, `InventoryMovement`'s relation to it stopped being an inert number
and became a real foreign key — so hydrating 40 movements against an empty
variants table failed the whole batch with `SQLITE_CONSTRAINT_FOREIGNKEY`,
reported as a console `warning:` nobody sees. `example` answers it the way an app
can: the variants are declared too, and imported FIRST, because the warm walks
its declarations in registration order. The framework half is filed as `FJS-1210`.

**`verify:offline` grew the assertion that proves the whole path** — the envelope
on the wire, the bridge unwrapping it, the service passing it down, and litestone
comparing against a real row. Each half passes its own tests with the other half
missing, which is why it is a drive and not a unit test.

**Its control is the sharp part**: the identical stale write with NO base is a
plain 409. Without that, the merge assertion passes just as well against a
boundary that had stopped checking the revision at all — which is the opposite
of the feature. Removing the pass-through reds it exactly, and reveals the
degradation to be a `retryable: true` version conflict, the shape an automatic
re-apply would turn into silent data loss.

## 2026-09-20 — `verify:automations` drives the node inspector

Nineteen assertions, and what they grade is the DERIVATION rather than the panel. `model.patch`
declares three properties and the drive asserts that three fields appear, in that order, none of
them written down in this app or in orion's screens; the node's button carries the label the
DESCRIPTOR supplies, which only the catalog call can answer. The two sharpest read a value's STATE:
`model` is stored as a literal and opens on its own control holding `Customer` — the value and not
the `{ type: 'literal', … }` wrapper around it — while the `id` beside it is a `ref` and opens on
the expression.

The write half is asserted through the document, because the inspector and the textarea are one
model: an edit above appears below as the expression the resolver reads, and the ref beside it is
untouched — which a serialize that flattened every value into a literal would have passed the first
two assertions without. The good definition is then re-typed and saved, so the flow the rest of the
drive activates is the one it always was. 56 assertions from 37; it still starts and stops both
servers itself and leaves nothing active.

## 2026-09-20 — `PickupPoint`, and `verify:geo`

The `Collect` shipping method existed with nowhere to collect from. Now there are six
branches, five of them located and one not yet, and `site Json? @point(lat, lng)` is the
whole declaration behind them — two generated columns over `json_extract`, a composite index
on the pair, and a `CHECK` that a migration, a seed and `asSystem()` are all held to.

`/pickup/` is the screen: a nearest-first list whose search lives in the URL as ordinary
bracket notation, and a create form in which **nothing names a control** — `x-geo` reaches
sierra's table, which answers `geo`, which the kit binds to `GeoField`. The distance beside
each branch is computed on the page from the point on the row and the center the page
already knows, rather than being a column the server returned (`FJS-D320`).

**`verify:geo` is the drive, and it exists because three unit suites can all pass while the
crossing is broken** — which is exactly what it found. Two defects, both answering a 200 or a
400 with nothing else able to see them:

- junction's `autoSort` refused every distance-ordered list with *unsortable $orderBy key
  'site'*, because litestone's `$checkOrderBy` — the one the API boundary asks BEFORE the
  call is made — had not been taught the lift its sibling already had;
- and one layer above that, `normalizeOrderBy` read any structured value as *not ascending*,
  so a relation hop, a `nulls` placement and a distance order all reached the Data boundary
  as `{ field: 'desc' }`.

The search half is graded against a brute-force scan of the same rows rather than a
hand-written list of names, because a prefilter that drops a row at a seam says nothing at
all.

## 2026-09-20 — the shop has an agent surface, and it is the shop's own ladder

`app.configure(mcpPlugin(…))` mounts `POST /api/mcp`, and `verify:mcp` drives it
with a REAL `@modelcontextprotocol/client` — the handshake and framing a
person's editor runs, rather than this repo's own `fetch` agreeing with itself.
22 checks, no browser, starts and stops its own API. It runs under **bun**, for
`verify:site`'s reason: its last section imports the app's own Litestone, which
reaches `bun:sqlite`.

**This app is the shape that makes the drive worth having.** `tenancy
{ strategy database }` means there is no `app.db` at all, which is what made the
plugin's first draft answer a permanent 503 here; four real accounts on a real
ladder; and a row policy sitting beside the gate.

**Which is what the drive got wrong twice on its first run, and the corrections
are the point.** `sam@shop.test` carries `isStaff` and reads every order in the
shop — and does not reach level 5, so the refund move is `alex`'s and not
"staff's". And `sam` and `robin` are offered the **identical tool list**: a row
policy moves nobody up a rung. **The list is the LADDER's and the rows are the
POLICY's**, asserted as a pair — one list, two different order counts out of it.


## 2026-09-19 — the storage mount says its bytes came from strangers

`static: { root: STORAGE_ROOT, untrusted: true }` ([FJS-D314](../DECISIONS.md#fjs-d314)). Every byte
under that root arrived on a form somebody filled in.

Nothing about the photographs changes and the drive now asserts that: an image is inside the inline
allow-list, so it answers no `content-disposition` and renders as before. The expensive mistake this
guards is one word in that list — a photograph answered as a download renders nowhere, and every
screen in the app shows an empty box. **The attachment half cannot be reached from here**, because
every `File` column in this app declares `@accept` and none of them accepts a type the allow-list
refuses; that half is junction's own suite. 39 passed, 0 failed.

## 2026-09-19 — the catalog drive graded the label, not the bytes

`verify:catalog`'s refusal row sent the real photograph under a `.txt` name and asserted a 400, so
what it proved was that `@accept` graded the NAME — and a name is the one part of an upload the
caller controls ([FJS-1184](../ISSUES_ARCHIVE.md#fjs-1184)). Its `upload()` helper always sent `photo`, so
there was no way to send bytes of the wrong kind at all; it takes them as an argument now and the
refusal sends real text.

Three rows added: a genuine photograph with the wrong name is ACCEPTED, it is served as what the
bytes are rather than what the name said, and the stored key's extension agrees with the ref.

**The mislabeled row is deleted before the browser section rather than with the rest at the end.**
The gallery check is `every(naturalWidth > 0)` over the swatches and the images lazy-load — two
assertions above depend on that — so one more row pushes a swatch below the fold and it reads as a
photograph that failed to decode. 38 passed, 0 failed.

## 2026-09-18 — the migration files build the schema again, and a drive says so

`db/migrations/main/` was a whole feature behind (`FJS-1154`). The app boots with `autoMigrate`, which
diffs the live database, so development never reads those files — and a deploy replays exactly them.
The drift had accumulated across auth's `LoginChallenge` fragment, orion's seven tables, `KvEntry`,
the two stocktake models and a column rename, with nothing going red.

One forward migration closes it. `migrate dev` wrote most of it and blocked where it should:
`invoice.dueOn` is NOT NULL with no default, so the copy is hand-written. It states `date("dueAt")`
rather than the `RENAME COLUMN` the generator offers, because `dueAt` held an instant and `dueOn`
holds a day — a rename would leave `…T23:30:00.000Z` in a column every reader compares as
`YYYY-MM-DD` — and it recreates the two indexes a rebuild drops.

**The half no tool reported**: `DateTime` and `String` both emit TEXT, so ten of the fourteen columns
`FJS-D288` converted are invisible to `diffSchemas`. It printed nothing for `employee.startedOn`,
both pay-window pairs, `pay_run`'s three, and `payslip`'s and `invoice_line`'s — so the file carries a
`date()` backfill for each. Idempotent, and UTC, which is this app's own `timeZone` floor.

`verify:migrate` is new and is the only thing that reads the committed files. It replays them onto an
empty disk and asks `migrate check`, then reads every `String @date` column OUT OF THE SCHEMA and
grades the seeded rows — so the next column converted joins the drive by being converted. The row
count is asserted beside it, because an empty table passes *nothing is wrong* without reading
anything.

## 2026-09-18 — a pay period is DAYS, and payroll keeps no clock (`FJS-D288`)

The second half of the plain-date conversion, over the domain where a wrong day is somebody's wages.
`Employee.startedOn`/`endedOn`, both window pairs (`PayWindow`, `PayRate`), `PayRun`'s period and pay
date, and `Payslip`'s period are `String @date`; `EmploymentPay.effectiveFrom` and `AsAtQuery.at` are
days on the wire. `PlanVersion`'s window stays a `DateTime` and is the contrast the schema keeps: a
price changes at a moment, a salary changes on a day.

**`api/src/domain/payroll` now has no clock in it.** `instant()` is gone with every `= new Date()`
default, and `payAsAt`, `payAsAtMany`, `employedAt`, `ratesAsAt` and `allRatesAsAt` each require the
day they answer for. The zone is spent at the edge instead — `$.config.timeZone` in
`employees.setPay`, the registry meta in the seed, `'UTC'` in each drive — so a pay run planned on a
laptop in Los Angeles and in a UTC container picks the same pay windows.

**A pay period is `[periodStart, periodEnd)`, which is billing's interval.** `periodEnd` is therefore
the first day the run does not pay for, and terms are read on `lastDayOf(run)`: a raise opening on
`periodEnd` belongs to the NEXT run. One application, one answer to what a period covers.

Two things only running it could find. A window can no longer open and close on the same day —
`[d, d)` covers nothing — so `assertEffectiveFrom` refuses that by naming the employee rather than
leaving a `@@check` to name a column; an instant hid it by putting the two writes milliseconds apart,
which produced a window true for a few milliseconds of somebody's employment. And the people screen
was putting a typed day through `new Date(…).toISOString()`, which sent the day BEFORE the one
somebody picked to anyone west of Greenwich; `backdate.theDayTypedIsTheDayStored` is the assertion a
`DateTime` column could not carry.

Writing any of it through the API needed `FJS-1182` in junction first.

`verify` also stopped racing: the stop-renewing assertion waited for its button to exist rather than
to be ENABLED, and `changePlan` clears `busy` only after both re-reads settle, so a click could be
swallowed and the failure surfaced as a timeout on a confirmation popover naming neither.

## 2026-09-17 — the devtools console is on when you run the app

`bun run api` sets `DEVTOOLS=1`, so the call feed, `/metrics`, readiness and the job queue are at
`http://localhost:8503` without anyone remembering a flag. The flag itself stays rather than becoming
unconditional: 8503 is a global tooling port, so one console at a time, and a held one is fatal at
boot (`FJS-420`) — a drive that spawns `api/index.ts` directly inherits nothing and binds nothing.

The toolbar in the corner comes back with it: `web/config/sierra.config.js` declares `devtools: {}`,
which is the whole opt-in — sierra injects the bootstrap only when the block exists, because the
toolbar's only source of data is that console, and an app without one gets a socket retrying nothing.

Response bodies come from `junction: { debug: true }` beside it, not from the panel: the telemetry
event the feed is built on carries no payload, and the browser's own Network tab already holds the
frames. `_wrapDebug` logs `{ request }` and `{ response }` with a duration per call, which is the
thing neither surface gave.

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
grades 4 exactly as staff do ([`FJS-1169`](../ISSUES_ARCHIVE.md#fjs-1169)), and the Automations link
shows for `isStaff` rather than level 4. `verify:automations` asserts Robin sees no link and is
refused a draft, Sam drafts one, and Alex activates Sam's flow and watches its run arrive on the
open runs screen and complete — the screen half of
[`FJS-1170`](../ISSUES_ARCHIVE.md#fjs-1170), which the row policy reading `auth().level` closed. `verify:ui`'s
palette row expects the five commands `ord` matches (`FJS-1168`).

## 2026-09-15 — `verify:automations`

The drive for orion's screens (`DRIVES.md`), and a nav link to them at USER(4). `joinChannels`
joins orion's `flows` and `runs`, so a run started by a write elsewhere reaches an open runs
screen. **Found by it**: five framework defects (`FJS-1162`–`FJS-1166`), and that orion's runs
and flows were readable by every USER(4) — here a shopper read another customer's row out of
`/api/runs` that `/api/customers/:id` refused her ([`FJS-1167`](../ISSUES_ARCHIVE.md#fjs-1167)). Ruled
[`FJS-D295`](../DECISIONS.md#fjs-d295) and fixed in orion; the drive now asserts staff and a
shopper read nothing of the administrator's flow or its run. Alongside
it, `verify:ui`'s palette row turned out stale ([`FJS-1168`](../ISSUES_ARCHIVE.md#fjs-1168)).

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
