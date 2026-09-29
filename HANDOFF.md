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

# Handoff — 2026-09-22 (a commitment is a transition at a time)

> **The session started from one sentence in the ontology paper — *is a
> commitment ever a noun* — and ended with four rulings and a build order.** The
> through-line: every consequence the three hand-written shapes produce is
> already a declared `@@transitions` edge, so the noun costs one attribute and
> inherits the gate, the audit trail, the announcement and `x-transitions`
> rather than needing machinery of its own.

**Nothing is built. Start at [`IDEAS/ontology.md`](IDEAS/ontology.md) § 6 *Build
order***, which names the files each step touches, the template it copies
(`@@expires` for step 1, the `outbox()` plugin for step 2), and the open
question each later step waits on. Steps 1 → 2 → 3 are the critical path.

**How it got there, in the order it moved.** A declaration naming a job
(`run: 'subscription-renew'`) was the first draft and was refused: the Data
realm would name an API-realm file it cannot resolve. Asking *where does the
effect land* replaced it — inside the database the effect IS a transition,
outside it is a hook on that transition riding the outbox. That made the
from-state the guard and the optimistic lock the once-ness, so `occurrenceKey`
leaves every case where the state changes. **Offsets** were settled by the
owner's own proposal, better than the options offered: a literal, or a
same-row `@immutable @unit(d)` column stamped when the terms are agreed — the
tree's *a value at an instant is a copied column* leaf, and `FJS-D348`'s
first consumer. **The word is *transition*, not *move***: the code types
`transition` everywhere and *move* was prose's second name; `VOCABULARY.md`
now says so.

**Rulings:** [`FJS-D353`](DECISIONS.md#fjs-d353) (the noun),
[`FJS-D354`](DECISIONS.md#fjs-d354) (`@@commitment`),
[`FJS-D355`](DECISIONS.md#fjs-d355) (offsets),
[`FJS-D356`](DECISIONS.md#fjs-d356) (model-level). **Still open** in the paper,
each gating its step: the sweep's shape (2), a related-model target (4),
renewal (6), reminders (7).

**Three things measured that a cold reader would otherwise re-derive.**
`@@transitions` refuses a self-transition, and `transition(id, name, opts)`
carries no data — which is why renewal is not a transition and is argued as a
row per period. Caravan already answers a cron's next run
(`app.jobs.nextRuns()`), so [`FJS-1241`](ISSUES_ARCHIVE.md#fjs-1241) is a side fix and
not evidence for the noun. And `FJS-D352` split the time words by their
DEFAULT: `@@expires` is imposed (a dead row), `@@effective` is asked (history
something still points at) — the test is *would a pointer to it break if it
were hidden*.

**Four words, one line between them:** `@@relator` is structure and has no
clock; `@@expires` and `@@effective` are the clock changing what counts and
write nothing; `@@commitment` is the clock causing a write. On one date the
window is the truth for reads and the transition is the record that catches up.

---

# Handoff — 2026-09-22 (a word for what a number counts, and three time gaps that turned out to be one)

> **The session was gap 04 of the `.lite` language survey and ended by settling
> gaps 03, 07 and 08 together in one paper.** The through-line is the same move
> twice: a fact the tree already states in a place nothing can read, given a
> declaration — and both times the measurement, not the reasoning, decided the
> shape.

**Gap 04 shipped: `@unit`.** [`FJS-D348`](DECISIONS.md#fjs-d348) rules it,
[`FJS-1240`](ISSUES_ARCHIVE.md#fjs-1240) is the build. `@money` was the precedent and
carried the whole shape — a symbol from a shipped table, refused at parse,
emitted as an `x-` keyword, read by the control layer — so the word cost no new
mechanism. **It converts nothing**: the value stored is the value sent and the
emitted DDL is byte-identical with the attribute and without it, asserted both
ways against a real database. The symbol table is closed because the attribute
promises the symbol resolves to a DIMENSION, and a free-text `@unit("widgets")`
would have been [`FJS-1236`](ISSUES_ARCHIVE.md#fjs-1236)'s shape on a new word.

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
[`FJS-1241`](ISSUES_ARCHIVE.md#fjs-1241), `basecamp`'s `Job.nextRunAt`, set once on
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
