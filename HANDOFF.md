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

# Handoff — 2026-09-08 (reading a real legacy app onto FJS, and what it graded here)

> **The session was an audit of an application this framework did not build** —
> `/home/j/code/KOBAMI/my.maid.tech`, seven years old, Feathers on Express +
> Prisma + Svelte 5 in legacy mode, whose `.lite` conversion was already done.
> The question was what ELSE would make it hard to move. It produced two records
> — `IDEAS/conversion-maid-tech.md` (assessment) and
> `IDEAS/tenant-authored-queries.md` (proposal, ranked 4.32) — and the headline
> is the one nobody expected: **nothing needs to be added to FJS for any of the
> hard parts.** Every Tier-1 blocker had an owner in the tree, and five are
> answered better here than the app answers them itself.

> **Reading the code got five things wrong and the database got them right.**
> The tenant-configurable permission matrix looked like the deepest blocker and
> is two accounts of 148, one of them empty. Delegations have their own model,
> service and a branch in `getLevel` — and **zero rows**, because `getLevel`
> reads `delegation?.level` off a model whose column is `role`, so every
> delegate ever resolved to `undefined` standing. Meanwhile per-account
> dropdowns, which read as an incidental JSON key, are used by **92 of 148**.
> The order those were found in is the transferable part: the source says what
> was BUILT and the rows say what was ADOPTED, and an audit that reads only the
> first sizes the work by how much code exists.

> **The transformer probe is what turned an audit into a proposal.** The app
> runs stored JavaScript through `vm.createContext` over 13 of its 72 reports.
> Probed on Bun 1.3.11 rather than argued about:
> `this.constructor.constructor("return typeof Bun")()` inside that context
> answers `"object"`, and `process.env` is 89 keys away — one expression, no
> import — while `timeout` covers synchronous work and not a returned Promise.
> That settles the DIRECTION rather than the design: Bun has no isolate API and
> no permission model on `Worker`, so the question stops being *which sandbox*.
> What the transformer column actually wants is a declared expression evaluated
> and never executed, and litestone already has that language with two compilers
> and an oracle — which makes this the **second** proposal wanting `evalJs` as a
> third reader, after `declared-field-state.md`. Neither justifies the third
> reader alone.

