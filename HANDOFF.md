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

# Handoff — 2026-08-31 (logging, and the log nobody could read back)

> **Two things in this tree were called logging and they were not the same
> feature.** `ILogger` is what the process says about itself; `@@log` is what the
> Data boundary records about a write. One went to stdout and was read with
> `docker logs`, the other to a directory of JSONL beside the database, and they
> shared no id, no destination and no reader. `IDEAS/logbook.md` is the record;
> phases 0–3 and Part C shipped, phase 4 (the hash chain) is deferred rather than
> blocked, since phases 0 and 2 met its precondition.

> **The join is one id and it now exists on both sides.** `$.log` is a derived
> accessor beside `$.db`, `$.me` and `$.config` — `app.logger.child('orders.pay',
> { correlationId, userId, tenantId })`, memoised per call — and the audit row
> carries six provenance columns filled from `db.$logContext(fn)`, a closure
> junction installs over its own store. The direction is forced: litestone must
> not learn that a request exists (Invariant 1), so the function is handed down
> the way `now` already is. `correlationId` is the column no audit package in the
> field carries and it is the whole point.

> **`@@log` may now name a SQLite model, and that changed what a trail IS.** It
> had refused any database that was not `driver logger`, so a trail could not
> join `User`, carry an `@@allow`, be paged with `findWindow` or be replicated.
> Naming a model makes it an ordinary one: `Json` columns parse, a row policy
> scopes it, and `@@gate("5.8.9.9")` makes it append-only at the Data boundary —
> read by staff at 5, written by the engine at 8, amended by nothing, because
> `asSystem()` grades 8 and **9 is LOCKED**. Writing `9` for create instead gives
> a trail that migrates, snapshots, passes every check and refuses the first row
> the engine writes.

