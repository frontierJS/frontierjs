# Handoff

**The two most recent sessions, narrative. `fli register:archive` rotates
older ones into `docs/handoff-archive/`.** This is an assessment file (`PHILOSOPHY.md` §VII):
dated, never cited as behavior, and read cold rather than consulted.

**It names nothing a register does not also hold.** A defect gets an id in
`ISSUES.md`, a settled argument a ruling in `DECISIONS.md`, a shipped change a
commit, and a live fact a sentence in a `CLAUDE.md`.
What belongs here is the ORDER those were found in and why one led to the next —
the half a register cannot carry, and the half that costs nothing when the entry
rotates out. A session that ends with something recorded only here has not
finished.

---

# Handoff — 2026-10-23 (backups leave the box, on the day three real boxes enrolled)

> **Started from `IDEAS/backups.md` with six questions open and nothing past a
> local `backup:run`, and ended with Phase 1 closed: a hub archive and an app
> archive each land in a bucket by a pre-signed PUT, retention prunes both
> sides, a refused upload keeps the file and says so, and the operator's recipe
> exists.** The through-line: every question was ruled before its step was
> built, and every step reused a door that already existed — `backup:run`,
> Outpost's `/backup`, `NotificationChannel`'s credential shape — so the day
> was eleven steps rather than a design.

**What is recorded where.** The six rulings are `FJS-D1485`–`FJS-D1488`,
`FJS-D1490` (Q5: basecamp LIFTS `conduit-s3` into `providers/storage/`, since
`FJS-D1185` rules a `link:` on the sibling out) and `FJS-D1491` (Q6:
`BackupDestination` is workspace-owned). Five more fell out of building:
`FJS-D1493` (a rescanned archive is `found`), `FJS-D1494` (one delete helper),
`FJS-D1495` (`AppBackup.kind` gains `release`), `FJS-D1496` (the pre-swap
*Back up volume* step is fatal with no opt-out) and `FJS-D1497` (a copy of
`ENCRYPTION_KEY` off the box is a person's attestation, graded by
`hub.key-escrowed`). The recipe is `packages/basecamp/docs/BACKUPS.md`;
`packages/basecamp/PROJECT_STATE.md` § Backups leave the box is the build
record. Steps 1.1–1.4 are committed (`038bce79`); 1.5–1.9 are in the
working tree.

**The same day, by hand, on real machines.** `fli basecamp:create` ran three
times (ops, ops2, ops3) and each fresh Ubuntu 24.04 box found a failure the
stand-ins could not: the security pass's systemd re-exec raced the Docker
install (`FJS-3469`), the upgraded openssh left `/run/sshd` gone so `sshd -t`
refused (`FJS-3473`), a box enrolled unpatched (`FJS-3462`), a download-only
apt pass read as an upgrade (`FJS-3463`), the sandbox score and the static
origin's bind (`FJS-3464`, `FJS-3465`), every app as host uid 1000
(`FJS-3474`, ruled `FJS-D1484`: SSH and Outpost stay root, the isolation owed
is a uid per app), and a rollback that lost the secrets directory
(`FJS-3476`). All closed the same day. `FJS-D1481`–`FJS-D1483` settled how a
static App built on a laptop reaches a box. Hetzner as a flag got its Phase 0
and 1 on stand-ins (`FJS-D1478`–`FJS-D1480`); 2.1, a real token, is the
owner's.

**Also ruled that day.** `FJS-D1492`: local speech-to-text is Parakeet through
sherpa-onnx, not whisper.cpp, off a 45-minute call measured on CPU (RTF 0.115
against 0.65); the plan is `IDEAS/transcription.md`, Q1–Q3 open. The Frontier
network's Haven side closed: a login is the chain (`FJS-D1476`), and a Haven
takes nothing else (`FJS-D1477`).

**The night pass, 2026-10-23/24.** `fli done` on the tree named two rows with
an invalid status and a tracked build cache; `fli close` moved `FJS-3469` and
`FJS-3473`, the cache is now ignored. The drives it named ran: `verify:provision`
243/243, `verify:outpost` 48/48, `verify:pages` 24/24, outpost `verify:docker`
54/54 — the last only ALONE, since two drives sharing Outpost's port read as 32
failures. Seven tests red on COMMITTED main were filed rather than fixed:
`FJS-3479` (example/desktop drifted from `make:desktop`), `FJS-3480` (`fli ask`
at 21 of 24), `FJS-3481` (a verb-ended term candidate), `FJS-3482` (sierra's
`composed: true` warning never fires); all four deterministic and dated to the
10-21/22 renames.

**What is NOT proved.** `verify:screens` stops at the path-route check, which
is `FJS-3477`, filed that morning and open. The hand run against a real B2
bucket that Phase 1's done-when asks for has not happened. The owner's dev
`basecamp.db` predates the new tables and needs a reset. Nothing after
`038bce79` is committed on the date above.