> **The same probe then graded this tree, which is why it is worth carrying.**
> Five `new Function` / `node:vm` sites here; four are a dynamic-import shim and
> an operator console, correctly bound to loopback with `--token` and
> `--readonly` both real. The gap is that **nothing connects them**:
> `--host` does not require `--token`, and the pairing lives in a source
> comment. Confirmed by running studio with `--host=127.0.0.1` — loopback on
> purpose, since probing it on `0.0.0.0` would be the defect — and getting an
> unauthenticated `/api/repl` to evaluate `process.env`. Filed
> [`FJS-1029`](ISSUES.md#fjs-1029).

> **Three existing records gained a second consumer and one lost a false
> status.** `tables-from-the-seed.md` and `tenant-declared-fields.md` are being
> worked in separate sessions and now carry dated notes pointing at the app —
> 292 route files of list/detail/filter for the first, tenant-declared columns
> in production for the second, built the way that record argues against, which
> makes it a negative control rather than a restatement.
> `content-collections.md` got the larger addition, because the app answers two
> of its open questions with evidence: it IS the *files synced into a table*
> third answer, running, with the conflict question dissolved by writing a
> commit first and a row second — and its editing surface, which that record
> called `foundry` territory and a much larger project, is **14 files and 2,460
> lines** serving 100 sites and 9,355 documents. Counting those documents also
> found that the named collection is the RAREST noun in a real CMS: blocks,
> settings, menus and templates outnumber it 50 to one.

> **`support-mode.md` said *PROPOSED, nothing here is built* in its body while
> its own frontmatter said `shipped` and the code agreed with the frontmatter.**
> Struck in place per `PHILOSOPHY.md` §VII rather than left as two answers. It
> is the cheapest possible instance of the thing that file warns about, and it
> survived four days in the register nobody re-reads.

---

# Handoff — 2026-09-06/07 (the last two value-set axes, and what building them found)

> **The session was a walk down `IDEAS/value-sets.md`'s open questions, and it
> ended with the file marked shipped.** `FJS-D122` (dependent sets, built as
> `FJS-953`) came first, then `FJS-D121` (order) in two halves — `FJS-963` for
> the authored and default ones, `FJS-964` for the learned head. Each ruling
> made the next one cheaper, and the third could not have been built at all
> without a verb that did not exist when the session started.

> **The aggregate verb is the middle of that chain and it was not the plan.**
> `FJS-D121`(iii) had been framed for months as *where do we KEEP the recency* —
> a `Recent` model, a JSON column, localStorage. Measured against the tree, the
> blocker was upstream of storage: `resource.options()` reads the source
> service, junction's auto surface is exactly find · get · create · update ·
> patch · remove · restore, so a rank — a `groupBy` over the binding's own model
> — **could not be asked from a browser at all**, whatever held the numbers. So
> the question stopped being where to put a counter and became whether the
> surface gains a verb. `FJS-D226` ruled that it does, `FJS-957` built it, and
> the recency then needed no storage at all.

> **Grading the surface that verb would expose found two live holes in it**,
> which is the argument for ruling an allow-list rather than passing a spec
> through. `FJS-954`: `having` and an aggregate `orderBy` recovered a `@guarded`
> column in eighteen requests. `FJS-955`: the `sql`` ` brand was a plain JSON
> key, so a request could forge one and break out through `FILTER (WHERE …)`.
> Both were reachable before the verb existed, through app code; the verb would
> have put them on the wire for every app.

> **`FJS-963` measured what the tree was already doing and found it doing it
> twice, unstated.** A literal set travels in declaration order (a side effect of
> `values.map()`); a table-backed one arrives alphabetical from a literal written
> at two call sites. And an app could change neither: `optionsQuery` reads like
> the place to state a picker's order and does not reach one, because
> `options(field)` asks the SOURCE model through a resource `relatedResource`
> mints. Sierra's suite asserted `getOptions()` — what an app calls directly —
> and never the `options()` crossing, so the gap was untested rather than known.

> **The drive found `FJS-962` on its first real run**, which is the whole reason
> `verify:values` exists: `directiveParams` sent `$orderBy` as a JSON string
> whenever it was not one, and the reader takes it as-is — so every structured
> `orderBy` from the browser client was a 400, on both transports, for as long as
> the client has had directives. `FJS-D125`'s inverse-pair rule broken at one
> line, with the encoder and the parser already agreeing on bracket notation.

> **`FJS-965` is the session's own tooling lying**, and it cost a wrong report to
> the user before it was caught. `scripts/typecheck.mjs` checks the package it is
> run FROM and has no `--only` flag, so at the workspace root it prints `clean`
> and exits 0 having checked nothing — three times, over a junction carrying ten
> real errors from `FJS-957`. `bun run ci --fast` found them. The rule that
> catches this class is `proof-target`'s: advice that fails when taken is worse
> than none.

> **`FJS-964` departed from its own ruling in one respect and the ruling records
> it.** `FJS-D121` sketched `recent(Model.field)`; the build is
> `recent(Model.column, clock)`, because ranking by the wrong clock draws an
> order that looks perfectly reasonable, which is this axis's entire failure
> mode. The head is a PREFIX rather than a re-sort for a related reason: a
> picker's list is capped, so re-sorting it by recency changes which rows are
> offered, and *an order is not membership* is exactly what this axis was
> separated from strength to protect.

> **Two things about the drive are worth carrying.** Its sharpest row moves a
> colorway onto the shop's newest variant and asserts the picker's head moves —
> a stored rank passes every other row and fails that one. And it MOVES a row
> rather than creating one, because a soft-deleted variant keeps its `@@unique`
> tuple (`FJS-204`), so a create-then-remove drive 409s against itself on the
> second run; that was found by running it twice rather than by reading the rule.

> **`example`'s dev database could not migrate for the whole session** — a
> blocked `order_line.userId` drop, pre-existing — so the drives ran against a
> stale schema and `db:seed` failed outright. It was rebuilt at the end. Worth
> knowing because the blockage is silent from inside a drive: the API serves
> anyway and says so in one line nobody reads.

---

