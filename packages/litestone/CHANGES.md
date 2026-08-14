# Changes — @frontierjs/litestone

## 2026-08-14 — `backup` copied the wrong databases; `replicate` covered one

`FJS-246`, `FJS-242`, `FJS-243`. Found by making `replicate` schema-driven and
hitting the same wall `backup` was already standing behind.

**`createClient({ db })` names MAIN and overrides a declared `database main`**,
and `loadConfig()` always answers a `db` — `./development.db` when nothing said
otherwise. Six commands forwarded it blindly: studio, seed, optimize, backup,
replicate, db push. So `litestone backup` opened a client at a file the schema
never named, createClient created it, and the empty result was snapshotted as
`main` with a `✓` beside it. Proven with a marker row — the backup did not have
it, the real database did.

Underneath that, the SQLite arm reopened a client **per database**:

```js
createClient({ parsed, db: info.path })   // ← still names MAIN
```

so each client was main-at-another-database's-path *and* held every declared
SQLite connection open, which tripped `$backup`'s multi-database branch. The
output was `bk/main.db/` and `bk/analytics.db/` as **directories**, each holding
a copy of both, and `bk/analytics.db/main.db` was analytics filed as main.

Fixed at the owners rather than at the call sites. `declaresDatabases()` /
`clientDb()` is the rule `openSqliteDbs` has always applied for the migrate
commands, now shared: **when the schema declares databases, the declaration owns
the paths.** `$backup(dest, { only })` lets one client answer for one database,
so nothing needs a client per database again. `--db` was overloaded by the same
confusion — a name filter on a multi-database schema, a path on a single one —
and read as a name it matched nothing (`No databases found matching --db=./app.db`).

**This is what a deploy's `05-backup` calls for its pre-migration snapshot**, so
the one guard against a bad migration was writing a wrong or empty file and
reporting success. It sits directly beneath `FJS-240`, which made a *partial*
backup fail loudly; this one was not partial, it was wrong.

**`litestone replicate` is schema-driven now**, the same resolution for the same
reason — it read one `db:` path out of a transform-pipeline config, so an app
with a `main` plus an `audit` logger replicated its rows and silently not its
trail. One `dbs:` entry per declared SQLite database, each to `<url>/<name>` so
two databases cannot overwrite each other's generations:

```
litestone replicate --schema db/schema.lite --url s3://bucket/myapp
litestone replicate --db main
litestone replicate ./litestone.config.js
```

`--schema` and `--url` mean it runs against a scaffolded app with no config file
at all, which is what it could never do before. Resolution moved to `cli.js`,
which owns `loadSchema`/`createClient`; `replicate.js` is the litestream driver.

**Litestream replicates SQLite, so a jsonl or logger database cannot be covered
at all** — reported by name with what to use instead, because a replication
report that lists only what it did reads as though it did everything.

**And it refuses litestream below v0.5.** Not a warning: this machine carries
v0.3.4, and against a litestone database it starts, announces `replicating to:`,
then loops forever on

```
sync error: malformed database schema (user) - near "STRICT": syntax error
```

because litestone emits STRICT tables and 0.3.x bundles a SQLite too old to
parse them. It never exits — a live process, an empty replica, and every deploy
check in the repo saying healthy because they ask `pgrep`. `LITESTREAM_BIN` is
the hatch. Litestream is not forked or republished (`DECISIONS.md` `FJS-D31`);
this is how the version is controlled without becoming its distributor.

## 2026-08-14 — `$transaction` is safe under concurrency

Two concurrent `$transaction` calls silently became one. The depth counter is per
CLIENT and one connection holds one transaction, so *am I nested?* could not be
answered by the counter: a second REQUEST arriving while the first awaited looked
exactly like a genuinely nested call, and was treated as one.

```
A: begin()  → depth 0→1, BEGIN IMMEDIATE, awaits
B: begin()  → sees depth 1 → SAVEPOINT sp_1 INSIDE A's transaction
B: commit() → RELEASE sp_1        ← B's caller is told it succeeded
A: rollback → ROLLBACK            ← B's rows are gone
```

B could also read A's uncommitted rows, because the read router sends every read
to the write connection while `depth > 0`. Reproduced before fixing.