---

# Handoff — 2026-10-22 (the network ruled in a day, and the big files split by realm)

> **Started from `IDEAS/frontier-network.md` with eight questions and a
> `fli tell:` namespace, and ended with `fli frontier:*`, a post that signs
> member rows, badges, lineage and an invite allowance — Phases 0–2 built —
> while a second lane cut litestone's `makeTable` and the cli's two largest
> files into modules without changing a line of behavior.** The through-line
> of the rulings: the owner chose to OWN the identity layer rather than lean
> on one, and every later answer followed from that.

**What is recorded where.** The network's rulings are `FJS-D1444` (Q8: one
identity layer, owned), `FJS-D1445` (a max-age stamp on the member row),
`FJS-D1446` (*stake*), `FJS-D1447` (`frontier:`), `FJS-D1448` (Cloud, not
yet), `FJS-D1449` (a bad invitee costs the inviter nothing), `FJS-D1466`
(three joins per member) and `FJS-D1467` (the post's key is the Durable
Object's own); the oath was WITHDRAWN against the recommendation
(`FJS-D1475`). `fli`'s Basecamp commands became one `basecamp:*` namespace
(`FJS-D1465`). Pen-testing 2.6 and 2.7 landed: a strict CSP on the SPA
document with Mesa writing `style=` through CSSOM (`FJS-D1464`, which is what
`FJS-3467` on table alignment then found), and no proxy limit owed
(`FJS-D1193`).

**The splits.** Nine litestone commits that evening moved the where rewrites,
`writeData`, the `$`-introspection, the `@@extensible` pool, the state guards,
nested writes, `groupBy`, aggregate/search and the cursor verb out of
`makeTable` and `createClient`, each a pure move proved by the suite. The cli's
`core/checks.js` went to `core/checks/<realm>.js` and `commands/project/new.md`
(3,109 lines) to `core/scaffold/{app,api,web}.js`, proved by a byte-identical
`fli new --full`. The rule the owner set, worth keeping: split by REALM or
surface, never per rule, and leave a dense small file alone.

**Connectors, in the sibling repo.** `conduit-quo` committed with 115 drive
rows green (`5081762` there). ELA's Microsoft Graph dialect becomes
`conduit-microsoft` (`FJS-D1463`); ELA adopting it is owed. `conduit-n8n`
built as the owner's override of the *not a connector* row (`FJS-D1489`).
Cloudflare's dialect got one owner (`FJS-D1468`, `FJS-D1469`). Inillucent was
evaluated at the owner's ask and not adopted: about 6x in its own harness on
Windows, slower than `bun:sqlite` WAL on Linux; the conditions for a re-probe
are in the owner's memory notes, not in `IDEAS/`.

**Paused, by the owner.** `IDEAS/preview-branch.md` slice 0 (gh is in,
the CORS step is stale; a Submit over a tunnel is next).
`IDEAS/conduit-37signals.md` at 5.2, which needs the owner's own OAuth grant
before any code. `FJS-3387` closed and ruled `FJS-D1368` but held uncommitted
beside other work. The two hunt-cost rows closed (`FJS-3460`, `FJS-3461`).

**What is left.** The sibling repos are dirty — `conduit-connectors` holds
the 37signals 4.1 diff, and every one of the 27 `fjs-prototypes` has
uncommitted changes, `ela` at 324 files. The frontier network's open box is
2.8 (a nameplate in Haven), waiting on haven Phase 22.

---

# Handoff — 2026-10-10 (litestone docs: the runner, then the per-file pass)

> **Started from the 2026-10-09 audit memory with its ~100 per-file rows LOST
> (the scratchpad table was gone), and ended with every fence in litestone's
> hand-written docs running green — 574 of them — under a runner that did not
> exist in the morning.** The through-line: the lost table was not worth
> re-deriving by reading, because the durable fix re-derives the broken-example
> half by running, and the prose half was re-probed per file by six agents
> after the runner had shown them what failed.

**Order it happened in.** The runner came first, as data rather than design:
`test/doc-examples.test.ts` ran the corpus as-is and 374 of 492 blocks failed,
and the failure BUCKETS decided the contract — `db is not defined` (84, pages
with no schema) became *the nearest preceding ```lite is the schema in scope,
a page with none gets one near its top*; syntax errors and `ReferenceError`s
on prose names became `fragment`; the five `near ")": syntax error` schemas
became `FJS-2330` (a field-less model builds `CREATE TABLE x ()`). The nine
were answered after that draft and named as late in `FJS-D860`. Two more
words came from the agents' first reports: `failing` (an example pinned to a
filed defect, `test.failing`'s way), and a fix to `throws`, whose `try` had
swallowed the block's own `import` lines. The `prisma` fence went in the same
hour — the runner keying on `lite` is the loud failure that row of § IV asks
for. A fragment ceiling closed § V 9: a block marked `fragment` runs nothing
and nothing says so, so the count ratchets down.

**Two waves, six agents, one file list each**, no src edits allowed and every
code bug reported with a probe rather than filed. Every probe was re-run here
before its row went in, and that caught two things worth knowing: an agent's
probe is STATEFUL (db files and trail dirs in its scratchpad), so a second run
reads `UniqueConflictError` where the finding was — delete `*.db*` first — and
a finding re-filed under an id another session's write had displaced
(`FJS-2422` once named the `@scoped` message, now `FJS-2424`). Twenty-two
rows: `FJS-2330`, `2364`–`2367`, `2379`–`2380`, `2386`–`2390`, `2418`–`2424`,
`2426`–`2427`; one question, `FJS-D862` (are `arrange()`'s factories
system-bound), since ruled **A**, scoped to `setup`/`arrange`. The Fable-audit session running alongside landed
`doc-examples-run` in `checks.js` the same day; `FJS-2331` now says which half
that rule grades and which half it leaves.

**What is NOT proved here.** Two red litestone tests and two `fli check`
errors belong to the other session's uncommitted `src/` and test edits; my
agents touched no `src/`. The tree is uncommitted.

---

# Handoff — 2026-10-10 (the eleven audit runs, filed)

> **Started from `IDEAS/fable-audit-plan.md` with 11 of 17 runs unrun, and ended
> with the plan `shipped`: 104 rows, nine questions and one close, every red case a
> `test.failing` with its id above it.** The through-line: the plan's own rule that
> filing is a separate step held, because @V's six reports had already been lost,
> so every run wrote to the scratchpad and the rows went in through `fli file`
> the same hour.

**What is recorded where.** Every row says *Fable audit 2026-10-05, run N.N
(2026-10-10)*; the questions are `FJS-D861`, `FJS-D863`–`D871`, options in
`IDEAS/owed-rulings.md`. Run 2.4 landed `doc-examples-run` in `checks.js` and
closed `invariants.snapshot.md` § The gap. Run 4.2's draft is
`IDEAS/spec-directives.md`, pointed at from `specifications.md` § 14. Run 5.1's
list of workarounds the ports can drop is in `IDEAS/conversion-maid-tech.md`.
The eleven reports (rows, leads, refuted claims, verdicts) are kept outside the
repo under the owner's Claude project folder, `audit-reports-2026-10-10/`.

**The order.** Risk first: 1.5, 1.4 and 5.2 together, then the seam and ruling
runs, then the judgment runs, 2–4 agents at a time and never nested. Two things
the sequence showed. First, the runs confirm one another: 5.2 found basecamp's
hand `find`s drop directives, 2.1 found the second `$`-parser in `parseQuery`
that makes that silent, and 4.2's vectors then measured the same parser at
fourteen spellings — so `FJS-2345`, `FJS-2442` and `FJS-2458`–`2468` are one
fix in three registers. Second, another session filed into `ISSUES.md` the whole
time: two `fli file` writes were clobbered and refiled, and that session's
`updates` commit swept in run 2.3's `dist-audit/` build output (a wasm binary),
which is now `git rm --cached` and ignored. `fli file` has no lock; that is a
lead, not a row.

**What is left.** Nothing in the plan. The re-severity list (`FJS-D863`) and the
vocabulary questions are the owner's, one at a time. `FJS-1831`–`1876` from the
first six runs are untouched, nineteen of them `stale?`. Everything here is
uncommitted on the date above.

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
(one relation per model) came from the Charter drive pinning every parent it had
made, which handed `IssueRelation` the same Issue twice.

**Measured** by a ladder sweep over the 21 Charter freehand schemas, run from the
scratchpad: 323 of 323 models seed, against 139 of 176 in the drive. The Charter
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

**Later the same day, `FJS-D664` ruled as `FJS-D832`.** The owner took **C**:
`bearerClaim({ session: 'refuse' | 'merge' })`, default refuse, and the
refusal moved BEFORE the grant lookup so a request's shape says nothing about
which tokens exist. The one surprise was in litestone: `actorType` already
filed a merged principal as `user` while `actorId` named the link, so the
precedence became operator, person, grant — one line in `audit-log.js`, one
test. `example`'s basket states `merge`; `FJS-1987` closed on it.

**Left open, in order.** `FJS-D664` is ruled (above); the three hand-written
refusals (chatwoot, ela, sstime) retire on their re-drives. Two grants on one
request was settled by `FJS-D819` — first-in-order is the trail's actor. `FJS-D548` / `FJS-1503` (the socket keeps the upgrade's cookie)
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
