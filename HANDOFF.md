# Handoff

**The two most recent sessions, narrative. Older ones rotate into
`docs/handoff-archive/`.** This is an assessment file (`PHILOSOPHY.md` §VII):
dated, never cited as behavior, and read cold rather than consulted.

**It names nothing a register does not also hold.** A defect gets an id in
`ISSUES.md`, a settled argument a ruling in `DECISIONS.md`, a shipped change a
line in the package's `CHANGES.md`, and a live fact a sentence in a `CLAUDE.md`.
What belongs here is the ORDER those were found in and why one led to the next —
the half a register cannot carry, and the half that costs nothing when the entry
rotates out. A session that ends with something recorded only here has not
finished.

---

# Handoff — 2026-09-22 (a word for what a number counts, and three time gaps that turned out to be one)

> **The session was gap 04 of the `.lite` language survey and ended by settling
> gaps 03, 07 and 08 together in one paper.** The through-line is the same move
> twice: a fact the tree already states in a place nothing can read, given a
> declaration — and both times the measurement, not the reasoning, decided the
> shape.

**Gap 04 shipped: `@unit`.** [`FJS-D348`](DECISIONS.md#fjs-d348) rules it,
[`FJS-1240`](ISSUES.md#fjs-1240) is the build. `@money` was the precedent and
carried the whole shape — a symbol from a shipped table, refused at parse,
emitted as an `x-` keyword, read by the control layer — so the word cost no new
mechanism. **It converts nothing**: the value stored is the value sent and the
emitted DDL is byte-identical with the attribute and without it, asserted both
ways against a real database. The symbol table is closed because the attribute
promises the symbol resolves to a DIMENSION, and a free-text `@unit("widgets")`
would have been [`FJS-1236`](ISSUES.md#fjs-1236)'s shape on a new word.

**The artifact that framed the gap was wrong about its case, and measuring first
is what caught it.** It reasoned about `weightGrams`, which exists nowhere in
the tree; the real corpus is 123 columns carrying a unit in the identifier, of
which **107 are durations and 10 are bytes and 0 are mass**. That changed the
table that shipped. One defect the tests found rather than the reasoning: the
first cut copied `@scale`/`@money`'s validation walk, which reads models only —
correctly, since those are refused inside a `type` — so
`type Box { w String @unit(kgg) }` parsed clean and emitted `x-unit` for a
symbol resolving to nothing. The walk covers types.

**Then sierra, because a declaration nothing can read is the thing being
removed.** `_CARRIED` is an allowlist, so `x-unit` would have been dropped
between the schema and `$context.form`. Carried — and deliberately NOT joined to
`@money`/`@scale` in answering `control: null`: those refuse a control because
the box and the column disagree, and `300` typed into a `@unit(s)` field is the
`300` that is stored.

**Gap 07 was next and the register was righter than the paper.**
`IDEAS/ontology.md` said the fourth shape — a commitment a person can SEE — had
no instance in the repo. It has one and it is broken:
[`FJS-1241`](ISSUES.md#fjs-1241), `basecamp`'s `Job.nextRunAt`, set once on
create to `now + 60s` by a line whose own comment calls it a placeholder, never
written again, and rendered on a screen as *Next run*. Caravan already answers
the true value through `nextRuns()` and basecamp's own tests already call it.
The paper is corrected in place.

**The turn worth remembering is that a lint was the wrong answer and only
running it showed that.** The obvious shape for gap 07 was an attribute marking
the deadline column plus a `fli check` rule saying *every read filters on it*.
Graded against all five reads of `StockReservation`: three filter, one
deliberately inverts, one omits correctly — so the rule finds **zero** defects
and fires **twice wrongly**. The answer is an automatic filter on
`@@softDelete`'s pattern, under which both omissions become a stated
`withExpired` and stop being indistinguishable from a bug.

**Which is how three gaps became one paper.** `IDEAS/effective-time.md`.
`expiresAt > now` is the one-sided case of a validity window, so gaps 03 and 07
are one mechanism at two arities — and the load-bearing argument is the
DIRECTIVE rather than the filter: the four opt-back-in directives in
`@frontierjs/toolbelt/directives` are all `asBool`, expiry alone needs a fifth
boolean, and valid time needs a VALUE. Ship 07 first and the language carries
two directive families for one idea for ever, with `withDeleted` as the
precedent for how immovable a flag becomes. So `asOf: <instant>` lands first and
every flag is sugar over it. Gap 08 composes rather than merges, and
[`FJS-D143`](DECISIONS.md#fjs-d143)'s own word says why — *a zoned comparison is
a window the framework BINDS* — the window's edge IS `asOf`.
`overview.md` row 4.21 had asked for exactly this settlement and is now pointed
at it.

**The second prize in that paper is the clock.** `inventory.ts`'s filter reads
raw `Date.now()` rather than `createClient({ now })`, so `advance()` moves
nothing and shape 1's entire correctness condition — *a hold is dead the instant
it passes, whether or not the job ran* — is untested and untestable.
`verify-stock.mjs` stages expiry by moving the CUTOFF to `2099-01-01`, which
proves the sweep and never touches the read.

**And the thing that must not be swept up, which is why the three had to be
taken together.** Eight `periodStart`/`periodEnd` columns on `Invoice`,
`InvoiceLine`, `PayRun` and `Payslip` are `@immutable` facts copied onto a
document, spelled almost identically to a validity window and emphatically not
one. Auto-filtering them would make a payslip vanish from a read. A one-gap
write-up would never have had to think about it and would have been free to get
it wrong later.

**Picked up cold.** The survey's agreed order was 01 · 04 · 05 · 02 · 03 · 08 ·
06 · 07, cheapest first; 01 and 04 are shipped, 05 has a paper
(`IDEAS/relators.md`, written the same day in a parallel session) and 07 now has
one that also covers 03 and 08. Phase 1 of `effective-time.md` is
`@@effective(to:)` with the full `asOf` directive, and `FJS-1241` is the second
caller `FJS-D143` said to wait for.

**Two things a fresh session will trip on and neither is a defect of this
work.** `packages/litestone` has two pre-existing failures in
`test/device-schema.test.ts` from `example/db/schema.lite` at HEAD, and
`test/jsonl-multiprocess.test.ts` is load-flaky in the full suite and passes
alone. And the tree is dirty from a parallel session — conduit, junction, mesa
and several litestone docs are not this work's, which is why `fli done` reports
three `changes-entry` misses that should be left alone.

---

# Handoff — 2026-09-12 (a list is one call, and a flake that was never the drawer)

> **The session started as a review of somebody's list-controller proposal and
> ended with every list page in the repo's generator on it.** The review turned
> into a fresh record, `IDEAS/list-controller.md`, and the record said three seams
> had to move before the controller could be honest: `<Table>` columns keyed
> `name` rather than `key`, the `orderBy` pair read through
> `@frontierjs/toolbelt/directives`, and the router owning the URL's round-trip
> — `page.pathname` and `page.search`, borrowed from `window.location`, with
> `page.path` retired because it was `pathname + search` under a name that reads
> like the first. Only then `resource.list()`, eleven names where the proposal
> guessed seven. Fixing the public-routes guard for the new names found
> [`FJS-1083`](ISSUES.md#fjs-1083): an exact rule stopped matching the moment the
> URL carried a query.

> **Two findings are in the controller's design rather than its tests, and both
> were measured before they were argued.** The router commits `query` BEFORE
> `route`, so a list answering every change to `page.query` re-asked the server
> with the NEXT page's filters on the way out. And `<FilterBar>` hands back its
> whole bag and clears a value by leaving the key out, so `apply` has to REPLACE
> each half — the first draft merged, and an emptied search box went on
> searching. A killed process mid-mutation left a mutant in `list.js` once; a diff
> against a scratch copy found it, which is the only reason to keep one.

> **The user asked whether a resource file could say something about its
> lists, and whether the old idea of a function taking page details belonged
> there.** The answer split three ways and is in the record: static `listQuery`
> and `columns:` in the file, `hooks.before.find` for scope computed from the
> principal, and `list({ where })` for scope computed from the page. A function
> of the page in the resource file was refused — the file is imported once and
> runs before any page exists. Building `columns:` found that the default also
> narrowed `summary()`, which would have dropped columns from detail screens with
> nothing said; `rankColumns` is the split.

> **[`FJS-1084`](ISSUES.md#fjs-1084) was filed with the wrong cause, by this
> session.** The row blamed a drawer step, on the strength of *61/61 against 4/4*
> — which compared two TIMINGS, not two drives. The old drive from `b7a412c`
> failed too, and so did the new one with the drawer deleted. The cause is that
> headless Chrome starts its component extensions about thirty seconds after
> launch, the window blurs, and `el.focus()` then moves `activeElement` and
> fires no `focus` event — so the failure landed on whichever step the drive had
> reached at that second. `Emulation.setFocusEmulationEnabled` in both `verify`
> and `verify:ui`: 5/5 failed without it, 63/63 twice with it.
> [`FJS-1075`](ISSUES.md#fjs-1075), the *first run fails* picker flake, was the
> same thing and closed with it. **The transferable part is the method**: a flake
> that moves between steps is about wall-clock time, and a bisection over drive
> versions cannot see that.

> **Proving it was contaminated by the other session, which is
> [`FJS-1086`](ISSUES.md#fjs-1086).** Every save under `sierra/src/router/` or
> junction's client made Vite full-reload the page mid-drive, and the drive's
> error named an unrelated screen. Runs were only trusted once `web.log` showed
> no `page reload` line inside them. Two drive defects came out on the way:
> `moves.user` read page one of an unfiltered orders list that grows by one per
> run, so ORD-1001 fell off on the 21st, and residue from a CDP run
> failed `combobox.filters` because the seed does not wipe products.

> **Three adopters were chosen to disagree, and the third one stopped the
> session for a ruling.** `example`'s invoices took URL state and moved its six
> columns and `-issuedAt` into `Invoice.mesa`, with three `verify` rows that MOVE
> the list (default order, a header click, Back). `basecamp`'s project page took
> local state with a `where`. The generated CRUD page in `core/crud-templates.js`
> became one `list()` and a *Load more* — the first generated page that can reach
> row 21. Deployments could not adopt: its `find` includes the app and the
> environment, a push carries the row alone, and the store's `upsert` replaces
> what it held. The user chose **re-read over merge**, so `list({ composed:
> true })` is `record(id, { composed: true })` for a list — rows held outside the
> store, any announcement or reconnect a trigger, a burst one more read, the
> window a limit. `verify` patches a release from the list page and asserts the
> row moves while the app cell keeps the name; `composed: false` shows the raw
> id there.

> **An author who omits `composed` is told, in dev** — for `record()` too,
> which had the gap first. The check is a declared relation key, or an object
> under an undeclared key; a bare scalar is not flagged, because `createdAt` is
> in no schema mode the build emits and would warn on every list. The gate was
> graded in a real production bundle, since vitest runs with `DEV` true and
> cannot see it. **Left open:** a bare-number count still passes unwarned, the
> environments list's re-read after a create was never mutated, and
> `scanner-plugin.test.js`'s *companion that throws on import* failed once in
> four full runs, untouched by this session ([`FJS-1132`](ISSUES.md#fjs-1132)).

---