**Re-entrancy is now asked of the async context, not the counter.** A module-level
`AsyncLocalStorage` holds the `txState` objects the current context owns, so a
nested call — which runs inside the outer callback and inherits the store — still
takes a SAVEPOINT, and anything else waits on a per-client FIFO lock. Both halves
matter in opposite directions: serialising everything would deadlock a genuine
nesting (basecamp's `/setup`, four models deep), and nesting everything is the
original defect.

`tx.wrap` — the **synchronous** batch wrapper behind `createMany`/`upsertMany` —
had the same hole. Its callers are already async, so the acquire is awaited while
the batch body stays synchronous.

This serialises only what SQLite already serialises: two `BEGIN IMMEDIATE`s
cannot overlap on one connection, and the old code avoided the error by enrolling
the second caller in a transaction it could not see. `FJS-244`.

## 2026-08-13 — `litestone backup` no longer calls a partial copy a success

`FJS-240`. Every failure arm in `cmdBackup` logged and continued — a `$backup`
throw, a logger directory that is not there, a failed zip — and then the summary
line printed unconditionally and the command exited 0.

Found by pointing a deploy's pre-migration snapshot at it. From the wrong
directory it copied `main`, warned on `audit`, printed `✓ backup complete` and
returned 0. **Database paths resolve against the process CWD, not the schema
file** — `example/db/schema.lite` says so in its own comment — so the wrong cwd
gives a partial backup rather than an error, and over SSH nobody reads the ⚠,
only the exit code.

It now collects what did not make it and refuses:

```
✗  backup INCOMPLETE   1 of 2 database(s) not backed up
   audit (…/db/audit not found — paths resolve against CWD)

Whatever was written is a PARTIAL copy. Do not treat it as a restore point.
```

Exit 1. The success path is unchanged, which is the half that had to be checked
too: from the app root with `--schema db/schema.lite`, `example` backs up `main`
and `audit` and exits 0. 1954/1955 suite unaffected.

## 2026-08-13 — Schema Advisor: a fix that edits the schema, and a corrected reason

**The advisor's stated reason for indexing a foreign key was backwards.** It claimed
`include({ environment: true })` would scan — that reads the *parent* and resolves by
primary key, and `EXPLAIN QUERY PLAN` confirms it never scanned. What scans is
everything starting from the other side: the parent's `hasMany`, a `where` on the FK
column, and `ON DELETE CASCADE`. Right conclusion, wrong argument, which is the kind
of advice that teaches the wrong model of the database.

The conclusion is now backed by numbers rather than assertion, measured on 50k rows:
2,000 lookups by the FK are **4,023ms unindexed against 56ms indexed**, a cascade
delete of 200 parents **656ms against 8ms**, bought for 1.7× on insert and ~60% more
disk.

**An issue that has a known fix now carries it as data** (`fix: { kind: 'index',
model, columns }`) and Studio renders a button that writes `@@index([col])` into the
right model in `schema.lite` — brace-depth located rather than regex-matched, since a
doc comment inside a model may contain braces; indentation taken from the block;
placed with the other `@@` attributes; parsed before saving; duplicates refused.

**It deliberately does not create the index.** The schema now states something the
database does not, so the toast says `migrate to create it` and offers the Migrations
panel, and the advisor keeps reporting the issue until a migration builds it. The raw
`CREATE INDEX` stays for a database you cannot redeploy, but the schema is the better
route for the reason above: a migration only drops what litestone named.

`bench/studio-advisor-fix.mjs` ends where it should — after the edit it builds a
migration from the edited schema and asserts SQLite now answers
`SEARCH deployment USING INDEX idx_deployment_environmentId (environmentId=?)`.
Asserting the text landed in the file would prove the button typed, not that it
helped.

## 2026-08-13 — Studio's schema advisor was reporting every foreign key as unindexed

**It queried `sqlite_master` by MODEL name.** `WHERE tbl_name = 'User'` against a
table created as `user` — SQL string equality is case-sensitive even though SQLite
resolves identifiers case-insensitively — matched nothing, so the advisor saw zero
indexes on every model and reported **all 48 FK columns on basecamp** while 60
indexes existed. It also called every declared `@@index`/`@@unique` "pending, run a
migration". Reported from Studio against a `User` whose schema declares
`@@index([accountId])` and whose database holds `idx_user_accountId`.

Four more defects in the same twenty lines, each found by the one after it:

- **Implicit unique indexes were invisible.** The query filtered `sql IS NOT NULL`,
  and an index SQLite creates for a `@@unique` has `sql = NULL`. Now read through
  `PRAGMA index_list` / `index_info`, which also returns columns already ordered
  instead of a regex over DDL text that has to survive partial-index predicates.
- **Every column of an index counted as indexed.** SQLite uses a leftmost prefix, so
  an index on `(workspaceId, userId)` does nothing for a lookup on `userId` — a
  false negative hiding a real scan, which is what a performance advisor exists to
  find. `WorkspaceMember.userId` is a true positive it was missing.
- **Suggested SQL used a name litestone does not manage.** `CREATE INDEX
  "User_accountId_idx"` is Prisma's convention; a migration only drops what it
  named (`idx_<table>_<cols>`), so following the advice left an index no later
  migration would ever touch. The note now says to declare `@@index([col])`.
- **Multi-database and tenant handles were mixed.** Indexes were read from the base
  connection while row counts came from the active tenant's, and a model in a
  `logger`/`jsonl` database was audited for SQLite indexes it cannot have.

`bench/studio-advisor.mjs` grades every verdict against `EXPLAIN QUERY PLAN` in
**both** directions — a checker that only proves its own complaints cannot catch
what it misses. Two traps the oracle itself fell into and now documents: litestone
always carries `deletedAt IS NULL`, so a probe without it cannot use a partial index
and blames the advisor; and `USING INDEX` is not enough, because SQLite will use
`idx_<t>_deletedAt` for the predicate while still scanning for the column asked
about. 48 reported → 18, then 14, all 14 confirmed real scans.

## 2026-08-13 — Studio: the query behind a view, a generated row, pinned parents

Four additions to Studio and two repairs it turned up, all driven in a real browser
by `bench/studio-{query-view,sidebar,factory,factory-click}.mjs`, which start Studio
and Chrome themselves and work on a tmpdir copy of the database.

**`{ } Query`** renders the Litestone query Browse already builds on every load and
then throws away, to copy or send to the REPL. It emits the **client** alongside the
arguments, because a view browsed as a user and the same arguments through
`asSystem()` return different rows. `findMany` rather than `findManyCursor` — a
pasted opaque cursor means nothing elsewhere, so the query describes page one of the
same filter and sort, and says so when you are past it.

**`🎲 Random`** generates one row from the schema with `factoryFrom` + `withParents`,
runs as the principal the sidebar selects, and reports every table it touched — a
generated `App` on basecamp also writes an Account, Workspace, Project and
Environment, and a button that does that silently is how a scratch database stops
being one. A gate refusal is shown in full with a **Retry as system** offer attached
to the toast; the escalation is never taken for you, and the resulting row says
`(as system)`. The offer is discriminated on `AccessDeniedError`, not on message
wording, so a validation failure gets none.

**Pinning.** `withParents({ pins: { Account: row } })` reuses rows you already have,
keyed by model and applied **at every depth** — which is the whole point, since
`.for()` wires one relation on one factory and cannot reach a grandparent. Studio
exposes it as 📌 on a row's detail drawer plus chips in the toolbar, holding only the
id and re-reading it through the client it is about to write with, so a pin cannot
hand a principal a row its own policy hides.

**`withParents()`'s cycle error gave advice that did not work.** It told you to pass
the root with `.for('parent', rootRow, fk)`, and doing exactly that threw the
identical error, because the cycle guard ran before the check for an
explicitly-wired relation. Both cures — `.for()` and now `pins` — are consulted
first, and the message names both.

**Four `onclick` handlers were dead**, found because a fifth one written the same way
did not fire. `onclick="fn(${JSON.stringify(x)})"` inside a double-quoted attribute
ends the attribute at the JSON's first quote, so the browser saw `copyCell(`. It
silenced the ⎘ copy button on **every grid cell**, both `open →`/`view →` links in
the row-detail drawer, and Copy SQL on a diagnostics issue. `esc()` already existed
and two neighbouring call sites already used it. Nothing threw, in any of them.

**The sidebar could not scroll.** `.app` clips its overflow and nothing below it
declared `overflow-y`, so basecamp's 38 models pushed the Tools nav past the fold and
out of reach. The table list scrolls now and the fixed sections stay put; `min-height:
0` is what makes a flex child shrink at all. A first fix passed at 700px and gave a
**0px-tall table list** at 420px — the list being the only shrinkable child — so it
also carries a floor, and the drive runs at five viewport heights.

## 2026-08-13 — `@encrypted(searchable: true)` is gone; `@encrypted(deterministic: true)` and `@hashed` replace it

**The old attribute stored an HMAC and no ciphertext, under a name that promises
the value comes back.** The plaintext was destroyed on write, `asSystem()` was
handed the digest as if it were the value, and `docs/encryption.md` said it stored
the HMAC *alongside* the ciphertext, which was never true — the example field it
chose was `email`. Following the page lost every address in the table with nothing
thrown at any point. Closes `FJS-211`.

Three modes now, on one axis — **can this value be read back?**

|  | recoverable | not recoverable |
| --- | --- | --- |
| **not filterable** | `@encrypted` (random IV, `v1.`) | — |
| **filterable (equality)** | `@encrypted(deterministic: true)` (`v1d.`) | `@hashed` (`v1h.`) |

The empty cell stays empty: a value you can neither read nor match is a value you
deleted, which is what the old attribute quietly built.

**`deterministic: true`** is AES-256-GCM with the IV derived from the plaintext
under a separate salt, so the same value stores the same bytes and an equality
filter works — and it is still ciphertext, so it decrypts and `$rotateKey` re-keys
it. GCM breaks catastrophically on nonce reuse across *different* plaintexts;
deriving the nonce from the plaintext makes that a hash collision rather than an
accident, and reuse across identical plaintexts is the property being bought. Same
construction Rails ships for `deterministic:`. It trades one thing and the doc says
so: equal values are visibly equal in the column to anyone holding the file. Every
searchable-encryption scheme leaks that, blind indexes included.

**`@hashed`** is HMAC-SHA256 and nothing else — no ciphertext, no key that recovers
it, not rotatable. It is a separate attribute rather than an option on `@encrypted`
because an option inherits its parent's promise. It refuses to compose with
`@encrypted`, `@secret`, `@guarded` or `@allow`, and requires a `String` column.

**Every read path refuses a digest, `asSystem()` included** — there is nothing to
lift the guard to. A row lacks the field; naming it in a `select`, a `groupBy` or an
aggregate **throws**. Those last two are the ones worth stating: they project a
column straight out of SQLite without building a row, so `by: ['token']` answered a
list of digests and `_max` answered one. Handing back something that looks like a
value is precisely how the old attribute lost data — it gets displayed, mailed,
exported and written into the next table before anyone notices the plaintext is
gone.

**`@secret(deterministic: true)`** composes, for a secret that must be both looked up
and rotated. `$rotateKey` now re-encrypts each field in the mode it was **declared**
with; rewriting a deterministic column under a random IV would leave it readable and
every equality filter over it answering nothing, silently, until someone searched.

**The old spelling is refused at parse time, not translated.** The two meanings it
stood in for are the whole decision, and guessing either one silently is how the
value was lost. **A column already holding `v1s.` values is unrecoverable** — an HMAC
has no inverse — so nothing reads the prefix and the migration is re-collecting the
values from wherever they still exist.

Both matchable modes share one WHERE rewrite (encode the operand the way the column
was encoded) and one refusal for everything else, so the suite asks the same
questions of both rather than trusting the second encoder to have inherited the
first's fixes. `test/matrix.test.ts` gains a `hashed` kind and renames `encSearch` to
`encDet`; its write cells verify by MATCHING the new value, since reading a digest
back is the one thing the column does not do.

Found while building this, filed and not fixed here: `FJS-236` (`$rotateKey` leaves
the client it was called on unable to read its own output, because `asSystem()` is
memoised over a snapshot of the key — predates this work) and `FJS-235`
(`@guarded(all)` blocks reads and not writes, and cannot be paired with
`@allow('write', …)` to cover both).

Also: `src/core/client.js` held a **raw NUL byte** in a `cols.join()` separator, which
made `grep` classify the largest file in the package as binary and skip it in silence.
It is the `'\x00'` escape now — same string, and the file is searchable again.

## 2026-08-13 — one clock per evaluation, and it can be frozen

`now()` in a policy expression resolved at the point it was **reached**, so
`@@allow('read', startAt < now() && now() < endAt)` bound two timestamps
microseconds apart, and `evalJs` called `new Date()` again on its own side.
Harmless for an access check, wrong in principle, and fatal for the reporting
shape the `@@scope` ruling depends on: a query with no single "as of" instant
can return a row satisfying a contradiction and will not reconcile with a
re-run. It is now resolved once per evaluation, carried on a prototype view of
`ctx` so every nested compile — a `check(field)` delegation recurses — reads the
same moment.

**`createClient({ now })`** is the injection point, taking a function returning
a `Date` or an ISO string. It reaches both halves of the policy compiler and
`@@softDelete`'s stamp, so a frozen clock freezes every timestamp litestone
writes rather than only the ones a policy compares against. That is what makes
a time-dependent test deterministic and a report reproducible, and it is the
prerequisite the `FJS-D28` ruling named before `@@scope`/`@@order` can land.

Closes `FJS-227`.

## 2026-08-13 — `@from(first/last)` returns a row that was actually read

`@from(Order, last: true)` built the row as `json_object('field', …)` over the
target's columns. That list filtered out the **virtual** attributes — `@computed`,
`@from`, `@generated` — and left the **protective** ones alone, because those are
applied by `read()` and a hand-built JSON object never reaches it. So the one
`@from` shape that returns a row returned it raw: `@guarded(all)` and `@omit(all)`
values in plaintext and `@encrypted` ciphertext, to an ordinary scoped caller,
while the target's own derived fields were missing.

The subquery now resolves the row's **id** and the row comes back through a real
read of the target — the same move as the recursive walk a day earlier, for the
same reason. Three ways to one row now produce one shape, which is what the test
asserts: a direct read, an `include`, and a `@from(last: true)` agree key for key.

Batched: one query per field across every row in hand, so a `findMany` of a
hundred parents costs one extra query. Resolution happens before `applyComputed`,
so a `@computed` on the *parent* reading `row.lastOrder.amount` still sees a row.

**Two behaviour changes.** The target's row policy now applies, as it always did
to an `include` — a `@@allow` on the target can make the field `null`. And the
default `orderBy` for `first`/`last` is now the **target's** id column; it was the
declaring model's, which is the same name often enough to hide the difference.

The three include branches each finished their rows with their own copy of
deserialize → compute → shape; they now share one `finishRelated`, which is why
the fix reached all three rather than only the one that was tested.

Closes `FJS-222`, `FJS-223`. Opens `FJS-224` for the residue: the pick is made
before the policy is known, so a denied row is `null` rather than the next
visible one.

## 2026-08-12 — `@from` reads the relation you meant

**A `@from` on a relation to the same model answered `0`, always.** The subquery
correlates a table to itself, and unaliased the correlation was captured by its
own scope: `(SELECT COUNT(*) FROM "task" WHERE "taskId" = "task"."id")` reads
that `"task"."id"` as the **inner** row, so it counted rows whose FK equalled
their own id — none. A parent with two children read `childCount: 0`, typed,
present and wrong. The target is now aliased in every `@from` subquery, not only
when the names collide: a rule that holds conditionally is a rule with two
implementations, and this one already cost a silent wrong answer.

**An ambiguous `@from` is refused rather than resolved by declaration order.**
Two relations can join one pair of models — `sender`/`recipient` both point at
`User` — and `@from(Message, count: true)` took whichever came first in the file
and said nothing. The other count was unaskable, and the one you got answered a
different question with nothing in the value to distinguish them. It is now a
schema error naming both candidates and the cure, and **`via:`** is the cure:

```prisma
sentCount Int @from(Message, count: true, via: sent)        // the field on this model
gotCount  Int @from(Message, count: true, via: recipient)   // or the one on the target
```

`via` names either side — the field here, the field there, the `@relation` name
they share, or the FK column. A name matching none is refused with the candidates
listed. The word is `recursive`'s, deliberately: it is the same question about
the same kind of ambiguity, and a second word for it would be a second thing to
learn.

`parent` + `children` is one relation and still needs no `via`. Nothing in this
repo's seven schemas is newly refused.

Closes `FJS-220`, `FJS-221`.

## 2026-08-12 — a tree read is a read

`findMany({ recursive })` was a second implementation of `findMany`. It built
its own SQL and returned before the plugin runner, so `@@gate` was never asked;
it composed the row policy and the soft-delete filter into the CTE's **anchor**
SELECT and nowhere else, so every row below the row you named arrived
unfiltered. A caller refused on a model could read its whole subtree by asking
for the children of a row it could see. Fail-open, and it broke Invariant 6 for
one option of one method.

The fix was to delete the second read path rather than thread three filters
through it. The CTE now resolves **ids only** and the rows come back through the
ordinary `findMany`, which is what applies the gate, the select, the includes
and the derived fields — one owner each, instead of a copy here that had drifted
out of all four. The walk carries the same visibility predicate as the anchor,
so a node the caller cannot see hides its subtree; that is the deliberate
reading, matching what `@@softDelete(cascade)` already does on the write side,
and the alternative reparents orphans up into the visible tree.

Three things that were silently ignored now say so. `count`, `findFirst`,
`findUnique`, `exists`, `aggregate` and `groupBy` **refuse `recursive` by
name** — `count({ recursive })` counted the anchors and answered a plausible
number for a question nobody asked. `nested: true` refuses `limit`/`offset`,
which would cut branches out of the middle of a tree. And `select` is honoured,
where before a caller that narrowed its read got every column back.

**A row can no longer be made its own ancestor.** The write is refused naming
the field, which is the only place that can — nothing about a tree read can say
which of a thousand rows was pointed at wrongly. A loop already stored is
survived rather than trusted: the walk tracks the path it came by. The `GROUP BY`
that dedupes the answer means the path column changes no result, only the work —
without it a two-row loop is ended by the depth ceiling alone, so it scans
`maxDepth` rows.

`_depth` is now the distance from the anchor in **both** directions (it started
at 1 walking up and 0 walking down), the anchor is never in its own result, and
`orderBy: { _depth }` works — it was written into the old path but unreachable,
because the orderBy validator rejected the key before the branch ran.

Closes `FJS-216`, `FJS-217`, `FJS-218`, `FJS-219`. Nothing in this repo declares
a self-relation, which is why all four survived: the feature had documentation
and eleven tests, and no drive.

## 2026-08-12 — a filter that cannot match now says so

`$checkWhere` gains `reason` and `message`, matching `$checkOrderBy`'s contract
exactly — `'computed'`, `'encrypted'` or `'unknown'`, so a boundary can say a
different sentence for each, and `allowed` now lists only keys that can actually
be filtered rather than every field name. `filterableKeysFor()` is the sibling of
`sortableKeysFor()` and the one definition of the split; both `$checkWhere` and
the per-query check ask it, so the rule cannot grow a second copy. A relation
stays filterable — `posts: { some: … }` is a legal where.

On a read an unfilterable key warns. On a **write** it throws, which is what an
unknown key already did: an `updateMany` that quietly touches no row is worse
than one that says why.

**Two predicates are refused when the client is built, not per query.** A global
filter and a `@@allow` are each named once and used for every read, so a mistake
in one is permanent and invisible — the model reads as empty for every caller
forever, which looks exactly like a table with no data. Both are decided by the
schema alone, so both are answerable at startup, which is also the only altitude
where the fix is a schema edit rather than a caught exception. The static filter
form is checked; the function form takes a `ctx` and cannot be judged without
one, so it still goes through the per-query check.

The policy case turned out to be broader than the read case. `policy.js` contains
no reference to encryption at all, so a predicate comparing **any** `@encrypted`
field — searchable or not — compares plaintext against stored bytes and denies
every row. A `where` on the same field works, because `buildWhereWithEncryption`
rewrites the operand first. Guarded here, tracked as `FJS-214`, because the real
fix is one owner for *compare a value to an encrypted column*.

What made the `@computed` case worth refusing rather than warning: SQLite reads
an unresolvable double-quoted identifier as a **string literal**, so
`WHERE "comp" = ?` is a comparison of two constants — `{ comp: 'A' }` matches
nothing and `{ comp: 'comp' }` matches **every row**, including rows whose
computed value is something else. Not "fewer rows you can see": a wrong answer in
the dangerous direction (`FJS-215`).

**Tier 3, ruled: an unfilterable key throws on a read too.** Not because silence
is untidy, but because the alternative is not "fewer rows" — SQLite reads an
unresolvable double-quoted identifier as a string literal, so `{ comp: 'A' }`
answers nothing and `{ comp: 'comp' }` answers **every row**, including rows whose
computed value is something else. A filter returning rows that do not match it
cannot be reported by a warning in a log nobody reads.

**An unknown key still only warns on a read.** That trade was ruled on separately
and its rationale holds: a typo returns fewer rows and leaves something to
notice. A key that is real, spelled right and impossible leaves nothing. Two
tests asserted the old silence as expected and were rewritten; nothing else in
1,895 tests moved, which is the argument that the change is scoped.

**`@encrypted(searchable: true)` now answers every spelling of equality.**
`rewriteEncryptedWhere` hashed the scalar form only — `typeof val !== 'object'` —
so `{ in: [x] }` compared plaintext against digests and answered nothing, and
`{ not: x }` answered **every row, the excluded one included**, because a
plaintext never equals a digest. `equals`, `not`, `in`, `notIn` and the
bare-array shorthand each hash their operands now; an operator a digest cannot
answer is refused naming the field, since a digest preserves equality and nothing
else.

19 tests across the three tiers, mutation-checked.

## 2026-08-12 — six silences, found by the matrix and closed

**A plain object in a bind position dropped every binding in the statement.**
`bun:sqlite` reads one as a bag of *named* parameters, and a statement built with
positional `?` matches none of its keys — so it ran with nothing bound, **the
WHERE included**, and raised no error. `SELECT ? IS NULL` given `{x:1}` answers
`1`. That one fact produced four unrelated-looking symptoms: `update` returned
`null` (its WHERE had been voided, so it matched no row, which litestone reports
as *no such row*), `updateMany` said `NOT NULL constraint failed` about a column
whose value was never bound, `create`/`upsert` threw the driver's raw
`Binding expected string, TypedArray, …` naming no field, and a **read** answered
`[]` — the worst of them, because a read has no `changes` to notice. Now refused
naming the field, on reads and writes alike, and the write message says litestone
has no atomic update operators, since `{ views: { increment: 1 } }` is the shape
that gets here (`FJS-D27` asks whether it should have them). Functions and
symbols are named on the write path too rather than left to the driver.

**A `@computed` or `@generated` field is refused instead of dropped.** Both were
absent from the writable-key set, so a write naming one went out through the
*unknown-key* strip — which is silent by design, because that strip is the
mass-assignment protection. Declared-but-unwritable is a different thing wearing
the same clothes, and the caller has to hear about it: the refusal says which
kind it is. An unknown key is still stripped without a word.

**`updateMany` with nothing left to set emitted `UPDATE "t" SET  WHERE …`** and
SQLite answered `near "WHERE": syntax error`. Reachable from an ordinary form post
whose fields no longer match the model — again because stripping unknown keys is
the protection working. It now answers the matched count, which is what `update`
already did with the same input. SET and WHERE parameters are collected in
separate arrays and joined at the end; sharing one made the statement depend on
which half was built first, which is why the case could not be handled where it
belonged.

**`in` and `notIn` now read an array column's elements.** `filtering.md`
documents the bare array as meaning `in`, and after FJS-189 the shorthand
answered while its own explicit spelling did not — `{ words: ['x','y'] }` found
the row and `{ words: { in: ['x','y'] } }` found nothing. The bare-array branch
had `arrayFields` and the `in` branch was never given it.

**`groupBy` and `aggregate` hydrate the values they return.** They handed back
SQLite's own, so an array column came back as its JSON text, a `Boolean` as `0`/`1`
and a `Json` as a string — a value's TYPE depended on which method asked for it.
Applied only where the value is still in the column's domain: the `by` keys and
`_min`/`_max`. **Not** `_sum`/`_avg`, where the number is no longer of the
column's type — the sum of a Boolean column is a count, and coercing it back would
answer `3` as `false`.

**An unknown where operator names its field**: `Unknown where operator "tier" on
field "meta"`, not `Unknown where operator: "tier"`.

`@encrypted(searchable: true)`'s documentation said it stores an HMAC "alongside
the ciphertext". There is no ciphertext — the column holds the digest and nothing
else, so **the plaintext is destroyed on write and cannot be read back**. The
behaviour is deliberate and asserted by a test; the page now says so in a warning
before the example, and no longer uses `email` as that example. Whether the
attribute should keep the `@encrypted` name is `FJS-211`.

Closes FJS-199, 203, 208, 209, 212, and half of 206. 26 tests, mutation-checked.

## 2026-08-12 — the crossing matrix

`test/matrix.test.ts`. Every defect found in this sweep was a **crossing** — two
features that each work alone, whose intersection nobody owned and nobody tested.
An enum that is also an array. An array reached by a `where`. An array given a
`@default`. A bulk write over rows of different shapes. Feature-by-feature tests
cannot find these, because each feature passes its own suite.

So the crossings are declared as a grid, 14 column kinds × 12 operations, under
one invariant: **no cell may silently return a wrong answer.** A cell is
supported, or it is refused *by name* — the runner checks a refusal actually
contains the field name, because a raw SQLite message is a refusal nobody can act
on. Silence is the only outcome never allowed, being the one a caller cannot see.

**A known defect is a cell, not an omission.** `200:ref` means *FJS-200, and this
should refuse*; the runner asserts the defect is **still there** and goes red when
it is fixed, naming the cell and telling you to promote it. Same ratchet as the
typecheck baselines, and the reason a fix cannot leave the grid stale — the
register went wrong in the closing direction before (`FJS-043` sat open for eight
days after being fixed), and a grid nobody re-grades would do it again.

Every declared kind × every declared op must have a cell; a missing one fails
rather than being skipped. Adding a column kind means answering the question
twelve times. That is the point — it makes a crossing somebody's job.

The grid was filled from what the code **does**, not what it should do:
`MATRIX_REPORT=1 bun test test/matrix.test.ts` prints the observed grid ready to
paste. Filling it by hand from belief is how a grid ends up asserting a wish.

It found eight defects on its first run, three of them silent — `FJS-208` through
`FJS-212`, plus evidence that widened `FJS-201`, `FJS-203` and `FJS-206`. The one
worth naming here: `@encrypted(searchable: true)` stores only an HMAC, so the
plaintext is **destroyed on write and unrecoverable**, while `encryption.md` says
it is kept "alongside the ciphertext" (`FJS-211`).

Relation kinds, `@edge`, `@sequence`, `File` and the cursor/window/FTS operations
are **not** in the grid yet, and the file says so rather than leaving the gap
silent.

## 2026-08-12 — `sampleWrites()`

One seeded row per model, plus the payloads a create and a patch would carry, with
every required FK pointed at a parent the same call made. The Data-realm half of
deriving a call list: mapping a model onto the service that exposes it is an
API-realm fact this package cannot see (Invariant 1), so what comes back is keyed
by model name and the caller does the mapping. `@frontierjs/testing`'s transport
parity runner is the first consumer.

Server-owned columns are absent from the create payload — over the wire they are
`readOnly` in the model's JSON Schema, so sending one is a 400 about the fixture
rather than an answer about the rule under test.

**A model that cannot be seeded comes back as `{ error }` rather than being
dropped.** An absent key reads as *this model has nothing to test*, which is how a
derived suite silently stops covering the model whose fixture broke.

It builds its `withParents()` chains through the existing memoised `_chains`, so
it does not re-enter the sequence trap that has now cost four rounds of false
results.

## 2026-08-12 — `env.verifyRowPolicies()`, and `litestone mutate`

**A gate refuses and a policy filters**, which is why this needed its own runner
and why it was the last mutant nothing could see: deleting an `@@allow` raises
nothing anywhere. It returns MORE rows, and more rows is not an error — it is a
disclosure with a 200 on it.

**The oracle is a second implementation, not a restatement.** Litestone compiles
a policy twice, into two languages: `compileSql` for reads (a WHERE) and
`evalJs` for creates (JavaScript). This reads rows through the compiled WHERE and
asks `evalJs` which should have come back. That is the opposite of the oracle
problem — and the same comparison found `field == null` compiling to
`"col" = NULL` while the JS side was right (FJS-195). Verified by reverting that
fix: 3 mismatches.

Covers `read`, `update` and `delete`, all of which compile into a WHERE.
**`create` is deliberately absent**: it is checked by `evalJs` and nothing else,
so grading it with `evalJs` would be circular and there is no second
implementation to compare against.

**Rows are placed on both sides deliberately**, with values taken off the
predicate itself — the principal's own value for an `auth()` comparison, the
literal for a literal one. Three things had to be right for that to work, each
found by running it against basecamp:

- **the field is usually a FOREIGN KEY.** `workspaceId == auth().workspaceId` is
  the whole of basecamp's tenancy, so a made-up value breaks the FK and the row
  never exists. Every matching-side candidate was lost that way, leaving one row
  with all of it excluded.
- **a generated sentinel must satisfy the column's own validators**, or the
  insert fails and the row is on neither side.
- **a targeted value and a miss value are not interchangeable.**
  `verifyFieldProtection` seeded with whichever came first and hid the row from
  the very reader it was about to check.

**Rows on one side only are reported, not passed.** A policy that admits
everything and a policy that is not applied at all are the same observation when
every row matches. `example`'s own `title != null` over a required column is
exactly that, and the runner says so.

**`litestone mutate` / `fli test:mutate`** run the sweep by hand and print the
survivors with their line numbers. Not a CI phase: basecamp is 232 mutants at
several seconds each. `--kinds` narrows it.

`example` now scores **97%** with one survivor — a nullable `@unique`, which
SQLite cannot be made to refuse. Both real schemas are clean on all four checks.

## 2026-08-12 — schema mutation testing, and the two checks it demanded

```js
const r = await mutationScore({ schema, build: (text) => createTestEnv({ schema: text }) })
// example: 30 mutants, 97% killed, one survivor, 3s
```

**Mutate the schema, not the code.** Drop a `@@gate`, grade one down, remove a
`@guarded`, widen a `@length`, delete an `@@allow` — then run the suite derived
from the ORIGINAL schema against a database built from the mutant. A `.lite` file
is small and declarative, so the mutation space is enumerable rather than
combinatorial: 30 mutants for `example`.

**Expectations from the original, database from the mutant.** Deriving both from
the mutant is the oracle problem at its purest — drop a `@@gate` and the ladder
loses the rows that would have caught it, so every mutant survives and the score
reads 100%. `verifyGateLadder`, `verifyConstraints` and `verifyFieldProtection`
all take `{ against }` for this.

**The score named two holes and both are now closed.**

- `verifyGateLadder` executes **all four operations**, not just read. Create
  needs a valid row, update and delete need one already there; the factory
  machinery `verifyConstraints` proved out supplies them. Until it did, lowering
  a create or delete gate was a mutation nothing could see.
- `verifyFieldProtection` reads every `@guarded`/`@encrypted`/`@secret` field at
  SYSADMIN(7) and asserts the key is **absent** — and separately that
  `asSystem()` still gets it, because a column absent for everyone is broken
  rather than protected.
- `verifyConstraints` gained `@unique`, the one declared rule whose failing value
  cannot be generated: it has to be taken off a row that already exists.

`allow-drop` still survives. Row policies need rows on both sides of a predicate,
and nothing executed asks — the finding, stated, rather than a gap in a count.

**An `error` row never counts as a kill.** This was worth 36 points. Every mutant
came back with the same 22 error rows and the score read 93% while four mutations
went completely unnoticed. A mutation score that counts its own harness failures
as successes is the oracle problem wearing a percentage.

**Two more traps the runs surfaced, both fixed:**

- *Mutating prose.* `example` reported four surviving `guarded-drop` mutants on a
  model with no `@guarded` field — the matches were inside a doc comment
  explaining what `@guarded` is not. A mutant that edits a comment is behaviourally
  identical to the original and survives everything, so every documented attribute
  name was quietly costing a point. Mutation is now quote-aware and code-only.
- *A schema the framework will not LOAD is a kill, not an error.* `parse()`
  accepts a non-monotonic `@@gate("4.3.4.5")` and the gate plugin refuses it at
  construction, so the two halves of "is this schema legal" do not agree and only
  the second is reached.

**A row policy makes one direction ungradeable, and only one.** A policy filters,
so it can turn an allow into a deny and never the reverse — `Server.create` on
basecamp reports `allow` from the schema and `deny` from the client, and the
policy is the correct answer. Skipping BOTH directions cost a real kill: a
lowered read gate on a model that happens to declare an `@@allow` stopped being
graded at all.

Clean on `example` and `basecamp`. Basecamp's ladder takes ~5.7s (37 models × 4
ops × 9 levels, with a restore between rows) — an audit, not a unit test.

