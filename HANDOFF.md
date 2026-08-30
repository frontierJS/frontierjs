# Handoff — 2026-08-29 (converters and the checks that grade them)

> **A converter is graded by reading its output BACK, and neither of ours was.**
> `litestone introspect` — the adoption door, and what `fli db:pull` runs — wrote
> a `.lite` litestone could not parse, for its whole life, behind six tests that
> only ever matched substrings of it. `expect(schema).toContain(...)`, six times,
> and not one of them fed the result to `parse()`. The foreign-key test asserted a
> relation carrying no `onDelete`, so the case that breaks was the case nobody
> wrote (`FJS-594`).

> **The property replaced the fixes, and that is the transferable part.**
> `test/introspect-roundtrip.test.ts` asserts that reading a database built from
> the output gives the same output, over the seven corpus schemas and the
> 188-model `openmrp` fixture. Three known defects went in; **five more came out
> the same day**, every one of them invisible to a substring assertion:
>
> - a SQL expression default emitted as a **string literal**, so a
>   `@default(uuid())` column got 200 characters of SQL as its value and `ddl.js`
>   doubled the quotes inside it on every pass;
> - `@@index(where:)` re-emitting the clause `createIndexes` ANDs on for
>   `@@softDelete`, nesting one level deeper each time until `predicateToLite`
>   could no longer read it and dropped the predicate;
> - a non-identifier enum member emitted **bare** (`Half-yearly`) — the quoted
>   spelling shipped the same day and never reached the second producer;
> - a relation field named for **the table it points at**, which takes a real
>   COLUMN's name and deletes it, since the parser keeps one field per name;
> - an enum name colliding with a **MODEL** name, which makes that model's own
>   relations resolve as enums and become TEXT columns.
>
> The last two lose data. Both were found by erpnext, 534 models of input nobody
> here wrote.

> **`import` said what it could not carry and `introspect` printed a paragraph.**
> One job, one of its two doors honest. `src/import/tiers.js` is the grading table
> now — one, because two would be two answers to *how bad is this* — and
> `test/import.test.ts`'s totality guard reads `introspect.js` alongside the four
> readers, in **both** directions. `--report` writes the list, `--strict` fails on
> `changed`.

> **And the documented door could not reach any of it.** `fli db:pull` passes
> `--schema` and no path, so the command fell to `cfg.db`, which `loadConfig`
> answers as `./development.db` when nothing said otherwise. Every app declaring a
> `database` block was pointed at a file its schema never named — `FJS-449`'s
> class. It resolves from the declaration now, and a schema declaring several is
> asked WHICH, because the output carries no `@@db`.

---

## `litestone mutate` — three defects stacked, and what each hid (2026-08-29)

`FJS-597`, and the shape is worth keeping: each fix exposed the next.

**It read the schema as TEXT.** `readFileSync` into `schemaMutants`, so nothing
followed an `import` — a schema importing a fragment parses as a file full of
`extend model` naming models nothing declared. basecamp (45 models, all gated)
died at *the original schema does not parse*. `FJS-264`'s class, fourth instance,
and the only one that fails loudly. Fixed with `inlineImportsFromDisk` and not
`parseFile`: the catalogue is line-oriented and wants text, the same reason
`createTestEnv` keys its template cache on one string.

**That unblocked the second.** With the fragment in, every mutant came back
*refused by the loader* and the run printed `100% killed · 14/14` having graded
nothing — `createTestEnv` cannot build a schema declaring `@secret` without a key,
so the refusal was about the schema and not about the mutation. Counting a build
refusal as a kill is right, and right ONLY while the original builds, which
nothing checked. `mutationScore` builds it first now and refuses with the reason
attached. Same control it already kept one level down, where an `error` row from a
check is not a kill.

**The third was why it could not build.** This command alone read
`cfg.encryptionKey`, which `loadConfig` does not populate; every other command in
the CLI reads `getEncKey()`.

**The payoff is immediate and it is `FJS-602`.** The first `unique-drop` run that
could reach the imported models scores **63% — 5 of 8** on basecamp, and all three
survivors are `String @unique @guarded(all)` on `@@gate("8")` models:
`Session.token`, `Verification.value`, `OauthFlow.state`. None is nullable, so
none is either survivor class the tool names as expected. `verifyConstraints`
proves a UNIQUE by writing two rows that collide, and it can write neither — so
**nothing in the package can see the uniqueness of a session token being
removed**, and a schema that dropped it would migrate cleanly and pass every
check.

## Left open, and whose it is (2026-08-29, second session)

**`FJS-598` — no CI phase runs `mutate`, and the tier is the open question.**
Measured rather than guessed, after one wrong guess: `example` is 159 mutants,
**100% killed in 239s**; basecamp is 328 and was still going at **25 minutes**
when it was killed. It does not scale from example's rate — the per-mutant cost is
a property of the SCHEMA, and basecamp's 34 policied models under row tenancy give
`verifyRowPolicies` and `verifyTenantIsolation` far more to grade. So a full tier
is out and the candidates are a nightly or a `--kinds` subset. **The 100% on
example is the argument FOR a phase, not against it**: the checks already see
everything that schema can express, so a phase starts green and fires the first
time somebody declares something they cannot see. A score baseline that ratchets
(Invariant 14) is the other half.

**`FJS-592` — the migrator compares a composite index's columns as a SET**, so
reordering them migrates nothing. Filed earlier in the session and not taken.

**A shared tree, again.** A concurrent session committed mid-work (`aeeff46`,
`720a0ed`), which swept `src/import/tiers.js` and the widened totality guard into
its commits; ids 586, 589, 590, 595, 596, 599–601 were taken as they were reached,
which is why this session's are 594, 597, 598 and 602. One careless
`git checkout -- src/import/sql.js` happened here against a recorded rule not to
do that; it was harmless because the tree had been committed, and it is written
down rather than glossed. Two sessions in `packages/litestone` at once still want
coordinating before, not after.

---

# Handoff — 2026-08-29

> **A question that arrives constantly — *can this row point at any row?* — was
> priced rather than answered, and the answer is no.** Real polymorphic
> relations are not a large diff, they are a change to what access control
> means: `policy.js:805` compiles the TARGET's own policy into a correlated
> subquery, so N possible targets is N branches in a `CASE`, each carrying its
> own `@@gate`. A caller reading `Order` at 4 and `Product` at 5 would then see
> half a list as a **200 with fewer rows**, which is the exact shape Invariant 6
> is arranged around. 158 `relationMap` threadings and 69 single-valued
> `.targetModel` reads are the cheap half of the cost. `IDEAS/polymorphic-relations.md`
> (4.28) is the argument; Prisma refuses it too, and ZenStack's `@@delegate` is
> the ecosystem's best answer to the CLOSED set only, since `extends` is a closed
> set by construction.

> **`@@arc` shipped instead, and it is the cheap 90%.** Several optional foreign
> keys of which exactly one is set — `@@arc([orderId, productId])`, plus
> `optional: true` and `message:`. The whole argument for it is that the members
> stay ORDINARY relations: a real FK, a real cascade, a real `include`, and all
> 69 `.targetModel` reads stay single-valued so nothing in the access core moves.
> It compiles to a table CHECK counting non-null members, so it holds against a
> migration, a seed, an atomic operator and `asSystem()`. **One column per member
> and it stops scaling around six — that ceiling is the feature**, because
> hitting it is the signal the target set is open, and an open set is the one
> case no relation can serve.

> **Two things the build found that the design had not.** The first refusal read
> `this record is not valid` — the generic sentence `FJS-534` had removed for
> `@check` one attribute earlier — so `arcCheckExpr()` is now the single owner of
> the SQL, written by the emitter and matched back by `client.js` to find the
> declaration holding the message. And `release:check` **could not see an arc at
> all**: `describeModel` collected `kind === 'check'` only, so adding one graded
> as an *expand* — a deploy that cannot be taken back, reported as one that can.

> **`packages/litestone/references/` is a new catalogue, written in `.lite` for
> one reason: a reference that cannot parse is a reference that is wrong.**
> `Notification`, `AuditEvent`, `Tag`, each carrying what the model needs and —
> the more useful half — what is deliberately absent, since a column left off on
> purpose looks identical to one nobody thought of. `test/references.test.ts`
> parses every file and fails on any warning. Its first pass found that the
> polymorphic subject is spelt two ways in one repo (`subjectType`/`subjectId`
> in basecamp, `contextType`/`contextId` in `example`) and that
> `@frontierjs/notifications` writes a `Notification` model it does not ship.

---

## `@@arc` — what to know before touching it (2026-08-29)

**The expression has one owner and it must stay that way.** `arcCheckExpr()` in
`ddl.js` is what the DDL emitter writes into the table AND what `client.js`
matches SQLite's reported CHECK text back against to resolve the message. A
second spelling would not fail loudly — it would fall through to the generic
sentence, which is the failure the message exists to prevent.

**The unknown-member check is deliberately absent.** A generic validator at
`parser.js:3980` already covers every `@@`-attribute carrying a `fields` array,
so the arc's own version produced a duplicate message for one typo. What remains
is only the guard that stops the required-member test also firing about a column
that is not there.

**Two refusals at parse**: a required member (a column always set is always the
answer) and fewer than two members (that is `@@check` written long).

`docs/schema.md` § *Exclusive foreign keys*, `test/arc.test.ts` (21 tests), and
the reference snapshot is at 97 words.

---

## `references/` — the convention, and the constraint that shapes it (2026-08-29)

**A reference carries the foreign key COLUMN and never the relation.** Measured
before the format was chosen: a `@relation` to a model the file does not declare
is exactly two errors (`unknown type 'User'` and `@relation references unknown
model 'User'`). That is honest rather than a dodge — the column is the shape, and
which model it points at is the installing app's answer, since an identity model
may be `User`, `Person` or `Account` keyed `Int`, `String` or a uuid.

The test fails on **warnings** as well as errors: a reference is the one place a
footgun warning must not be tolerated, because it is what somebody is about to
copy. It was negative-controlled by breaking `Notification.lite` and confirming
both errors surfaced.

`references/README.md` carries the full running list — roughly fourteen groups
not yet written. **Add a file when there is an instance worth deriving from**; a
reference invented from nothing is the stale example the folder exists to
replace. `Tag.lite` is marked as the one argued rather than derived, and is
therefore the one most likely to be wrong.

---

## Partial indexes — `where:` on `@@index`, and the rule that is asked rather than written (2026-08-29)

**`@@index([cols], where: <expr>)` ships.** It came out of the corpus: a partial
index was the largest unrepresented `.lite` construct by 2.3x — 251 instances,
every source that has predicates at all has them — and the language could not
say it. `IDEAS/partial-indexes.md` is the record and it is `partial` rather than
`done`, because Option A is built and B and C are deliberately still open.

**The design is one sentence and it is asked of the compiler, not described in a
grammar.** A predicate is legal exactly when compiling it pushes no parameter and
its SQL is reproducible by a caller's own filter. That is not a stylistic
preference: SQLite must prove query implies index at PREPARE time, so a bound `?`
on either side makes the index unmatchable, and an unmatchable index is not a
slower index — it is one that is built, maintained, and never used, with nothing
anywhere reporting it. Writing the rule as a grammar means maintaining a second
model of what the compiler does. Asking `compileStatic` and refusing on
`params.length > 0` means the rule cannot drift from the thing it is about.

**It survived being wrong twice, and that is the evidence for the approach.**
First on booleans: the policy compiler inlines `= 1` and the query builder bound
`= ?`, so `live == true` passed the rule and produced an index no caller could
reach (`FJS-578`). Second on the existence of a second compiler at all. Both
times the fix was one clause, not a rewrite, because the rule delegates.