> **Three defects fell out and each was silent in a different way.**
> [`FJS-616`](ISSUES.md#fjs-616) — every container this framework starts had an
> uncapped log, in all four places one is started; the symptom is not a lost line,
> it is a machine whose database stops writing.
> [`FJS-617`](ISSUES.md#fjs-617) — the audit trail was written inside the
> container, so every deploy deleted it, and the app worked perfectly throughout.
> [`FJS-618`](ISSUES.md#fjs-618) — a jsonl model that gains an indexed field
> silently stops being written, for ever, after one `console.warn`; found by
> **causing it**, since phase 1 adds `@@index([correlationId])` to the logger
> auto-model, which is exactly that upgrade for every app that already has a
> trail.

---

## The counters found what the tests could not (2026-08-31)

Part C was the small half — `db.$logStats()` on `/metrics`, answering
`{ written, dropped, lastError, lastWrittenAt, lastDroppedAt, lastRetainAt }`,
because `fireLog` is fire-and-forget and a trail that stopped recording reads
exactly like an app doing no work.

It immediately reported `written: 0, dropped: 0` against a SQLite trail that had
just been written to. Zero **and** zero is the informative pair: not a failing
write, a `fireLog` never reached. `logModel` was being copied onto the
jsonl/logger registry branch and onto none of the three SQLite ones, so the whole
feature was inert and every behavioral test passed by asserting on a client that
never got there.

**The transferable part is that a counter is not instrumentation, it is the
assertion nothing else can make.** Eight tests had gone green over that path.

## Phase 2's own test failed, and that is the finding (2026-08-31)

The phase was argued on the claim that basecamp runs two trails —
`@@log(audit)` beside a hand-written `AuditEvent` — and that the duplication was
the verdict on `@@log` being unable to be a table. The test was written to be
falsifiable and **it failed**: `AuditEvent` is a SERVICE-level feed carrying what
the application decided, and `@@log` is a DATA-boundary trail carrying what the
row did. They are two documents, not one document written twice.

Recorded in place rather than smoothed over — `IDEAS/logbook.md` § Phase 2 —
and the ranking row in `overview.md` was corrected too, because a row is what
somebody reads first. The feature is still right; the argument for it was not.

## A log nobody can read back (2026-08-31)

Asked whether basecamp has anything like CapRover's GoAccess integration. It does
not, and the three things that sound like it are each measured in
`IDEAS/traffic-analysis.md`: the `logs` tab is a `docker logs` tail that stores
nothing, `IObservability` declares `queryLogs` and no service exposes it, and
`EdgeAnalytics` is four scalars behind a `stubWarn` counting the CDN rather than
the machine.

**The precondition was broken and nothing said so.** The vhost `deploy:setup`
writes declared no `access_log`, so every app fell through to nginx's
machine-wide default — a working config, a green `nginx -t`, a serving site, and
one file that cannot be read back because nothing in a line says which app took
the request. [`FJS-622`](ISSUES.md#fjs-622). The path now carries the app id, and
**the directory is load-bearing**: `/var/log/nginx/*.log` is the glob the
packaged logrotate rule already rotates, so writing them anywhere else would have
been `FJS-616` one layer up while looking like a fix.

The record's own argument is that there are **two products here and they are
routinely confused**. nginx sees `POST /api/` and a status; junction already
knows the service and method, the principal and the tenant. GoAccess tells you a
scanner is hammering a path the app never saw; the junction one tells you
`orders.pay` is slow for one tenant. Phases 1–2 are S and need no store; phase 3
is L and blocked on the same question phase 4 of `logbook` sits behind.

## A flake that was not one (2026-08-31)

Adding an unrelated test file made `children.test.js` fail — 2/2 on the full
suite, 3/3 green in isolation, which is the signature that reads as somebody
else's change breaking it. **The control ruled out the obvious explanation**: the
same reorder using only existing files stayed green, so it was the window and not
the position.

`echo $$ > f` creates the file before it writes to it, so `existsSync` was never
the signal — an empty read parses as `0`. And only the success path removed the
file, while the path is keyed on the runner's pid: `/tmp` held nine of them,
including a **0-byte one**, the failure state sitting on disk waiting for a run
whose pid recycled onto the same number. [`FJS-623`](ISSUES.md#fjs-623).

## The example had no user management, and finding out why took the tooling with it (2026-08-31)

**The question was "do we have user management built in?" and the answer was no,
across five surfaces and twenty-six drives.** No `users` service, no `User`
resource, no roster screen. The only thing in the whole app that changed who
anybody was were two hardcoded palette entries. `db/user.lite` had declared
`isStaff Boolean @allow('write', auth().isAdmin)` since tenancy landed and
**nothing in any surface had ever written it** — the column separating a shopper
from a member of staff was set by the seed and by no person, ever (`FJS-624`).

**What the missing screen was hiding is the interesting half.** auth ships `User`
reading at USER(4) with no read policy, which is correct for an app whose only
people are its staff. This shop registers shoppers on a public storefront who
grade USER(4) too, so the shipped default handed every shopper the entire roster.
Not a defect in auth — the case a gate cannot express, and now one line of the
app's own: `@@allow('read', id == auth().id or auth().isStaff)`.

**Then `fli check` reported the new, correct service as naming a model that does
not exist** — and that was the thread. An app's seed is `schema.lite` PLUS
fragments a package ships and the app appends in memory PLUS `extend model`, so
a file scan sees the first only and the models it cannot see are exactly `User`,
`Session` and `Credential`. Two readers, failing in opposite directions, which is
why neither had been noticed: `service-model` failed CLOSED (a rule firing on a
correct app is a rule people baseline) and **`fli admin:generate` failed OPEN**,
generating a complete admin panel with no Users screen in it, silently, for its
whole life. `core/app-schema.js` is the one owner now, read by both (`FJS-625`).

**The generator had never been executed by anything** (`FJS-372`), and running it
found three more in ninety minutes. A service name is a FILENAME and was being
derived — the app serves `shipping-methods`, `servicePlural` says
`shippingMethods`, and five screens called a URL that does not answer. A model
with no service was generated and then warned about, which is the wrong half; and
filtering those out of the TARGETS was not enough, because the layout is built
from the full list on purpose, so the nav went on advertising two sections that
had never been written. The third was introduced by this change and caught by the
first end-to-end run: kebab reaching the export name, which does not parse.

**What is left is the half that cannot take this fix, and it is the sharpest
one.** `db/access.snapshot.md` — the artefact whose entire job is *who may do
what* — does not mention `User` at all; `grep -c User` answers 0 on a 32-model
snapshot. The same is true of the jsonschema and release snapshots, so
`release:check` grades a deploy it cannot read: raising a gate on the identity
table is a contract no comparison can see. litestone sits below the packages
whose fragments it would have to resolve (Invariant 1), so it cannot take
`app-schema.js`'s answer. Two candidate shapes, both bigger than a fix — a
`--schema` taking several files, or an `import` resolving a package specifier —
and whichever lands should make a snapshot say which sources it was built from
(`FJS-626`).

`verify:users` is the new drive, 24 assertions, and its substance is a pair:
`isStaff` under `@allow('write', auth().isAdmin)` compiles to
`SET col = CASE WHEN … END`, so a shopper's self-promotion is **200 with the
column unchanged** — no error, no field message, nothing a form can render. It is
asserted beside an admin sending the identical payload and beside an unpoliced
column as control, because a refusal that cannot be shown to come from the rule
it names proves nothing (`FJS-351`).

**Finished the next day: adding somebody, and two silent defects on the way.**
`create` is on the service, and its authority is `@@allow('create',
auth().isAdmin)` rather than a level check — `@@gate` is single-valued so an
`extend model` may not restate it, and create is the one operation where a policy
THROWS rather than filtering, so a shopper is refused by name where a read would
have been an empty list. Two things had to be fixed to make an account usable.
**`onPasswordResetRequested` had never been wired** — auth MINTS a token and
sending is the app's callback — so reset had emailed nobody for the app's whole
life, invisible because the route answers 200 either way on purpose. And
**`ctx.result` inside a hook is the ENVELOPE**, so the invitation's `afterCommit`
read `undefined` for the email and never fired: every part was correct in
isolation and the chain did nothing. `resultData()` is exported for exactly that.

**The generated admin panel is NOT committed and that was deliberate.** It was
generated, proven (`fli check` clean over 95 files, opened in a browser), and
then deleted: it duplicates ~20 screens the app already hand-writes, and 95 files
nobody maintains beside the screens that are the teaching material is a bad
trade. The generator fixes, `core/app-schema.js` and `FJS-625` stand without it;
reproducing the panel is one command.

**`FJS-626` was closed by a concurrent session rather than by this work**, and by
the better of the two shapes the row proposed: `db/schema.lite` now declares
`model User` on disk and imports the rest by package specifier, so there is one
schema and every tool reads it. `db/access.snapshot.md` carries `User`'s gate and
all six policies now. That also removes the class — an app has no reason left to
assemble a fragment at boot.

**Left open as `FJS-629`**: there is no way to REMOVE a person, and the reason is
structural. The correct operation is `IAuth.deleteUser`, which needs a custom
method, and `gateAuth` grades CRUD only — *a method the map does not name is not
gated here* — so a custom method has no way to ask the schema for its own
authority. `payments.refund`'s answer does not generalize: it asks
`db.order.transitions(row)`, which works because a refund IS a declared move.
Removing a person is not one.

**One thing worth knowing for the next run**: the tree had 19 stray orders left
by earlier drive runs, enough to push the seeded `ORD-100x` off page 1 and fail
`verify`'s `moves.user` for a reason that has nothing to do with orders. Swept;
`verify` and `verify:build` are 58/58 after it. Two single-assertion failures
seen across repeated runs did not reproduce. Measured again after the work:
`verify` is 58/58 twice in three runs and fails `subDetail.priceMoved` on the
third — the `@from(PlanVersion, …)` path CLAUDE.md already names as having no
announcement behind it, and nothing this session touched.


## Where things stand (2026-08-31)

```
litestone   3719 pass / 0 fail          junction    1692 / 0
cli         1549 + 35 / 0               outpost       27 / 0
basecamp     211 unit / 0 · 306/306 browser checks, exit 0
typecheck   exit 0 — junction and litestone clean
register    0 findings · repo checks 20, all pre-existing
```

## Left open, and whose it is (2026-08-31)

- **`logbook` phase 4 — the hash chain.** Deferred by the maintainer, not
  blocked; its precondition now holds. Nobody in the field ships it.
- **`CLAUDE.md` says forty-three `fli check` rules; the tree has 44.** Somebody
  added one today and left the count. `doc-claims-count` reports it. Not touched
  because that work may still be in flight — if it has landed, it is one word.
- **`packages/litestone/{catalog,docs/reference}.snapshot.md` are stale**, beside
  a modified `litestone/src/`. Another session's in-flight work; regenerate from
  that session, not this one.
- **`exports.snapshot.md` is stale and git-clean** — it was stale before either
  of the last two sessions began and nobody owns it. `fli ws:exports` regenerates
  it; what it reveals about the published surface may need a judgement.
- **Eighteen pre-existing repo warnings** — six packages with no
  `PROJECT_STATE.md`, and thirteen `doc-cites-dead` in `HANDOFF.md`, older
  `ISSUES.md` rows, three `IDEAS/` files, `basecamp/CLAUDE.md` and
  `sierra/example/README.md`. All older than these sessions.

---

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
than the DDL beside it, not a misclassification, and `ISSUES.md` is for behavior
that is wrong. It becomes a correctness hole the day Option C ships, and it is
recorded against Option C in the idea rather than as a defect.

**What no drive can do is prove an index is used**, because an index changes no
answer and every behavioral assertion passes with it dropped. The EXPLAIN in
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