## 2026-08-12 — `env.verifyConstraints()`

`verifyReadLadder`'s sibling. `generateGateMatrix` and `generateValidationCases`
both **describe** a schema, and describing is where a generator's value stops;
this executes the constraint cases against the real write path and returns the
ones that disagreed.

```js
expect(await env.verifyConstraints()).toEqual([])
```

**The oracle is structural, not textual.** The schema declares a rule, so a value
violating it must be refused — the message is not asserted, which is what keeps
the expectation independent of the code producing it. A rule that reaches the
browser through `x-messages` and is ignored by the server is what it exists for.

Runs as SYSTEM, because the question is enforcement and a `@@gate` refusing the
write first would answer *rejected* for every case including the ones nothing
validates. Rolls its rows back, so it is safe to call mid-suite.

**Three outcomes, not two.** A write that fails for an unrelated reason is
`error`, never `rejected` — calling it a refusal is the trap, because it makes a
broken validator look enforced. It is reported rather than swallowed: a case that
could not run is a hole in the coverage the count implies. A model whose row
cannot be built at all (a required self-reference) reports once and the run
continues.

**Three collision guards, each measured on basecamp's 37 models.** One factory
clone per model (a re-clone writes sequence 1 every time); `fresh: true` parents
(reused parents give identical FKs and collide on a `@@unique` over them — 1
case); and a restore between models (two models sharing a parent each build one
from their own seq 1 — 57 cases). Every one of those failures looks exactly like
the validator working, which is why the `error` outcome had to exist before the
runner could be trusted. Its first run on basecamp reported 23 mismatches, none
of them about basecamp.

Clean on `example` (22ms) and `basecamp` (157ms). Mutation-checked against both:
disabling `@gte` reports 2 and 10, `@email` 1 and 1, `@length` 8 and 46.
Basecamp's own suite now asserts it.

## 2026-08-12 — `field == null` in a row policy (FJS-195)

`@@allow('read', ownerId == null)` compiled to `"ownerId" = NULL`, which SQLite
answers NULL — never true. So the policy hid every unowned row and raised
nothing: an empty list with a 200, which is the failure mode `@@allow` has by
design and the reason a wrong one is so hard to see.

Worse than half-wrong. `create` is evaluated by `evalJs`, which compares with
`===` and had always been right, so a caller could create a row and then not see
it — the two halves of one rule disagreeing. The `auth() == null` form was
already special-cased in both paths; the `field == null` form was in neither.

Now emits `IS NULL` / `IS NOT NULL`, resolving a `belongsTo` field to its FK the
same way `field == auth()` does. Found by the first vertical test through
`@frontierjs/testing`, whose fixture schema wrote the natural thing. 3 tests,
mutation-checked at 3 red.

## 2026-08-12 — `env.setup()`, the hoisted arrange

```js
const fx = await env.setup(({ factories }) => factories.account.createOne())

test('…', async () => {
  const t = env.phases({ as: developer })     // rows are back at fx
})
```

Runs once, snapshots what it wrote, and every later `phases()` call restores it.
The restore is a truncate + bulk re-insert of the exact rows — cheaper than
re-running factories through validation, hooks, gates and FTS. With
template-clone already off the per-test bill, the fixture is what dominates a
suite's runtime, and this is the part that stops paying it per test.

`setup` takes the **same tools** `arrange` takes, so hoisting a line out of a
test is a move rather than a rewrite. The value it returns survives the restore:
rows go back with the ids they had.

Refused twice, and refused after the first scenario has run. Both are one
failure — a baseline that does not describe what the tests around it started
from — and it is order-dependent, so nothing else would catch it.

`seal`/`reset` are untouched and keep their own snapshot; `phases()` restores
`setup`'s baseline and nothing else. Mutation-checked: dropping the per-scenario
restore or the second-setup guard turns one test red each.

## 2026-08-12 — `readOnly` and `env.phases()`

**Arrange / Act / Assert as three different clients rather than three comments.**

```js
const t = env.phases({ as: developer })
const lead = await t.arrange(({ factories }) => factories.lead.createOne())
await t.act(as => as.lead.remove({ where: { id: lead.id } }))
await t.assert(read => expect(read.lead.count()).resolves.toBe(0))
```

`arrange` gets the **system** client, so a gate that refuses the principal does
not refuse the fixtures. `act` gets the **principal's** client and runs once —
a scenario with two acts cannot say which one an assertion is about, and setup
after the act is part of the act, which is what would stop `arrange` being
hoisted and cached. `assert` gets the principal's **read-only** client, which is
the pair of properties that phase actually needs: graded, so *the row exists*
cannot stand in for *this user can see it*; and unable to write, which is what
makes retrying a scenario sound.

The body stays linear. Callback phases would thread state through return values
and stop a line being commented out to bisect, and the enforcement does not need
them — it comes from what is in scope.

**`readOnly(client)` is an allow-list, not a deny-list of the writes.** A write
method added to litestone later would pass straight through a deny-list, and the
whole value of this is that it cannot. The doors back out to a writable client
are refused by name: `asSystem`, `$setAuth`, `sql`, `$rawDbs`, `$transaction`.
`asSystem` needed naming specifically — it is the one escape that is not
`$`-prefixed, and it first "passed" only because it fell through to the table
branch and failed as *not a function*, which is an accident, not a guard.

Mutation-checked: turning the allow-list into a passthrough, dropping the
`asSystem` guard, or dropping the one-act rule turns 2, 1 and 1 tests red.

Not tied to a runner — `phases()` is called inside whatever `test()` the package
uses, so bun and Vitest both get it without an adapter.

## 2026-08-12 — the validation generator, run against a real client for the first time

**Nothing had ever executed a generated validation case.** `generateValidationCases`
shipped with unit tests over its *output* and none over whether a client agreed
with it. Running all of them found **five** defects, four of which made the
generator produce tests that fail against a correct implementation.

**`cases.valid` was not valid.** `generateFactory` had no case for `@time`,
`@date` or `@datetime` on a **String** column — those are string formats, not
column types, so `day String @date` got the generic `"Day 1"`. Every case is
built as `{ ...valid, [field]: bad }`, so one such field made *every* generated
case for the model fail, naming a field it was not testing. "Correct by
construction" was a claim with nothing behind it.

**An authored message was ignored.** A field declaring `@email("Use your work
address")` generated a case predicting the DEFAULT wording, so the documented
`rejects.toThrow(c.message)` failed against a client behaving correctly. The
message now comes from the attribute, falling back to the shared table.

Reading `DEFAULT_MESSAGES` is not the oracle problem the gate matrix had, and the
distinction is worth stating: the claim under test is *this value is rejected*,
which is derived here from the attribute's presence. The message is a **label**,
and the table is the one definition of it that Junction and Sierra also read
through `x-messages`. Sharing a label is fine; sharing a verdict is not.

**`@phone`, `@time` and every array rule generated nothing at all** — enforced,
untested, silently. `@minItems`, `@maxItems` and `@uniqueItems` now produce
invalid and boundary cases; arrays were skipped wholesale before.

**The fix that matters is the test, not the five repairs.** Every generated case
now runs against a real client: invalid ones must be refused *with the message
the case predicted*, boundary ones must be accepted, and every field carrying an
attribute must produce at least one case. Mutation-checked — dropping the custom
message, the `@time` factory branch or the array cases turns 2, 3 and 2 tests red
respectively.

Found and filed rather than fixed: **`FJS-194`** — the array validators are
enforced inline in `writeData` rather than through `DEFAULT_MESSAGES`, so
`@minItems(2, "Pick at least two")` reaches the browser through `x-messages` and
is ignored by the server, and the same rule refuses with different wording
depending on which side saw it.

## 2026-08-11 — `createTestEnv`, and a database per test that costs a file copy

**Applying the DDL was the per-test cost, and it produces the same bytes every
time.** `src/testdb.js` migrates once per schema per process into a template and
every client after the first is `copyFileSync`. Measured on basecamp's 37-model
schema: **476ms → 13ms per database**, and litestone's own suite went 41.5s to
33.7s without a test changing. `makeTestClient` uses it too, so the win is not
opt-in. In SQLite, a database per test is a file copy — which makes the isolation
everyone else pays for with transactions cheaper here than transactions are.

**`createTestEnv({ schema })`** is the environment: a migrated database, a
client, factories and a principal in one call. `schema` takes the text or a path.

**Two auth doors, deliberately not one.** `actingAs(user)` grades through the
app's own `getLevel`; `atLevel(n)` grades synthetically for walking the gate
grid. A matrix driven by `atLevel` passes in full while the app's resolver is
broken, because the resolver was never called — so `atLevel` is for the grid and
everything about behaviour uses `actingAs`. `atLevel` opens a second client (a
level is fixed at construction, so it cannot be a property of a call), dropping
any caller-installed `GatePlugin` and keeping every other plugin; `atLevel(8)` is
`asSystem()`, since `getLevel` is clamped to 0–7.

**`migrations:` builds the template by replaying the committed migration files**
rather than generating DDL from the schema — a directory, a `.sql` path, or an
array of either. That is Encore's actual shape, and it is what basecamp's suite
needed: all 61 of its tests are about the database a deploy produces, and they
had been replaying `001_initial_schema.sql` by hand for exactly that reason.
Converting them cut that file's runtime from **58s to 9.5s** and gained a test
nothing had asked before — build a database each way, introspect both, compare.
They agree.

