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
> four full runs, untouched by this session and unfiled. Nothing from this session is committed, and the tree carries the other
> session's work beside it.

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

