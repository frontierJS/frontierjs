# Handoff

**The two most recent sessions, narrative. Older ones rotate into
`docs/handoff-archive/`.** This is an assessment file (`PHILOSOPHY.md` §VII):
dated, never cited as behavior, and read cold rather than consulted.

**It names nothing a register does not also hold.** A defect gets an id in
`ISSUES.md`, a settled argument a ruling in `DECISIONS.md`, a shipped change a
commit, and a live fact a sentence in a `CLAUDE.md`.
What belongs here is the ORDER those were found in and why one led to the next —
the half a register cannot carry, and the half that costs nothing when the entry
rotates out. A session that ends with something recorded only here has not
finished.

---

# Handoff — 2026-10-09 (the fixture that reads the schema's rules)

> **Started from FJS-1779 — a quarter of a generated schema's models could not be
> seeded, so the access drive graded nothing about them — and ended with the
> auto-factory reading the rules on a row rather than the types alone.** The
> through-line: every cause in the row was one declaration the generator never
> looked at, and the five became eleven once the reproducing schemas were run.

**What is recorded where.** `FJS-1779` is closed in `ISSUES.md` with the causes
and the measurement; `FJS-1213` carries the amendment that its fixture half is
done and names what stays open there (the channel split, `@immutable` on update,
the tenancy claim, the ignored explicit factories). The pin and `@@check` rules
are in `docs/testing.md` § Relations and § Generated values. The test is
`test/factory-schema-rules.test.ts`, one case per cause.

**The order.** The 2026-10-06 run predated the interval fix (`_orderByChecks`),
so the simple `a < b` was already gone; what the reproducing schemas showed was
`AND`-joined checks, `IN (…)`, `(type = 'album') = (albumId IS NOT NULL)`, an
identity over `@system` columns, and orderings against a `@default(now())`
sibling — which is why the solver reads the SQL subset rather than one shape.
The slug collision turned out to be two things: a regex sampler drawing one
letter, and every clone of a factory restarting the sequence at 1. The pin rule
(one relation per model) came from the base44 drive pinning every parent it had
made, which handed `IssueRelation` the same Issue twice.

**Measured** by a ladder sweep over the 21 base44 freehand schemas, run from the
scratchpad: 323 of 323 models seed, against 139 of 176 in the drive. The base44
apps have drifted from the tree on `driver logger` → `driver trail` and `@@log` →
`@@trail`; the sweep rewrote them in memory, and quo's and chatwoot's
`access.test.ts` fail to parse for the same reason, so their exclusion lists could
not be removed from here. **Next:** regenerate or rename in those apps, drop the
`OpenWindow` / `@@arc` / either-or exclusions, and rerun Q3's Phase 2 freehand.

---

# Handoff — 2026-10-09 (the principal list, and a grant the caller mints)

> **Started from the stressor audit's ranking — eight apps composed two claim
> sources by hand, nine wrote the same grant-and-redeem — and ended with both
> rows built as one design.** The through-line: `bearerClaim` already held the
> four facts the mint and the redeem need (model, column, key, purpose), so the
> paved road was to put the two acts on its answer rather than coin anything.

**What is recorded where.** `FJS-D819` (Access control) is the ruling: `system:
['col']` admits a `@guarded` column's write half, the Grant trait is imported and
declares no gate, `bearerClaim(...).mint()` / `.mintOnCreate()` / `.redeem()`
exist, and a principal list keeps every grant (`ctx.locals[BEARER]` first-in-order,
`bearerOf(ctx, model)` any). `FJS-1450`, `FJS-1749`, `FJS-2176` are closed with the
pins named. `FJS-D522` and `FJS-D694` are built as ruled, `kind: 'signature'`
included. The `example` basket now mints through `cartClaim.mint()` and
`mintCartGrant` is gone.

**How it moved.** The litestone half came first because it decides the shape of
the junction half: FJS-1749's *a generator the schema names* was priced and
dropped — a `@default` has one output and the mint needs two (the digest stored,
the token answered) — in favor of `system:` admitting the column, which is
`FJS-D575`'s rule extended one kind. The trait's `@@gate("8")` was the second
half of the same trap. On the junction side the `validated` stage, not `around`,
is where the digest joins the payload: a `@guarded` column is absent from the
client's schema and a digest added before validation is an unknown key.

**Left open, in order.** `FJS-D664` (session + grant on one request) is unchanged
and now has a stated sibling — two grants on one request, first-in-order is the
trail's actor. `FJS-D548` / `FJS-1503` (the socket keeps the upgrade's cookie)
is what every redeem-then-navigate page still hits; AGENTS.md says reload. The
stressor copies this retires are not yet retired: chatwoot `visitor.ts`, ela and
sstime `principal.ts`, notion/lago/jazzhr redeem routes and nullable digests —
each is a re-drive, and `fli proves` names `example verify:cart` for the
principal area, which needs the dev servers on 8110/7010.

# Handoff — 2026-10-06 (shapes consolidate, models do not)

> **Started as "where did we leave Oracle" and ended with eight reference files one rung below the catalog Oracle was, that same morning, rebuilt on.** The through-line: the references folder's own rule — write a file only from a real instance — was blocked on *no instance in this tree*, and the eight `fjs-prototypes` schemas plus basecamp, example and the nine fixture corpora are now instances for every unwritten row.

**What is recorded where.** The review is the artifact *The Ten Shapes* (https://claude.ai/artifact/KFxSqaTYsKfZLcVquhfQVt): corpus, a shape-by-schema heatmap, ten shapes with every instance named and where they contradict, the fidelity/abstraction axis, and a before/after of Oracle. The eight files are `packages/litestone/references/`; `references.test.ts` now finds a trait-only file's noun on `schema.traits`. The four rulings the files leaned on are `IDEAS/owed-rulings.md` § Shapes, unfiled.

**How it moved.** This session read Oracle as V2-deferred under `FJS-D14`; a parallel session the same morning lifted that (`FJS-D600`) and built the module (`FJS-D601`): `src/catalog.js` is the 32 entities with typed fields, `checkAnswer` grades a model's answer under thirteen rules, `emit` writes the graded plan onto the scaffold's `db/schema.lite`, no model inside. The two sessions did not see each other until the end. What this one adds is one rung below that catalog: reading nine prototype schemas side by side showed the reuse is not the entities (which share only a WORD across apps) but 4–8-column shapes — a bearer grant, an occupying interval, a weekday slot, a decision stamp, a tree, a poller, a delivery row — recurring byte-for-byte under six names each. Litestone already has the construct (`trait` + `@@trait`), so those are now `references/` files, and the join is obvious and not done: `emit` could spread `@@trait(Interval)` where an answer names a span, instead of emitting the pair by hand. The ladder's fourth rung, *shape*, between variant and novel, is the catalog entry that would carry it.

**Left open, in order.** The house's own contradictions are in the report's table and none is filed: `User` drifted across nine scaffold copies while `Notification` held (is `package-model-drift` grading `User`?); `CustomField` is spelled three ways in-house with `example` as the one that should have been copied; `@frontierjs/notifications` fans out and records no `Delivery`; linear carries `rank` and `position` on one row and `canceled` against the house spelling. Oracle's catalog and `references/` are two origins for what a shape's columns are until `emit` reads the latter. Unwritten but named: `Run` from transit `SyncRun`, `Invitation` as Grant + email + role, `auth/db/grant.lite`, `junction/db/inbox.lite`. `fli done` was not run this session; only `test/references.test.ts` was.

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