**Four of the five issues closed were found by building, not filed in advance** —
`FJS-577` (the rebuild path recreating a soft-delete model's indexes without
their predicate, `FJS-443`'s shape in a branch its fix never reached), `FJS-578`,
`FJS-586` (`indexOf('(')` finding the bracket inside a QUOTED table name, and the
corpus's 47 expression indexes breaking the same function for a second reason),
`FJS-590` (the two conversion paths disagreeing). `parseIndexColumns`,
`indexPredicate` and `predicateToLite` are one owner in `core/migrate.js` now,
read by three converters; there were two copies of the same broken regex.

**Measured payoff: 94 of the corpus's 251 partial indexes survive conversion
whole, where the number was 0.** The other 119 are unique and correctly dropped —
`FJS-204` is not reopened and the asymmetry is why: dropping a predicate from a
UNIQUE index STRENGTHENS the constraint, which can refuse rows that already
exist, where dropping one from a plain index only widens it.

**`example`'s `ProductVariant` declares the repo's only `where:`**, and it is
there because three things can be proven nowhere else: the migrator adding a
partial index to a database that already holds rows, the predicate ANDing with
`@@softDelete`'s own clause, and the planner reaching it through a query where
the caller wrote HALF the predicate and litestone injected the other half. The
four ways to miss it were run as negative controls and all four miss. The last of
them is `active = ?` — `FJS-578` seen from an app, and the reason that fix
mattered.

**One thing found and deliberately not filed.** The release surface keys an index
on its column list alone, so a predicate appears in neither the rendering nor the
comparison: edit one and `ddl.snapshot.sql` moves while `release.snapshot.md`
does not. The verdict stays correct, because an index is EXPAND either way and
partial uniques are refused — so this is an artefact that is less informative
than the DDL beside it, not a misclassification, and `ISSUES.md` is for behaviour
that is wrong. It becomes a correctness hole the day Option C ships, and it is
recorded against Option C in the idea rather than as a defect.

**What no drive can do is prove an index is used**, because an index changes no
answer and every behavioural assertion passes with it dropped. The EXPLAIN in
`test/index-predicates.test.ts` is the proof and the negative controls are the
test; `verify:catalogue` proves only that the app still works with it.

**Concurrency, honestly.** This session and another ran in the same tree
throughout. Theirs regenerated the corpus fixtures while this one's importer
change was half-applied, baking a non-parsing schema in, which was then fixed and
regenerated. This one regenerated `repo-atlas` and `repo-map` — which the section
below records their session as having deliberately avoided doing for exactly this
reason — and regenerated `example`'s `ddl.snapshot.sql` and `release.snapshot.md`
over their uncommitted `Float -> Int @money` migration, which had left the
snapshots phase red before this work started. Nothing was lost, but that was
partly luck. Two sessions in `packages/litestone` and `example/db/` at once want
coordinating before, not after.

## Left open, and whose it is (2026-08-29)

**`FJS-570` was filed and not fixed, because it needs a ruling.** A relation
picker asks for a service named after the target MODEL
(`serviceNameFor` → `productVariants`) and Junction names a service after its
FILE (`loader.ts:4` → `product-variants`). They agree only for single-word
models, which is why nothing in either app's drives can see it; it fails as an
empty list rather than an error, so a person reads *there are no variants*.
Invariant 2 names three resolvers that must agree about a model name and the
service name is a fourth that nothing reconciles. Teaching `serviceNameFor` the
kebab spelling invents a fifth rule; letting a resource DECLARE the service a
relation resolves to is the shape the escape hatch already takes.

**Three CI findings at the end of this session belong to a concurrent session**,
not to this work: two corpus `.lite` files hidden by `.gitignore`,
`packages/cli`'s `test-files-run` (two new test files no script lists), and
`example`'s `surface.snapshot.md` carrying an `orders.paymentCode` method.
`repo-atlas.snapshot.html` and `repo-map.snapshot.html` want a regenerate that
would fold that in-flight work into a gated artefact, so it was deliberately not
run.

**Still deferred with measured reasons**: `FJS-558` (the orders list asks for no
ordering, which is what breaks `example`'s `bun run verify` at `ORD-CDP-1` — and
the one-line `orderBy` fix breaks the drive the other way, so sorting alone is
not the fix).

---

# Handoff — 2026-08-26

> **The Release realm got its recorded-state format, and the audit that
> preceded it found the retrofit had already started.** `IDEAS/overview.md` has
> said for weeks that 2.3b's shape matters more than its scope, because *a verb
> can be added later and a recorded-state format cannot*. Five stores in this
> tree already hold a piece of serving state and none of them knows about the
> others: `db/release.snapshot.md`, a `releases/<commit>` directory name, a
> renamed `_replaced` container, basecamp's `Deployment`/`DeploymentStep`, and
> `Environment.variables` beside a `@version` that is an optimistic lock wearing
> a generation's clothes. Three of them hold exactly one step of history, which
> is why `fli deploy:rollback` can be taken once and not twice.

> **A third research round read nine systems for what they RECORD rather than
> how they fail** — Cloud Run, Workers, Helm, Nomad, NixOS, Kamal, Argo, OTP,
> Vercel — and found the same two nouns in all nine: a frozen
> artefact-plus-bindings and a mutable pointer at it. Five amendments came back
> and are folded into `IDEAS/release-transitions.md` rather than listed apart:
> pinned secret references (`latest` resolves at instance start, so it makes a
> revision immutable in name only), a `bindingsHash` beside the generation
> counter (a counter answers which came first, a hash answers whether anything
> moved), retention recorded ON the Release (Kamal prunes at three days and the
> promise expires in silence), a journal format version from row zero (Terraform
> and Temporal both pay for this in public), and no per-release downgrade
> instructions — OTP's `relup` is the maximalist end of that road and nobody
> runs it.

> **Phase 1a shipped: `packages/cli/db/deploy.lite`.** Five models — `Journal`,
> `Release`, `BindingSet`, `Transition`, `TransitionStep` — carrying every field
> including the ones nothing writes yet (`audienceKey`, `retentionUntil`,
> `formatVersion`), because an unused column is free today and a journal
> migration is not. It writes nothing and deploys nothing, which is the point.

> **`FJS-534`: the CHECK family was half-built and both halves are fixed.** A
> field `@check` reached the table and its refusal escaped as SQLite's own
> sentence in a **500** — a validation problem answered as a server fault, with
> nothing a form could mark. It is a `ValidationError` and a 400 now. And
> `@@check` did not exist at all, which left a rule spanning two columns of one
> row with nowhere to live but a service hook that a job, a migration,
> `asSystem()` and a seed all walk past. Both take a message as the last
> argument, where every field validator already carries one.

> **A live list pages by GROWING, and building the first real one found that
> the window's edge and the page it was minted from were walked in different
> orders.** basecamp's audit trail moved onto `more()`; on the first run five
> rows sharing one `createdAt` across the 50-row edge lost two of themselves,
> because the page took the caller's `orderBy` and the cursor took the total
> order (`FJS-535`). `table.orderTotal()` is now the one owner of both, and a
> list whose ties cannot be broken carries no edge rather than a wrong one.
> `findWindow` is exported, because the derived find is not the only find.

> **Two rules that had two implementations now have one each.**
> `@frontierjs/toolbelt/match` is `matchesQuery` — jetty's store upserted
> whatever its channel delivered, so a shipped order went back into the queue it
> had just left (`FJS-493`), and the fix is the MOVE rather than a second repair.
> And `fli check` grew `detail-read-dead`, which is `FJS-518` made executable:
> sixteen screens keep a row nothing can update, every one inspected and real
> (`FJS-533`).

---

## A schema with no file can say where it lives (2026-08-26)

`FJS-449`'s remaining half, and the register's own row named the shape it could
not fix: `resolveFrom: 'schema'` anchors a relative `database { path }` to the
app root and needs a schema FILE to do it, so an app assembling its schema in
memory — auth's fragments, the outbox model, a tenant registry — fell back to
the process CWD. That is the shape with the sharpest consequence measured: a
`vite build` from a surface root prerendered twelve product pages as **zero
products, exit 0**, which is a published static site with nothing in it.

**Two ways to say it, and the first already worked.** An app that READ
`db/schema.lite` and appended to it still has the file, and passing `path:`
beside `schema:` makes the assembled string resolve exactly as the file would —
the string is parsed, the path is the anchor. That was true before today and was
written down nowhere, which is most of why the half stayed open. What is new is
`resolveFrom: '<dir>'` — a directory or a `file:` URL — for a schema with no
file behind it at all, and it THROWS on an anchor that is not a directory,
because a statement that quietly reverts to the CWD is the failure being closed.

The rule moved to `core/db-path.js` on node builtins alone. The CLI answers the
same question before a client exists, and a second copy of it is how this
started.

**A mint is announced.** Creating the database FILE is ordinary — every first
run does it. Creating the DIRECTORY above it is the signal, and it is the one
thing all three orphans had in common: `example/db/db/`, `example/web/db/` and
`example/site/db/` were each minted by a command run one directory away from
where the path was written, none of them failed, and the repo's `*.db*` ignore
rule kept `git status` clean, so the only way to find one was to go looking.
Four sites say it now — the SQLite open, the tenant registry's directory, the
jsonl/logger driver's first append, and the CLI's `ensureParentDir` — and the
cwd is in the message, because `db/shop.db` from the app root and from a surface
root print the same relative string and name different files. Eight lines across
litestone's 3,215 tests, every one a temp tree a test deliberately made.

**`example` lost three workarounds and is the proof.** `SHOPS_DIR`,
`SHOPS_REGISTRY` and `AUDIT_DIR` were absolute `join(HERE, …)` constants, each
with a paragraph explaining why the declaration could not be trusted; the app
names the schema file once and reads all three off the block. Loading its data
layer from `example/site/` mints no `site/db/`, `litestone studio` from
`example/db/` creates no `db/db/` and opens the real database, and the storefront
prerenders twelve products from the surface root. Green: litestone 3,215 ·
junction 1,533 · auth 244 · caravan 188 · basecamp 210 (including the seed test
whose isolation IS the CWD, which is why the default is unchanged) · sierra
`test:safety` 5 · `example` `verify` 42, `verify:site` 39, `verify:jobs` 10,
`verify:tenants` 26.

**Watch the drive order in `example`.** `verify:jobs` cancels every pending
order and says so; running it before `verify` fails four assertions that look
like a defect and are a seed. `bun run reset` between them.

---

## Where an app's services are, probed rather than derived (2026-08-26)

`FJS-458`, the day-one experience bug. The autoload default resolved
`dirname(Bun.main)/services` — the FLAT layout, entry and services as siblings.
The layout this repo documents and `fli new` writes puts the entry at
`api/index.ts` and the services at `api/src/services`, so the default named
`api/services`, which is not there, and a missing directory is a deliberate
no-op: the app boots, `/health` answers, and every route those services would
have mounted is a 404. An alpha user working from the README rather than from
`fli new` hits it in hour one.

`core/services-dir.ts` is the one answer now and it PROBES — `./services`, then
`./src/services`, beside the entry, first that exists. Both layouts and a moved
entry resolve with the app saying nothing. It knows nothing about an app having
an `api/` directory, and there is deliberately no cwd-relative candidate: that
is how a command run from the wrong place picks up somebody else's directory.

**A declared directory is never probed around.** An absent one is reported by
name, everywhere including a test, because the case it is most likely to be is
`FJS-449`'s — a relative path resolved against the wrong cwd, landing on
nothing and looking exactly like an app with no services.

**The miss is on the boot banner** rather than in a warning: `autoload=` names
the directory that answered, or the candidates that did not. A warning would
have fired on every app that registers its services by hand — including most of
junction's own test suite — and a framework that shouts at a correct app teaches
everyone to stop reading. `services=3` beside
`autoload="none — probed api/services, api/src/services"` says the same thing on
the line people already read.

**Two more callers had their own copy of the old default.** The snapshot tools
were handed `--services` by hand, because the app's phase resolves against
`Bun.main`, which when they run is the tool — that flag is an override now. And
`build:app`'s bundling guard checked `<entry>/services`, so a canonical-layout
app downgraded its ERROR to a warning and shipped a bundle that boots clean and
404s every route: the same failure one level up, and the second defect this
closes. That is why the rule lives in a module with node builtins and nothing
else — `build:app` imports none of the runtime.

`tests/services-dir.test.ts` pins it: ten resolutions, five banner sentences, and
two apps booted in a real SUBPROCESS, because the default cannot be exercised
in-process — under `bun test` the entry is the test file, which is also why
`basecamp` keeps its absolute `autoload:`. `example` dropped its declaration and
runs on the default: 20 services, `verify` 42/42. `fli new` keeps writing one —
it is a true statement, and the only form that also works against the junction
that is published today.

---

## A block owns its anchor — `FJS-512` and `FJS-468` are one defect (2026-08-26)

**The alpha blocker was not a staleness bug and nothing had stopped tracking.**
`FJS-512` was recorded as an unreproduced `{#if}` going stale beside an
attribute that stayed current — the worst shape to ship, because it could not
be described. It is a compiler defect with a one-line cause.

A block asked for its anchor by leaving a label request pending, and the next
node pushed into the template satisfied it. Between two blocks written on
separate lines that node is a whitespace text run — and the compiler keeps
those as separate entries while the emitted template is ONE STRING, where
adjacent text parses as a single DOM Text node. So both blocks resolved to the
same anchor, each inserted `[marker, content]` before it, and the second one's
DOM landed inside the first one's `[marker, anchor)` removal range. Tearing the
first branch down took the second one's content with it, and the block that had
just built that content had no reason to run again.

That is exactly the rule a COMPONENT invocation has followed since `FJS-110`,
whose comment describes this hazard in full for components and had never been
carried to blocks. `ownAnchor()` in `buildBlock`'s `go()` now pushes a comment
of the block's own for `{#if}`, `{#each}`, `{#key}`, `{#await}`, `{@render}` and
`{@html}`.

**Two accidents decide whether a page shows it, and both of them are why this
resisted isolation.** A component-ROOT template has its whitespace collapsed,
so the anchors were already distinct there: the same three `{#if}`s in the same
`<div>` are correct at a component root and wrong one branch down. That is why
`chained-derived.mesa` — written to reproduce this and passing 7/7 — could not:
it copied the markup and not the POSITION. And within one flush, whether the
removal or the insertion runs first: with plain `<button>`s in the branches the
removal happened to go first and the DOM came out right, and a kit `<Button>`
adds a prop-push effect that inverts the subscriber order. The reproduction was
a three-variant probe that changed one thing at a time; variant B — components
in the branches — failed on the first run, with the action row EMPTY and
`data-moves` current, which is the report verbatim.

**`FJS-468` is the same defect from the other end**, and its own row named the
mechanism: *the isolated case needs a SIBLING `{#if}` tearing down in the same
flush*. Its spec pinned two assertions as broken on litestone's matrix
convention, so the fix turned the runtime drive red — which is the convention
working. Both are flipped to `true`.

**What proves it.** `packages/mesa/test/block-anchor.test.js` — seven emission
shapes and two DOM cases through a real mount, three of the nine failing
against the compiler as it was. Then mesa 1333 vitest + 89 + 47 browser, `ui`
857, `sierra` 1114 + 25 widget, `jetty` 445, `example` `verify` 42 and
`verify:site` 39, `basecamp` `verify` 302 — the last of those with basecamp's
server screen put BACK on the single `moves` Set the bug was found on, so *a
draining server offers cancel, not drain* is asserted against the shape that
failed rather than around it.

---

## A list that is a window, and the two defects the window exposed (2026-08-26)

Three pieces, and the second and third are what the first found.

**`fli check` grew `detail-read-dead`** — the thirtieth rule, and the executable
form of `FJS-518`. A row a screen KEEPS should be watched (`resource.record(id)`)
and not fetched once, because `service.get(id)` answers a plain object no
announcement can reach. The heuristic is a BARE assignment and nothing else: a
`const row = await …` is a genuinely one-shot read, and flagging those is how a
rule gets turned off. Sixteen findings on this tree, every one inspected and
real; the one screen already converted is silent, which is the built-in negative
control. Filed as `FJS-533`, with the caveat that **not all sixteen are the same
fix** — a screen over a `@@tenant(none)` model has no channel to broadcast on,
so `record()` makes those no more live than they are and the answer there is the
missing channel.

Measuring it changed the rule twice: a wrapped ternary put the assignment a line
up, and the comparison guard was eating plain `NAME = ` assignments. Both found
by looking at the output rather than trusting it.

**basecamp's audit trail became a window that grows** (`FJS-D145`'s first real
caller). A trail is the shape a numbered page is worst for — it only grows, and
it grows at the end a reader starts from, so between page 1 and page 2 every
offset has moved by however many things happened in between. The service half is
**`findWindow`, now exported from junction**, because the derived find is not the
only find: a service that assembles its own query (this one forces `workspaceId`
and declares the filters it exposes) had no way to answer `$after` short of
restating both paths.

**And the drive found `FJS-535` on its first run.** The page was ordered by the
CALLER's `orderBy` and the cursor minted in the TOTAL order — the caller's plus
the tiebreaker litestone appends — so where two rows tie on every sort key the
page stopped where SQLite stopped while the edge named where the total order
says it stopped, and the rows between were lost. Once per tie, silently, with the
list reporting itself complete. `table.orderTotal(orderBy)` is the fix and it is
one owner: the page's `ORDER BY` and the cursor come from it, and a list whose
ties cannot be broken now carries **no edge rather than a wrong one**.

It is invisible in any fixture built one row at a time. `window.test.ts` already
had a non-unique walk and it passed, because it ordered ASCENDING over sequential
ids where SQLite's own order and the total order agree by accident. The
regression runs the tiebreaker AGAINST the scan order and loses 12 of 25 without
the fix.

**Then jetty, and `FJS-493` closed by MOVING the rule rather than repairing it a
second time.** jetty's store upserted every record its channel delivered — but a
record is an announcement about a ROW and a live list is the answer to a QUERY,
and nothing on the wire says a row has left a filter, because there is no such
event. So a shipped order came back as `orders ship` and went into the queue it
had just left. `matchesQuery` is `@frontierjs/toolbelt/match` now, the fourth
pure half to come down for `FJS-059`'s reason; sierra re-exports it and keeps
only the SEAM.

Two things fell out of building it. **The store has to remember the query its
rows answer**, and `set()` clears it — rows put there by hand are not the answer
to the last `populate()`'s question. And **the reload is coalesced**, because a
burst of undecidable pushes is one question, not N.

**What is not proved.** `example`: `verify:extension` could not run — another
session's API held port 8110 — so jetty's end-to-end wire behaviour rests on the
unit tests (negative-controlled: forcing the verdict to `true` turns 4 red) and
not on a browser. Run it when the port is free; the drive's *the shipped order
leaves the despatch queue* now has teeth, because the dock's render-time filter
is gone and the store is the only thing deciding.

---

## The journal does not live in the app's database, and it was measured (2026-08-26)

The record contained two sentences that pull apart: the journal is *in a
Litestone database* so the framework's own tools inspect it, and it *lives with
the app* so basecamp vanishing changes nothing. The prior art is one-sided —
Capistrano writes `revisions.log` at the deploy root, Kamal writes
`.kamal/app-audit.log` and locks a directory on the primary server, NixOS keeps
generations on the machine, Helm and Argo store in the target cluster, OTP's
`RELEASES` sits in the release directory. **Terraform is the only one that
exiles state to a remote blob, and it does so because a cloud API has nowhere to
put a file.** Our target is a machine with SQLite on it, so the exception does
not apply.

The recommendation is `deploy.db` at the deploy root as **its own Litestone
client**, not a second `database` block on the app's — and the reason is
`$locks`, which stores in main only. Under a second block the deploy lock lands
in the app's database while `deploy.db` gets no `_locks` table at all: the lock
cannot sit with the record it protects. `$backup` sweeps every declared SQLite
database, and `05-backup` takes that copy before every deploy, so restoring it
would erase the journal recording the deploy that authorised the restore.

**All four properties were run, including a negative control on the rejected
shape**, and they are `packages/cli/tests/deploy-journal.test.js` now. The
ruling is deliberately NOT made — it belongs to whoever starts 1b, with the code
in front of them. The open question in `IDEAS/release-transitions.md` carries the
recommendation, the evidence and the one refusal (the operator's machine: two
operators, two disagreeing histories of one server).

### What running it taught that reading did not

Three times this session, the source said one thing and the machine said
another. Worth carrying forward as a habit rather than as three facts.

- **A standalone fragment cannot carry `@@db(main)`.** `outbox.lite` does,
  because it is pasted into an app that declares that database; one handed to
  `createClient({ schema, db })` has no referent and fails to parse. Copying the
  idiom would have shipped it broken. Asserted now, because nothing in the
  fragment says *no `@@db` here*.
- **`$locks` already exists** — owner, TTL, heartbeat, expiry cleanup. The first
  recommendation said to build one shaped like caravan's `job_owners`, which
  would have been a duplicate of the exact kind this repo files bugs about. And
  contention **throws** rather than answering falsy: `LockNotAcquiredError`, 409,
  `retryable`, naming the holder — already the *refuse by name* shape
  `fli revert` wants.
- **`@@check` was reported absent when field-level `@check` worked.** Reading
  the parser's model-attribute list and stopping there produced a filed issue
  that was half wrong within the hour. Corrected in place.

## The CHECK family, and what `example` now declares (2026-08-26)

`FJS-534`. The refusal was the sharper half and the one that was shipping: a
`ValidationError` rather than a class of its own, because two error classes exist
where two RECOVERIES exist — restore-or-release against send-another-value is
why `SoftDeletedUniqueError` sits beside `UniqueConflictError` — and there is one
here. Measured through junction's boundary: **400 `BadRequest`** carrying
`[{path:['qty'],message:'must be at least one'}]`.

**The expression is for the developer and never for the person.** It is on
`err.constraint` and out of the sentence a control renders, because `qty > 0`
under a form field is SQL reaching somebody who did not write it. Without an
authored message the person reads `is not valid`.

Three things it needed and only one was work. The migrator already compared
CHECK text and rebuilt (`FJS-466` had done it), so migration needed nothing.
`fli release:check` did need it — a new `@@check` is a **contract** and a removed
one an expand, since it is the one constraint that changes what a WRITE may be
without changing what a read answers. And the catalog refused the attribute
until it had a row and a page.

**`example` adopted it, and the schema had already asked twice.** `Discount`
carried a comment saying `@@check` *cannot see `kind` from here, so the bound
that matters is enforced in `pricing.ts`* — written when only the field-level
form existed, and now deleted, because a model-level one can. `carts.service.ts`
carried the other: it counts a redemption with a read-modify-write **instead of**
`{ increment: 1 }` precisely so a validator can see the value, since an atomic
operator computes inside SQLite where nothing in this package runs (`FJS-D27`).
A raw `UPDATE … redemptions = redemptions + 5` past the limit is refused now.

`Order` got the receipt identity its own header states in prose —
`subtotal − discount + shipping + tax = total`. **The tolerance was fuzzed, not
guessed**: 4,000 real `priceBasket` breakdowns, worst drift 7.3e-12 and never
zero, so exact equality would have failed on live data. Half a penny is nine
orders of magnitude above the noise and one below the smallest real error.
`litestone release` grades the whole change **5 contract · 0 expand**, correctly.

### Pick up here

- **1b — mint a Release**, with `2.3f` (*digest, not tag*) as its prerequisite:
  a Release cannot be content-addressed while its artefact is named by a tag
  that means different bytes on different hosts.
- **Two decisions belong to 1a and are recorded, not made**: where `deploy.db`
  physically lives (recommended above), and what basecamp's existing
  `Deployment`/`DeploymentStep` become — they describe the console's own fleet
  actions, the journal describes the app's, and one has to be declared a mirror
  before both are written to.
- **`packages/cli` does not depend on litestone.** It now ships
  `db/deploy.lite`, and opening `deploy.db` needs a client. Fine today — only
  the test touches it, by relative path, which is the house convention — but the
  dependency arrives with the writer.
- **`example`'s money and cart drives have not been run against the new
  constraints.** A `bun run api` from 00:58 was still holding port 8110 and the
  drives refuse a port that answers, correctly. Everything else was verified:
  the constraints are live in the migrated tenant database, all five refuse
  through the real client, the seed writes 11 orders through the identity, and
  every snapshot is regenerated and green.

## Session summary — 2026-08-24

> **Mesa now has four prefixes and each one is a different KIND of name.** `$`
> is the door, `$:` is the label, `$$` is the compiler's own locals, and `__` is
> the CALLING CONVENTION — `__anchor`/`__props`/`__block` are a component
> function's parameters, read by name out of compiled output by jetty's build
> plugin, which is why they do not converge on `$$` (`FJS-D137`). Five door
> members keep a canonical BARE spelling (`FJS-D135`), element `bind:` is form
> values only (`FJS-D136`), and `$main` is gone.

> **A cleanup pass over the register: six items, five of them already filed and
> the sixth found by reading a header.** No new features. The one worth knowing
> about is `FJS-441` — a taken `@unique` value reached the browser as a **500**
> carrying `UNIQUE constraint failed: product_variant.sku`, and it is a 409 with
> the field on it now, measured through `example`'s own API before and after.
> The others: the language server counted a DECLARED warning as a parse failure
> and was CI's only standing red (`FJS-461`); `fli list | head` died printing 980
> bytes of stack (`FJS-379`); an SPA route's `title:` never reached the tab while
> the static target had always written one (`FJS-389`); `AUTH_SECRET` was
> generated, declared and required across four packages with **no reader
> anywhere** and is gone rather than wired (`FJS-360`); and junction's webhook
> delivery signed `${timestamp}.${body}`, binding neither method nor path, now on
> `@frontierjs/toolbelt/signature`'s canonical string (`FJS-472`).

> **The shop takes money, and the framework's oldest live-update seam turned out
> never to have run.** `example` grew a payment provider: a conduit target with
> `auth: { type: 'hmac' }` that the provider VERIFIES, and a signed webhook
> against a raw route that drives the order state machine with no session
> anywhere. `verify:pay` is 16 assertions. Building it found that
> `announceDataWrites` — the seam that puts a write nothing routed onto an open
> tab — has never announced anything in any app, plus two more beside it.

> **And then one of its buttons moved onto somebody else's page.** `widgets/` is
> a third surface beside `api/` and `web/`; the buy button on it reads the shop
> cross-origin (so CORS and a real preflight, which nothing here needed before)
> and hands its basket to the shop's own site as a **one-time code in the URL
> fragment**, never the token. `verify:widget` is 36 assertions over four
> origins. It found three framework defects, two of them in the router.

> **The example shop grew a warehouse.** `ProductVariant.stock` is now ON HAND
> and a basket takes a HOLD with a clock on it, so AVAILABLE — on hand less the
> unexpired holds — is a number no column carries. `api/inventory.ts` is its one
> owner and pairs every write to `stock` with an append-only
> `InventoryMovement`. `verify:stock` is 41 assertions. It found one gate that
> had been wrong since the basket was written, and two things about the drives
> themselves.

> **Tenancy is declared, and basecamp is the first app on it.** One
> `tenancy { strategy row }` block replaced sixteen hand-written `@@allow` lines
> and the app-side machinery behind them; `createApp({ principal })` is the seam
> that puts the claim and the standing on the principal
> (`FJS-D113`/`FJS-374`). Adoption found **five defects, four inside the tenancy
> feature itself** — the first thing to know is that this feature had never been
> used by anything until 2026-08-21.

Session state for picking up cold. Read `CLAUDE.md` first (the map), then this.

Everything below was verified by running it, not by reading. Where I could not
verify something, it says so.

**Sessions are recorded here, newest first.**

---

## Four prefixes, and the one that could not converge (2026-08-24)

**Where it stands.** `$` is the door and it is legal only as the object of a
member expression — `$.onMount`, `$.emit`, `$.tick`. Five members are the
exception and their BARE spelling is the canonical one: `$props`,
`$attributes`, `$slots`, `$context`, `$async` (`FJS-D135`). They are read as a
bag and a key rather than called, and `{...$attributes}` is 81 of this repo's 82
uses of that member — it sits in markup, where `$.` is JavaScript punctuation in
the middle of HTML. Both spellings are one binding aliased at emit; the bare
names stay RESERVED, so declaring one at script top is refused rather than
shadowing it.

**`__` is a fourth tier, not an unfinished migration** (`FJS-D137`). The
framing that kept it looking unfinishable was *converge everything on `$$`*, and
it cannot happen: `packages/jetty/src/build/mesa-plugin.js` matches
`__anchor`, `__props` and `__block` BY NAME in mesa's compiled output to inject
its HMR registration. That is `FJS-D134`'s class — a name that crosses a package
boundary as text is protocol, and protocol is frozen. `__` also holds three
different kinds of thing and only one is touchable: the four parameters, runtime
*properties* (`$$runtime.__dev`, which no local can shadow), and generated
locals. All four parameters are reserved now, so declaring one is refused rather
than shadowing a parameter and failing at mount.

**Two names correctly wear a single `$`.** `$class`, the prop `{class}` travels
under, and `$dom`, the key a block factory answers with. Both are read from
outside the compiler, so `FJS-470`'s "no single-`$` name in output" now reads
with its exception declared instead of as an oversight.

**Element `bind:` is form values and nothing else** (`FJS-D136`). `value`,
`checked`, `files`, plus `group` and `this` on their own paths; every other
`bind:x` on an element is refused, naming `x={expr}`. The argument is that there
was never a second direction — nothing but you changes `readonly` or `colspan` —
and for the eight attributes whose DOM property is spelled differently
(`for`/`htmlFor`, `class`/`className`, `readonly`/`readOnly`, …) there was no
FIRST direction either: `bindInput`'s generic branch is `el[name] = v`, which
writes a JS expando the DOM never reads. `bind:class` was the measured one
(`FJS-478`), and `compiler.test.js` held a test PINNING it — asserting
`bindInput` was emitted. On a COMPONENT `bind:x` is an ordinary two-way prop and
is untouched, which is every non-form `bind:` in this repo.

**`$main` is removed.** It was a runtime resolver (`makeClassResolver`) with no
author-facing spelling and no reader in any `.mesa` file here. Styling a child's
parts from a parent is a real occasional need and is now a design record rather
than a half-mechanism — `IDEAS/child-part-styling.md`, `overview.md` 5.23.

### What it cost to find

**Two defects, both filed and fixed.** `$.mounted`'s one-per-component gate was
a REGEX over script text (`FJS-477`) — it is an AST walk now — and
`$.context.use` / `.provide` emitted an undeclared `$context`, so the compiled
module threw at mount.

**A brace-depth template scanner, because prose is not code.** My first refusal
pass rejected a REPL example whose markup contains the sentence "It provides
`$.context.count`". `templateExpressions()` walks `{ … }` regions and is now
what both the compiled-door refusal and `refuseBareBuiltins` read, which closed
the same latent trap in the second one.

**The recurring shape, hit five times in one session: a hand-kept copy drifts
from the enforced list.** VISION's §17 member table against `DOOR_MEMBERS`; the
CLI generators emitting `.mesa` as strings; RULE 31a missing from the rules
index; `FJS-470` never having swept the docs; and jetty's regex against mesa's
output. Every fix READS the authoritative list instead of restating it —
`generated-mesa.test.js` computes `DOOR_MEMBERS` minus `SUGAR_MEMBERS` out of
the compiler source, and a new VISION rules-index drift test found **eleven more
unindexed rules** (43–53) on its first run.

**jetty's plugin now fails loudly.** It threw nothing when its regex stopped
matching — it just emitted a module with no HMR registration, and the symptom
was hot updates silently not applying. It throws by name now, and
`packages/jetty/test/phase9.test.js` (7 tests) drives `injectJettyHMR` with real
compiler output rather than a fixture string.

**`fli check`'s `test-files-run` was widened wrong first.** Requiring only "no
runner" broke a deliberate case — a harness beside the tests is support code.
The real signal is that support code is IMPORTED, so the rule now requires no
runner AND no importer. It found two dead harnesses in jetty that import
`/home/claude/repo/...`; they are in `packages/jetty/docs/dead/` with a README.

**Verified, not assumed.** `example` 31/31 and `packages/basecamp` 76/76 `.mesa`
compile under the new compiler; zero residual door spellings in either; all
`bind:` usage in both is form values or component props. `fli check` clean on
both (23 and 20 rules). Full suite green — mesa 1293 + 82 + 47, sierra 1093, ui
857, jetty 11 phases, cli 848 + 31, typecheck 0.

**Left open.** `packages/basecamp/db/access.snapshot.md` is stale against its
source and is NOT from this work — a concurrent session was editing basecamp's
schema, and regenerating it would bury their change. Four packages sit at a
local version equal to the published one with substantially different trees
(mesa 0.1.3, sierra 0.1.3, ui 0.1.2, jetty 0.0.3); they ship as 0.1.x patches.
The CLI's `.mesa` templates are still emitted as strings, deliberately, for now.

---

## Money, and a live-update seam that had never run (2026-08-23)

**Where it stands.** `example` has a payment provider. A shopper's order is paid
by a machine now, not by a seller pressing a button: `payments.start` asks the
provider for an intent over conduit, the shopper confirms at the provider, and
the provider POSTs a **signed webhook** back, which is what moves the order
`pending -> paid`. `bun run verify:pay` is 16 assertions and it is repeatable —
run twice, back to back, from a database it has already written to.

**The two directions are two credentials and that is the point.** The shop signs
outbound with `SHOP_PSP_KEY`; the provider signs its webhooks with
`SHOP_PSP_WEBHOOK_SECRET`. Sharing one would mean that leaking the key used to
spend money also lets anybody forge an event saying money arrived. Both sides run
`@frontierjs/toolbelt/signature` and neither has an implementation of its own —
and `api/src/core/psp-sink.ts`, the dev provider on **8112**, actually REFUSES an
unsigned call. That is the whole reason it is a separate listener: a signer with
no verifier reads as a scheme being enforced while enforcing nothing, which is
`FJS-349`, and an in-process fake would have proved the payload gets built and
nothing else.

**Four refusals, four lifetimes, four assertions.** A forged signature, a body
swapped under a real signature, a clock outside the five-minute window, and a
replayed nonce all end in "nothing happened twice", and which one did it matters
enormously. The fifth is a redelivered EVENT, which is the ledger's job:
`model PaymentEvent` is append-only with a `@unique` event id. The nonce store is
in memory and per-process on purpose — it guards a SIGNATURE inside its freshness
window, where the ledger guards the EFFECT for all time — and the file says so,
because "the nonce set is per-process" reads like a defect until you ask what it
is guarding.

**The claim and the effect are one transaction, and that is load-bearing.** The
obvious arrangement — claim the event id, commit, then do the work — has a hole a
crash fits through exactly: the event is claimed, the order is still pending, and
the provider's retry is deduped away by the very row that recorded nothing
happening. `transactional: ['record']` closes it.

**`api/src/core/settle.ts` is the one owner of "this order has been paid for".**
Two callers reach it — a seller pressing Mark paid, and a webhook at four in the
morning — and it takes no client, no context and no transaction: it reads `$`,
junction's ambient service call, so it inherits the caller's transaction, client
and audit actor. It is the shape `$` exists for, and it is what let the webhook
path avoid a nested transactional service call.

### What building it found

**`announceDataWrites` has never announced anything, in any app** (`FJS-464`).
The tap that puts a write nothing routed onto an open tab — `FJS-010`, and
`FJS-307` on top of it — finds the service for a model through one index, and
that index was keyed by the SERVICE name while the lookup used the MODEL name.
Every service in every app is named in the plural (Invariant 2), so it missed for
all of them. Measured by printing the index on `example`: fourteen services,
fourteen plural keys, zero hits.

**The unit tests could not see it because all of them declare `model: 'Order'` by
hand**, which is the one shape no real service file has. Three new cases cover
what an autoloaded file actually writes.

**`createBaseService` was dropping four of the options it accepts** (`FJS-462`) —
which is why `svc.model` held the wrong thing. The loader spreads what a factory
returns into `createService`, so a key that object does not carry was never
declared. `idField` and `softDelete` are the quiet ones: both reach `_meta`,
which the devtools and manifest plugins read, so they were REPORTED correctly and
ENFORCED as undefined. `db` is still deliberately not carried — it is a function,
and no config key may land on that object as a callable own key.

**A transition made outside its own service announced nothing, and fixing it made
it announce twice** (`FJS-463`). The tap mapped create/update/remove and let
`transition` fall through, so the seller's tab stayed on `pending` with a 200. It
announces under the move's name now (`orders pay`) — the same event
`callService` announces for that move through the owning service. The second half
is that `update()` fires BOTH event kinds for one write, so the first fix
broadcast twice; litestone stamps the update with the move's name, and only when
the transition event is really coming, since `asSystem()` suppresses it.

### Traps worth carrying forward

- **A drive against an append-only table cannot use fixed ids.** `verify:pay`
  hand-signs six events, and with literal ids the second run of the drive read
  every one of them as a redelivery — the ledger doing exactly its job. Every id
  is stamped with a per-run token now.
- **`bun run reset` does not clear `db/jobs.db`**, so an absolute count of
  `announce-payment` rows for order 4 includes whichever order held id 4 last
  time. Counted as a delta, like `verify-jobs` already does.
- **Ids collide with the other session.** 457–461 were taken while I was writing;
  mine moved to 462–464. Check `ISSUES.md` immediately before writing a row, not
  when you start the work.

**Verified.** junction 1392, litestone 2946, sierra 1079, cli, mesa — all 0 fail.
All thirteen `example` drives green (331 assertions), `verify:pay` twice.
`node scripts/ci.mjs --fast` passes.

---

## A buy button on a page the shop does not own (2026-08-23)

Feature #4 of the five turning `example/` into a shop. Three framework packages
changed — sierra twice, the cli once — and each change was found by the example.

**The surface.** `fli make:widget BuyButton --prefix fjs-` scaffolds
`widgets/` at the app root: its own Vite root, its own host pages under `test/`,
its own `deploy/`. One `.mesa` in `src/Embeds/` becomes one self-contained IIFE
with its runtime and CSS inside it, mounted in a shadow root by a custom
element. A host page writes one tag and one deferred script — no bundler, no
init call.

**Three things are true here and nowhere else in this app.**

1. **CORS is real.** The SPA is served by Vite, which proxies `/api`, so every
   call it makes is same-origin and no preflight has ever happened in this
   repo's own drives. A widget is a guest. `origins: ['*']` is the right answer
   and the comment in `api/app.ts` says why at length, because it reads like a
   mistake: CORS stops a page READING a response the BROWSER attached
   credentials to, and this app attaches none — no cookie session, and a Bearer
   token is put on a request by code that already holds it. The two things that
   would make it wrong are both absent and both named there.
2. **One call, not three.** `product-variants.embed` answers the product, the
   price, the photograph and what may be SOLD in one request, addressed by the
   SKU a merchant pastes. An embed's budget is round trips on a page it does not
   own.
3. **The basket cannot be shared, so it is handed over.** `localStorage` is per
   origin. Sending the shopper to checkout is handing a capability ACROSS an
   origin, and the token must not travel — a URL goes into history, into
   `Referer`, into every log on the way, and this one is good for the life of
   the basket. `carts.handoff` mints a **one-time code**, the link carries it in
   the **fragment** (never sent to a server), and `carts.redeem` exchanges it
   and clears it in the transaction that read it. Worth one basket, two minutes,
   once.

**Three framework defects, and the router pair is the one to know about.**

- **`FJS-447` — the boot navigation dropped the URL fragment.** `initRouter`
  booted with `pathname + search` and `_navigate` rewrote the address bar with
  `replace: true`, so the fragment was ERASED on every direct load and every
  refresh. `/docs/#install` became `/docs/`, did not scroll, and left the reader
  with a URL that no longer says where they were. Clicking the same link inside
  the app carried it — so it failed only for the person who pasted one, which is
  the person a deep link is for. `scrollRestoration = 'manual'` is what makes it
  total: the router had taken the browser's own handling away and then did not
  do it.
- **`FJS-446` — a URL with a query AND a fragment wrote the fragment twice.**
  `_navigate` split the whole URL on `?`, so the fragment landed inside `search`
  and `page.query.status` came out as `open#top`. Unreachable while the boot
  path dropped the hash; found the moment it stopped.
- **`FJS-448` — a minified widget lost every stylesheet it imported.**
  `widgetCssPlugin` deletes Vite's `style.css` asset and swaps its text in at a
  placeholder. `generateBundle` runs after minification and the matcher knew `"`
  and `'`; esbuild writes **backticks**. The asset is deleted whether or not the
  swap lands, so the widget carried the literal `@sierra-widget-css` into its
  shadow root as its stylesheet. A widget's own scoped `<style>` was unaffected
  (Mesa's runtime is shadow-aware), so it looked styled. It survived because the
  fixture builds with `minify: false` — for a good reason — leaving the one
  working case as the only one under test. The swap is asserted now: not finding
  the placeholder throws rather than shipping.
- **`FJS-445` — `fli make:widget` wrote project 0's ports into every app.**
  8200/8300 in four generated files. `ports.js` is explicit that the numbers are
  derived; `strictPort` turns the collision into a refusal, so it surfaces as a
  second widget server that will not start naming a port nobody chose.

**And one in the example, worth the same attention.** `carts.redeem` built the
basket it hands over through the CALLER's client, like every other method there
— and the caller redeeming a code holds no claim yet, because the claim rides a
header on the NEXT request. So `@@allow('read', token == auth().cartToken)`
filtered every line out and the shopper landed on the shop's own site looking at
an empty basket with a 200. It is the one call in that service where reading as
the shop is correct, because the code IS the proof.

**Where it stands.** All eleven example drives green, `verify:widget` 36/36.
sierra 1056 tests + 25 widget-browser assertions + 5 safety. `bun run ci:fast`
green.

**Next**: #5, a payment provider and a signed inbound webhook.

---

## Inventory, reservations, and a shelf that is not a column (2026-08-23)

Feature #3 of the five that are turning `example/` into a shop. Everything here
is in `example/`; **no framework package changed**.

**The shape.** Three numbers, one of them a column:

```
ON HAND    ProductVariant.stock      what the warehouse could pick now
HELD       Σ StockReservation        set aside for a basket, with an expiry
AVAILABLE  on hand − held            what may be sold, computed every read
```

The two obvious designs are both wrong and in opposite directions.
Decrementing `stock` on add is unrecoverable — the thing that would put it back
is a person who has closed the tab. Leaving it until checkout oversells the last
one to two shoppers, and the second finds out at the till. A hold is the third
answer: a row with a clock on it, so nothing has to come back and undo it.

**Three things that break silently, and are what `verify:stock` is for.**

1. **A hold is a row about the SHELF, not a column on the line.** `CartLine`
   already carries a variant and a quantity, so `heldUntil` there was three
   characters of schema — and wrong, because the line is scoped by the shopper's
   own token. Summing holds from their client answers a sum over their own
   basket: always plausible, usually zero, never the number asked for. It is
   Invariant 6's failure mode exactly — a wrong policy is an empty screen.
2. **A shopper's own hold must not count against them.** Holding 2 of the last
   5 and raising the line to 3 is legal, and the naive sum refuses it — which
   looks exactly like a stock shortage and is not one. `levelsFor(client, ids,
   { exceptCartId })` is the whole of it.
3. **The expiry is in the READ.** Every availability sum filters
   `expiresAt > now`, so a hold is dead the instant it passes.
   `api/jobs/release-holds.job.ts` deletes the rows and is HOUSEKEEPING: the
   queue can be down for a week and every price and every button is still right.
   A sweep that "releases" stock by putting a number back means a queue outage
   quietly stops the shop selling, and it looks identical from outside until the
   day it happens.

**The ledger is `@@gate("5.5.9.9")` and every digit is load-bearing.** Read 5;
create 5, so `inventory.receive` writes the movement through the CALLER's own
client and the Data boundary is what grades them — there is no level check
anywhere in `inventory.service.ts`; update and delete **9**, which nothing
passes including `asSystem()`. That is what append-only is spelled with. The one
movement written any other way is `sold`, which a shopper at level 0 causes and
the shop records for itself through `asSystem()` — the asymmetry is the whole
authorisation story for stock and it is two sentences long.

**`asSystem()` where it is genuinely needed, and said out loud.**
`product-variants.availability` is a public method that sums a table a stranger
may not read. The number is public — it is what the shop is telling people it
can sell — and the rows are not; what crosses the wire is `{ variantId,
available }` and never a cartId or somebody else's quantity. The same reasoning
is why holds do **not** travel on a channel: a broadcast does not re-check the
gate, so publishing them would hand every open browser the rows the Data
boundary refuses it. The cost is that another shopper's hold does not move your
buy box live; the server refuses regardless and says which of *sold out* and *in
other baskets right now* it is.

**Three things found.**

- **A guest could not remove a line from their own basket.** `CartLine` was
  `@@gate("0.0.0.5")` — delete at 5 — with `@@allow('delete', token ==
  auth().cartToken)` written underneath it saying what was meant. So
  `removeLine` and `setQuantity(0)` answered 403 to every shopper in the shop
  for as long as the basket had existed. Nothing noticed because the two drives
  that fill a basket only ever added to it. Now `"0.0.0.0"`.
- **Two self-hosting drives could not run in a row.** They start `npx vite`,
  which is a launcher: SIGTERM killed the launcher and left vite on 8010, so the
  next drive refused the port and reported *a dev server from an earlier run* —
  true, and nothing said which run. `detached: true` and signalling the process
  GROUP, in all three.
- **`preview.mjs` re-labelled decoded bytes as gzip.** It forwarded
  `accept-encoding`, junction compressed past a threshold, `arrayBuffer()`
  handed back decoded bytes, and the proxy answered with the upstream's
  `content-encoding: gzip`. `ERR_CONTENT_DECODING_FAILED`, for whichever
  response happened to cross the threshold — so it surfaced as `verify:build`
  failing at sign-in with *Failed to fetch*, reading as a regression in whatever
  grew a payload last.

**`FJS-424` was hit again** on the same page, and the second occurrence narrows
it: `rows.find(v => availOf(v) > 0)` throws while
`variants().reduce((n, v) => n + availOf(v), 0)` in the same file and the same
edit does not. `find` and `reduce` are not equivalent here, which is a sharper
lead than *nested callback* and is the first thing to try in a fixture.

**`FJS-444` filed**: `litestone access --from` answered *no change to who may do
what* for a branch that added seven gated models, because a model with no
counterpart at the base ref contributes no findings. Defensible by the axis's
own definition and wrong for the reader — `release --from` grades a new model as
an expand and says so, so the two commands disagree about whether a new table is
worth a line.

**Where it stands.** `bun run ci:fast` green in 73s; 21 snapshots current;
registers agree. All ten example drives green against one database:
`verify` 38, `verify:build` 38, `verify:ui` 31, `verify:values` 14,
`verify:live` 14, `verify:jobs` 10, `verify:notify` 9, `verify:public` 22,
`verify:catalogue` 20, `verify:cart` 27, `verify:stock` 41.

**Next**, from the five approved for the shop: #4 a `widgets/` surface with a
buy-button embed, #5 a payment provider with a signed inbound webhook.

---

## Tenancy stopped being written out (2026-08-22)

`FJS-D113` ruled that a tenant claim and a per-request standing are the same
thing — claims on the principal — and that resolving them is an API-realm
question with one seam. `FJS-374` was the work. Both are closed.

**What junction gained.** `createApp({ principal })` takes a resolver that runs
once per service call and merges its answer onto a fresh principal, composed
INSIDE `withLitestoneDb`/`withTenantDb`. That ordering is the whole thing and it
is the one an app cannot arrange for itself: `getTable()` re-derives its own
scoped client from `ctx.auth.user`, so a standing that lives only on
`ctx.locals.db` is dropped the moment a service touches a model. Two refusals
are built in — a resolver may not set `userId`/`id` (a claim says what a caller
HOLDS, not who they are) and it does not run for an anonymous caller (minting a
principal out of claims turns *nobody* into *someone*, an object satisfying
`auth() != null` while carrying no identity).

`membershipClaim()` ships the shape almost every B2B app has, and its whole
safety is one line: **no row is no claim**. The hand-written version that
forgets the membership check emits the claim anyway and every read answers 200
over somebody else's rows. Its tests run against a real Litestone client because
that failure looks exactly like success to a stub.

**What basecamp lost.** `applyStanding`, `withWorkspaceStanding`, sixteen
`@@allow` lines, the workspace clause inside `findScoped`/`getScoped`, and seven
copies of `data.workspaceId = ws()` — the declaration desugars a
`@default(auth().workspaceId)` that fills the column at the Data boundary, which
was probed rather than assumed. `stampWorkspace` is `deriveSlug` now.
**17 models with row policies became 31**: the fourteen carrying no `workspaceId`
of their own had nothing to hand-write and were relying on a parent, and they
say `@@tenant(via: parent)` now. Eight say `@@tenant(none)` by name.

**The five defects, and why none was findable from inside the package that
owned it.**

- `FJS-378` — **a caller could move their own row OUT of their tenant.** The
  generated denies asked *may you touch this row* and never *may the row end up
  there*. The hand-written `@@allow('all', …)` never had the hole, because `all`
  expands to `post-update` for free. Found when basecamp's own tests started
  failing on the framework version of a rule they had passed for months.
- `FJS-382` — **a delegated child whose parent is optional was invisible to
  every scoped read.** Two implementations of `check(parent)` disagreed about a
  null foreign key: `evalCheck` true, `compileSql` a bare `EXISTS`, false. Four
  dashboard widgets went empty with a 200 and nothing said, and
  `verifyRowPolicies` skips `check()` by name so it could not see it.
- `FJS-381` — **`verifyFieldProtection` reported every field on a scoped model
  as unchecked.** Its seeder satisfies *allow* rules; tenancy generates a *deny*.
  A green run over an assertion that never executed.
- `FJS-383` — **`tenantClaimGuard` answered 401**, so a member of workspace A
  following a link into B was not refused, they were logged out of A. Every
  client treats 401 as a dead token. 403 in every branch now.
- `FJS-380` — **still open.** `litestone access --from` grades the allow→deny
  inversion as WIDENS (16 widen · 30 narrow), so `--strict` would fail the
  safest refactor the feature has. The `access` CI phase only prints, so nothing
  is blocked today.

**A late one, caught by a peer session and worth reading as a lesson.** The
first cut of the guard collapsed *named no tenant* and *named one, not a member*
into one empty answer — so a caller who named nothing was told they do not
belong to "the workspaceId this request names", naming nothing. The status was
wrong too: basecamp's own hook had answered **400** with the header and the
query param spelled out, and the guard buried it under a 403. Three branches
now, and `membershipClaim({ namedBy })` carries the app's actionable sentence
into the framework's refusal, because `tenantFrom` is the only thing that knows
where a tenant is named.

**Verified:** basecamp 132 pass · `verify` 301/301 · junction 1287 pass ·
litestone 2380 pass · typecheck clean workspace-wide · 19 snapshots current ·
registers clean. `ci:fast` has one standing ✗ — `--source npm: fli deploy:local`
— which fails because this shell's `/tmp` is private to it and prints exactly
that. Environmental.

**What the Laravel comparison bought.** Reading Crowd Favorite's Orthicon
architecture (same shape: row tenancy, one database, a scope injected into every
query) against ours produced three rows. We are ahead where data leaks — their
`TenantScope` is applied per model by a human, ours is exhaustive with named
exemptions, and an Eloquent global scope filters reads without stopping a row
LEAVING, which is `FJS-378` in their design too. They are ahead on everything
that makes it a product:

- `FJS-386` (S2) — the cache is not tenant-aware, so under `strategy row` the
  first caller to warm an entry decides what every other tenant reads. **Not
  measured** — the next action is a two-caller probe, not a fix.
- `FJS-385` — no per-tenant configuration. A tenant can differ in its rows and
  in nothing else: bucket, timezone, locale, mail from-address all resolved once
  at boot.
- `FJS-384` — background work has no tenant, so jobs reach for `asSystem()` to
  do ordinary work, dropping the gate, the row policies and the audit actor
  together. Measured: all four of basecamp's job files. `FJS-D113` ruled the
  resolver does not run there and the reasoning holds; the consequence was not
  weighed. Wants a ruling before code.

### Pick up here

1. **Give `example` declared tenancy.** The feature is proven on exactly one app
   and the first adoption found five defects; a second independent one is the
   cheapest bug-finder available. `example` is also the app a reader copies, and
   its paved road is still hand-written.
2. **Split basecamp's `core/`.** The question that started this whole thread.
   Two-thirds of what made it a grab-bag was framework gap and is now gone, but
   `hooks.ts` is still 607 lines and `app.ts` 539 — the folder is smaller, not
   yet named. Worth doing AFTER `example`, which will say which of the remaining
   helpers is really app-specific.
3. **`FJS-380`**, so `fli test:access --strict` is usable by the branch most
   likely to trip it.

Smaller and unstarted: `FJS-368` wants a ruling (litestone no-op vs junction
drop for a version-only patch); forty-two `workspaceId: ws()` clauses survive
inside basecamp service methods, each redundant against the declaration but each
needing its accessor checked against the eight exempt models first; the
conformance checker (an L1 lexical vocabulary rule) was offered and never filed.

---

## A second human can get in (2026-08-19)

`FJS-032`, the next one on the S2 ranking after the deploy plane, and the only
one of the five left whose blocker was work rather than a decision.

**Basecamp's one door for a human was the setup wizard.**
`workspaces.addMember` takes a `userId`, so it could only reach somebody who
already had an account, and `/auth/register` — the one route that makes one —
leaves them with no account row and no workspace, after which every scoped
request 400s and they cannot create a workspace either.

`model Invitation` is an offer of membership to an **email address**, which is
the thing that carries a workspace and a role across the gap where there is no
user to hang them on. Three columns on `WorkspaceMember` — `invitedBy`,
`invitedAt`, `acceptedAt` — had been declared since the schema was written and
nothing had ever written one; accepting writes all three and deletes the
invitation, so the row IS the pending state and there is no second place a
membership's origin is recorded.

**`invitations.preview` and `.accept` are the app's only unauthenticated service
methods.** They have to be: the population they serve is not a member yet and
may not exist yet. The `@guarded(all)` token is the credential — no scoped read
can answer it, so the link is shown once, the shape an issued API key already
had — and everything a token cannot decide (unknown, expired, workspace gone,
workspace suspended) is decided in one function, because none of the hooks that
normally decide it are running. An address that already has an account must be
signed in as that account; taking a password on this method would be a second
login door with none of the first one's rate limiting, and an oracle when it
refuses.

**Mail is now real and its absence is honest.** `api/src/core/mailer.ts` is
`IMail` over `app.conduit.send()` — a declared target with a credential ref
rather than a key in a closure — and `app.mail` is ABSENT where nothing is
configured. That is the design, not a gap: a fleet console that cannot mail is
ordinary, and a screen that looks like it sent something is not. The invitation
issues a working link either way and says which happened. Two env pairs decide
it (`MAIL_URL`/`MAIL_API_KEY`, else `RESEND_API_KEY`), and `APP_URL` is where a
link points, named rather than derived from a request's Host.

**Three defects, all found by running it.** The drive is 301/301 with 21 new
checks, and it grew a mail sink on 8121 so the mail half is graded by a provider
over a real socket rather than by the app's own claim.

- `POST /workspaces` 400d for any caller that did not send its own slug
  (`FJS-352`). `create()` derived it in the METHOD and `autoValidate` runs
  first — the same ordering `stampOwnership` in that file already exists for,
  with `accountId` and `ownerId` in it and `slug` left behind. Only the browser
  called it, and its form sends a slug.
- The invite screen asked *does this address have an account* before *who is
  holding this browser*, so an owner following a link to check it was one click
  from creating somebody else's account with no mention of the session they
  were in.
- `web/config/api-paths.js` was missing `/invitations`, and its own comment said
  why that is harmless — wrongly. The Junction client uses `location.origin`, so
  it goes through the dev proxy like everything else; what actually hides a gap
  is the WEBSOCKET, which carries every service call for a SIGNED-IN browser
  under one rule that cannot go stale. The HTTP path is exercised only where
  there is no socket, which is exactly what accepting an invitation is.

**And one framework defect it turned up, now closed too**: `FJS-351`. Litestone's
`generateValidationCases` built every case from ONE attribute with no idea what
else sat on the field, and both halves of that were wrong once a column carried
two rules. A boundary claimed a value the field REFUSED — measured at 8 of 12
false on a six-field schema, 4 of 6 fields reported broken when nothing was —
and an invalid case was refused by somebody ELSE's rule while counting as proof
of its own. That second half was measured rather than argued: disable `@length`
in `validate.js` and the runner reports *the write was ACCEPTED* on a
single-rule field and **nothing at all** on the `@email` field — so it could not
tell an enforced `@length` from a missing one there, and the false alarm is what
hid it, because a schema that always reports something looks like a schema being
checked. Four findings now, all naming `@length`, and zero on a clean schema.

Closed against one judge: `validateField`, now exported from `core/validate.js`,
because a table of formats in the generator would be a second definition of
every rule — and asked about the field's OTHER rules only. Whether a value
satisfies or breaks the rule it NAMES is settled by construction; the first
version asked the implementation, which makes the runner its own oracle, and
disabling `@length` then reported *not checked* rather than *ACCEPTED*. Caught
by measuring the claim I had already written down, which is the only reason it
did not ship. The repair is format-blind — grow or trim the factory's own valid
sample and ask the validators — so an email grows in front of its own domain and
`@startsWith("ORD-")` keeps its prefix with nothing here knowing either word;
shrinking works on alphanumeric RUNS and leaves punctuation alone, which turns
`email1@example.com` into `e@e.c` at five characters. What cannot be isolated is
`uncheckable`: named out loud, never dropped.

`Invitation.email` carries `@email @length(6, 200)` again — **6 and not 5**
because `a@b.c` is the shortest string `@email` accepts, so a bound sitting on
the format's own floor can never be violated by anything still an email, and the
runner now says so rather than passing.

Green: litestone 2373 · junction 1232 · testing 23 · basecamp 132 · `verify`
301/301 · `verify:build` 8/8 · `ci:fast` pass · typecheck 15 against a baseline
ratcheted 16 → 15.

---

## The deploy plane got hands, and the door it knocks on got a lock (2026-08-19)

Started as *rank basecamp's S2 issues*. The ranking put `FJS-257` first because
its cone is the widest, and everything below followed from actually opening it.

**A deploy reported six green steps and issued no command.** `runStep` returned
early when no placement resolved and the caller marked each step `success`.
`api/src/engine/executor.ts` is now the one owner of *who carries out a release*
— a registered outpost, the named stub (`BASECAMP_STUB_OUTPOST=1`, refused in
production, and it writes *no /deploy was issued* into every step it touches),
or a refusal — asked at `deployments.create` so the 400 lands where the button
is, and again in the engine because a placement can be removed in between.

**The gap under it was wider than the row said**: `AppServer` was read by three
engines and written by nothing — no service, no seed, no screen — so refusing a
placement-less deploy would have bricked Deploy for everyone. `apps.place` /
`apps.unplace` write that gate-8 row through `asSystem()` after checking the
caller against the workspace; the App screen edits it and the seed uses it.

**Then the wire contract turned out to have no lock on it.** Reading what the
Outpost would have to speak, I found `servers.heartbeat`, `volumes.report` and
`cleanup.report` exempted from `sessionScope` behind a comment saying the
transport verified an HMAC. Nothing did, anywhere. Measured against a running
API: an unsigned POST answered **200**, moved a server to `online`, and
registered the Conduit target at `http://attacker.invalid:9999` — which points
every later `/exec`, `/deploy` and `/system/prune` for that machine at a host
the caller owns, signed with basecamp's own secret. Filed and closed as
`FJS-349`; the scheme now has one owner in `@frontierjs/toolbelt/signature`,
conduit signs with it, basecamp verifies with it, and junction grew
`ctx.$raw.rawBody` because a signature is over bytes.

**`packages/outpost` exists.** The route table is read off the call sites that
have been sending to nothing, not invented — and the first test found the first
defect: the bodies are snake_case on the wire, and a route passing one straight
through addressed a container called `fjs-undefined`. basecamp's drive runs the
REAL server over an injected docker runner, so both sides of the protocol are
graded rather than restated.

Also closed on the way: `FJS-031` (every service broadcast every read to the
whole workspace — 17 services now declare `channel:` instead of running a
publish hook), `FJS-154` (the audit trail said *what happened* and never *what
changed*; both sides of the diff are read through the system client, because a
scoped read strips protected columns and made an `@encrypted` rotation look like
a removal), and `FJS-350` (junction's test request fired on the microtask queue,
so an `await` before `.send()` silently sent nothing).

**Three checks in basecamp's drive had gone stale against its own shell** —
*Sign out* moved into a `{#if open}` dropdown, the login inputs had no stated
`id`, the nav left the topbar. Each read as a broken app. `bun run verify` was
red on main before any of this.

Green at the end: litestone 2369 · junction 1232 · conduit 193 · toolbelt 83 ·
basecamp 132 · outpost 19 · cli 668 · `verify` 279/279 · `verify:build` 8/8 ·
`ci:fast` pass. What is still not proven is a real Docker daemon — `FJS-257`
says so and names the parse most likely to be wrong.

---

## The notifications plugin, cleaned up — five rows closed (2026-08-16)

`@frontierjs/notifications` had five open issues and they turned out to be four
readings of one question: **what does this package address, and what does it
call the thing it addresses it on.** 54 tests (was 38), typecheck clean,
`example`: `verify:notify` 9/9 and `verify:jobs` 8/8, `node scripts/ci.mjs
--only notifications` green.

**`channel` meant two things fourteen lines apart in `types.ts` (`FJS-285`).**
`FJS-D06` had already ruled it: Channel is junction's broadcast set, a delivery
medium is a **Transport**. So `Channel`/`BuiltInChannel`/`ChannelError` →
`Transport`/`BuiltInTransport`/`TransportError`, `NotificationDriver.channel` →
`.transport`, `channels:` → `transports:`,
`NotificationChannelNotImplementedError` →
`NotificationTransportNotImplementedError`. `app.channel(...)` in the in-app
driver is untouched — it is now the only `channel` in the package, and it reads
unambiguously. **The old option name throws naming the new one**: an unknown key
configures nothing and would surface as a missing driver at the first send,
which is the failure the rename exists to remove.

**A recipient is not a user (`FJS-096`).** `notify()` took a `User`, so a shop
customer was passed as one with an invented id (`customer:42`) — right for
email, and for `inApp` a row keyed by an id nothing will ever query, written
with no error. The unit of address is now `Recipient`, whose **`id` is
optional**, and each transport states what it needs, checked **before any
delivery**: `inApp` refuses an id-less recipient by name, `email` refuses one
with no address, a registered driver is exempt because only it knows what it
addresses by. Eager, so a two-transport notification cannot half-land. The
near-miss is named in the message: a recipient carrying `userId` is reported as
a probable `SessionContext` — `ctx.user` is `{ userId, email }` and reads as
id-less, which is the same trap in a second costume.

**The plugin implemented only `register()` (`FJS-049`).** `boot()` now fails
startup when the email transport is configured and `app.mail` is not set —
`requires: ['mailer']` proves the PLUGIN is configured, which is not the same
claim — and `shutdown()` awaits each driver's own optional `shutdown()`,
isolated so one that throws does not stop the next. `app._db`/`app._drivers`
were two enumerable properties under a comment claiming they were symbol-keyed;
they are one `Symbol.for` state object now, so nothing leaks onto the app
surface and `notify()` on an unconfigured app names the missing plugin.

**`ctx.app.notify` from a service hook had never been run (`FJS-050`)** —
the way every doc comment in the package says to use it. `tests/hook.test.ts` is
a real service with a real after hook; the row it writes is the evidence the
hook ran, and it is asserted field by field, which is also the answer to that
row's second half (no consumer of the in-app record shape existed).

**The package's own runnable example could not run (`FJS-072`).**
`examples/Notification.mesa` imported `resource`, `derived` and `get` off
sierra's root, which exports none of the three. It is the resource file
`example/` actually runs now. `examples/wiring.ts` had the same class of error
in prose — `ctx.params` (nowhere in Junction; path captures are `ctx.route`),
`db.asSystem().users` (the accessor is `db.user`), `ctx.user` handed straight to
`notify()`.

Found on the way and fixed: **each `to*()` was called twice per `notify()`** —
once to check the method existed, once to deliver — so a formatter that renders
an email-kit template did it twice, and the message that was validated was never
the one sent. It is formatted once and carried into delivery.

Not done, deliberately: **the version is still 0.1.1.** The renames are
breaking for any consumer outside this repo, and cutting a release is a separate
act. `packages/basecamp` has its own `NotificationChannel` MODEL — a Slack or
webhook destination, its own domain vocabulary — and it was left alone.

Unrelated and pre-existing: `packages/auth` typechecks at 12 against a baseline
of 4 (`plugin.ts` body destructuring + `tests/schema-accessors.test.ts`), which
fails the root `bun run typecheck`. Another session's work in flight — untouched.

---

## Tenancy is a declaration, not a call (2026-08-16)

**`FJS-D05`, ruled and built — the litestone half is green, the junction half is
written and NOT yet tested.** Say that first: `withTenantDb` and
`tenantClaimGuard` exist, compile and are wired into `createApp`, and nothing
has run them. Treat them as unproven.

The row asked for a config shape for db-per-tenant. Two things were actually
wrong. **db-per-tenant had three configurations that could disagree** — a
`createTenantRegistry()` call, a `tenants:` slice in `litestone.config.js` that
the CLI read three keys of, and nothing at all in the schema — so
`litestone tenant create` and the running app could each be right about a
different directory. And **row-level tenancy was not a framework concept in any
form**: basecamp hand-writes `@@allow('all', workspaceId == auth().workspaceId)`
on fifteen models, which is fifteen chances to leave one off.

**Both answered by one `tenancy { }` block in the seed**, beside
`database { }` — `strategy database` or `strategy row`. Everything downstream
asks one resolution (`db.$tenancy`, `registry.tenancy`, `resolveTenancy`) and
precedence is stated once: **option → declaration → default**.
`createTenantRegistry({ path: './db/schema.lite' })` is now the whole call.

**The part worth knowing before touching it: row tenancy compiles to `@@deny`,
never `@@allow`.** Allows are OR'd within an operation, so a generated allow on
a model that already declares one *widens* its reads to the whole tenant — a
tenancy feature that grants access. And it is TWO rules, because
`checkCreatePolicy` runs before `applyAuthDefaults`: on create the column the
`@default(auth().<claim>)` stamp is about to fill is legitimately absent, on
read a row holding no tenant belongs to nobody. Verified by running both
directions against a real client — cross-tenant create refused by name,
cross-tenant update and delete answer `null`, anonymous sees nothing,
`asSystem()` still crosses.

Deferred with a reason, filed as `FJS-282`: a model reached only through its
parent. `check(parent)` is conservative-allow on create (the related row does
not exist yet), so generating it would enforce reads and permit a cross-tenant
create in silence — half-enforcement in the one feature whose job is
enforcement.

`packages/litestone/docs/multi-tenancy.md` is the reference;
`DECISIONS.md` § Access control is the argument.

---

## A job now knows who sent it (2026-08-16)

**`FJS-093`, and the principal half filed beside it.** A Caravan handler took one
argument and it was the job — no `app`, no second parameter — so an autoloaded
`*.job.ts` had no route to the service layer at all, and apps grew a module
holding a mutable app reference (`example/api/app-ref.ts`, which said so in its
own header). Separately, a job had no principal, and no principal is STRANGER(0),
so every job carried `{ auth: { user: SYSTEM } }` by hand.

Both were documented hazards rather than bugs, which is what made the cost
invisible. **Reading `example`'s audit trail is where it shows**: booking a
courier for one customer's order was recorded as an act of the shop, at
SYSADMIN(7), with nothing anywhere naming who had asked for it.

**Ruled: deferred work runs as the ENQUEUING principal, re-resolved.** Two
alternatives were rejected and the reasons are the decision (`DECISIONS.md`
§ API design). *SYSTEM by default* removes the refusal by removing the question
and silently escalates every customer's work. *Snapshot the session at dispatch*
is one line shorter and lets a caller demoted between asking and running keep
that authority for as long as the retry schedule runs — revocation that does not
reach queued work is not revocation.

So an id travels, not a session. Three pieces, none Caravan-specific:

- `app.principal()` — who is in scope, asked from somewhere holding no `ctx`
- `app.runAs(userId, fn)` — re-resolves through `IAuth.sessionFor` and opens the
  ALS scope, so `fn` makes ordinary service calls that name nobody
- `createApp({ system })` — who the app is when it acts on its own behalf, for
  work nobody asked for. Declaring none gives `null`, not an invented principal

Caravan records `actor_id` at dispatch and runs the handler inside `runAs`. A
handler's argument is a `JobContext` now — the job's facts plus `app` and `auth`.
An actor that cannot be resolved fails the job **by name**: falling back to no
principal is the defect being removed, falling back to `system` is the rejected
option, so there is no fallback.

**Proof, from the audit trail rather than an assertion:**

```
update order  actor= 39a9a6ea…   ← alex@shop.test, who pressed Ship
update order  actor= system      ← the cron sweep
```

`example/api/app-ref.ts` is deleted and no job names a principal.

**Verified:** caravan 92 (was 81, 11 new in `tests/job-context.test.ts` — the
implementation was broken on purpose and 6 of the 11 went red), junction 1120,
auth 131, conduit 193, notifications 38, testing 23. Typecheck clean across all
17 packages. `example`: `verify:jobs` 8/8, `verify` 37/37. `bun run ci --fast`
green except `fli new failed`, which is a syntax error in another session's
in-flight edit to `packages/cli/commands/project/new.md` and is caught by that
package's own parse sweep.

**Not run:** basecamp's suite and its browser drive.


## `contains` on an array was a substring search wearing `has`'s clothes (2026-08-14)

**`FJS-210`.** `{ tags: { contains: 'x' } }` on a `String[]` compiled to
`LIKE '%x%'` over the stored `["x","y"]`. It matched — and so did
`["xylophone"]`, and `contains: '","'` matched every array of two or more
elements, and `contains: '['` matched all of them. The cases where a substring
search and `has` agree are exactly the ones that hide the difference. On a
`Boolean` the same operator answered `[]` in silence, the value being 0/1.

Refused now on the four kinds where the stored text is not the value — array,
`Json`, `File`, `Boolean` — each naming the operator that was meant. **`Int` and
`DateTime` deliberately keep the answers they gave**: `{ when: { contains:
'2024-01' } }` against an ISO column is a real way to ask for a month, and those
cells are load-bearing in the crossing grid as `ok`. A path INTO a typed `Json`
column is untouched, because that operand really is text.

**The fix is one map, not one per question.** `buildWhere` already took an
`arrayFields` Set for an unrelated reason — a bare array means `IN` on a scalar
and `hasSome` on an array column, and the operand cannot say which. That is the
same fact: what the column HOLDS. It is a `fieldKinds` Map now, so the builder's
signature did not grow and `buildArrayMap` is deleted rather than left beside a
second map of one fact.

**Both `where` refusals became `ValidationError`s**, including the array-operator
guard that predates this. Junction maps the name to a 400; a bare `Error` is a
500, which tells the caller the server broke when they asked a column something
it cannot answer.

Six `210:ref` cells promoted in `matrix.test.ts`. One regression, caught by the
suite: a schema `view` builds its table by hand and was still handed the old
`Set`.

Proven by litestone 1985, junction 1044, sierra `test:safety` 5/5, basecamp's own
suite 72, the matrix 183, typecheck exit 0, and `example`: `verify` 37/37. The
basecamp browser drive is still blocked — see the entry below, unchanged.

## A sort key that was a serialisation (2026-08-14)

**`FJS-200`: `orderBy` over an array, `Json`, `File` or encrypted column ordered
rows by the stored TEXT**, and `$checkOrderBy` blessed it. `[10]` sorted before
`[9]`; a Json document sorted by whichever key serialised first; ciphertext
reshuffled on every re-encryption. Nothing anywhere refused it, so page 2 of a
"sorted" list was plausible and wrong.

`sortableKeysFor()` split a model's keys three ways and an array fell into
`sortable` by default. There is a fourth bucket now — `reason: 'opaque'`, one
message per kind. **`File` was added on the row's own principle** rather than
named by it: the stored value is a reference document, the same failure in a
different type. Junction's `autoSort` reads the new reason and says its own
sentence, so `$checkOrderBy` stayed a bridge with both sides in step.

**One regression, caught by the existing suite:** an implicit m2m (`tags Tag[]`)
is an array in the AST and a join table in SQLite, so the array bucket took it
and `orderBy: { tags: { _count } }` stopped compiling. Claimed as a relation
first now. The eight `200:ref` cells in `matrix.test.ts` are promoted to `ref`.

**Two things in the tree are broken and are not this** (both landed ~10:20–11:27
while this was running, both in the parallel session's area):

- **Basecamp cannot boot on a fresh database.** `db/migrations/001_…sql` moved to
  `db/migrations/main/`, which is right for litestone's runner — but the app boots
  through Junction's `dbClient.migrate(dir)`, and that globs `*.{sql,ts}` at the
  TOP level only. It finds zero files, creates `_migrations`, applies nothing, and
  the API answers `no such table: workspace` with a 200-shaped 500. `bun run
  verify --reset` dies at the setup probe; a deploy would come up empty. Verified
  by replicating the harness's own spawn and polling the probe for 60s.
- **`bun run ci` crashes in its own reporter** — `renderOutput` reads
  `stdout.trim()` on an undefined stdout (`scripts/ci.mjs:776`). `ci:fast` is
  fine, and every suite passes run individually.

So this change is proven by: litestone 1975, junction 1040, sierra 836 +
`test:safety` 5/5, basecamp's own suite 72, the crossing matrix 183, typecheck
clean with no baseline raised, `example`: `verify` 37/37, and `ci:fast`. The
basecamp BROWSER drive could not run — see above.

## The path a stranger walks, and the six things on it (2026-08-14)

A review of *what does the happy path look like and what blocks it*, done by
**running it** rather than reading the register: `fli new` from published
packages, boot, probe, build. That found more than the register held.

**The finding that reframes the rest.** Every id in `ISSUES.md` is a statement
about the working tree, and a user's experience is a function of the tree **and
the registry**, which drift independently. A scaffolded app today cannot log in —
its `app.ts` and `sierra.config.js` are written for an `apiPrefix` that moves
`/auth/*`, published auth mounts at `/auth/*` regardless, and `POST
/api/auth/register` is a 404 reading *Service 'auth' not found*. Also: `fli new`
tells you to make something answer `/api/health` while the app it wrote answers
`/health`, and `frontier.config.js` points a deploy's health check at the first —
which is `FJS-238` alive again on the published side, where it rolls a good
deploy back. All fixed in the tree, none published. Filed as **`FJS-252`**;
`fli ws:npm` already asks the registry and nothing runs it.

**Six closed, all verified by running:**

- **`FJS-193`** — `migrate apply` said *no migration files found* about a
  directory holding a real one. The register named one cause and there were two:
  basecamp's migration was misnamed `001_…` **and** sat one directory above
  `migrations/main/`, which is where a schema declaring `database main` is read
  from. `createTestEnv` reads loosely enough to replay it either way, so 68 green
  tests never noticed. A directory with candidates and no matches is now a
  refusal that exits 1; basecamp's migration applies for the first time.
- **`FJS-157`** — the lockfile converges. Two causes: seven `"latest"` pins (two
  `@types/bun` copies resolved at once), and `sierra`/`jetty` declaring
  `@frontierjs/mesa` as a peer with no workspace devDependency, so bun
  re-resolved it every install and wrote a nested tree carrying mesa's own
  devDependencies. `--frozen-lockfile` now passes on a pristine copy, and the
  workflow uses it.
- **`FJS-036`** — the `scaffold` phase grew the step the row is actually about:
  `fli scaffold Note` into the installed app, four generated files named
  individually, then a second build.
- **`FJS-213`** — the studio smoke test asks for port **0** and reads the bound
  port back. That needed a product fix too: `cmdStudio` printed the REQUESTED
  port, so `--port=0` announced `http://localhost:0`.
- **`FJS-247`** — `verify:public` was three-red for a week. 21/21 now, with the
  number's reason written beside it: at 4 of 4 the assertion cannot tell an
  island that filters by `active` from one that renders everything.
- **`FJS-177`** — already closed by a parallel session; basecamp is green.

**`FJS-009` is narrowed, not closed, and the remainder is not fixable from a
laptop.** Three of its four gaps are gone — tarball install, deploy, frozen
lockfile. The workflow has still never been triggered, so the runner's Chrome and
a genuinely fresh clone stay unproven until a commit reaches GitHub.

**Two things to know:**

- **`FJS-245` was issued twice** by two sessions in one window. The sierra build
  defect is now `FJS-251`; junction's filtered-restore keeps 245, because
  `DECISIONS.md` cites it and a settled register should not have ids rewritten
  under it. Check the highest id in BOTH files immediately before filing.
- **And `FJS-253` was issued twice, the same day, the same way.** litestone's
  `$rotateKey` keeps it — that row is CLOSED and cited five times, including a
  comment in `client.js` and two in the test file. cli's `extractServiceMeta` is
  now **`FJS-254`**, renumbered because it is still open and carried two
  citations. **The rule the second collision suggests**: when two rows share an
  id, renumber the OPEN one with the fewer citations — rewriting an id inside
  shipped `CHANGES.md` entries and source comments is the expensive direction,
  and a closed row is a historical record.
- **`scaffoldAndDeploy` fails in a sandboxed shell** and it is not a deploy
  defect: the Docker daemon cannot see a private `/tmp`, so `docker build` reports
  a context path that is plainly there. `FJS_CI_WORKDIR=$HOME/fjs-ci-work` fixes
  it, and the finding now says so when it detects the shape.

## One translation, made in one place and not the other (2026-08-14)

**`FJS-214`: a `@@allow` comparing an encrypted column denied every row to
everyone.** `@@allow('read', owner == auth().email)` emitted `"owner" = ?` bound
with the plaintext while the column held ciphertext. It failed *closed*, which is
why it lasted: a model nobody can read looks like a table with no data.

A `where` had never had the bug, because `buildWhereWithEncryption` encodes the
operand first. `policy.js` mentioned encryption nowhere — the same translation,
owned in one place and absent from the other.

`comparisonEncoderFor()` in the new `packages/litestone/src/core/encryption.js`
is that owner now; the crypto primitives moved there out of `client.js`, which
had kept them private, and both callers ask rather than decide. A policy over
`@hashed` or `@encrypted(deterministic: true)` answers on every operation that
compiles to a WHERE — verified with rows on **both** sides of the predicate,
across read, update, delete and create.

**The startup refusal narrowed from a field to a shape.** It used to refuse the
presence of an encrypted field in any policy, which took the two modes that work
down with the one that does not. It now names which shape has no answer: plain
`@encrypted` (a random IV, so nothing can be encoded to match it), any operator
but `==`/`!=`, and a column compared to a column.

**Two ops are not WHEREs and had to be decided separately.** `create` is
evaluated in JS against the data as written — plaintext, so every form works,
and it is exempt. `post-update` is evaluated in JS against the row read *back*,
where the column is `@guarded(all)` and stripped, so it would compare against
`undefined` and roll back every write: refused at startup, which is new.

Drives: litestone's own suite, `example`: `verify`, `basecamp`: `verify`,
`sierra`: `test:safety`, then `bun run ci`. **CI was red on something else** —
`packages/basecamp` sat in `knownTestFailures` for `FJS-177`, which was fixed
earlier the same day, and a stale allowance is a failure by CI's own rule. Entry
removed; that is the only change here outside litestone.

---

## A bulk write that walked past the state machine (2026-08-14)

**`FJS-044` was filed as an ergonomics gap and was not one.** The row said bulk
partial success is creates-only — patch and remove answer `{ count }` while
create answers `{ data, errors }`. True, and the smaller half.

**Litestone does not enforce `@@transitions` on `updateMany`.** That is
deliberate on its side: a power tool whose caller "takes responsibility", with a
note in the source saying to loop `update()` where transition safety matters.
Junction's bulk patch called `updateMany` directly, so nobody took it. Verified
through a real service over a real client before changing anything:

```
PATCH /orders/1            {status:'shipped'}  → TransitionViolationError
PATCH /orders?status=draft {status:'shipped'}  → {"count":2}, both rows written
```

Same forbidden move, reachable over HTTP by anyone on a service with
`allowBulk: true`. `@version` was the same shape — bumped by a bulk write, never
required — so optimistic concurrency was off for the writes touching the most
rows. Gate and row policy were fine on the bulk path, and `removeMany` cascaded
correctly; those were checked rather than assumed.

Both holes are properties of `update()`, so calling it per row closes them —
and calling it per row is also what produces a per-row outcome. One change, two
reasons, which is what decided the `FJS-D11` ruling against the "scope partial
success to creates" alternative.

**Three consequences worth knowing before you touch a bulk service.**
`bulkMax` (default 1000) refuses a filter matching more, before any write —
that is the one place this can break a working app, since a filter matching 50k
rows used to be one statement. Only rows the caller can READ are touched now,
because selecting the targets applies the read policy. And a caller-supplied
`@version` on a bulk patch is refused by name: one value cannot be right for N
rows, so each row is written against the version selected with it.

**The third filtered write had never worked.** Asking what `restore` does with a
filter found `table.restoreMany({ where })` — a function a Litestone table does
not have. `LitestoneTable` declared it, so nothing typed the mistake, and every
`PUT /{service}?filter` was a 500 for the life of the method (`FJS-245`).
`restore({ where })` already takes a multi-row where and answers rows, so the
fix is one call.

**No app in this repo sets `allowBulk`**, which is why no drive has ever
exercised any of it and why the 15 tests are the whole proof. If you want the
HTTP path covered, that is the gap.

**Two register notes.** `FJS-243` collided — another session claimed it for a
litestream row while my `$transaction` row already held it, so **mine is now
`FJS-244`** and all seven references moved with it; theirs was left untouched.
And I overwrote `tests/bulk-partial-success.test.ts` with `Write` without
noticing it was tracked — recovered from `HEAD`, confirmed by the test count
returning to exactly 1025, and my tests appended to it instead. **Check `git
status` before `Write`ing a test file whose name you guessed.**

---

## A commit scope, and the transaction bug underneath it (2026-08-14)

**`transactional: true` on a service** wraps the whole pipeline — before hooks,
the method, the after hooks — in one `$transaction`, so a later `after` hook
throwing rolls the write back instead of leaving a committed row behind a
rejected response. `FJS-089`'s write half.

`around` is the only phase that reaches the after hooks; that is the entire
reason this is a commit scope and not a longer before hook. Two orderings carry
it and both already held: `withLitestoneDb` is an APP-level around hook so it
runs OUTSIDE this one (the transaction opens on the caller-scoped client, so row
policies and `auth()` survive), and the announcement happens after `runPipeline`,
so the write lock is released before anything fans out to a socket.

**Planning found a blocker underneath it, and it was the bigger half.**
`$transaction` treated a CONCURRENT caller as a nested one: the depth counter is
per client, one connection holds one transaction, so a second request arriving
while the first awaited took a SAVEPOINT inside it, was told it committed, and
lost its rows to the first request's rollback (`FJS-244`). Reproduced before
fixing. Latent only because few call sites use `$transaction` — but
`transactional:` opens one on every mutating request, which would have made it
the normal path.

The fix asks the **async context**, not the counter: an `AsyncLocalStorage` holds
the txStates the current context owns, so a nested call still SAVEPOINTs and
anything else waits on a FIFO lock. Both directions are load-bearing —
serialising everything deadlocks basecamp's `/setup` four models deep, nesting
everything is the original bug. `tx.wrap` (the sync batch wrapper behind
`createMany`) had the same hole and now awaits the acquire with its body still
sync.

**Two things worth carrying forward:**

- **What this does NOT do.** A transaction rolls back rows, not SMTP. An email an
  earlier `after` hook sent stays sent. `FJS-089` stays open for that, and the
  route is the transactional outbox — turn the effect into a row, which this can
  already roll back. The open decision is where that table lives: Caravan's queue
  is its own SQLite file, so `app.jobs.dispatch()` from a hook buys retries and
  **not** atomicity. Putting it in the app's own database — a schema fragment,
  the way auth contributes `User`/`Session` — is what would make them one
  transaction.
- **The cost, which is why it is off by default.** `BEGIN IMMEDIATE` holds
  SQLite's single write lock for the whole pipeline including the after hooks, so
  one `after` hook doing network I/O serialises every write in the app.

**Also:** `createBaseService` dropped a `transactional` declaration, so a service
written with the base factory and spread through the autoloader declared a
transaction nobody opened — the same silence that once made `methods:` do nothing
through that factory. Found by a test that counted the opens rather than checking
the outcome, because a doubled scope would still have been *correct*.

**Note for whoever is next:** another session was writing to `ISSUES.md` during
this work — ids 237-243 were claimed mid-session, so this row is `FJS-244`. Check
the highest id immediately before filing, not at the start of a session.

## Registered twice, and one accessor that grew a limiter (2026-08-13)

Three Junction rows, all one shape: **something duplicated, and nothing said so.**

**`FJS-225` — a route could be registered twice.** Which copy survived depended
on something the caller cannot see: a FIXED path is written into a map by
`build()` so the LAST registration won, while a DYNAMIC one is pushed onto a list
`lookup()` scans in order, so the FIRST won and the later handler never ran. Same
mistake, opposite outcome, decided by whether the path has a parameter.
`Router.add()` now refuses at registration, keyed on the route's SHAPE — `/a/{id}`
and `/a/{name}` accept the same requests and differ only in a name nothing that
matches reads. Watch the encoding: `{}` is a legal static segment
(`PARAM_PATTERN` needs a character between the braces), so a placeholder spelt
`{}` made `/a/{}` collide with `/a/{id}`. Segments carry a type tag now.

**`FJS-045` — `channel:` plus the `publish()` hook broadcast twice.** The
register's remedy was *"grep before merging"*. Verified unrealised first: 17
basecamp services use the hook and none also declares `channel:`. The check lives
in `svc.pipelines()`, which is the only place the FULL effective chain is known —
so an app-level `after: { all: [publish(…)] }`, the shape that doubles a whole app
at once, is caught too. It matches **marked** hooks, never names: an app may call
its own hook `publish`, and suppressing a real one on a name collision would
silently stop broadcasting, which is the defect inverted.

**`FJS-017` — three rate limiters.** The row read as *merge middleware and
hooks*, which `FJS-D01` refused. It is not that: it names three concrete
symptoms. `rateLimit` took `limit`/`keyFn`/`window: 60_000`, `rateLimitHook` took
`max`/`key`/`window: '15 minutes'`, and `@frontierjs/auth` carried a third —
whose comment justified the fork with *"ServiceContext, which has
`ctx.params.ip`"*. **A ServiceContext has no `params` at all.** The real gap was
one accessor, and the copy had already drifted: it returned before comparing on a
fresh bucket, so `max: 0` let one request through.

`core/rate-limit.ts` owns counting, the window, the sweep, the teardown and the
refusal; the three call sites are adapters. `clientIp(ctx)` reads either context
shape. The transport tier keeps `x-ratelimit-*` and stays a separate tier on
purpose — it counts a flood that never reaches a service, which a pipeline hook
cannot see. Old option names **throw**: a silently dropped `limit:` leaves `max`
undefined, and `count > undefined` is never true, so the limiter would accept
everything and say nothing.

**If you pick this up:** the three closures added 23 tests and lowered the
typecheck baseline 199 → 198. Junction's open list is now `FJS-010` (blocked on
`FJS-D04`), `018`, `034`, `089` (ruled defer-and-document), `044`, `046`, `047`.

## The service split — FJS-D01 ruled and executed (2026-08-13)

**Ruled: go on the definition/compiled split only.** Export tiering (`FJS-046`)
and the middleware/hook renaming (`FJS-017`) were in the original proposal and
are refused — they stay open on their own merits. Inline action keys are
supported permanently; **no app was migrated** (56 basecamp actions, 7 in the
examples, all untouched and all still passing).

The shape came from reading Feathers 5 (Dove) source rather than memory, and the
adaptation is written up in `DECISIONS.md` § API design. The user's call, and the
better one: **`methods:` becomes the declaration site** rather than inventing an
`actions: {}` block — Junction already had the key, it was just being validated
*against* a scan instead of being believed.

**Phase 0 — a bug found while planning (`FJS-231`).** Every autoloaded
`createBaseService` service ran its `@@gate` and its validator **twice per
request**: a base returns the MERGED hook map, the autoloader spreads a base back
through `createService`, and the second pass appended the derived layer again.
Nothing caught it because nothing was wrong on the wire — the symptom was cost.
Fixed by marking the four derived hooks (a WeakSet, invisible to a spread) and
skipping one already present. Marked, never matched by name: a user hook called
`gateAuth` is not ours, and letting it suppress the real one is fail-open.

**Phase 1 — one parse step.** `collectActions` runs at construction into
`_actions`; dispatch, `/manifest`, OpenAPI and `/metrics` read the table instead
of six consumers re-applying the deny-list rule. `Service` lost its index
signature (`ServiceDefinition` keeps it — you *write* actions there), which took
the baseline **211 → 201** on one line: `keyof Service` was `string | number`, so
`Omit<Service, …>` collapsed and every `base.find` read as `unknown`.

**Phase 2 — one owner for the pipeline.** `pipelines(appHooks)` memoised on the
app map's identity and a version `hooks()` bumps. Deleted: `_pipelines`,
`_compiledPipelines`, its hand invalidation, four writers, the registry's
`hooks()` monkey-patch, and the ladder in `callService` where the cache
**outranked the app hooks the transport had just passed**. A call now always runs
the hooks it was handed — the inverted test is the point of the phase.

**Phase 3 — `describe()` and the marker.** One answer to *what is this service*,
so three readers stopped reaching into `_meta`/`_schemas`/`_hookMap`.
`Symbol.for('junction.service')` replaces the loader's `typeof hooks !== 'function'`
discriminant; non-enumerable, so a spread copy is correctly seen as unbuilt.
Baseline **201 → 199**.

**Phase 4a — scaffolds.** Deliberately did NOT emit a `methods:` list into the
CRUD-only scaffold: it would be identical to the default and would 405 the first
action someone added without updating it. What shipped is the useful half — the
scaffold comment shows the declaration form, and `fli`'s service parser reads
`methods:` first, which is the only form that can see an action assigned from a
module-level const (`refund: move('refund')` was invisible to it).

**Deviation worth knowing:** the plan said Phase 3 drops the dispatch fallback
for an action attached AFTER construction. It stays, with its one-time warn. It
costs one property read on a path that already missed the table, and it turns a
breaking 404 into a warned upgrade for anyone doing that outside this repo.

Verified: junction 991 · testing 23 · conduit 193 · auth 88 · cli 363+25 ·
typecheck 199 (ratcheted twice) · `ci:fast` · `example` verify 37 / live 14 /
jobs 8 · `basecamp` verify 271/271 — the last three re-run after Phase 3, not
carried over from Phase 1.

**Still open here:** `FJS-034` is now a corrected row — 199 errors, of which the
bulk is tests and examples, not `service.ts`. `FJS-046` and `FJS-017` were
untouched by the ruling; `FJS-017` has since closed on its own terms (see the
rate-limiter section), doing none of what the ruling refused.

---

## Three things you could not ask Junction for (2026-08-13)

Same session as the batch below, second half. All additive, no rulings needed.

**`populate` on the browser client** (`FJS-084`). The wire and the server had
supported `$populate` from the start; the client had no way to say it, so a
component could not declare its own data shape. Both builders emit it now — the
query string and the WS frame, because the client prefers the socket whenever
one is up. **A by-id `get` carries `params` too**; they were accepted and
dropped on that path, which is the shape a detail page wants most. Sierra needed
no code change, only docs — `findParams` was already threaded.

**`buildRoutes(app)` + `fli api:routes`** (`FJS-091`). `routePaths()` existed
and nothing assembled it. The surface is emergent, so it reads the router rather
than the registry, splits `service` from `raw`, and rides `/manifest`.
**`manifestPlugin()` is now configured in `example/` and in `fli new`'s
scaffold** — a command about a plugin nobody configures is not a command.

That last one paid for itself on its first run: `fli api:routes` against a
freshly scaffolded app printed `OPTIONS /*` **twice**. The scaffold configured
CORS by hand *and* through `config.http.cors`, so every FJS app has been running
doubled CORS middleware since the config path started working. Scaffold fixed;
The framework half — a second registration of the same route was silent, and
which copy survived depended on whether the path had a param — was `FJS-225`,
**closed 2026-08-13**: `Router.add()` refuses a duplicate by name at registration,
keyed on the route's shape rather than its literal path.

**`IEventBus.stats()`** (`FJS-143`). `{ events, total }`. Basecamp's hub card
stated the gap on the screen; it prints the number now.

**`FJS-089` was ruled defer-and-document**: `after` means after the METHOD, not
after the call succeeded. README and the package file say so, with the two
workarounds. The row stays open for the phase itself.

Verified: junction 959 pass / typecheck at baseline, cli 363+25, sierra 832,
`ci:fast` green, `example`: `verify` 37, `verify:live` 14, `verify:jobs` 8,
`basecamp`: `verify` 271/271 (270 + the subscriber count, which replaced the
check that asserted the card's *we cannot measure this* copy), plus
`fli api:routes` run against both a scaffolded app and `example`.

**`FJS-D01` was unruled at the time of writing** — ruled and executed later the
same day, see the entry above. The measurement stands and is why the register's
claim needed correcting: of junction's 211 typecheck errors, **137 were in
`tests/` and `example/`, 72 in `src/`**, and only 8 were the
`unknown`-not-assignable shape. The refactor was worth doing on design grounds,
not to move that number.

---

## Junction's three silent declarations (2026-08-13)

`FJS-012`, `FJS-013` and `FJS-088` closed together because they are one shape:
something Junction declares, reads as handled, and does not do.

**`apiPrefix` has one owner now** — the `app.get`/`post`/`put`/`patch`/`delete`
shortcuts. It used to be applied by `registerServiceRoutes` alone, so a plugin's
route stayed at the root while the services beside it moved; four plugins in
junction hand-resolved `app.config.apiPrefix` to compensate, and
`@frontierjs/auth`, being another package, did not. An app with
`apiPrefix: '/api'` therefore served its login at `/auth` while the browser
client looked under the prefix. The four copies are deleted,
`registerServiceRoutes` registers bare `/{service}` paths, and `app.http.router`
is the escape for a path that must not move.

**This moves paths in every app that sets a prefix, which is the fix, not
fallout.** `example` now serves `/api/auth/login`, `/api/session`, `/api/jobs`
and `/api/health`; its vite proxy went from four entries to one, and `fli new`'s
scaffold and caravan's `CLAUDE.md` both said the old thing. If a drive suddenly
404s on a path you remember, that is this.

**An `Idempotency-Key` executes once.** It was parsed into request metadata and
consumed by nothing. `core/idempotency.ts` claims it in `callService` — the one
path every transport takes — so a repeat replays the first answer and runs no
hooks. Keyed by `(service, method, principal, key)` because replay skips the
pipeline and therefore the auth in it. A failed call releases the key; an
in-flight duplicate is a **retryable** 409; the in-flight marker has its own
2-minute TTL so a throw between claim and settle cannot lock a caller out for a
day.

**Found while doing it: the WS path established no request metadata at all.**
It wrapped nothing in `runWithMeta`, so `requestMeta()` was `undefined` for every
socket call — the correlation id was as HTTP-only as the key. Both now ride the
frame's `meta`. That is the hazard the package file already warns about (the two
transports build their context separately and a difference is silent) showing up
in a third place.

**A model service with no field rules says so** — `autoValidate` stored `null`
for a `$defs` miss and for a definition that would not compile, and warned on
neither. It warns once per model now, but only when the accessor resolves to a
real table: a service with no model is a supported shape, and `getTable` already
names every spelling when someone calls an unused CRUD method on one.

Verified by running: junction 942 pass / typecheck at baseline, auth 88,
caravan 79, sierra 832, testing 23, `bun run ci:fast` green, `basecamp: verify`
270/270, and all six `example` drives — `verify` 37, `verify:build` 37,
`verify:ui` 27, `verify:live` 14, `verify:jobs` 8, `verify:notify` 9,
`verify:public` 21 — against a **restarted** API, since a dev server serves the
code it started with.

One thing worth knowing for the next person: a single failing test in
`tests/client.test.ts` took 25 unrelated tests down with it in the full-suite
run, across three other files that bind fixed ports. Alone they all passed. Not
chased, not filed — but a red suite here may be one real failure wearing 26
faces.

---

## `fli check` — architecture rules, and a dead production build (2026-08-12)

Ten rules in `packages/cli/core/checks.js`. `fli check` runs them against a
client app; `scripts/ci.mjs` imports the same module by relative path and runs it
as a new **`structure` phase** (CI is six phases now, not five). One engine on
purpose — two implementations of one rule is how a framework ends up breaking
rules it publishes.

**The membership test is that a violation is SILENT**, which is sharper than
"greppable" and threw out half the candidates: *no TS in a JS package* is loud
the moment anything runs. What survived is half invariants no compiler enforces
(model names, `src/resources/`, resource filenames, one Resource per file) and
half hazards with no invariant at all — and the second half earned its place
immediately.

**`FJS-198`: `packages/sierra/example`'s production build shipped no JavaScript
and no CSS.** The `index.html` explained in a comment that the theme goes on the
body tag; vite injects the built `<script>` at the first TEXTUAL match and does
not skip comments, so the script and the stylesheet both landed *inside* the
comment. The build succeeded, the file looked right, the page was inert. The
hazard is documented in the root `CLAUDE.md` and the repo's own example was the
thing violating it — which is the whole argument for checking a rule rather than
writing it down. Fixed and rebuilt; the tags now land outside the comment.

Also found and fixed: `resources/leads.mesa` (lowercase, three Resources in one
file) split into `Lead.mesa` / `Account.mesa` / `Tag.mesa`, and `ui/IDEAS.md`
moved to `ui/docs/`.

**The two false positives became rules**, which is the more useful half of a
first run. A Resource over no model may take its own service noun singularised —
basecamp's `Hub.mesa` is `createResource('hub')` and is correct. A schema with
neither `api/` nor `web/` beside it is a fixture, not an app that got the layout
wrong. A check that scolds every fixture in a repo is a check people turn off.

**No ignore comment.** An exception is a named entry with a reason in
`ci-allowances.json` under `structure`, keyed `'<rule>:<path>'`, and a stale one
is reported. The one live entry is `packages/css/AGENTS.md` — a fifth root
markdown file that is the same *kind* of thing as `CLAUDE.md`. **Whether
Invariant 17 grows to name `AGENTS.md` is an open ruling**, deliberately left as
an allowance rather than a quiet edit to the invariant.

**Not mine, and left alone:** `bun run ci`'s coverage phase fails on
`packages/datetime-kit`, which is exempt as *claimed, not built* and now has an
untracked `package.json`, `src/` and `test/`. Another session is building it; the
exemption is theirs to remove when it lands.

## Testing realm — Phase 5's transport parity (2026-08-12)

`env.verifyTransportParity()` in `@frontierjs/testing`. `listen: true` binds a
real port — asked for as 0 and read back, so parallel suites cannot collide — and
the runner puts the same call down HTTP and WS under the same principal and
compares the answers. Calls default to every CRUD method of every service
registered with a `model:`, fixtures from litestone's new `sampleWrites`, plus a
`$limit`-bearing find because directives reach the two transports by different
routes.

**The oracle is two real transports.** Same shape as `verifyRowPolicies` grading
`compileSql` against `evalJs`, and there is genuinely nothing shared to collapse
into: HTTP goes URL → router → `bridge.toContext()`, WS goes frame → `channels()`
→ `bridge.internal()`. Neither side restates what the answer should be, so a
mismatch names both and a person decides which is the bug.

**Two junction defects on the first two runs**, which is the argument for the
category. `FJS-196` — any status junction has no error class for arrived as a
500, so a deliberate 423 paged someone. `FJS-197` — `ctx.id` was a string over
HTTP (a path segment can be nothing else) and whatever JSON type the client sent
over the socket, so a handler comparing it to a row's id was correct in dev and
wrong in production, or the reverse, depending on whether a socket was up.

**What the build settled, all three found by running it:**

- **A derived check that cannot connect must say so.** The browser client falls
  back to HTTP when no socket is live, so an app without `channels()` would have
  been HTTP compared against HTTP — agreement on everything, certifying a
  transport never spoken to. Reported as a row. So is an empty call list.
- **Volatility is measured, not named**, and the WS attempt goes BETWEEN the two
  HTTP ones. Two back-to-back calls can land in the same millisecond, mark
  `deletedAt` stable, and then the third lands a millisecond later and reads as a
  transport difference. Bracketing means the HTTP pair spans at least as much
  time as the HTTP↔WS gap does.
- **Port claiming (Phase 2's open item) is answered differently than planned** —
  port 0 cannot collide at all, where the broker only makes a collision less
  likely. `listen: <number>` is the door for a port something external was told
  about in advance.

Also here: the **Bridge index triage** that sizes the rest of Phase 5 —
`IDEAS/testing-realm.md` § The triage. About eleven of the ~30 entries are
boundaries in Rainsberger's sense; two are now built; the top four are hand
copies or lookup tables, which are the cheapest pairs to generate.

Verified: `bun run ci` green; `@frontierjs/testing` 23 tests; junction 925;
litestone 1695. Sabotaged the server back to reading `params` instead of `meta`
— the defect that motivated this — and got 15 rows across three principals,
naming the bulk-write refusal and the lost `$limit`.

Not done: the parity runner has never been pointed at `example` or `basecamp`.
Both build their app at module scope and start it on import, so neither can be
handed a test env's client without restructuring — worth doing, and it is where
the next real findings are.

---

## Next — the other 36 models (2026-08-10)

`Server` declares `@@allow('all', workspaceId == auth().workspaceId)` and holds.
The rest is repetition with an audit in front of each one, and the audit is the
part that matters: **a gate refuses, a policy filters**, so a read that
legitimately crosses a workspace and is not `asSystem()` returns nothing with a
200. For `Server` that audit came out clean — the three engines, the hub and the
agent's heartbeat were already system paths. The next model may not be.

Do them one at a time with `bun run verify` between. Two shapes to look at
before each: **who reads this model without a workspace** (grep the service for
`asSystem`), and **which parent includes it**, now that an include really does
apply the child's rules.

`Volume` and `ServerEvent` are the interesting pair, because neither carries a
`workspaceId` — their tenancy is the join to `Server`, and `check(server)` is
the policy expression for exactly that. Worth doing early: it is the shape most
of the remaining models are not, and it will say whether `check()` through a
belongsTo is enough.

**Still unruled**: `/metrics` is unauthenticated (`healthPlugin` got no token),
so the service registry and every action name is world-readable. Untouched
again this session because the drives and any external probe read it — it wants
a decision, not a quiet edit.

**Not run this session: `example`'s browser drives.** A `bun run api` from
another session has held :3600 since 03:50 (11h54m at the time of writing) and
serves pre-change code; killing it is not mine to do, and probing it would have
proved the old build. If you can clear that port, `example`: `verify` +
`verify:public` are the two the litestone read-path change most deserves.

---

## Session — the reactivity registry closed itself, and the replacement was quieter than the bug (2026-08-10)

`FJS-060`. The record said *hand-maintained cross-package registry, nothing
validates it*. Two thirds of that was already stale — a drift test existed, and
the map was down to **one entry**: `theme`, in two spellings, which nothing in
the repo read. The router's eight signals had become the plain object `page` and
junction's two had become `status`.

So it closed by finishing: `theme` is `{ value }` written through `watchProxy`,
`mesa-plugin.js` passes **no map**, and `tests/external-signals.test.js` is
replaced by `tests/no-module-signals.test.js`, which asserts the stronger thing —
`src/` exports no module-level signal and the plugin declares none. Breaking:
`theme.get()` → `theme.value`, zero consumers here.

**The finding worth keeping is the other half.** Plain-object state has the
*identical* silent failure — `{page.path}` with no `$:` watch is hoisted out of
the render block and assigned once at mount, exactly as a missed signal rewrite
was — and by default it was **quieter than what it replaced**. Mesa's path tier
reports an uncovered read only when the file already watches some other path on
the same import; it says nothing about a component that watches *nothing*, and
that is the shape the `connected` bug had. `externalReactivityHints: 'strict'`
covers it, existed already, was opt-in, and **nothing anywhere turned it on**.
Sierra's plugin does now.

Measured before finishing: 4 warnings over 97 app components — all
`resource.gate.<method>`, a level number the schema fixes, now `var` snapshots
(RULE 13 exists to say exactly that). After: **0 over all 218 `.mesa` in the
repo**. Strict is free, which is the argument for leaving it on.

Verified: sierra 832 + `test:safety` 5, mesa 1078, and in a browser `example`
`verify` 37, `verify:build` 37, `verify:public` 21.

**Next, if anyone wants it:** jetty's own mesa plugin forwards an empty
`externalSignals` and does not pass strict. Left alone deliberately — this row
was Sierra's — but the reason for strict is a Mesa-level truth, not a Sierra one.

---

## Session — two Mesa features the docs described and the compiler did not have (2026-08-10)

`FJS-023` and `FJS-087`, both closed. They are one bug wearing two hats: **the
compiler's answer to "I do not handle this" was to emit nothing and say
nothing**, so in both cases the build stayed green and the failure arrived at a
user.

**`export function` was deleted from the output** while every reference to it
survived. A component calling its own exported function from its template threw
`ReferenceError` on the first click — and **no render test can catch that**,
because SSR dispatches no events, so the component renders perfectly. Four kit
form controls declared `export function focus()` and none of them had one.
Fixed by emitting the declaration (assignments rewritten through the signal
setters, like any other function body) plus one `registerExports({…})`.

**`bind:this` on a component handed over the anchor** — a comment node — where
VISION §10.2 promises the exported interface. Now `componentApi(anchor)`:
methods, plus props as accessors onto the child's own signals, so `ref.count` is
live rather than a snapshot and `ref.count = 2` writes it. The element form is
untouched. Nothing in the repo was using the component form, which is why a
comment node satisfied it for as long as it existed.

**`<mesa:element this={tag}>` exists.** A tag cannot be interpolated into a
template string — the string is parsed once and the parse decides the element —
so it compiles under the placeholder `mesa-dynamic-element` and
`$runtime.dynamicElement` transplants attributes and children onto the real
one. Every directive works because the ordinary element path runs over the
placeholder first. In a `keyBlock`, because a tag is not writable. One limit:
a **tag selector** in a scoped `<style>` cannot match it.

**The silence around it was the larger half**, and it covered the whole `mesa:`
namespace: an unknown name dropped the element and all its children. It now
errors listing the eight that exist. That is what made `<mesa:element>`
indistinguishable from a typo for as long as it was missing.

Proven where the two halves fail apart: mesa 1078 (+26 new), sierra 833,
ui 64 compile / 27 render / 60 attributes / 7 form, email-kit 34, and in a
browser — `example` `verify` 37, `verify:ui` 27, `verify:public` 21. Every one
of the 26 new assertions either calls a method or reads a prop back after a
mutation, because that is the only kind that could have failed.

**A trap found on the way, not fixed**: `example`'s `bun run build:public`
REWRITES `web/config/routes.js` with the public-site-only tree and leaves it
there, so a dev server started afterwards serves an app with no `/` route and
`verify:ui` dies as "the shell never appeared". `git checkout` the file and
restart the server. Filed as `FJS-168`.

---

## Session — Mesa support was one commented-out line and three landmines (2026-08-10)

```
frontierjs-vscode    npm test 34 + 36 + 6 · typecheck clean · verify:package all green
```

`FJS-008b` closed. `startMesaClient` is called from `extension.ts` and `.mesa`
files get hover, completions, the outline and compiler diagnostics — plain
vscode providers, no second server. **Uncommenting the line was never the fix**:
each of the three blockers ships an extension that fails where nothing watches.

- **The providers are plain JS and tsc emitted none of them** — no `allowJs`, so
  `require('./hover')` threw at activation. They are `import`ed now as well:
  esbuild leaves a computed require alone, so the bundled `.vsix` would have
  shipped without them and thrown on the first hover, in the marketplace.
- **The compiler resolver hunted `@mesa/compiler/compiler.js`**, a name from
  before the rename. It probes `@frontierjs/mesa`'s `src/compiler.js` in
  node_modules, a `packages/mesa` above the edited file, `mesa.compilerPath`
  (file or package directory), and a sibling of `context.extensionPath` —
  which had to replace `__dirname`, since that is `out/` in the bundle and
  `out/mesa/` in the tsc output.
- **`await import(p)` cannot load it.** tsc under `module: commonjs` rewrites it
  into a `require()`, and `require()` of mesa's ESM throws in the extension host.
  It is loaded through `new Function('specifier', 'return import(specifier)')`
  so neither compiler can see the specifier. This one is the dangerous shape: it
  fails as *no diagnostics*, which looks like a clean file.

The compiler is the workspace's own and is never shipped — without one, the other
four features still work and the extension says so once.

**`test/mesa.test.js` — 36 assertions over the built output.** There is no
protocol to drive these providers over, so `test/vscode-stub.js` stands in for
the editor; the compiler is the real one, because a fake compiler resolves
happily and resolution was the defect. It covers all five resolution routes and
the none-found prompt, an analysis error and a `compile()` that throws, the
debounce, and each provider. Mutation-checked: dropping `allowJs` reproduces
`Cannot find module './hover'`, and restoring the plain `await import(p)` turns
every resolution case red. `verify:package` runs it against the unpacked `.vsix`
and asserts the providers and the opaque import survived bundling.

Writing it found one more: a diagnostic's range came from matching a declared
variable on a word boundary anywhere in the message, so
`bind:group={missing} — 'missing' must be a top-level let variable` underlined
`let a = 1` — "must be a top-level" contains a standalone `a`. Only a quoted
name names a variable now.

**Running it in a dev host found `FJS-156`, which no suite could have.** Two
Mesa snippets wrote `$onCleanup` and `$class` unescaped in their BODY, where
`$name` is a VS Code snippet *variable* — an unknown one expands to nothing, so
the snippets inserted `(() => { })` and `export let  = ''`. The editor says so
once, in the extension host log, naming neither snippet nor file:
*"very likely confuse snippet-variables and snippet-placeholders"*.
`test/snippets.test.js` now walks every body of both languages; a `$` must be
escaped, a tabstop or one of the 33 real variables, and a `prefix` is exempt
because it is typed rather than expanded.

**The third blocker was outside the repo** and is gone: two copies of an older
`mesa-language-support` extension (publishers `frontierjs` and
`your-publisher-name`) sat in `~/.vscode/extensions` contributing the same
`mesa` language id, along with a stale `undefined_publisher` build of this
extension. Removed by hand. A dev host shows what is INSTALLED, so check that
directory before concluding anything about this tree.

---

## Session — eleven packages prepped to publish, and two were broken (2026-08-10)

```
prepped   mesa utils sierra auth caravan conduit notifications ui email-kit jetty cli
verified  every declared export imported from an INSTALLED copy, each package ALONE
suites    mesa 1052 · sierra 833 · email-kit 34 · utils 15 · ui 64/64 — unchanged
```

All eleven got the four things junction needed — `publishConfig.access`
(a scoped package's first publish otherwise fails on *payment*), a `files` field
written from what each entry point actually reaches, a `LICENSE` for the MIT
every manifest already claimed, and `repository` + `directory`.

**Two of them would have shipped broken, and the same probe found both.**

- **mesa** had `happy-dom` in `devDependencies` while `src/render.js` and
  `src/css-inliner.js` import it at the top level. Six specifiers dead on
  arrival. Now a dependency.
- **sierra** had **no `peerDependencies` at all**, while five shipped files
  statically import `@frontierjs/mesa/runtime` and one imports
  `@frontierjs/junction/client`. `@frontierjs/sierra/router` — the main path —
  would throw. mesa is now a **required peer**, deliberately not a dependency:
  two copies of the reactive runtime are two signal graphs and nothing says so.
  junction, litestone and vite are optional peers, all three genuinely
  `await import`ed (litestone resolves from the APP on purpose).

**The method is the transferable part. A probe that installs the family together
cannot see either bug** — the missing package is present because a sibling
pulled it in. Both only appear when the package is installed ALONE. That is the
same failure as auth's `../junction` imports wearing a different hat: correct by
adjacency, broken on arrival. Install one package into an empty project and
import every subpath its own `exports` declares.

The static scan that found them has one trap worth knowing: `import('vite').Plugin`
in a JSDoc `@returns` and `import x from 'y'` inside a doc comment both look
exactly like real imports. Strip comments first or roughly half the hits are
phantom — of 16 candidates, 11 were prose.

**Publish order, because one package gates three.** mesa is a leaf and
`sierra`, `ui` and `email-kit` all peer on it — they now *refuse to install*
until it exists, which is the improvement. Wave 1: **mesa**, utils, auth,
caravan, conduit, notifications, jetty. Wave 2 (needs mesa): **sierra**, **ui**,
**email-kit**. `cli` is separate — it is already on npm at `0.0.0-beta.0` while
the tree says 0.1.0, so it is a re-release and the version bump is a human's
call. Never: basecamp and both `example`s are `private`, and
`frontierjs-vscode` goes to the VS Code marketplace.

## Session — junction is on npm, and it is Bun-only for good (2026-08-10)

```
packages/junction    919 tests unchanged · 29/29 subpath exports import from the
                     INSTALLED copy · @frontierjs/junction@0.1.0 live, tag latest
```

No code changed. Four manifest gaps, each failing at a different moment:

- **`publishConfig.access: "public"`.** A scoped package defaults to restricted,
  so the FIRST publish under `@frontierjs/*` fails on *payment* — an error that
  says nothing about the package. This is the one that would have wasted an hour.
- **`files`** — 131 files / 464 kB, carrying `tests/`, `example/`, `bun.lock`,
  `tsconfig.json` and all three state markdowns. Now 64 / 281 kB. `tools/` ships
  because the bin loads `init.ts`/`setup.ts`/`repl.ts`/`build-app.ts` beside it;
  the seven `check-*.mjs` repo audits are negated out.
- **`LICENSE`** — the manifest claimed MIT with no file.
- **`repository` + `directory`.**

**The decision underneath it: it ships raw TypeScript, and that is correct.**
Node refuses to strip types inside `node_modules` — a policy, not a version
gap — so `import '@frontierjs/junction'` fails there outright. Compiling would
not buy Node support, only move the failure later: the transport is `Bun.serve`,
logging and static files are `Bun.file`, cache and database import `bun:sqlite`.
So the honest move was to say so rather than build a dist. The README's Quick
start used to open `git clone <this repo>` — the wrong first sentence for
someone arriving from npm — and now opens with `bun add` and the Bun-only
paragraph.

**Verified against the artefact.** Every one of the 29 declared subpath exports
imports from an installed copy; `/auth` answers zero runtime exports, which is
correct because it is types-only. The `junction` bin runs from
`node_modules/.bin`. Then the thing this was for: `bun add` of the auth tarball
into an empty project resolves `@frontierjs/junction@^0.1.0` **from the
registry** and imports — the same command that 404'd before publish.

**`npm publish` needs a 2FA OTP**, which is on a human's authenticator. Prep,
dry-run and verification are all automatable; the publish itself is not.

**Publishing a package makes every loose peer range on it go quiet, and that is
the part to check after the next one too.** While `@frontierjs/junction` was a
404, a peer of `"*"` or `>=0.1.0` failed at install — loudly, with a name in the
error. The moment it existed, those same ranges resolved to 0.1.0 from the
registry without a word, and would keep resolving through a future 2.0. Five
were tightened to `^0.1.0` (caret pins the minor below 1.0, which is the
behaviour wanted here): notifications and jetty were bare `*`, caravan and
conduit were `>=0.1.0`. Nothing in the workspace had actually switched to the
published copy — every consumer pairs its peer with a `workspace:*` devDep, and
jetty's `file:` entry is a symlink — so this was about what an *outside* install
would resolve, which is exactly the surface publishing just created.

The audit found one unrelated live mismatch: **`@frontierjs/ui` declared
`@frontierjs/css: ^0.11.0` while css is 0.15.0** in the workspace and on npm.
Below 1.0 a caret pins the minor, so `^0.11.0` means `>=0.11.0 <0.12.0` — ui's
declared peer excluded both copies of the package it is built on. Nothing caught
it because ui resolves css by workspace and never by range. Now `^0.15.0`.
Verified by suite, not by reading: caravan 79, conduit 193, notifications 38,
auth 83, ui 64/64 + 26/26 + 60/60 + 7/7, jetty unchanged at its one known
`FJS-030` failure.

## Session — the extension packages, and the icon was the small half (2026-08-10)

```
frontierjs-vscode    npm test 34/34 · typecheck clean · npm run verify:package all green
```

`FJS-008c`, closed. The row said `icons/` does not exist and that it blocks
packaging only. Both true, and the icon was the cheaper half: `icons/` now holds
`frontierjs.svg` → `frontierjs.png` (128×128) plus `litestone-{light,dark}.svg`,
one family with `example/`'s favicon — three bars, middle one `#0d83dd`, which is
`--color-primary` from `@frontierjs/css`.

**With the icons in place `vsce package` still died** —
`invalid relative path: extension/../../.claude/settings.local.json`. bun installs
`vscode-languageclient` and the two server packages as **symlinks into the
workspace root's `.bun` store**, and vsce's dependency walk follows them above the
extension root. `--no-dependencies` packs in one second and ships an extension
whose first `require('vscode-languageclient/node')` throws — in the marketplace,
where nothing tests it. That is the failure the icon was hiding.

So `vscode:prepublish` bundles: `scripts/bundle.js` (esbuild, already a dep and
already bundling the parser) rewrites `out/extension.js` and
`out/litestone/server.js` as self-contained CJS. Two things stay out — `vscode`,
which the host provides, and `out/litestone/parser-bundle.js`, which `server.js`
require()s by a computed path and which must sit beside it.

**Proven against the artefact, not the tree.** `npm run verify:package` packs,
unpacks the `.vsix` into a temp dir with no `node_modules` above it, asserts every
icon `package.json` names is inside, asserts neither bundle bare-requires anything
unshipped, and then runs **all 34 LSP assertions against the unpacked server** —
`test/lsp.test.js` takes `FJS_LSP_SERVER` now, so one suite covers both copies.
The `.vsix` is 20 files, 292 KB. A `LICENSE`, a `.vscodeignore` and a README with
its stale *"npm run build fails"* banner removed came with it — that banner is the
marketplace page.

**Left open:** `vsce publish` needs a marketplace publisher account, and nothing
here can create one. `FJS-008b` (Mesa client switched off) is untouched — the
bundle does not reach it, since `startMesaClient` is still commented out.

---

## Session — auth was written as a folder, not as a package (2026-08-10)

```
packages/auth        83 tests unchanged · typecheck 4, unchanged (its baseline)
example              verify 37/37 · basecamp verify 270/270 (--reset)
```

`FJS-003`, closed. The row named three things and all three were the same
mistake: the package was written as a directory that happens to sit next to
junction, rather than as something that leaves the workspace.

**Eight imports of `../junction/index.ts`** across `auth.ts`, `plugin.ts`,
`types.ts`, `crypto.ts` and `cleanup.ts` — a path *out of the package root*.
Three of the eight are runtime values (`parseTtl`, `createScheduler`, the three
error classes), so an installed copy did not typecheck wrong, it threw on
import. They are now `@frontierjs/junction`. Worth knowing why this was only
ever auth's bug: conduit, caravan, notifications, basecamp and `sierra/example`
were all already writing the specifier, so **auth was the one package resolving
by adjacency**, and nothing in the repo could see it because adjacency held.

The peer range was `"*"` (now `^0.1.0`) and there was no `files` field (now
`["*.ts", "README.md"]`, a 10-file tarball rather than one carrying `tests/`
and the state docs).

**Proven the way the row asked**: `npm pack`, install the tarball into an empty
project, import it, build a plugin. Two things that probe teaches, neither
obvious from the diff:

- **`bun install` cannot satisfy a semver peer from a `file:` dep.** The probe
  404s on `@frontierjs/junction` even with junction's own tarball installed
  beside it — and it does that with `"*"` as the range too, so it is not the
  range. `npm install` resolves it from the tree and the import passes. Do not
  read that 404 as a regression.
- **auth's own side is done; the peer was junction's turn** — and junction was
  published the same day, so this is closed end to end. See the session below.

## Session — an include enforced nothing, and one model got a policy (2026-08-10)

```
packages/litestone   1480 tests (was 1462) · junction 919 · sierra 833 + 5 safety
packages/basecamp    verify 270/270 · 61 data tests (was 56) · typecheck 63, unchanged
```

The ask was `@@allow` on `Server`, one model, as the start of moving row-level
tenancy out of service where-clauses. The declaration is one line and it works.
Everything else here is what was found underneath it.

**The audit named in the last handoff was the `include:` graph, and the answer
was worse than the question.** The question was *does a policy on a child model
apply to a parent's include* — asked by probing rather than reading, and the
answer is that **nothing** did. Not the policy, not `@@gate`, not `@guarded`,
not a field `@allow`. A caller refused `Vault.findMany` by a level got the whole
table back as `team.secrets`, with the `@guarded(all)` column in plaintext and
the `@encrypted` one as raw ciphertext. `resolveIncludes()` builds its own SQL
below the query pipeline — which is why the soft-delete and `@@hasTemplates`
filters in it are hand-appended, and why the access rules, which nobody
hand-appended, were absent. 1462 tests and not one asked a policy question
through an include (`FJS-150`).

That is also the sentence that matters for the previous session's work: **the
gate the last handoff called landed was one join away from not being enforced
at all**, for a day, in an app whose whole tenancy model is nested.

Three fixes, because the three rules answer at different times. The gate is a
**preflight** in `GatePlugin.onBeforeRead`, walking `include:`, `select:` and
`_count`: `getLevel` is async and the include resolver is not, and a gate is per
model, so refusing by name beats returning an empty list that reads as *no rows*.
The row policy is compiled into all three relation SQL shapes and both `_count`
shapes — subqueried in the m2m branch, where the target is aliased beside the
join table and the policy compiler emits unqualified column names. The field
rules moved out of `makeTable`'s closure into `applyFieldPolicyTo(row,
modelName, …)`, because an include holds rows of a model that is not its own.

**The second defect only appears when a policied model has a Json column, and
`Server` has four.** `@@allow('post-update', …)` reverts a write that became
illegal once it landed, and it reverted from the `read()`-shaped snapshot —
where a Json column is an object, and a SQLite parameter cannot be one. So the
revert threw `Binding expected string, TypedArray, boolean, number, bigint or
null`, the `AccessDeniedError` never reached the caller, and **the write the
policy had just refused stayed in the database** (`FJS-151`). It reverts from
the raw row now; `beforeRow` stays read-shaped for the audit snapshot, which is
what wanted it that way.

**What the declaration itself needed was an audit, not a line.** Every read that
crosses a workspace has to be `asSystem()` before the policy exists, or it
silently filters to nothing — and here all of them already were, each with a
comment saying why. That is the only reason this was a one-liner, and it will
not be true of every model.

Five tests run the policy with **no service and no hook in the picture**
(`db/test/schema.test.ts`), which is the only arrangement that can tell a policy
from the where-clause the service was already writing: a caller reads one
workspace's servers with no `where` at all, naming another workspace's server by
id answers null, creating or moving one into another workspace is refused, and a
`Workspace` carries only its own servers through an `include`.

**A third defect came out of the probe schema rather than the app** (`FJS-152`,
also fixed). Implicit many-to-many only ever worked on models keyed `Int @id`
named `id`: the join table hardcoded `INTEGER … REFERENCES "<table>"("id")` and
six runtime sites read the target's key as the literal `.id`. A uuid key dies
loudly on the first connect; **a key named anything else fails silently**,
because join rows are written `INSERT OR IGNORE` and OR IGNORE swallows a NOT
NULL as happily as a duplicate — connect returns the row, writes nothing, and
the relation reads back empty. Nothing in the repo noticed because nothing here
uses the feature: `basecamp` writes an explicit join model all three times, and
`sierra/example`'s ids are `Int`.

---

## Session — the gate that was deferred ten phases (2026-08-10)

```
packages/basecamp   verify 270/270 (was 262) · 56 data tests (was 49)
                    typecheck 63, baseline lowered from 76
packages/litestone  1461 tests (was 1458) · junction 919 · sierra 810 + 5 safety
```

`FJS-007` closed. All 37 models declare `@@gate`; `FJS-149` was found on the
first request of the drive and fixed in litestone.

**What it was actually blocked on was never the resolver.** `sessionGateLevel()`
grades standing that travels with the user, and here the same person is `owner`
in one workspace and `viewer` in the next — so grading them from their user row
answers USER(4) everywhere, including workspaces they are not in. The level is
resolved per request from the `WorkspaceMember` row for the workspace being
addressed: viewer/billing 2, developer 4, admin 5, owner 6, `isSystemAdmin` 7
above any membership, and an authenticated caller with no membership 1 — which
reads `Workspace` and nothing else, because that is the screen a fresh login
needs before it can name a workspace.

**Three things about `applyStanding()` are the work; the rest is arithmetic.**
It puts `memberRole` on the PRINCIPAL rather than on the client, because
junction's `getTable()` re-derives its own scoped copy from `ctx.auth.user` and
would drop it. It builds a fresh object rather than mutating, because the WS
session is resolved once at upgrade, shared by every frame on that socket, and
frozen. And it re-resolves when the workspace changes mid-request — the
workspaces service addresses `ctx.id`, not the header, and without it an admin
of the workspace on screen carried level 5 into a patch of any other workspace
they could name.

**The levels were not designed, they were moved.** Each one is the
`requireWorkspaceRole` call the service was already making — into the one place
that also covers an engine calling a service in-process, a custom action nobody
wired a hook onto, and a where-clause built by hand. The hooks stay: a gate
refuses with a level, a person needs the sentence.

**262 green checks proved nothing about the gates and that is the trap.** The
drive signs in as the setup user, who is `isSystemAdmin` — SYSADMIN(7) clears
every gate in the schema. Eight checks now ask the same API as a second human,
and the one that matters is *a developer is refused `GET /secrets`*, asserted on
the message naming the level: no hook refuses that read, so it fails if
`memberRole` never reaches the principal. That is the only check that can tell
a working gate from a wired-up-but-inert one.

**`FJS-149` — `$transaction` on a scoped client handed the callback the ROOT
client.** `POST /setup` writes four models in one transaction as system and
failed with *"Account.create" requires SYSTEM access (use asSystem())* about a
call that was using `asSystem()`. The mirror image is the quiet one:
`$setAuth(u).$transaction(…)` ran with `auth()` null, so `@@allow` matched
nothing and `@createdBy` stamped nobody. The `query()` batcher on those same
proxies already kept its scope and says so in a comment; `$transaction` was the
one that did not.

Two smaller things fell out: `runSeeder` ran on the root client (STRANGER(0)) in
a file whose own header says everything runs as system, and `AuditEvent` at
LOCKED(9) means `db:seed --force` cannot clear the table — it lets the workspace
FK cascade do it.

**Not run: `example`'s browser drive.** The rule table says a litestone client
change wants it. Port 3600 was held by an `example` API from another session
that has been up since 03:50, running pre-change code; killing it is not mine to
do, and probing it would have proved the old build. The change is covered by
litestone's own 1461 (3 written for this), basecamp's 270 in a browser, junction
919, sierra 810 + `test:safety`.

---

## Older sessions

`docs/handoff-archive/2026-08.md` — every session before the two above, newest
first, unedited.

**Rotate when a third session lands here.** This file is read cold at the start
of every session, so it stays at two; the archive is unbounded and read only
when something specific is being traced. Nothing is deleted — the move is a cut
and paste, and the archive keeps its own newest-first order.

What an archived session is NOT: a statement about the current tree. Live
behaviour is `CLAUDE.md`, open defects are `ISSUES.md`, settled questions are
`DECISIONS.md`. If a session note and one of those three disagree, the three win
and the session note is history.