A directory is read more loosely here than `listMigrationFiles` reads one: every
`.sql`, not only litestone's generated `<14-digit>_<label>.sql`. A hand-written
`001_initial.sql` is a real migration, and a template that skipped it would
produce an empty database and a wall of *no such table*. A `.js` migration is
refused by name rather than skipped — it is handed a client, and a template is
built on a raw connection. `migrationStatements(path)` is exported from
`core/migrations.js` so the comment-and-transaction stripping has one owner
rather than a second copy in the template builder.

**`verifyReadLadder()` runs the read column of every gated model at every level
against a real client, with no fixtures** — a read either refuses or answers.
333 assertions on basecamp in 214ms. Each mismatch is a sentence naming the
model, the operation and the level.

### The oracle has to be independent of the thing it grades

The first cut had `gateLadder()` ask `levelPasses()` for its expected verdict —
one definition, no duplication, and the reasoning that got it there was the same
reasoning that made `levelPasses` an export in the first place. It was wrong.
Deleting a branch from the plugin outright produced **zero mismatches across 333
executed assertions**, because the expectation moved with the enforcement.

`expectedVerdict(required, level)` in `access.js` now states what `@@gate` means,
and deliberately does not call `levelPasses()`. One exhaustive test over every
(required 0–9 × level 0–8) pair holds the two statements together, so a
divergence fails there — loudly, in one place — instead of silently disarming
every suite downstream. Re-run against a real off-by-one (`>=` → `>`): 34 of 333
mismatches, each naming its model and level.

The distinction is between describing and verifying. The access snapshot
describes what the plugin enforces and should share its predicate. A runner
grades the plugin and must not.

**Also fixed while writing its test: a read that throws for a non-gate reason
was counted as a refusal.** An `@@external` model emits no DDL, so every read
fails with *no such table* — and the ladder called that a pass at all six levels
its gate refuses. Only an `AccessDeniedError` counts as `deny`; anything else is
reported as `error` regardless of what the schema expected.

## 2026-08-11 — `litestone access`, and a gate matrix that covers the ladder

**A schema's access rules were only readable by reading the schema.** `@@gate`
refuses and `@@allow` filters, both below the API, and a wrong policy is an empty
screen with a 200 rather than an error — so a gate that moved was invisible until
something was refused in production.

`litestone access` writes `access.snapshot.md` beside the schema: gates per model
per operation, each row policy as the predicate it was written as, protected
fields, and gated transitions. Commit it and read its diff. `--check` re-derives
and exits 1 when the committed file is stale, which is the half that makes it a
gate rather than a document. `--json` gives the structured table.

Two properties are load-bearing and both are pinned by tests. Models render sorted
by name rather than in schema order, and empty sections are omitted — a model
inserted mid-file otherwise shifts every row below it and the diff stops naming
what changed. And the render is byte-deterministic, because `--check` compares the
whole file and a check that cries wolf gets disabled.

**`generateGateMatrix` now covers the whole ladder.** It emitted two cases per
operation — the required level and the one below — which proves the comparison
operator and nothing else; a gate granting at 6 and again at 2 passed. The default
is now every operation against every reachable level (0–8), 36 cases per model,
with `{ levels: 'edges' }` for the old shape. Cases carry `required` alongside
`level`.

Verdicts come from `levelPasses(required, userLevel)`, newly exported from the gate
plugin and now the single definition of "does this level pass this gate" —
`checkLevel` guards on it and keeps its three distinct messages. Anything that
*describes* a gate rather than enforcing it asks that function, because a second
copy is an artefact certifying access the plugin does not grant.

Also fixed: two usage comments and two doc examples called these generators with an
accessor (`'posts'`, `'leads'`) where the code matches on the model name and throws,
and `docs/testing.md` showed the level being passed on the user object
(`$setAuth({ id, level })`), which the plugin ignores — the level comes from
`getLevel`, clamped to 0–7, so SYSTEM is reachable only through `asSystem()`.

## 2026-08-11 — a bare array in a `where` reaches an array column

`findMany({ where: { tags: ['x', 'y'] } })` against `tags String[]` returned `[]`
for a row whose tags were exactly that. The bare array is litestone's shorthand
for `IN`, and `"tags" IN ('x','y')` asks a JSON document whether it equals `'x'`.
`$checkWhere` reported nothing — the key IS a real field — so `autoFilter` passed
it through as a valid filter. The one shape a caller reaches for first was the
one shape that silently answered nothing.

The shorthand now says the same thing on both kinds of column — **the column's
value is in this list** — and the SQL stays an `IN` either way:

```sql
-- { status: ['active','pending'] }   "status" IN (?, ?)
-- { tags:   ['x','y'] }              EXISTS (SELECT 1 FROM json_each("tags") WHERE value IN (?, ?))
```

A scalar has one value to test; an array column supplies its elements. On an
array column that is `hasSome`, reached without a new word.

**It is deliberately not `equals`, which is where Prisma reads it the other way.**
Both readings can be silently wrong for a caller who meant the other, but they
fail in opposite directions: `equals` fails to *zero rows*, the shorthand fails
to *too many*. A wrong empty result is the failure this change exists to remove,
so re-introducing one as the default reading would have been the wrong trade.

### What came with it

| | |
| --- | --- |
| `equals` | new. `json(col) = json(?)` on an array column, ordinary equality on a scalar. `json()` on both sides so a row a JS migration wrote as `[ "x", "y" ]` still matches |
| `hasNone` | new. The counterpart to `hasSome` |
| `not: [...]` | fell into `col != ?` with one placeholder and N bindings, so SQLite answered *expected 1 values, received 2* — about placeholder counts, naming neither the field nor the reason. Now NOT-equals on an array column, `NOT IN` on a scalar |
| `has`/`hasEvery`/`hasSome`/`isEmpty` on a scalar column | raised `malformed JSON` from `json_each`, naming neither the field nor the operator. Now refused by name |
| `{ tags: [] }` | emitted `IN ()`, which is not valid SQLite. Now matches nothing, like `in: []` |

`equals` and `not` compare the whole document and are therefore
**order-sensitive** — `['y','x']` does not match a row stored `['x','y']`. That
matches PostgreSQL array equality, and so Prisma's.

### The plumbing

`buildWhere` could not tell the two readings apart, because they are the same
shape: `{ id: [1,2] }` and `{ tags: ['x','y'] }` differ only in what the column
is. It now takes an `arrayFields` set for the model, built once by
`buildArrayMap` beside the bool and enum maps, and threaded to every path that
builds its own WHERE — `delete`, `deleteMany`, a relation filter (the TARGET
model's set), an `include` filter, and a `_count` include.

## 2026-08-11 — a set of enum values is a column

`targets ReclaimTarget[]` was refused at parse time, so a declared vocabulary of
MANY values had no home in the seed. An app wrote `String[]` and validated the
members somewhere else, or declared the enum anyway and kept two homes with
nothing joining them — which is how `AlertRule.severity` came to default to a
value its own API refused.

```prisma
enum ReclaimTarget { logs  cache  artifacts }

model ReclaimRule {
  id      Int @id
  targets ReclaimTarget[]
}
```

One declaration now feeds the column (JSON TEXT under the same
`json_type = 'array'` CHECK every array carries), the generated type
(`ReclaimTarget[]`), the JSON Schema and the picker. The `$ref` goes on the
**items** rather than the field — a picker reading the field's own schema would
otherwise offer one choice for a column that holds several. Every member is
checked on create and update, and the error names all of the bad ones.

**There is no membership CHECK and there cannot be.** Reading a JSON array's
elements needs `json_each`, that needs a subquery, and SQLite forbids a subquery
inside a CHECK. `enumCheck` returns null for an array rather than emitting
`IN (...)`, which would compare the whole document against one value and fail
every non-empty set. So the client is the boundary here, the same tier
`@minItems`, `@uniqueItems` and `Int[]` element typing already sit at.

### `@default` on an array field

`tags String[] @default("x")` parsed and migrated into a column whose own
default violates its own CHECK, then failed the first insert that relied on it
with `CHECK constraint failed` — naming the constraint, not the schema line.
A `@default` on an array field must now be a JSON array string; `@default("[]")`
still passes, `@default(a)` and `@default(1)` are schema errors.

## 2026-08-11 — a bulk write takes its columns from each row

`createMany` built one prepared statement from `Object.keys(rows[0])`, so row 0
decided what every other row was allowed to write:

```js
createMany({ data: [{ id: 1, title: 'a' },
                    { id: 2, title: 'b', subtitle: 'HELLO', views: 99 }] })
// → { count: 2 }, and row 2 has subtitle null, views 0. Nothing said.

createMany({ data: [{ id: 1, title: 'b', subtitle: 'HELLO', views: 99 },
                    { id: 2, title: 'a' }] })
// → SQLiteError: NOT NULL constraint failed: post.views
```

The same two rows, in the same call, either lost data or threw — on their order
alone, and one of the two was silent. A column absent from a later row was bound
as an explicit NULL, and that defeats the DDL `DEFAULT` that would have filled it.

Now one prepared statement per row SHAPE, cached by column list. A uniform batch
— the ordinary case — prepares exactly one and reports the SQL it always did.
Rows still insert in **caller order** rather than grouped by shape, because an
`@id @default(autoincrement())` is assigned in insert order and grouping would
renumber the caller's rows. `upsertMany` had the identical defect and is fixed
the same way, with the `ON CONFLICT DO UPDATE SET` clause derived per shape.

### A key set to `undefined` means absent

The same NULL bind hit one row with no batch involved: `{ views: form.views }`
off a form with no views field put a present-but-undefined key in the payload,
which became `views = NULL` and failed a NOT NULL column. `writeData` now drops
an undefined-valued key along with the unknown ones, so only `null` clears —
create, createMany and update alike.

## 2026-08-11 — `db` names main's path

`createClient({ db })` was consulted only to invent an implicit main when the
schema declared none. Against a schema that declares one it did nothing and said
nothing, so `db: ':memory:'` wrote the declared file and a test that believed it
was in-memory accumulated state across runs. basecamp carried a nine-line
comment warning about it instead of passing the option.

`db` now names main's path either way. Most specific wins:

| | |
| --- | --- |
| `databases: ':memory:'` | every SQLite database, plus a tmpdir per jsonl/logger one |
| `databases: { name: { path } }` | one named database |
| `db` | **main only** |
| `database main { path ... }` | the declaration |

It reaches main and nothing else — a second declared database keeps its declared
path, which is the whole distinction between the two options.

## 2026-08-11 — a migration only drops what litestone named

An index created outside the schema — in a JS migration, or straight against the
database — was live-and-not-pristine, which lands in `indexes.dropped`. Since
`hasChanges` counts that list, **its presence was itself the change**. Measured:

```
1 first autoMigrate    : in-sync
2 app adds an index    : ["note_title_idx"]
3 restart, same schema : in-sync   ["note_title_idx"]     ← survives
4 an UNRELATED nullable column added
                       : migrated  []                     ← gone
```

The DDL-hash fast path is what hides it. The index survives every restart until
someone makes an unrelated change, and dies with it. No error, no rebuild — a
query plan collapses and the app is only slower.

Every index litestone generates for a model table is `idx_<table>_<fields>`, so
the prefix is what it owns. Removing an `@@index` still drops `idx_note_title`;
`note_title_idx` is now left alone. An index the app happens to name
`idx_<table>_…` is still litestone's, since that is the name litestone would
generate for the same declaration.

**A rebuild is a separate matter and stays unsupported.** It drops the table,
which takes every trigger and index on it; litestone's own are regenerable and
restated, and the app's exist only in the live database. Rather than lose them
silently, the generated migration now names them before the SQL that destroys
them:

```sql
-- "note": this rebuild DROPS the table, which destroys:
--     trigger "note_audit"
--     index "note_title_idx"
-- Litestone did not create these and cannot restate them — recreate
-- them below, or in a JS migration that runs after this file.
```

`FJS-187` fixed; `FJS-183` ruled and left open to revisit. 4 tests,
mutation-checked.

### A `view` over a model made that model impossible to migrate

A rebuild ends in `ALTER TABLE "note__new" RENAME TO "note"`, and SQLite
reparses every view in the schema on a rename. A view still pointing at the
table the rebuild just dropped is an error:

```
model Note { id Int @id  title String  scratch String }
view NoteV { title String  @@sql("SELECT title FROM note") }

→ drop `scratch`
→ SQLiteError: error in view NoteV: no such table: main.note
```

Litestone's own `view` declaration against litestone's own migrations. Declare
one over a model and that model could never drop a column, change a type,
change a foreign key or change `@@strict` again — the migration failed
identically every time, naming the view rather than the cause. A hand-made view
did the same.

**A view is not in the trigger's class.** It is a stored `SELECT` with no state
and no side effects, so it can be dropped before the rebuild and put back
verbatim after, which is now what happens — schema-declared and app-created
alike. A view the schema redefines in the same migration is left to the
changed-views block instead, since restating its old body would fail on exactly
the change the new body was written for.

One sharp edge closes with it. SQLite does not resolve a view body at `CREATE`
time, so a view over a column the rebuild dropped comes back without complaint
and fails in whatever reads it. Each restored view is now read once inside the
migration's transaction, so a view the change invalidated refuses the migration
rather than surviving broken. That cannot catch a body written `SELECT
"scratch"` with the column double-quoted — SQLite resolves an unknown
double-quoted identifier as a string literal and reports nothing, the same trap
`rebuildSQL` already carries a comment about.

`FJS-188`. 6 tests, mutation-checked.

## 2026-08-11 — a `@computed` field may declare what it reads

`applyComputed` iterated the whole extension map and knew nothing about
`select`. Measured on a model with two computed fields:

```
findMany({ select: { id: true, title: true } })
→ both fns ran, over rows carrying only id and title, and both results
  were then thrown away by trimToSelect
```

The waste is the smaller half. The row those fns received was the one the select
had already narrowed, so a fn reading an unselected column saw `undefined` and
answered something plausible. That is the third appearance of one failure: the
same shape was chased across `findManyCursor` and all three `include` shapes,
and again across a relation `orderBy`, both times as a missing `@from` field.
Here the select path itself was the narrowing.

A computed field outside the caller's select is no longer computed. That removes
the waste and the partial row together — there is no path left on which a fn
runs over a row shaped by a select that did not ask for it.

The other half is the fetch. Selecting a computed field set `needsAllDbCols`, so
the SQL widened to `SELECT *`, which defeats a covering index, decrypts
`@encrypted` columns nobody asked for, and emits **every** `@from` correlated
subquery on the model — the `*` branch is what appends them, so three `@from`
fields cost three subqueries per row for a computed field needing none.

A fn may now declare its inputs:

```js
export default {
  Client: {
    chattiness: { needs: ['noteCount'], compute: row => row.noteCount * 2 },
  },
}
```

The SELECT carries exactly those names, a `@from` among them emits just that
subquery, and all of them are trimmed from the result — asking for a computed
field does not smuggle its inputs back. A bare fn keeps the old behaviour and
the old `*`, because undeclared has to mean *fetch everything*; one bare fn in a
select widens it for the declared ones too.

**The declaration is enforced rather than trusted.** The row a declared fn
receives carries exactly the declared names and reading anything else throws,
naming the field and the list. Without that, adding a line to the fn and
forgetting the list would answer `undefined` — strictly worse than fetching
every column, and the same silence the first half of this change exists to end.
`in` is left alone, so feature-detection still works. A `needs` naming something
that is not a readable field of the model is refused at `createClient`, where
the list is written, rather than at a read that would answer nothing.

Narrowing reaches `findManyCursor` and `search()`, which build their own
SELECTs, and a nested `select` under an `include`.

`FJS-184`, `FJS-185`. 16 tests, mutation-checked.

### Found by it: `search()` dropped every row when the select omitted the id

`search()` runs two queries — the FTS5 table for `rowid` + `rank`, then the base
table for the rows, rejoined by id to restore rank order. The second took the
caller's `select` verbatim, so:

```
db.message.search('sqlite', { select: { title: true } })   → []
```

No error, no partial answer: *no results* for a query that has them, and the
more precisely a caller asked the more completely it failed. Pre-existing and
unrelated to the change above, but found by it — narrowing a computed field's
fetch is what makes an id-less select common rather than rare. The id is now
injected when a narrowed select omits it, and dropped again by the trim.

`FJS-186`. 3 tests.

## 2026-08-11 — `@@softDelete` + `@@fts` corrupted the index on every soft delete

Found while splitting a test fixture in two to avoid it. The pair was unusable:

```
db.note.remove({ where: { id: 1 } })
→ SQLiteError: database disk image is malformed   (SQLITE_CORRUPT_VTAB)
```

Two triggers fired on one soft delete. An unconditional `AFTER UPDATE` one
issued `'delete' old` and re-inserted `new`; an `AFTER UPDATE OF "deletedAt"`
one issued `'delete' old` a second time. FTS5 reports a repeated delete of one
docid as a malformed database — a message naming neither the model, the FTS
table, nor the two attributes that could not both be declared, so it read as a
broken file rather than an unsupported combination.

**It only raises when the extra delete empties the structure.** With more than
one indexed row the second delete was swallowed and the row stayed in the index,
which is why nothing caught this and why the original report said *every*
`remove()` throws. So the triggers never achieved the live-only index they were
written for either: `search()` was correct only because it filters again in its
own `WHERE`.

That second filter is now the only one. The index mirrors the table, the two
extra triggers are retired, and the trigger set no longer branches on
`@@softDelete` at all — one owner for "is this row visible", which is the rule
the rest of the package already follows.

Three things follow from it:

- **`withDeleted` / `onlyDeleted` on `search()` work.** They were documented and
  accepted, and could not do anything: the rows they asked for were not in the
  index to find.
- **`rebuild` agrees with the triggers.** It reindexes straight from the content
  table, so it can only match an index that mirrors that table. A live-only
  index silently disagreed with its own rebuild.
- **`search()` narrows before the FTS `LIMIT`.** Soft-deleted, template and
  `where`-excluded rows used to spend slots that step 2 then discarded, so a
  search for 20 answered 13 with nothing to say why, and `offset` paged index
  entries rather than matching rows.

The fixture that found this now carries both attributes on one model. Two
fixtures, each exercising one attribute, is exactly what hid it.

## 2026-08-11 — a trigger could never migrate, and a rebuild destroyed every one

Both found fixing the above, and both are why that fix would otherwise have
reached new databases only.

**`introspect()` recorded no triggers.** Tables, columns, indexes, foreign keys,
STRICT and views were all read back; triggers were not. So `diffSchemas` could
not see one and `generateMigrationSQL` could not emit one — every database that
already existed kept the broken trigger pair while the diff reported the schema
in sync. Triggers now travel in `__triggers` beside `__views` and compare on
normalised SQL.

**A table rebuild dropped every trigger and put none of them back.**
`rebuildSQL` is the standard SQLite rewrite — create `_tmp`, copy, `DROP TABLE`,
rename — and dropping the table takes its triggers with it. A model came out of
an ordinary column-drop migration with an FTS index that had stopped updating
and an `updatedAt` that had stopped being stamped. Writes still succeed and
searches still return rows, so there is nothing to notice. A rebuilt table now
has its generated triggers restated afterwards.

Only names Litestone generates are ever dropped — `*_fts_*`, `*_updatedAt`. A
trigger the app wrote is not in pristine, so nothing here drops it. It is still
lost by a rebuild, which is `FJS-183` and stated in `docs/migrations.md` rather
than fixed silently.

## 2026-08-11 — `@from` read the target model the wrong way, twice; `orderBy` validated nothing

Three defects found in one sitting, by trying to build a CRM "chattiness" score:
a per-client count of notes, messages and call logs, divided by the account's
age. That is `@from` for the counts and `@computed` for the ratio, which is the
shape the package already recommends, and all three of these were on the path.

**A `@from` ignored the target model's own defaults.** `@from(Note, count: true)`
counted soft-deleted rows and template rows. Every schema therefore had to write
`where: "deletedAt IS NULL"` by hand on every derived field — a default nobody
remembers on the second model, and one that goes silently wrong rather than
loudly. `include: { _count: true }` over the same relation had injected both
filters since it was written, so the two counts of one relation disagreed:

```prisma
model Client {
  noteCount Int @from(Note, count: true)   // counted deleted notes
  notes     Note[]
}
// db.client.findMany({ include: { _count: true } })  → _count.notes excluded them
```

A `@from` now reads the target the way the target is read. `withDeleted: true`
and `withTemplates: true` opt back in, named for the `findMany` args rather than
inventing a second vocabulary, and an explicit `where:` still composes on top.
An existing `where: "deletedAt IS NULL"` becomes redundant, not wrong.

**A `@from` did not survive a relation `orderBy`.** The correlated subquery names
the outer table, and a relation orderBy aliases that table to `t`, so the two
disagreed — in two different registers depending on what the caller selected:

```js
db.author.findMany({ orderBy: { books: { _count: 'desc' } } })
// → every @from field undefined, and a @computed field reading one
//   computed from undefined, in silence

db.author.findMany({ orderBy: { books: { _count: 'desc' } }, select: { bookCount: true } })
// → SQLiteError: no such column: author.id
```

Both variants of every subquery are built at schema load now, and the query
picks by whether it aliased. The WHERE clause needs the same choice, and the
alias question is not the join question — a relation *aggregate* orderBy adds an
order part and no join, which is the case that was still wrong after the SELECT
list was fixed.

**`orderBy` validated nothing at all.** `orderBy: { bogusColumn: 'desc' }` was a
silent no-op: rows came back in insertion order, no warning anywhere, not even
the stderr line that `where` prints. The same silence covered `@computed`, which
cannot be sorted at all — it is a JS function over a row, so SQLite can neither
sort nor paginate by it — so a list "sorted by" a derived score was ordinary
rows in arbitrary order, and page 2 of it was plausible and wrong.

This half does **not** inherit `checkWhereKeys`'s warn-on-read split. A bad
filter key returns fewer rows, which the caller can see; a bad sort key returns
the right rows in the wrong order, which nothing can see. Both now throw, naming
what is sortable, and separating the two refusals — a field that does not exist
gets a typo suggestion, a `@computed` field is told why it cannot be sorted and
what to do instead. A `@from` field sorts, as it always did.

`db.$checkOrderBy(accessor, orderBy)` is `$checkWhere`'s sibling and carries the
identical contract: ask before you query, an unknown accessor answers `[]`
because *I cannot judge this* is not *this is wrong*, and every flavour of client
answers identically, because sortability is a fact about the schema that auth and
scope cannot change. Junction's `autoSort` calls it and answers 400.

**And `@from` turned out to exist on one read path only.** `findManyCursor` and
`resolveIncludes` build their own SQL below the query pipeline, so neither ever
appended the subqueries — the field was absent, not wrong:

```js
await db.author.findMany()                            // { id, name, bookCount: 2, score: 10 }
await db.author.findManyCursor({ limit: 10 })         // { id, name,               score: 0  }
await db.book.findMany({ include: { author: true } }) // author: { id, name,       score: 0  }
```

Absence is the dangerous half. `applyComputed` runs either way, so a `@computed`
field over a missing `@from` field answered a plausible `0` rather than throwing
— the same row read two ways gave two different numbers, and neither complained.
Selecting the field by name on those paths answered `{}`.

Closed the way `@from` under an alias was: `fromSelectExpr()` and
`deserializeFromRow()` are module-level, `fromMap` is on `ctx`, and the four
sites ask instead of growing a fourth copy of the rule. The m2m include needed
the aliased variant, since it selects `t.*` beside the join table. Both halves of
the shaping were missing and only one of them is visible — without the SELECT
expression the field is absent, without the deserializer a `@from(X, last: true)`
arrives as the JSON string SQLite returned.

Walking every method that returns a row found two more of the same, and they
are closed too. `search()` builds its own step-2 SELECT. And **every write
returned a row with no `@from` field at all** — `RETURNING` is table columns
only, SQLite cannot put a correlated subquery there:

```js
await db.author.findUnique({ where: { id: 1 } })      // { …, bookCount: 2, score: 10 }
await db.author.update({ where: { id: 1 }, data: {} }) // { …,               score: 0  }
```

That is the one that reached furthest. Junction returns `table.update()`
straight through, so the PATCH response *and* the `svc updated` broadcast built
from it both carried the degraded row — every open tab replaced a correct row
with it.

Writes now re-read the `@from` values before shaping. One extra SELECT, only
for a model that declares `@from`, and only on write paths that opt in — a read
already carries the values, and hydrating whenever a key happened to be missing
would fire a query per row for a `select` that legitimately excluded them.
`delete` needs no extra query: it already reads the row before the DELETE, which
is the only moment the values still correlate to anything.

## 2026-08-11 — `restore()` answers the rows

It returned `{ count }`. `index.d.ts` declared `Promise<TRow | null>` and
`CLAUDE.md` documented `row[]`; three sources, three answers, and the
declaration was the wrong one in the direction that typechecks —
`(await restore(…)).id` compiled and was `undefined`.

The rows were there the whole time: `restore` runs `UPDATE … RETURNING *` and
threw them away to count them. It now answers the array, which is what `where`
matching many implies and what `remove` already does with its row. They are
also **shaped** — the RETURNING rows had never been through `read()`, so had
they been returned before they would have carried unparsed Json, `0`/`1` for
booleans, and no computed or `@from` fields.

Breaking for a caller reading `.count`. One existed: this package's own
audit-trail suite.

64 tests, mutation-checked — 45 fail on revert. Proven by `example`: `verify`
(37) and `verify:jobs` (8), `basecamp`: `verify` (270), `sierra`: `test:safety`.

## 2026-08-10 — an `include` enforced nothing the model declared

Every access rule in the package held on a direct read and none of them survived
being reached as somebody's child:

```js
await db.$setAuth(u).vault.findMany()
// AccessDeniedError: "Vault.read" requires level 7, user has level 4

await db.$setAuth(u).team.findMany({ include: { secrets: true } })
// → every Vault row, @guarded(all) columns in plaintext
```

Four rules, one hole. `@@gate` never fired, because it fires in `onBeforeRead`
for the model being addressed. `@@allow`/`@@deny` never filtered, so a tenant
scoped out of a row still received it as a parent's child. `@guarded` and a
field `@allow` were never applied, and `@encrypted` came back as raw ciphertext
— which also meant `asSystem()` did **not** decrypt it, the same bug pointing
the other way.

The cause is one shape: `resolveIncludes()` builds its own SQL and bypasses the
query pipeline for speed, which is why the soft-delete and `@@hasTemplates`
filters in it are hand-appended. Nothing hand-appended the access rules. No test
in 1462 asked a policy question through an include, and the docs promise the
opposite in as many words — *there is no path to unfiltered data except
`asSystem()`*.

Three owners, because the three rules answer at different times:

- **The gate is a preflight**, in `GatePlugin.onBeforeRead`, walking `include:`,
  `select:` and `_count` down the tree. It has to be a preflight rather than a
  filter: `getLevel` is async and the include resolver is not. It also has to
  **refuse** rather than return nothing — a gate is per model, so an empty list
  would read as *no rows* instead of *not for you*. The nested-WRITE preflight
  beside it has done exactly this since gates existed; reads were the direction
  nobody mirrored.
- **The row policy is compiled in**, into all three relation SQL shapes and both
  `_count` shapes. The m2m branch takes it as a subquery over the target alone,
  because there the target is aliased `t` beside the join table and the policy
  compiler emits unqualified column names.
- **The field rules moved out of the closure.** `applyFieldPolicyTo(row,
  modelName, …)` is now module level, so a path holding rows of a model that is
  not its own can ask for them — one definition instead of the two that drifted.

13 tests, mutation-checked: 10 fail on revert, 3 are controls. 1480 pass. Found
by declaring `@@allow` on one model of `basecamp`'s 37 and asking what would
have to be audited first — the answer was the `include` graph, and the graph
turned out not to matter, because nothing in it was enforced.

## 2026-08-10 — implicit many-to-many only ever worked on `Int @id` named `id`

```
model Post { slug String @id  tags Tag[] }
model Tag  { code String @id  posts Post[] }
```

The join table came out as `"postId" INTEGER NOT NULL REFERENCES "post"("id")`
whatever the models said. Two shapes, two different failures.

**A uuid key failed loudly**, which is the better half: STRICT refuses the TEXT
and the first `connect` dies with `cannot store TEXT value in INTEGER column
_post_tag.postId` — an error naming a table the author never wrote.

**A key named anything else failed silently.** Join rows are written `INSERT OR
IGNORE`, so connecting twice is idempotent — and OR IGNORE swallows a NOT NULL
violation exactly as happily as a duplicate. `.id` on a row keyed by `code` is
`undefined`, so `connect` returned the created row, wrote nothing, and the
relation read back empty. Forever.

The fix is one fact carried instead of assumed: `detectM2MPairs` now puts each
side's `@id` **name and SQL type** on the pair, and the relation map carries
`selfPk` / `targetPk` to the six runtime sites that each had their own `t."id"`
— the include join and its policy subquery, `_count` in both directions, the
relation-filter correlation, the aggregate `orderBy`, and the
connect/disconnect/set/delete writes. The `@edge` side table had copied the same
two DDL lines and takes the same treatment. A target row with no key now throws
by name rather than being ignored.

Nothing here caught it because nothing here uses the feature: `basecamp` writes
an explicit join model all three times it needs one, and `sierra/example` is the
only implicit m2m in the repo — keyed `Int @id`. 4 tests, mutation-checked in
both halves.

**Upgrading an existing database**: join tables are invisible to introspection
(underscore prefix), so a migration emits them `IF NOT EXISTS` and never alters
one. A database created before this keeps its `INTEGER` table and the same
failure. Drop it and re-run the migration — it is provably empty, since no
insert into it could ever have succeeded on the schemas this affected.

## 2026-08-10 — a refused update stayed applied

`@@allow('post-update', …)` is the rule that catches a write which was legal
when it started and illegal once it landed — moving a row out from under its
owner. It rolled the write back by writing the before-snapshot's columns back
one by one, and that snapshot came from `read()`, where a Json column is an
object. A SQLite parameter cannot be an object:

```
TypeError: Binding expected string, TypedArray, boolean, number, bigint or null
```

Two failures out of one line. The `AccessDeniedError` never reached the caller —
a binding error did, naming nothing they had written — and **the update the
policy had just refused was left in the database**, because the throw happened
before the revert.

`read()` was the wrong snapshot for the job in two further ways: it adds
computed and `@from` fields that no `UPDATE` can name, and it strips `@guarded`
ones. The rollback now reverts from the raw row, whose keys are the table's
columns exactly. `beforeRow` stays read-shaped, for the audit snapshot that
wanted it that way.

It surfaced the first time a model with Json columns declared a policy —
`basecamp`'s `Server`, where *move this server into another workspace* is the
exact thing post-update is there to refuse.

## 2026-08-10 — a transaction dropped the scope it was started from

`db.asSystem().$transaction(tx => tx.account.create(…))` was refused by the
`@@gate` it was meant to bypass. The callback received the **root** client:
every scoped proxy — `asSystem()`, `$setAuth(u)`, `$scopedBy()` — exposed the
root `$transaction`, which hands `fn` the unscoped `clientProxy`.

It fails in opposite directions on the two flavours, and only one of them is
loud. As system, the body is refused by a level it should never have been asked
about. As a user, nothing throws at all: `auth()` is null inside the
transaction, so every `@@allow` matches nothing and every `@createdBy` stamps
nobody — which reads as a bug in the transaction body.

Each proxy now passes ITSELF; the root is unchanged. The `query()` batcher on
those same proxies already did this and carried a comment explaining why —
`$transaction` was the one that did not.

Nothing had noticed because no schema in the repo carried both a transaction and
a gate until `basecamp` declared its levels. Its first-run `POST /setup` writes
four models in one transaction as system, and failed on the very first request
of the drive with *"Account.create" requires SYSTEM access (use asSystem())* —
about a call that was using `asSystem()`. 3 tests, including the quiet policy
case; 1461 pass.

## 2026-08-07 — raw SQL could not write, and had never been able to

`db.asSystem().sql` is the documented — and on any schema declaring access
rules, the *only* — way to run a raw statement. **Every raw write through it
failed**, with `SQLITE_READONLY: attempt to write a readonly database`: a
message about a connection, naming nothing the caller wrote.

`_runRawSql` sent every statement to `readDb`, which is opened `readonly` with
`query_only = ON`. That is right for `SELECT` and wrong for everything else, and
the three surfaces that call it (`db.sql`, `db.$setAuth(u).sql`,
`db.asSystem().sql`) all inherited it — as did **the system client a JS
migration is handed**, which is exactly the caller most likely to need a raw
`ALTER`/`UPDATE` and least able to route around it.

Statements now route by kind: `SELECT`/`EXPLAIN`/`VALUES` stay on the reader,
everything else goes to the writer, which reads perfectly well. `WITH` counts as
"everything else" on purpose — `WITH x AS (…) DELETE FROM …` is legal SQLite, so
a CTE cannot be assumed to be a read. Leading comments are stripped before the
test, so `-- why\nDELETE …` is not misread as an unrecognised statement.

Found in `basecamp`, hard-deleting a row to prove an FK cascade fires — the one
thing `.remove()` cannot do on a `@@softDelete` model. 3 tests; 1454 pass.

## 2026-08-07 — `docs/jsonschema.md`, and `--stdout` that actually pipes

The JSON Schema this package generates is the wire the other two realms are
built on, and **nothing documented what it emits.** `x-messages`, `x-relations`,
`x-gate`, `x-transitions` and `x-version` were described in the repo's bridge
index because a consumer needed them; the other eight extensions were not
described anywhere. `docs/jsonschema.md` is now the full reference — every
standard keyword, every `x-`, which mode and audience produces it, and **who
reads it**. That last column is the useful one: `x-litestone-policies`,
`x-litestone-read-policy`, `x-litestone-from`, `x-litestone-secret` and
`x-litestone-guarded` are emitted and read by nothing at all.

Every snippet in it was generated, not written. The fixture that produced them
is at the foot of the doc, because no app in the repo exercises the whole
surface — `example` has no `File`, `Bytes`, `@from` or `@version` field, and
`basecamp` declares no `@@gate`.

Two things the writing found:

**`litestone jsonschema --stdout > schema.json` produced invalid JSON.** The
banner is printed with `console.log`, so `litestone jsonschema` landed at the
top of the file being piped. `litestone types --stdout` had it too, writing the
banner into the `.d.ts`. Both now suppress the header when `--stdout` is set.

**`--include-computed` did nothing.** The CLI read the flag and passed
`includeComputed` through; `generateJsonSchema` never destructured it. Derived
fields are governed by `mode: 'full'` alone, so the flag was removed rather than
implemented — the mode already means "everything readable". It is gone from the
CLI help and from this package's `CLAUDE.md`, which had also listed it.

## 2026-08-06 — `$checkWhere` on every client, not just the root one

1451 tests (was 1450). `FJS-117`.

It was written **inline in the top-level proxy's `get` trap**, so the three
derived clients — `$setAuth`, `asSystem`, `$scopedBy` — did not have it. And a
Litestone proxy *throws* on an unknown property rather than answering
`undefined`, on purpose, so a typo'd accessor is loud:

```js
db.$checkWhere                    // → function
db.$setAuth(user).$checkWhere     // → Error: "$checkWhere" is not a table in this schema
```

Junction hands a service the `$setAuth` client on `ctx.locals.db`, so its
`autoFilter` hook could not even *ask whether* the method existed without
throwing. **Every list read by a signed-in caller 500'd, in both apps**, naming a
table nobody had written.

It is now one function in `createClient` scope, handed to all four proxies and
pinned to give identical answers on each. Which keys are filterable is a fact
about the **schema**; auth and scope have no bearing on it, so there was never a
reason for the root client to be the only one that could say.

The shape of the mistake is worth more than the fix. Every test that touched
`$checkWhere` held the root client, so 1450 of them passed over a seam no real
request uses — and the browser symptom was **navigation**, not data: the page
committed the redirect and then threw while fetching, which read as a router
bug and was blamed on an unrelated change to another package.

## 2026-08-06 — `$checkWhere`: ask before you query

1450 tests (was 1443). The litestone half of `FJS-109`.

The ORM validates where-keys already, and the read/write split is deliberate: a
typo'd filter on a **write** is a mis-scoped destructive operation and throws,
while on a **read** it warns and returns nothing. That is right for a caller
holding the client. It is wrong one layer up, where the warning goes to the
server's stderr and the HTTP caller gets `200 {"data":[],"total":0}` — a typo, a
misplaced directive and an empty table wearing the same answer.

Rather than let Junction grow a second definition of "is this a valid filter
key" against JSON Schema — which would drift from this one on relation
sub-filters, `$raw`, edges and the AND/OR/NOT descent — the client now answers
the question:

```js
db.$checkWhere('product', { nme: 'a' })
// → [{ key: 'nme', suggestion: 'name', allowed: ['id','name','price'] }]
```

Same rule, same Levenshtein hint, same descent, but it neither warns nor runs a
query — pinned by a test that taps `$tapQuery` and `console.warn` and asserts
both stay empty. An unknown accessor returns `[]` rather than throwing: a caller
using this to reject a request must not reject what it failed to understand.

Nothing about the ORM's own behaviour changed. `findMany` still warns, writes
still throw.

## 2026-08-06 — the benchmark harness works again

No test change. `bun run bench` and `bun run bench:core` now exist; `FJS-112`
filed.

`bench/audit-bench.mjs` had not been run since the 2026-07-18 audit produced it,
and it had a broken case:

```
gate-getlevel FAILED: "posts" is not a table in this schema. Tables: post
```

A plural accessor against `model Post`. So the one measurement that proves the H4
fix — GatePlugin resolving `getLevel` once per scoped client rather than once per
operation, a cache with security-relevant behaviour behind it — had been silently
skipping for three weeks. It reports **0 calls across 200 gated reads**, which is
the pass condition.

Several annotations were fossils: they described the pre-fix behaviour of findings
fixed the same day, so a reader saw `0.3 ms/call` beside *"runs full pristine build
+ 2x introspection"*. Each now names the finding it verifies, or says **STILL
OPEN** — one does: JSONL `create()` is still `existsSync` + `statSync` +
`appendFileSync` per row, confirmed against `drivers/jsonl.js`.

Every fix from the audit still holds, re-verified rather than assumed —
`upsert()` issues ONE statement, checked with `$tapQuery` instead of inferred
from the timing.

**On reading the numbers:** a first pass looked ~2x worse than the audit on the
core path. It was not. Interleaving the same bench against the pre-session tree,
four rounds on one machine, put run-to-run spread wider than the delta, and a
later quiet run landed at 1.65 / 38.9 / 10.5 µs (`findUnique` / `findMany` 100 /
`create`) against the audited 1.28 / 38.4 / 9.2. Absolute µs across machines mean
nothing here; only an interleaved same-machine A/B does.

Also measured, since nobody had it: `@@createdBy` + `@@updatedBy` costs +21% on
create and +28% on update (partly two real FK columns, not only the stamp), and
`@version` +7% create / +35% update.

## 2026-08-06 — the client enumerates, and `asSystem()` stops lying

1443 tests (was 1437). Closes `FJS-014`, open since 2026-08-02.

`Object.keys(db)` threw. So did `Object.getOwnPropertyNames(db)`, `{...db}`,
`for…in`, and — the one that actually hurt — `JSON.stringify(db)`, which meant
logging a context blew up on a line that was not the bug.

The cause was two strings. `$setAuth` and `$db` were on the proxy target *and*
in the `ownKeys` trap's hand-written list, and a duplicate makes the **engine**
throw:

```
TypeError: Proxy handler's 'ownKeys' trap result must not contain
           any duplicate names
```

which names proxy internals and neither of the two responsible. All five traps
now go through one `dedupeKeys()` rather than having the two names deleted — the
literal lists have grown before, and the next property added to a target would
reintroduce it with no test able to predict which one.

### The quieter half, found by probing rather than by the report

`asSystem()`'s proxy had a `get` trap **and nothing else**. So it did not throw;
it answered wrongly:

```js
db.asSystem().user            // works
'user' in db.asSystem()       // false
Object.keys(db.asSystem())    // no tables at all
```

A guard reading `if ('user' in db)` silently skipped the table under a system
client — a wrong answer rather than a loud one, which is the worse of the two.
It now carries the same `ownKeys` / `has` / `getOwnPropertyDescriptor` traps as
every other scoped client.

### What it cost downstream

Junction wrapped its own `Object.keys(db)` in a `try/catch` with a ten-line
comment, because otherwise this replaced a *"your model name is wrong"*
diagnostic with a stack trace about proxies. The catch stays — `db` is whatever
the app handed to `createApp` — but the comment no longer describes a live bug,
and the list turned out to be wrong the moment it started working: it offered
`asSystem`, `sql` and `query` as model names. Junction now filters against
`$schema.models`.

Worth noting how it survived four days: every test of that message used a plain
object as the client, so the one path that mattered — a real Proxy — was the one
nothing exercised. There is now a test on each side, and junction's uses a real
Litestone client.

## 2026-08-06 — `@version`: the lost update is now a 409

1437 tests (was 1416). `IDEAS/declared-semantics.md` item 1, shipped.

Nothing in litestone carried a row version, so two people editing one order both
`PATCH`, both succeed, and the second silently erases the first — the oldest
silent-wrong-data bug there is.

```js
const alice = await db.order.findUnique({ where: { id: 1 } })   // version 1
const bob   = await db.order.findUnique({ where: { id: 1 } })   // version 1

await db.order.update({ where: {id:1}, data: { status: 'paid', version: alice.version } })
// → { status: 'paid', version: 2 }
await db.order.update({ where: {id:1}, data: { status: 'void', version: bob.version } })
// → VersionConflictError: expected 1, row is at 2
```

### The mechanism already existed

`@@transitions` has run a compare-and-swap since 2026-08-04:
`applyTransitionWhereClause` narrows the `WHERE` by the value it read, and no
rows changed means somebody got there first. `@version` is that with the column
unfrozen — the same *generalise the mechanism rather than add a second one* move
`cascading-fields.md` argues for `@@softDelete(cascade)`. The bump rides the
`SET`, which also means a versioned update always has a column to write.

### Where it applies, and where insisting would be wrong

| Path | Requires | Bumps |
| --- | --- | --- |
| `create` / `createMany` | — | starts at **1**, whatever the payload says |
| `update` | **yes** | ✓ |
| `updateMany` | no | ✓ |
| `upsert` / `upsertMany` | no | ✓ |

`update` is the concurrent-editor path. A bulk `where` matches many rows and so
many versions — there is no single value to compare — and an upsert is reached by
natural key from a sync or an import, which cannot have read one. **Both still
bump**, which is the half that matters: without it a bulk write would leave every
open editor's version looking current. Pinned by a test.

The `upsertMany` trap was worth catching: taking the version from `excluded`
would reset a live row to 1 and make every stale editor current again. It is
`"version" = "order"."version" + 1` instead.

### Two errors, because they mean different things

`VersionRequiredError` is **400, not retryable** — you left out an input, and the
identical request fails identically. `VersionConflictError` is **409 + retryable**
— re-read and re-apply is a real strategy. Both carry `status`, so Junction maps
them with no registration (verified: → `Conflict` 409 / `BadRequest` 400). Not-found
still returns `null`; a 409 means the row is there and moved.

### The rest of the surface

`asSystem()` skips the check and still bumps — a migration or a job is not a
second editor, the same reason it skips gates. The version travels in `data`
rather than `where`, because a Resource fetch carries every column and a form
round-trips it with no plumbing. It reaches the client as `readOnly` in the
update schema plus **`x-version`** naming the column, is absent from the create
schema, and typegen drops it from `*Create` and makes it **required** in
`*Update` — the type saying what the runtime does. One per model, `Int`, not
optional, not the `@id`; all four are schema errors.

**The client half landed the same day** — `createResource` remembers the version
of every record it reads and puts it on the next patch, so an app writes nothing.
See sierra's `CHANGES.md` (`FJS-105`).

## 2026-08-06 — the bulk write paths run the `ctx.auth` stamps

1416 tests (was 1408). Closes `FJS-092`, which was filed too narrow.

`upsertMany` stamped nothing from `ctx.auth` — not `@default(auth().id)`, not
`@createdBy`, not `@updatedBy`. Probing the whole table rather than the one
filed method turned up a second hole:

| Path | `@updatedAt` | `@updatedBy` | `@createdBy` / `@default(auth().id)` |
| --- | --- | --- | --- |
| `create` / `createMany` | ✓ | — | ✓ |
| `update` | ✓ | ✓ | n/a |
| `updateMany` | ✓ | **✗** | n/a |
| `upsertMany` | ✓ | **✗** | **✗** |

**`updateMany` was the worse of the two, and it wrote a wrong name rather than
no name.** `@updatedAt` is a SQL trigger (`ddl.js`), so the timestamp half of the
pair kept working on every path while the identity half — which needs `ctx.auth`,
which SQLite does not have — silently did not:

```js
await asBob.doc.update(…)       // updatedById: 2   ← Bob
await asAnn.doc.updateMany(…)   // updatedById: 2   ← still Bob, timestamp moved
```

A row reading *edited four seconds ago by Bob* when Ann edited it is worse than
a null: null says unknown, a stale name says something false in an audit shape.

### A conflict is an update

`upsertMany` needed more than a stamp call. `updateCols` defaults to every column
that is not the conflict target, so simply filling `createdById` would have put it
in the `ON CONFLICT … SET` clause and made every bulk upsert rewrite the original
author. Create-time columns are now held out of that clause — **but only the ones
we filled**. A column the caller supplied stays in, because naming it is an
explicit request and excluding it would change behaviour that predates the
stamps; an explicit `update: ['createdById']` moves it too.

### One owner for "ctx.auth → column"

The stamp was inline in four places with two different meanings mixed between
them. Now two functions, named for the distinction:

- `stampFromAuth` — the **principal wins**. `@createdBy`, `@updatedBy`.
- `applyAuthDefaults` — the **payload wins**. `@default(auth().field)`, which is
  a default and documented as one.

Neither fires without `ctx.auth`, which is what keeps `asSystem()` seeders,
imports and backfills able to carry an explicit author in.

8 tests; **4 fail if the stamps are removed.**

## 2026-08-06 — raw SQL goes through `asSystem()` when the schema declares access rules

1408 tests (was 1399).

`db.sql` reads the base table: no `@@gate`, no `@@allow`, no `@guarded`, no
`@scoped`, no `@@softDelete` — they are all enforced above SQLite. For a
deliberate escape hatch that is defensible. What was not is that it was the
**same function on every proxy**. `authSql` closed over `user` and never read
it, so it was byte-identical to the unscoped `sql` — while `authQuery`, directly
beneath it in the same closure, goes to real trouble to keep that same auth
context alive through `$transaction`. One preserved the scope; one silently
dropped it.

Measured on one model with `@@allow` + `@guarded` + `@@softDelete`:

```
$setAuth({id:1}).invoice.findMany()   → 1 row,  ssn absent
$setAuth({id:1}).sql`SELECT * …`      → 3 rows, ssn in plaintext, another
                                         owner's row and a soft-deleted one
```

### The unscoped client was the wider gap

An unauthenticated `db.invoice.findMany()` returns **0** rows — the policy
evaluates with `auth() == null` and matches nothing — while `db.sql` returned
all 3. So this was never "the scoped proxy drops its scope". Raw SQL ignored the
schema on *every* path and the ORM never does, and the anonymous path is where
the two disagree most. `IDEAS/scoped-sql.md` argued `db.sql` should be left
unchanged on the grounds that there is no identity to scope by; that is
overturned.

### The rule

| Surface | Schema declares access rules | It does not |
| --- | --- | --- |
| `db.sql` | **throws** | unchanged |
| `db.$setAuth(u).sql` | **throws** | unchanged |
| `db.asSystem().sql` | works — the documented bypass | works |

"Access rules" is `@@gate`, `@@allow`/`@@deny`, `@guarded`, `@encrypted`/
`@secret`, field `@allow`, `@scoped`. **Not** `@omit` or `@@softDelete` — those
shape what a read returns rather than who may read it, and refusing raw SQL for
a soft-delete column would fire on most schemas for a lifecycle rule.

### Coarse per schema, not per statement — on purpose

Deciding per statement means parsing the statement, and a hand-written SQL
validator that is subtly wrong grants a **false** guarantee, which is worse than
an honest raw hatch because people trust it. The escape routes are numerous and
all real: `main.`/`temp.` qualification, `ATTACH` (which this client exposes on
the proxy), `PRAGMA`, views created mid-statement, comment and string-literal
tricks. SQLite's own authorizer would be the right mechanism and **`bun:sqlite`
does not expose it** — verified, `Database` has no `setAuthorizer`.

### The refusal names both ways forward

`asSystem().sql` to bypass deliberately, or stay on the ORM — and for an
expression the query builder cannot express, `where: { $raw: sql\`…\` }` keeps
every policy. Verified rather than assumed: through `$raw` a scoped caller still
gets 1 row with the `@guarded` column withheld.

Also: three byte-identical copies of the raw runner (`sql`, `sysSql`, `authSql`)
collapsed to one.

9 tests; **5 fail if the refusal is removed**. The first caller it caught was
this package's own `@encrypted: stored as ciphertext in DB`, which peeked at a
raw column with `db.sql` — a genuine bypass, now saying so. Ruled in
`DECISIONS.md` § Access control. **Scoped raw SQL — the per-identity view set in
`IDEAS/scoped-sql.md` — is deliberately not built**; revisit with `herald`.

## 2026-08-06 — the audit log can record a String actor

1399 tests (was 1396).

The synthetic audit model declared `actorId Int`, and the jsonl driver's
companion index is a STRICT table. So the first audited write with a known actor
threw

```
SQLiteError: cannot store TEXT value in INTEGER column auditLogs_idx.actorId
```

and took the request with it. **Every FrontierJS app is exposed**:
`@frontierjs/auth` issues `id String @id @default(uuid())`, so its users are
uuids, and `@@log(audit)` on any model then fails on its first write by a
signed-in caller.

It was invisible until the same afternoon, and for a precise reason: Junction
handed the Data boundary a principal with no `id` at all, so `actorId` was always
null — and NULL fits an INTEGER column. Fixing that (junction's
`toDataPrincipal`) uncovered this. Two defects, one masking the other.

`actorId` is now `Any` — a real SQLite STRICT column type, and the honest one:
the trail records whoever the host app keys its users by, which is an Int in one
app and a uuid in another. The `.jsonl` itself was always untyped JSON.

**An existing index is rebuilt, not abandoned.** `CREATE TABLE IF NOT EXISTS`
does nothing to a table that already exists, so an index built before the type
changed would keep the old column and keep failing against a schema that no
longer explains it. The driver now compares the declared column types against
`pragma_table_info`, drops the table when they disagree, and **refills it from
the `.jsonl`** — which has every line and every byte offset. Dropping without
refilling would have been worse than the error: an audit trail that silently
looks shorter.

Found by `example/`, whose orders and customers are `@@log(audit)` and whose
users are auth's uuids.


## 2026-08-06 — `@encrypted` works on a `Json` field instead of destroying it

1396 tests (was 1387).

`@encrypted` on a `Json` field **silently destroyed the value**. `encryptField`
does `String(plaintext)`; an object stringifies to `'[object Object]'`, and what
went into the column was a faithful AES-256-GCM ciphertext of that literal
string. Nothing threw. The row looked correctly encrypted. The original was
unrecoverable.

```js
await db.vault.create({ data: { blob: { secret: 'hunter2', n: 42 } } })
// before → "[object Object]"
// after  → { secret: 'hunter2', n: 42 }
```

`ISSUES.md` FJS-006, S1. It had been "mitigated" by a `CLAUDE.md` hazard note
telling people to declare `String @encrypted` and serialize by hand — that note
is now removed.

### The fix is two points, because the pipeline is already symmetric

The write path encrypts and *then* serializes (`serializeRow(..., jsonFields)`);
the read path parses and *then* decrypts (`read()` → `applyFieldPolicy`). So a
Json field only needed its own serialization stepped inside the encryption:

- **encrypt:** `JSON.stringify(val)` before `encryptField`, so what is encrypted
  is text rather than `String(object)`.
- **decrypt:** `JSON.parse` after `decryptField`, mirroring it.

Keyed on the **declared** type — `json: field.type?.name === 'Json'`, captured in
`buildFieldPolicyMap` beside the other per-field facts, because neither call site
has the schema in scope. Keying on "the value looks like JSON" would have parsed
a `String @encrypted` field that happens to hold `{"a":1}`.

### What is covered

Objects, nested structures, arrays, and the JSON scalars (`string`, `number`,
`boolean`) — the scalars matter because `String(plaintext)` handled *those*
correctly, so a fix that only special-cased objects would have passed the obvious
tests and quietly double-encoded the rest. `null` stays null. `@secret`,
`$rotateKey` and `@encrypted(searchable: true)` all verified on a Json field; an
unencrypted Json field on the same model is untouched, and `@encrypted` still
implies `@guarded(all)`.

Verified beyond round-tripping: the stored column is ciphertext, and the
plaintext does not appear anywhere in the database file. A round-trip test alone
would also pass if the field were simply not being encrypted.

### Legacy rows read as the broken string, not null

Data written before this is already lost and cannot be recovered. A parse
failure therefore leaves the decrypted value alone rather than nulling it: `null`
reads as "this was empty", `'[object Object]'` reads as "something went wrong
here", and only the second sends anyone looking.

9 tests; **4 fail if the fix is reverted**.

## 2026-08-06 — authorship is one line, and cannot be forged

1387 tests (was 1370).

`@@createdBy` and `@@updatedBy` on a model each expand at parse time into the
pair of fields you were writing by hand:

    model Doc { id Int @id  title String  @@createdBy  @@updatedBy }

    // → createdById Int?  @createdBy
    //   createdBy   User? @relation("Doc_createdBy", fields: [createdById], references: [id])
    //   updatedById Int?  @updatedBy
    //   updatedBy   User? @relation("Doc_updatedBy", fields: [updatedById], references: [id])

Pure desugaring — nothing downstream knows the attribute existed. DDL emits both
foreign keys, `include: { createdBy: true }` resolves, typegen and JSON Schema see
ordinary fields. The FK type is copied from the `@@auth` model's `@id`, so an `Int`
id and a `String @default(uuid())` id both land right. `@@createdBy(owner)` renames
the pair. A field you already declare under either name wins and is left alone.
Without a model marked `@@auth`, both are a schema error — the same ruling
`@scoped` already makes.

**The field-level `@createdBy` is new, and it is a stamp, not a default.** The
obvious expansion was `@default(auth().id)`, and probing it is what killed that:

    const asAnn = db.$setAuth({ id: 1 })
    await asAnn.doc.create({ data: { title: 'x', createdById: 2 } })
    //  → createdById: 2      ← Bob. A default loses to the payload.

Authorship you can forge by adding a key to the request body is not authorship.
`@createdBy` overwrites instead, matching `@updatedBy`, which had these semantics
all along. Both are skipped entirely when `ctx.auth` is null, so `asSystem()`
writes, seeders and backfills still carry an explicit author in — that is the
only way a migration can.

Stamped on `create`, `createMany` and both `upsert` paths; the upsert fast path
stamps the INSERT branch only, so a conflict does not rewrite the original
author. `upsertMany` and `updateMany` were the two paths that stamped nothing —
see the entry below, which closes that as `FJS-092`.
`generateFactory` skips both attributes, and typegen drops them from the
`*Create` interface: a value there loses to the principal anyway.

## 2026-08-05 — every bulk write reaches the audit trail

1370 tests (was 1362).

`updateMany` and `deleteMany` on a model declaring `@@log` wrote **no audit entry
at all** — not an entry without snapshots, no entry. Both called `fireQuery` and
never `emitLogs`, and so did `removeMany`, `restore` and `upsertMany`. Probed
rather than read:

    createMany 3 rows · updateMany 3 · deleteMany 3   →  entries: 2 (the creates)

Two bulk writes destroyed three audited rows and the trail said nothing happened.
An append-only trail that omits the most destructive operation in the API is worse
than no trail, because it is trusted.

All five paths now log. `createMany`'s entry named no rows for the same underlying
reason — an `@id @default(autoincrement())` row has no id until SQLite assigns one,
and the entry was built from the pre-insert data — so the bulk paths take
`RETURNING` on a logged model and name their rows by id. An unlogged model is
untouched: the `RETURNING` path is guarded by `tableHasAnyLog`, so `run()` still
serves the common case.

Details worth knowing:

- **A bulk write records which rows and what operation, never contents.**
  `before`/`after` stay single-row-only, as documented. Naming the rows is what
  makes the trail complete; snapshotting a million-row update is a different
  feature with a different cost.
- **`upsertMany` splits its batch** into a `create` entry and an `update` entry.
  It looks up which conflict keys already exist *before* writing — one prepared
  `SELECT` per row, on logged models only — because after the write every row
  looks like an update.
- **`restore` logs as `update`.** The vocabulary is create|update|delete|read, and
  a restored row changed state; it was not created.

`docs/audit-logging.md` said "`before`/`after` snapshots are only included for
single-row `update()` calls — not `updateMany()`", which reads as *the entry exists
without snapshots*. It did not exist. Corrected there, along with three `db.auditLog`
call sites that should be `db.auditLogs`.

Repo register: `ISSUES.md` FJS-074.

## 2026-08-05 — a transaction can read its own writes

1362 tests (was 1355).

`$transaction` opened a write transaction on the write connection and then handed
the callback the ordinary client, whose reads go to the separate readonly WAL
connection. WAL isolation means that reader cannot see uncommitted work, so:

    await db.$transaction(async (tx) => {
      await tx.t.create({ data: { name: 'a' } })   // succeeds, returns the row
      await tx.t.findMany()                        // → []
      await tx.t.count()                           // → 0
    })

Every read-after-write inside a transaction saw stale data — check-then-act,
read-modify-write, and any `include` resolved against a parent created moments
earlier. Nothing threw; the reads simply described the world as it was before the
transaction started.

Each read connection is now wrapped in a router sharing the transaction manager's
depth. While a transaction is open, reads go to the **write** connection, which
observes its own uncommitted work; outside one, nothing changes and reads still run
concurrently on the readonly connection. The two prepared-statement fast paths
(`findMany()` with no args, `findUnique` by pk) stand down inside a transaction —
they were prepared against the read connection at table-build time and cannot be
re-pointed.

Read-only clients are untouched: their write connection is a throwing stub, and
they can never open a transaction to route into.

Found while trying to build per-test isolation on `$transaction` for the seeding
work below. Pinned by seven tests: findMany, findUnique, read-modify-write,
`include`, rollback, routing restored after commit *and* after rollback, and
nested savepoints.

## 2026-08-05 — seeding ergonomics

1355 tests (was 1334).

Six additions and one retry, all on top of the relation work below.

- **`snapshot(db)` / `restore(db, snap)`** — seed once, reset between tests. A
  truncate + bulk re-insert of the exact rows, which beats re-seeding. Deliberately
  raw: rows move through the write connection, so `@encrypted`/`@secret` columns
  keep the ciphertext they already have (a round trip through the ORM would
  re-encrypt them) and no gate, policy, hook or audit entry fires. FTS5 shadow
  tables are skipped — writing those directly corrupts the index.
- **`defineFactory({ model, definition, traits, afterCreate })`** — the Factory
  without the class. Returns a class, so it registers exactly as before. A subclass
  declares `traits` as an instance field, which initialises only after `super()`
  returns; that is the only reason `Factory`'s constructor returns a Proxy, and
  this path never needs it.
- **A value catalogue** (`src/fake.js`). Well-known field names — `firstName`,
  `city`, `company`, `title`, `description`, … matched case- and
  separator-insensitively — draw real words instead of `Name a4f2`. **Only when a
  seed was set.** Unseeded output is byte-identical to before, because
  schema-derived test *cases* have to stay stable and diff-able.
- **`static dependsOn = [OtherSeeder]`** — a seeder names what it needs instead of
  every caller knowing the order. Each class runs at most once per `call()`; a
  cycle throws naming the classes in it.
- **`loadFixture(db, model, jsonOrCsvOrArray, { upsert })`** — authored reference
  data (countries, plans, currencies) is written down, not generated. Rows go
  through the ORM, unlike `restore`. Ships a small RFC-4180 `parseCsv`.
- **`fli make:factory <Model>`** — scaffolds a `defineFactory` stub into
  `db/factories/`, refusing a model the schema does not declare.
- **UNIQUE collisions retry.** Generated values carry a seq token so a `@unique`
  column is unique by construction, but the token pool is finite and the catalogue
  is small. `createOne` now rebuilds and retries (5 attempts) — a rebuild advances
  `seq`, which changes every generated value — rather than failing a long seed.

`withParents()` also stops **silently skipping** a required relation whose target is
already in the parent chain. A cycle cannot be satisfied by creating more rows, so
it now says that, names the chain, and suggests `.for(…)` — previously it surfaced
as an opaque `FOREIGN KEY constraint failed` far from the cause.

### Why snapshot/restore rather than a transaction

The intended implementation was a per-test transaction rolled back at the end.
`$transaction` could not serve it: reads inside one did not observe its own writes.
That turned out to be a general correctness bug rather than a test-helper problem,
and is fixed in its own entry above. `snapshot`/`restore` remains the isolation
primitive here — it survives a client restart and does not hold a write lock for the
length of a test.

## 2026-08-04 — factories can seed a relation graph

1334 tests (was 1321).

Factories could only reach one relation shape: `withRelation`/`for`, a single named
belongsTo, wired by hand. Everything else was on the caller. Measured by pointing
`autoFactories` at the two real schemas in this repo and creating one row per model:

    example  (Int keys)   3 of 3  models seeded
    basecamp (uuid keys)  5 of 24 models seeded

The 19 failures were all `FOREIGN KEY constraint failed`. An `Int` FK falls back to
`1`, which accidentally works when the parent happens to be row 1; a `String`/uuid FK
has no fallback at all, so the generator emitted `"AccountId 1"` and every write with
a parent failed. Four additions:

- **`withParents()`** — reads the schema and auto-creates a parent for every
  *required* belongsTo, recursively. `{ optional: true }` covers nullable ones,
  `{ fresh: true }` gives each row its own. Relation cycles are skipped rather than
  followed; `depth` is only a backstop.
- **`has(name, count, opts)`** — hasMany children, created after the parent with the
  FK pointed back at it. The FK comes from the child's own `@relation`; a child with
  two relations to the same parent is an error naming both, not a guess.
- **`attach(name, countOrRows)`** — implicit many-to-many, via the `{ connect: […] }`
  form the client already takes. Accepts a count or existing rows.
- **`usingDb()` / `asSystem()` / `actingAs()`** — a schema declaring any `@@gate`
  auto-installs GatePlugin, so an anonymous factory grades STRANGER and cannot create
  anything. The client now propagates through the whole wired graph; rebinding only
  the top factory left every parent on the gated client.

`has`/`attach`/`withParents` need the parsed schema and a factory registry, which
`makeTestClient({ autoFactories: true })` and `factoryFrom()` now supply — to
hand-written factory classes as well as generated ones. Without them the methods
throw a message naming what to pass.

Same measurement after:

    example   3 of 3  models seeded via factories.X.asSystem().withParents()
    basecamp  24 of 24

## 2026-08-04 — the factory generator stops emitting data the schema rejects

1321 tests (was 1306).

`generateFactory` derives a row from a model's field types. It was not reading most
of the rules on those fields, so `autoFactories` produced rows that could not be
written. Probed with one hostile model — every line below is a separate failure:

    { code:"xxxx", phone:"Phone c9zs", age:11001, meta:null, tags:[], plan:"free" }

    createOne     → phone: must be a valid phone number, age: must be at most 99,
                    meta is required, ref: must match ^[A-Z]{3}-[0-9]{4}$
    createMany(2) → UNIQUE constraint failed: code.v

- **`@unique` + `@length` generated a constant.** The whole branch was
  `'x'.repeat(min)` — no seq — so the second insert always collided. Every string
  now carries the seq token and is padded/truncated into the declared range.
- **`Int` ignored `@gte`/`@lte`**, and both types ignored exclusive `@gt`/`@lt`.
  One bounds resolver now serves `Int` and `Float`, and the value walks the range
  with `seq` so a bounded `@unique` column also survives `createMany`.
- **Required `Json`/`Bytes` generated `null`** → "is required" on every write. Now
  `{}` / bytes when required, `null` only when optional.
- **`@phone` was unhandled** → plain text, always invalid.
- **`@regex` emitted `field-abcd`**, which matches almost no pattern. There is now a
  generator for the common subset (anchors, escapes, classes, groups, alternation,
  quantifiers) that **checks its own output against the pattern** and warns instead
  of emitting an invalid value.
- **`@minItems` was ignored** — arrays were always `[]`.
- **`@startsWith` / `@endsWith` were ignored.**
- **`DateTime` used `new Date()`**, so a seeded factory was not reproducible — the
  one promise the seeded-RNG design makes. Derived from `seq` now.
- **Enums always returned the first value** — five seeded builds gave five `free`.
  `rng.pick` when seeded; still the first value unseeded, so generated test cases
  stay stable.
- **`@sequence` columns are no longer emitted.** An explicit value is honoured and
  moves the per-scope counter (verified), so writing one both defeats the feature
  and collides with any `@@unique([scope, seqField])` beside it.

### makeTestClient could open the project's real database

Found while running the above against `packages/basecamp/db/schema.lite`: rows
appeared in tables that should have been empty. `makeTestClient` builds a throwaway
db in a tmpdir and passes it as `db:` — but **a `database` block in the schema wins
over `db:`**, which is documented litestone behaviour. So pointing this helper at a
real app schema opened `./db/basecamp.db` — the actual project database — and wrote
test rows into it. The docs said "always uses `:memory:` — no files created".

It now overrides every declared database path into the tmpdir, one file per declared
database, with per-database DDL. Pinned by two tests, including one asserting the
declared path is never created on disk.

## 2026-08-04 — `Factory.create(overrides)` no longer returns nothing

1306 tests (was 1302).

`build(n, o)` and `create(n, o)` branched on `n != null`, so the first argument was
a count whenever it was present at all. Laravel's `factory()->create($attrs)` is the
muscle memory everyone brings, and `factory.create({ role: 'admin' })` took the
overrides object as the count:

    Array.from({ length: {} })   // → []

No row written, nothing thrown, an empty array returned where a row was expected.
Both now branch on `typeof n === 'number'` — a number is a count, anything else
(object or function) is overrides. All four forms are pinned by tests:

    create()                    → 1 row
    create({ role: 'admin' })   → 1 row with overrides
    create(5)                   → 5 rows
    create(5, { role: 'x' })    → 5 rows with overrides

**Types corrected alongside.** `index.d.ts` described a `Factory` that does not
exist — `for(relatedId)` and `withRelation(model, id)` have taken
`(name, row|factory, fk?, pk?)` for as long as they have existed, `afterCreate` is a
subclass field and not a fluent method, and `seed`, `traits`, `build` and `create`
were undeclared. `testing.d.ts` typed `factories` and `factoryFrom` as `unknown`,
claimed `generateFactory` "returns code as string" (it returns the
`definition(seq, rng)` function), and gave `generateGateMatrix` /
`generateValidationCases` return shapes neither one has ever produced —
`{op, level, label, expect}` and `{valid, invalid, boundary}`, not what was written.

`docs/testing.md` told you to write `model = 'users'` and
`factoryFrom(schema, 'users', db)`. Lowercase plural throws
`model "users" not found in schema` — model names are PascalCase singular
(Invariant 2). README had it right; the doc had drifted.

## 2026-08-04 — transition errors carry an HTTP status

1302 tests (was 1298).

`TransitionGateError` always set `this.status = 403`, with a comment saying that
is the contract: Junction reads `err.status` directly, so an error class you own
needs no mapper and no registration. The other three were missed, so a caller
asking for an illegal move got `500 GeneralError` — the wrong class of error
entirely, telling a client to retry something that will never work.

    TransitionViolationError  → 409   conflicts with the row's current state
    TransitionConflictError   → 409   optimistic-lock loss; also retryable: true
    TransitionNotFoundError   → 400   named a move the model does not declare

Found by driving `@@transitions` from a UI for the first time in `example/`.

## 2026-08-04 — @label and @required, and messages that leave the Data boundary

1298 tests (was 1289).

Every validator already took its own wording — `@length(3, 20, "…")`,
`@email("…")`, `@gte(0, "…")`, the ZenStack convention — and this package's own
validator honoured them. `generateJsonSchema` emitted **none** of them, so a
sentence authored once in `db/schema.lite` died here: invisible to Junction's
autoValidate and to Sierra's client-side rules, both of which derive from that
document. A form said `customerId is required` and no amount of schema
authoring could change it.

**Messages are now emitted as `x-messages`**, keyed BOTH by rule name and by
the JSON Schema keyword the rule compiles to — `@length` publishes under
`length`, `minLength` and `maxLength`. Keying by keyword is the point: a
consumer that just failed `minLength` looks up `minLength`. The alternative,
publishing only the rule name, puts a keyword→rule table in Junction *and*
Sierra, and this file is the one that already owns that mapping (it is
documented at the top of it). `MESSAGE_KEYWORDS` is pinned by a test asserting
the aliases match what the field actually emits — `@gt` is `exclusiveMinimum`,
not `minimum`.

**`@label("Customer")` → JSON Schema `title`.** Every generated message on
every side builds its sentence from it, so an error stops reading `customerId`
under a form label that says "customer". Consumers must read it off the
FIELD's own schema and never a `$ref` target: every enum `$def` is titled with
the type name, so a deref'd title would make `status OrderStatus` introduce
itself as "OrderStatus".

**`@required("…")`** fills the one gap the trailing-message convention could
not: required-ness is the absence of `?`, not an attribute, so there was
nowhere to hang a message. ZenStack reaches for model-level
`@@validate(expr, msg)` here; this follows Remult's field-level
`Validators.required(msg)` so the wording sits beside the rule like every other
message in the file. It carries the wording only — it does **not** make the
field required, and on an optional field it is a parse error rather than a
message that could never fire.

Nine tests in `test/messages.test.ts`.

Newest first. Entries older than 2026-08-02 live in `PROJECT_STATE.md` §What's
been done (phases 1–10) — this file starts where that log left off.

## 2026-08-03 — `@@transitions`: state machines move to the model, and gain gates

A `status` column's rules used to live in whatever service handler was written
first. They are now declared once on the model, enforced at the Data boundary,
and readable by the browser.

```prisma
enum OrderStatus { pending  paid  shipped  refunded  cancelled }

model Order {
  status OrderStatus @default(pending)

  @@transitions(status,
    pay:    pending         -> paid,
    ship:   paid            -> shipped,
    refund: paid            -> refunded @gate(5),
    cancel: [pending, paid] -> cancelled)
}
```

**What's new**

- **`@@transitions(field, …)`** on the model, beside `@@gate` and `@@allow`
  where every other access declaration already lives. The transition name is
  optional (`pending -> paid` names itself after the target); `from` takes a
  list; a trailing `@gate(N)` takes a number or a level name.
- **`@gate(N)` per transition** — a floor on top of `@@gate`'s update level,
  which had to pass to reach the write at all. Shipping an order and refunding
  one are not the same authority. Under-level moves throw the new
  **`TransitionGateError`**, which carries its own `status: 403` so Junction
  maps it with no registration.
- **`db.order.transitions(row)`** — the legal next states for *this* record at
  *this* user's level. A gated move the caller can't make comes back with
  `allowed: false` rather than being dropped; a disabled button is usually
  better UI than a missing one. Takes a row (no round trip) or an id.
- **`x-transitions` on the model in `generateJsonSchema`**, so the machine
  reaches the browser. Sierra's `resource.transitions(row, level)` returns the
  identical shape — a UI affordance only, the server enforces regardless.
- A gated transition **auto-installs a level resolver** when the app configures
  no `GatePlugin`, the same way `@@gate` does. A declared gate that silently did
  nothing would be a fail-open default.

**Why the model and not the enum**

The existing `enum X { transitions { … } }` block attached rules to the *enum*,
so every model with a field of that type shared one machine — and therefore
would have had to share one authority level. Two models using one `Status` can
now differ. The enum block is kept as shorthand for the common case and
**desugars into `@@transitions`** at parse time, so there is one enforcement
path, one representation in the JSON Schema, and the existing behaviour is
unchanged (all 20 of its tests pass untouched). A model that declares its own
`@@transitions` for that field overrides the enum's outright.

**Breaking**

- `x-litestone-transitions` is **no longer emitted on the enum `$def`**. The
  resolved machine is on the model as `x-transitions`. Emitting both would give
  a client two sources that drift the moment one model narrows.

**Documentation corrections** — three places described syntax that never
existed: `docs/schema.md` documented a `@from(pending)` enum-value attribute,
and `docs/roadmap.md` and `docs/soft-delete.md` both showed an array form
`@@transitions([{ name, from, to }])`. `docs/soft-delete.md` additionally
claimed `remove()` enforces transitions — **it does not**, and never did;
enforcement runs on `update()` and `upsert()` only. Use a `@@deny('delete', …)`
policy to require a state before deletion.

1286 tests green (was 1253).

## 2026-08-03 — `@encrypted` on a `Json` field silently destroys the value

**Open. Not fixed — route around it.**

A `Json @encrypted` column round-trips as the string `"[object Object]"`. The
value is stringified with `String(obj)` instead of `JSON.stringify` before it
reaches the cipher, so the object is gone before encryption ever happens.

Everything *around* it works, which is what makes it dangerous: the column is
genuinely encrypted at rest, `@guarded(all)` read-withholding is enforced, the
write returns normally, nothing throws and nothing warns. Only the payload is
missing, and only on read-back.

```prisma
model Secret {
  data  Json @encrypted     // ← writes {"key":"…"}, reads back "[object Object]"
}
```

**Workaround:** declare the column `String @encrypted` and do the
`JSON.parse` / `JSON.stringify` at the service layer. That is what
`packages/basecamp/db/schema.lite` does — see `packages/basecamp/db/README.md`
§"A Litestone bug to route around".

Also recorded in `docs/gotchas.md`.

---

## 2026-08-03 — the audit logger was never dropping rows; reads lag writes

Reported repeatedly as "**`@@log(audit)` writes 0 rows**", including in the root
`CLAUDE.md`, where it sat unexplained for weeks. It is not a bug and nothing is
lost.

The logger driver buffers and flushes on a **~1s timer and on process exit**, so
a read in the same session immediately after a write sees nothing — and the
`.jsonl` file may not exist yet. Litestone's own examples read straight after
writing, which is exactly the shape that reports zero.

Measured on a fresh database:

| after | `auditLogs.findMany()` | file |
| --- | --- | --- |
| 1 write, immediately | 0 rows | does not exist |
| +2s | 1 row | 297 B |
| +50 more writes, same process | 1 row | 297 B |
| next process | **51 rows** | 15,137 B |

Entries carry `operation` / `model` / `records` / `before` / `after` /
`actorId` / `createdAt`, and are queryable through the **`auditLogs`** accessor
that declaring a logger database synthesizes.

Two related facts worth keeping together with this one:

- **`@secret` expands to `@encrypted + @guarded(all) + @log(<first logger db>)`.**
  Merely *declaring* a logger database therefore starts logging every `@secret`
  field in the schema. That is by design.
- **The logger `path` resolves against the process CWD, not the schema file.**
  Where the trail lands depends on where you launch from.

### Protected fields are redacted (same date, and this is what makes the above safe)

`src/core/client.js`. Any `@encrypted` / `@guarded` / `@secret` value is written
as `'[redacted]'` in **both** the field-level entry and the model-level
`before`/`after` snapshot. The trail records *that* a field was written, by
whom, to which rows, when — never what it holds.

- `null` is preserved rather than redacted: nothing to leak, and it keeps a
  `null → value` transition visible (`before: null, after: '[redacted]'`).
- Unprotected fields on the same model are still logged in full.
- The row returned to the caller is untouched — redaction happens on a copy, on
  the way to the log.

**Before this fix the plaintext landed in the JSONL while the database row was
correctly ciphertext**, so any audit file written before 2026-08-03 may hold
secrets in the clear. Consumers that log identity or credential models —
`packages/basecamp` does, on all 16 of its non-event models — require a
Litestone from this date or later.

Pinned by 8 tests (`test/litestone.test.ts` → "audit log redaction"), 5 of which
fail if the redaction is removed. Reference docs: `docs/audit-logging.md`
§"Protected fields are redacted".

---

## 2026-08-02 — v1.1.0 published; the dialect trap is closed

**The trap:** in-repo packages resolved a *registry* Litestone rather than the
workspace one, so schemas written against the current dialect
(`Int` / `String` / `Float` / `Bytes`) were parsed by a build that still spoke
`Integer` / `Text` / `Real` / `Blob`. The failure surfaced far from its cause —
Junction carried **7 test failures filed for months as "test drift"** that were
this mismatch and nothing else. Fixing the resolution cleared all 7.

Two halves, both closed:

- **In-repo:** junction and auth now take `workspace:*` as a dev-dependency with
  a `^1.1.0` peer, so workspace code gets the workspace parser.
- **Registry:** 1.1.0 is published and npm `latest` points at it. Verified by
  `npm view` dist-tags *and* by unpacking the tarball — `SCALARS` carries
  `Int/String/Float/Bytes` and `RENAMED_TYPES` rejects `Integer/Text/Real/Blob`.

**Type renames are a hard cut, not aliases.** `Text`, `Integer`, `Real` and
`Blob` are rejected outright with a rename message (`PROJECT_STATE.md` §"Type
rename — hard cut").

**Still true, and the reason this went unnoticed for so long:** don't pin
Litestone with a bare `"latest"` or `"*"`. A floating range is what let a
consumer silently sit on the old dialect. Use `^1.1.0`. Anything installed from
the registry before 2026-08-02 needs a reinstall.
