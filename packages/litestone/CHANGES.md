# Changes — @frontierjs/litestone

## 2026-09-03 — `resolveFrom: 'schema'` was inert whenever the schema came in as a path

`FJS-758`. 4222 pass, typecheck clean.

The option's contract is *the app root, derived from the schema FILE*, and the
anchor is computed from `path:`. But a `schema:` whose value is a single-line
string ending in `.lite` is read as a file too — `parseFile(resolve(...))`, ten
lines further down — and that path never reached `schemaAnchor`. So a client
written as

```js
createClient({ schema: '/abs/app/db/schema.lite', resolveFrom: 'schema' })
```

anchored on nothing, every relative `database { path }` fell back to the working
directory, and the option that exists to prevent exactly that was set. It is
`FJS-449`'s shape with the guard in place: a scaffolded app's `site/` build,
which runs from the surface, opened a **new, empty database** under `site/db/`
and prerendered every page with no rows in it, exit 0.

A path handed over under either key is still a path, so it now fills
`schemaFilePath` when `path:` is absent. Nothing else changes: with
`resolveFrom` left at its default this is unreachable, since the anchor is null
either way.

## 2026-09-03 — the advice a blocked migration gave was right for one of two readings

FJS-566. 4222 pass (5 new), typecheck clean.

A migration that would remove a column is refused, and the refusal said: *Pass
`{ acceptDataLoss: true }` to say the loss is intended.* That is correct advice
for an author who removed the column. It is destructive advice for the other way
to arrive at an identical diff — **your process is older than the database**,
which two processes on one file reach routinely: under `strategy database` a
long-running API, and a drive or a seed run from the app root after the schema
moved. Taking the option there deletes the column the newer build is writing to.

The diff cannot tell them apart, so both readings are printed and neither is
chosen. The gate is `onlyDrops(diffResult)` — a diff that ADDS anything is a
schema being edited forward, keeps the single reading, and is asserted as the
pair. **It must not test `needsRebuild`**: SQLite cannot drop a column in place,
so a rebuild is what a drop looks like, and testing it answers false in exactly
the case this exists for. A control pins that.

**What was investigated and found not to exist** is worth recording, because the
report named it as the cause: a running process re-reading its schema. Every
link is pinned at construction — `createTenantRegistry` parses once, `#doOpen`
passes `parsed:` after the options spread so a caller's `path` cannot win, and
`autoMigrate(db)` reads `db.$schema`. Editing `schema.lite` while a registry is
up moves nothing: not the flagship, not a tenant created after the edit, not the
client's own belief.

What no layer does yet is notice at OPEN, without `autoMigrate` being called.
The cheap test does not work — the recorded DDL hash carries no ordering, so
*differs from mine* is equally true of a schema being edited in development and
would fire on every boot for everybody. `FJS-754` holds the superset test that
would decide it.


## 2026-09-03 — the payload nobody could defend was the only one reaching SQLite

FJS-669. 4217 pass (12 new), typecheck clean.

A partial write has two ways of saying nothing about a field and they mean
opposite things. An **absent** key means *leave it alone*, which is why the
required pre-flight runs under `requireAll` and is create-shaped — demanding
every field on a patch would refuse every patch. An **explicit `null`** means
*clear this* (Invariant 9), and clearing is exactly what a NOT NULL column
cannot do. Nothing checked the second one, so it went to the database and came
back as `NOT NULL constraint failed: item.name` — a bare `Error`, which declares
no status and lands as a **500 with a null body**, where the same mistake on a
create is a 400 carrying `[{path:["name"], message:"name is required"}]` and a
form marks the box. Somebody empties a required field and saves.

It reached further than the report: `update`, `updateMany` and `upsert`'s update
half all did it.

**Fixed the way `FJS-608` was** — by testing the KEY rather than letting the
database answer. An `else` branch on the same block, asking `isStoredField` so
that *is this a real column* keeps one owner, and the sentence lifted into
`requiredFailure(f)` so the create half and this one cannot come to word one
field differently. That is asserted rather than asserted-about:
`expect(onUpdate.errors).toEqual(onCreate.errors)`.

**The exemption set is not the create branch's, and that is the substance.**
`@default` exempts there and must not here: a default fills an *absent* key and
this key is present. Measured — `qty: null` on `Int @default(1)` reached SQLite
and was refused by it. Arrays and `@updatedAt` are the same. `@generated` never
arrives, because `_virtualWriteKeys` already refuses it by name with a better
sentence than this one would give. `id: null` used to be `datatype mismatch`,
which is opaque in a different way, and now names the field.

**`asSystem()` is refused too, deliberately.** NOT NULL is the table's rule and
not one of this package's, so there is nothing here to bypass — the only thing
refusing buys is a sentence instead of a 500, and a system caller deserves that
as much as anybody.

`undefined` is untouched and stays absent: the strip above this branch deletes an
undefined-valued key and reassigns `data`, so it never arrives. The test is
`=== null` regardless, because the rule is about the value and saying so is what
keeps this correct if that strip moves.


## 2026-09-03 — one column of a tuple key identifies nothing

`FJS-694`. 4207 tests, 0 fail. Typecheck clean.

`expandCompositeId` stamps `@id` on every member of an `@@id([a, b])`, so every
downstream read of *which column identifies a row* answered with one of them.
Three faults, and the one that matters is silent.

**A cursor walk lost rows.** `orderBy: { userId }` on `@@id([userId, teamId])`
was treated as already a total order, because that column carries `@id`. Three
rows sharing a userId, paged two at a time: the first page served two, the
cursor said `userId > 1`, and page two came back EMPTY. One row gone, no error
and no gap — the exact class the tiebreaker exists to prevent.

**The default ordering named a column that does not exist.** `normaliseOrderBy`
defaults to the literal `id`, which it must — it is a pure function with no
model in scope — so the default belongs at the caller that has one. Without it
every derived list over a tuple-keyed model was `400 Unknown orderBy field 'id'`
and simply unreachable.

**The tiebreaker appended the key's first column only**, which is still not a
total order. It appends the whole key now, or none of it.

`_keyCols()` reads the model ATTRIBUTE rather than the fields, because the key's
column order is stated only there — and that order is the one fact `@id` per
field cannot carry, which `test/composite-id.test.ts`'s fixed point already
pins. **`$primaryKey(accessor)` is the same answer for the layer above**: the
sixth sibling of `$checkWhere`/`$checkOrderBy`/`$protectedFields`, `[]` for an
unknown accessor, identical on every flavor of client. Junction reads it to
refuse a one-value `get` by name.

## 2026-09-03 — a policy comparison follows SQLite's rules rather than JavaScript's

`FJS-713`, `FJS-723`. 4199 pass (6 new).

A row policy is compiled twice — `read`/`update`/`delete` into a WHERE, `create`
and the post-update check into JavaScript — and the two disagreed about
comparison itself. SQLite applies the COLUMN's affinity to the other operand and
then orders by storage class; `===` does neither.

The filed shape was the framework's own: a `SessionContext` carries `userId` as
TEXT, so on any model keyed by an `Int` the owner read their own row over HTTP
with a 200 and was then graded out of the broadcast for it.

**It was one pairing of a class.** An oracle over column type × operator ×
operand — read against create, the same predicate both ways — disagreed on **54
of 594 cells**, in both directions and on every operator, plus two more in `in`:

```
String  "5"   ==  5        sql=T js=F     affinity: TEXT pulls 5 to '5'
Int     5     ==  "5"      sql=T js=F     affinity: NUMERIC pulls '5' to 5
Boolean true  ==  1        sql=T js=F     the column stores 0/1
Int     5     <   "abc"    sql=T js=F     class order: INTEGER below TEXT
String  "abc" >   5        sql=T js=F     'abc' > '5' once 5 is text
Int     5     in  ['5']    sql=T js=F     membership is equality repeated
```

That measurement is what refused the narrower fix. The issue offered coercing
`id` in junction's `toDataPrincipal`; it closes four of those cells and leaves
fifty, and being junction-only it says nothing to a job calling `$readAs` or to
a policy naming any other claim. The fix is in litestone, where both halves
live.

`compare()` now puts a JS value in the storage class the binder would have given
it (a boolean is 0/1, a `Date` its ISO text), applies the column's affinity by
SQLite's own rules, and orders by class. The affinity comes from `sqlType` —
the DDL emitter's own function — so it cannot drift from the column that gets
built.

**Two things it deliberately does not do.** A value that is neither a number nor
a string after all that keeps JavaScript's answer: two distinct Buffers rank
EQUAL under a class comparison, so `==` would start answering TRUE for them.
And nothing changed in the SQL half, which was right all along.

The grading path's own fixture used a `String` id column with a comment saying
the divergence was deliberate and belonged elsewhere. It is an `Int` now, so
that suite is green on the shape the framework actually produces.

**`FJS-723`, found by measuring the fix.** `$readAs` runs once per broadcast
cohort, so a comparison's cost is multiplied by the audience — which is why the
per-call cost was measured at all. It was 17.15 µs on a 188-model schema against
2.22 µs on a one-model schema, *before* any of this. The cause was a memoisation
that never applied: `ctx.models` is keyed by MODEL NAME and all six `$` siblings
looked it up by ACCESSOR, so every call fell through to a scan of the model list
that lower-cased a name per model. Indexed once under both spellings, and the
derivation is `modelToAccessor` rather than the second inline copy of it that
was there — checked over 1,672 model names from the corpus and the scale
fixture, the two agree on every one.

```
                     before      affinity fix     + accessor index
  1 model            2.22 µs       2.41 µs            2.5 µs
  51 models          5.92 µs       6.24 µs            2.0 µs
  188 models        17.15 µs      19.12 µs            3.8 µs
```

5 of the 6 new named tests fail with the fix stubbed. The sixth is the negative
control — a genuine type mismatch stays unequal — which is what a control is
for.

## 2026-09-03 — attribute legality asked of a facet rather than of a pair

`FJS-721`. 4194 pass (23 new).

The parser refuses `@unique` over a randomly-encrypted column, with a good
message, because somebody hit it. The same class one attribute over was ruled
nowhere — and a rule written per PAIR is a rule somebody has to remember to
write, over a hundred-word surface. Three, each re-measured before it was
written:

```
@unique on a @computed field        vanished with no diagnostic
@@unique([c]) over one              SQLite refuses the whole table at boot:
                                    "expressions prohibited in PRIMARY KEY and
                                    UNIQUE constraints" — naming nothing you wrote
@scale(2) @default(12.99)           DEFAULT 12.99 into an INTEGER column; the
                                    first row that takes it is refused at runtime
@relation across two databases      an FK SQLite resolves nowhere; every create
                                    throws "no such table"
```

They are derived from one question now — *what does the column physically
hold*: `none` (`@computed`, `@transient`), `expression` (`@derived`, `@from`),
`ciphertext`, `plain`. `@generated` is deliberately outside the set, being a
real column.

**The boundary that decided what did NOT land here is worth more than the
rules.** `F24` also names `@@fts` over an encrypted column, and `advise.js`
already owns it — whose own contract is that *every rule in it parses*. Adding
it to the parser made that rule unreachable and broke its own test. So: this
file is what cannot be EXPRESSED, `advise` is what is legal and WRONG, and the
line is now written down where both would be reached for.

`F24`'s remaining item does not reproduce: a validator on an `@encrypted`
column emits no table CHECK, so nothing is judged against ciphertext.

Measured against the corpus and both apps — 1,777 models, zero refusals — which
is the only body of input large enough to say a legality rule does not
over-refuse. Negative controls: 11 of the 23 new tests fail with the facet
function stubbed to `'plain'`, 1 with the cross-database rule stubbed.

## 2026-09-03 — verbs × rules, and the verb that applied none of them

`FJS-720`. 4177 pass (104 new).

`makeTable` is one closure whose method bodies each hand-restate the rule
sequence — `buildPolicyFilter` at eighteen sites, soft-delete injection at
thirteen — so a rule is added at roughly fifteen call sites and a missed one is
silent. `test/verbs-rules.test.ts` is the grid underneath `matrix.test.ts`:

    A VERB THAT CAN REACH A ROW MUST APPLY EVERY RULE THAT GUARDS IT.

Twenty verbs × five row-reaching rules, one schema per rule so a cell names the
rule it is about (`FJS-351`), and the verdict never read off the verb's own
return value — a count, a row, a boolean and a throw are four vocabularies, and
reading them is how a probe grades itself. Every cell asks the SYSTEM what the
caller could reach or move.

**It found one hole, in the verb every sibling was right about.** With
`@@allow('update', ownerId == auth().id)`:

```
update()      → null          refused
updateMany()  → {count: 1}    skipped it
upsertMany()  → wrote it
```

…and with `@@allow('create', …)`, `create()` and `createMany()` both threw
`AccessDeniedError` on a row owned by somebody else while `upsertMany` inserted
it. It wrote a `@@hasTemplates` template row too.

**The two halves needed different rules**, which is why the fix is not one line.
A row that will INSERT is a create and one that will conflict is an update, so
the presence lookup a logged model already pays for is now paid whenever the
model has policies; the insert half calls `checkCreatePolicy` and refuses the
batch whole like `createMany`; and the update half rides SQLite's own
`ON CONFLICT … DO UPDATE … WHERE`, where an unqualified column is the EXISTING
row — the same predicate `updateMany` puts in its WHERE, narrowing rather than
throwing.

Fixing it exposed a fourth: `count` was incremented per row handed in rather
than per row moved, so a guarded skip was reported as a write — which the seal
branch three lines above already refuses to do.

Not reachable over HTTP: junction mounts no `upsertMany`, and single `upsert`
was correct in both halves.

Negative controls: 1 of the new tests fails with the create check stubbed, 4
with the `DO UPDATE` guard stubbed, 1 with the honest count stubbed.

## 2026-09-03 — one predicate, two interpreters, and a real oracle between them

`FJS-719`. 4073 pass (41 new).

Nothing held the policy language's two compilers together but testing — the
file's own comments log three prior drifts, and `FJS-195` is the canonical
shape: a row that create allows and read then hides. `test/policy-interpreters.test.ts`
puts the SAME predicate over the SAME rows and asks both halves, which is an
oracle rather than a restatement: 29 expression forms × 3 principals × 5 rows,
plus the clock, a `check()` delegation and a `@@deny` standing beside an
`@@allow`.

**It found one on its first run, and it is the meta-flaw stated exactly.** The
create half is evaluated against the PAYLOAD, so a column SQLite computes from
the row reads `undefined` there:

```
model Doc {
  big Boolean? @derived(qty > 5)
  @@allow('read',   big == true)     // SQL — answers it perfectly
  @@allow('create', big == true)     // JS  — undefined, so nobody can create
}
```

The startup check that catches this **already existed and was enumerated**: it
refuses `@computed` and `@transient` by name, both of which are not columns at
all, so the read half is broken too and its sentence is about the read. The
three kinds that ARE columns — `@derived`, `@generated`, `@from` — had no rule.
Refused at build now, and derived from the facet (*a value SQLite computes from
the row*) rather than from a list. `@system` is deliberately untouched: it
reaches the payload through `system: ['col']`, so a create policy naming one is
answerable.

**Two cells are pinned as still broken.** `FJS-713` — SQLite applies the
column's affinity to a bound parameter and JS `===` does not, so a String column
against a numeric claim reads TRUE and creates FALSE. Filed by another session
against `$readAs`; this is the same cause reached through create-vs-read, so it
is asserted here with its id rather than filed again. Fixing it turns those
cells red and says to promote them.

## 2026-09-03 — the migration differ gets a catch-all, and it found the seventh missed dimension on its first run

`FJS-717`, `FJS-718`, ruled `FJS-D186`. 4032 pass (13 new).

`diffSchemas` compares a list of dimensions somebody wrote down. Six issues of
this package's history are one dimension arriving in the DDL emitter and not in
that list — generated columns, CHECK, table uniques, index order, index sorts,
index predicates — and every one of them reads the same way: *schema is in
sync*, over a database that is not the declared one.

So once the enumeration has had its say, the two `sqlite_master`s are compared
whole and the leftovers are named:

```
[litestone] Database "main" is in sync on every dimension the migration differ
            reads, and 1 object(s) still differ:
              table account
                declared: CREATE TABLE "account"(…,"email" TEXT NOT NULL UNIQUE)STRICT
                live    : CREATE TABLE "account"(…,"email" TEXT NOT NULL UNIQUE COLLATE NOCASE)STRICT
```

**The first thing it named was a live one.** `ddl.js` emits `ON UPDATE`, the
parser reads `onUpdate:` on a `@relation`, `introspect` records it off
`PRAGMA foreign_key_list` — and `fkKey` built its comparison string out of
`onDelete` alone. `onUpdate: Cascade` → `Restrict` compared equal and the live
foreign key kept the old action (`FJS-718`).

**It is not part of `hasChanges` and it does not block.** Nothing here could
write a migration for a dimension it cannot see, so counting it as a change
generates an empty migration and finds the same difference on the next boot for
ever. And the commonest cause is not a defect: `litestone introspect` is the
adoption door, so a real database has a `COLLATE NOCASE` on its email column or
a hand-written index — things this language cannot say. `acceptResidue: true` is
the caller stating it, beside the `acceptDataLoss` it is modeled on.

**Measured before the shape was chosen, twice.** A raw text comparison fires on
162 of 694 objects across the corpus schemas after an ordinary v1 → v2
migration — every one of them the spacing `ALTER TABLE ADD COLUMN` leaves in the
stored statement, and not one of them a difference. Normalized around
punctuation: 0 of 694, 0 on a fresh build of all nine corpus schemas, and 0 on
both real databases in this repo. And normalizing inside `introspect` cost 18 ms
of a 75 ms introspection on the 188-model fixture, every object of it one that
then compared equal — stored raw and normalized only where two disagree, it is
1 ms.

Negative controls: 4 of the 13 new tests fail with the tripwire stubbed, 2 with
the `onUpdate` repair stubbed.

## 2026-09-02 — `$merge`: changing one key of a document

`FJS-D176`. 3993 pass (30 new).

```js
await db.account.update({ where: { id }, data: {
  settings: { $merge: { commute: { source: 'bus' } } },   // json_patch(settings, ?)
} })
```

The sixth atomic operator, and the first that wears a `$`. The other five are
read off a plain key because *the declared type decides* and a numeric column
cannot hold an object; a `Json` column can, so a document's own key could be
spelled `merge`. (The same ambiguity is why `{ doc: { increment: 1 } }` on a
`Json` column stores `{"increment":1}` — correct, and a trap.)

**The grading rule is not the obvious one, and the obvious one is unsound.**
The first design said: validate the patch's present keys against `T`, refuse a
`null` on a required key, done. Measured against real `json_patch` and
litestone's own validator over 68 (stored × patch) pairs — **2 counterexamples**,
both the same mechanism:

```
{"a":null}     + {"a":{"x":1}}  =  {"a":{"x":1}}       ← REPLACED
{"a":{"x":1}}  + {"a":{"y":2}}  =  {"a":{"x":1,"y":2}}  ← merged
```

RFC 7396 replaces rather than merges when the target is absent or null, so a
patch aimed at an OPTIONAL field is a create however partial it looks, and that
type's required keys are not optional after all. Validating the patch alone
cannot see it: a missing required key and a partial patch are the same thing.

The repair needs no read of the row:

> Grade a patch as **partial** where the target is guaranteed present, and as a
> **create** where it may be absent. A required field is present in every valid
> parent, by induction from the column's own type; an optional one may be null.

Re-run over 90 pairs at three levels of nesting: **0 unsound**, 3 conservative
refusals — all of them a partial patch into an optional nested object that
happened to be there, which the rule cannot know without the read it exists to
avoid. The refusal says so rather than answering a bare *is required*. The same
rule applies to the column itself: `Json? @type(T)` is graded as a create,
`Json @type(T)` as a partial.

An **undescribed** `Json` column is not graded at all — it declares no shape, so
there is no invariant a merge could break. That is where the feature has users
today: `@type(` is bound to zero fields in this repo while `advise` reports 24
undescribed `Json` columns on basecamp alone.

Refused by name: on `create` / `createMany` / `upsert` / `upsertMany` (nothing
to merge into — and `createMany` was not calling `extractWriteOps` at all, so
`$merge` was being stored as the document there); on a column that is not
`Json`; on `@encrypted`/`@secret`, where the stored text is ciphertext; on a
patch that is not an object; and mixed with any other key.

It is an ordinary write in every other respect — the gate, the row policies, the
field write predicate, `@version`, the audit row and `@@log`'s before/after
snapshots all apply, and it **announces the merged row**, which is the one thing
`asSystem().sql json_set(…)` cannot do: that workaround is already atomic and
race-free, and it reaches no open tab.

`validateTypedJson` grew a `mode`, defaulting to `full`, so every existing
caller is unchanged.


## 2026-09-03 — the envelope names the key

`FJS-714`, `FJS-715`, `FJS-716`, ruled `FJS-D183`. 4019 pass (18 new), typecheck
clean.

`F18` of the foundation audit. `v1.` encoded the FORMAT version — the one thing
about a stored value that never changes — and omitted the one that does.
`$rotateKey` runs **one transaction per database**, so a crash between two
commits left a schema in two keys under a single global key setting, with
nothing able to say which value was under which and no way to resume.

**`v2.<kid>.<payload>`** — the kid a domain-separated HMAC of the key, truncated
to eight hex characters, which identifies a key without being one.
`createClient({ previousEncryptionKeys })` is the read-only ring; the old key
stays on it after a rotation, which is what makes a partial one survivable, and
re-running finishes it. An unknown kid still tries the ring: **GCM's tag is the
authority and the kid is only the order.**

**A caller-supplied `v1.`-prefixed string was stored VERBATIM** in an
`@encrypted` column and read back as `null` (`FJS-715`). One `isCiphertext`
checked three characters and gated the HASH path too, so a `v1.` value skipped
hashing and `@hashed` held something that is not a digest. Now the mode must
match, the value must VERIFY, and a non-system caller may not send one at all.

**A decrypt that failed set the column to `null`** (`FJS-716`) — a wrong answer
rather than a missing one. It is raised, naming the model, the field, the kid
wanted, the kids held and `previousEncryptionKeys`; none of those strings is a
key. One column still degrades and the schema declares it:
`@secret(rotate: false)` is an acknowledged loss, so raising there would make
the whole row unreadable to punish a column the app already gave up.

**Two things measuring found that the finding did not name.** A deterministic
encoding is a function of the key, so making a half-rotated schema *supported*
would have made every equality filter over a not-yet-rotated row answer nothing
— the operand is widened across the ring at all four spellings of equality. And
the payload is **byte-identical across versions**, so every deterministic and
`@hashed` lookup **in every existing app** would have silently stopped matching
after the upgrade; no suite here could see it, because every one builds a fresh
database. `legacyForm` emits the v1 twin, and a simulated pre-upgrade database
is now a test.

## 2026-09-02 — a bulk write cannot reach around the state machine

`FJS-671`, ruled `FJS-D182`. 3993 pass (8 new), typecheck clean.

`F16` of the foundation audit. `updateMany` matches rows with a WHERE and never
reads them, so there is no `from` state to grade — and the skip took the whole
ladder with it. Measured, one level-4 caller holding no capability: a `@gate(5)`
move refused as `TransitionGateError` through `update()` and **allowed** through
`updateMany`; a `@system` move refused as `TransitionSystemError` and
**allowed**; a move the schema does not declare at all, **allowed**.

**Measuring corrected the precedent.** `FJS-044` did not rule the skip
acceptable — it fixed it one layer up, and junction's `bulkByRow` still writes
one row at a time through `update()`, so the HTTP surface was never exposed. The
reachable path is a hand-written service, job or script calling
`db.model.updateMany` with a caller-supplied payload.

What that fix could not weigh is the capability grid and `access.snapshot.md`,
both later. The snapshot said *a move a caller may not make is refused even
where `@@gate` allows the update* and printed the move gates with no per-verb
qualification, so **the artefact a reviewer grades an access change with
certified enforcement one verb did not apply**. It now states the refusal.

`BulkTransitionError` is **400** rather than 403 — no level answers it and no
grant answers it, because the verb is wrong rather than the caller — naming the
field and both ways forward. `upsertMany`'s `update:` half is the same ungraded
write and refuses with it; its insert half is a create, has no from-state, and
does not. **The power tool survives**: every other column on the model is
bulk-writable in the same call, which is `FJS-044`'s reasoning kept rather than
overturned.

`asSystem()` still writes it and now says so — `update()` announces its bypass
through `emitTransitionEvent`, which a bulk write never reaches, so the system
path would otherwise have been the one silent bypass of the two.

## 2026-09-02 — a claim is graded, and an absent one means one thing

`FJS-666`, `FJS-667`, `FJS-668`, ruled `FJS-D181`. 3963 pass (22 new), typecheck
clean.

`F11` of the foundation audit. Every identifier on the ROW side of a policy is
refused by name at startup; the identifier on the AUTH side of the same
comparison was checked by nothing, ever.

**A misspelled claim built clean and then enforced itself backwards, in two
directions at once.** `@@auth User { suspended }` with
`@@deny('update'|'create', auth().suspnded == true)` builds with no error and no
warning. The SQL half then denies the update for EVERY caller — `NOT (NULL = 1)`
is NULL and a WHERE that is NULL keeps no row — while the JS half allows the
create for every caller, the suspended one included. One typo, a lockout and an
open door, and the refused side reads like the policy working strictly.

`buildClaimSet` is the answer, from four sources and no fifth: the **eight names
this package itself reads** (`id`, `capabilities`, and the six
`FrontierGateGetLevel` grades a caller by — a standing is not a column, so an
app whose ladder tops out at `isAdmin` has no such field on `User`), the
**`@@auth` model's own columns**, the **`tenancy { claim }`**, and
**`createClient({ claims: [...] })`** for a value resolved per request, which is
on no row and in no schema. That last is why it is a client option rather than a
`.lite` keyword: junction already declares that list and generates
`principal.snapshot.md` § Claims from the resolver's own `describe()`.

It grades only when there IS a set — a schema with no `@@auth` and an app
passing no `claims` have said nothing to compare against — and that silence is
announced once per distinct set of names rather than assumed. `claims: []` is a
statement where absent is silence.

**A field-level `@allow` was checked by nothing at all** (`FJS-667`) — not for a
claim and not for a column, though it is the same expression language compiled
by the same compiler. `secret String @allow('read', ownerIdd == 1)` builds, and
every row comes back with `secret` gone: it fails CLOSED, which is why it
survived, because the schema, the build and every assertion on the refused side
agree with the mistake. `checkFieldPolicies` runs the same walk.

**And an absent claim now means one thing rather than two** (`FJS-668`). With
the typo refused at startup what is left is the ordinary case: a correctly
spelled, declared claim this caller does not carry. `evalJs` propagates NULL the
way SQLite does — `and3`/`or3`/`not3`, a comparison with an absent operand,
`NULL IN (…)` — and the verdict asks for TRUE rather than truthiness, so an
allow holds only on TRUE and a deny fires on TRUE and UNKNOWN alike. That is
`(allows) AND NOT (denies)` read on both sides. `x == null` keeps its own branch
and answers a boolean, generalized off `auth()` onto any operand: it is how this
language spells `IS NULL`, and `ownerId == null` compiles to `ownerId IS NULL`.
What actually moved is the deny side and `!` — an allow list was already
fail-closed — and the tests say so rather than claiming more.

Both apps adopted `@@auth`, which is what makes the check live where the bug
was; `example` declares `cartToken`, the one claim a caller with no session
carries.

## 2026-09-02 — the audit trail survives a second process

`FJS-665`, ruled `FJS-D180`. 3941 pass (9 new), typecheck clean.

`F8` of the foundation audit, and the one of its eight findings that had no id.
A `driver logger` database is schema-global and its auto-model carries three
`@@index` attributes, so every trail in every app is on the indexed path — and
`docs/concurrency.md` recommends running a second process.

**Three defects, measured on the shipped code.**

`statSync(f).size` then `appendFileSync` is two syscalls, so a second process
appending between them made the recorded offset name the other writer's line —
**1,999 of 8,000, one in four**, with no artificial delay. An indexed read then
answers the wrong record with no error.

The sidecar was a rollback-journal database every process writes. Eight
concurrent writers **killed 2 of 8** on the `CREATE TABLE` that ran on every open
and **dropped 12 rows**, worst insert **5,007 ms** of blocked event loop. Under
WAL the same run is 0 killed, 0 dropped, worst 79 ms, mean 0.03–0.27 ms.

Compaction was `readFileSync` → filter → `writeFileSync` over the same path with
nothing excluding a writer, inside every `createClient`. One 681 ms compaction
against one appender **destroyed 4,637 rows** — a contiguous hole with the first
and last present, so nothing reported anything.

**One fix: the index database's write transaction is the file's lock.** A
transaction rather than a lockfile because a lockfile has no answer for a writer
that dies holding it, and the OS already drops a dead process's file locks. The
lock covers `stat`+`append` and the index row that names the offset, so the two
commit together; and it covers compaction's READ as well as its write — locking
the write alone leaves the window and makes it wider, measured at a 297-row gap.

**The order is the ruling.** Compaction stops unlinking the index first, because
after an unlink a live process's next write answers `SQLITE_READONLY_DBMOVED`
under a rollback journal — a loud crash, `FJS-540` — and answers **`ok` under
WAL**, silently writing into an inode with no directory entry. WAL turns a crash
into a lie, so it could not go first.

Two more that fell out. An index created beside an EXISTING trail was left empty
— `drifted` is false when there is no table at all — so every indexed read
answered nothing, which reads as an empty log and is the state a trail reached the
first night its retention elapsed. And the WAL migration is attempted with a 50 ms
wait and its failure swallowed: `journal_mode` is persistent, so opening an older
index IS the migration, and against a live reader it otherwise waited the full
`busy_timeout` and threw at boot (5,008 ms, measured).

`src/drivers/jsonl-index.js` is the new one owner of the sidecar, because
compaction rewrites every row of the index and the driver writes them one at a
time — two callers that may not disagree about what a row is. The nine tests
spawn real processes: the window is between two adjacent syscalls and nothing
inside one event loop can sit in it.

## 2026-09-02 — a field write policy the atomic operators went round, and a write key that is a path

`FJS-661` and `FJS-658`. 3930 pass (17 new).

**`FJS-661` is an access-control bypass and was measured before it was fixed.**
`FJS-D129` says a field `@allow('write', …)` is the WHEN of
`SET col = CASE WHEN … THEN ? ELSE col END`, evaluated against the STORED row.
`setFragment` is the one owner of that wrapper and an atomic operator never
reached it: `extractWriteOps` emitted a finished assignment which `update` and
`updateMany` spliced into the SET clause whole.

```js
// views Int @allow('write', auth().role == 'admin')
await user.post.update({ where, data: { views: 999 } })            // declined — 10
await user.post.update({ where, data: { views: { increment: 5 } } })  // was 15
await user.post.update({ where, data: { tags:  { push: 'x' } } })     // was appended
```

An op now carries `{ col, expr, params }` rather than SQL, and `setFragmentExpr`
is the same predicate with an expression in the THEN instead of a parameter;
`setFragment` is one line of it, so there is one wrapper and not two.

**No test could see it, and the reason is worth keeping.** `write-operators.test.ts`
builds its client with `asSystem()`, which drops every field policy by design;
`field-predicate.test.ts` writes values. Each file is right about its own
subject and the crossing is in neither. Every new refusal is paired with the
same call by an admin and with an unpoliced column in the same payload —
a fix that stopped applying operators altogether passes every assertion made
from the refused side (`FJS-351`).

**`FJS-658`** — `{ 'settings.commute': … }` was stripped in silence, so a write
naming a real column with a real path was a 200 that changed nothing. The strip
already draws this line for a virtual column (*stripping an UNKNOWN key silently
is the mass-assignment protection; stripping a key the model declares but cannot
store is a different thing wearing the same clothes*) and a path was landing in
the first category. It is refused by name now, with the sentence chosen by the
column's TYPE, which is the only reason the refusal belongs here rather than one
layer up:

```
"settings.commute" reads as a path into "settings", and a write takes the whole
document — there is no path syntax on this side (a where has one). Read the row,
change "commute", and write "settings" back; nothing here merges into a stored value.

"name.first" reads as a path into "name", which is String and has no "first"
inside it. Write "name" itself.
```

The strip it is **not** is half the test file: an unknown key, and a dotted key
whose head is not a field, are both still dropped in silence. Whether a path
should be writable at all is `FJS-D176` and is deliberately unanswered.


## 2026-09-02 — `$readAs`: what would this person have seen of this row

`FJS-631`, ruled `FJS-D175`. 3913 pass (14 new).

`@@allow` compiles into a SELECT's WHERE, so a row that reaches a caller through
a query is filtered by construction and a row that reaches them any other way is
filtered by nothing. Junction owns the fan-out of a broadcast and cannot own the
rule — the gate, the row policies and the field policies are declared here.

```js
await db.$readAs('order', row, principal)   // → the row as they'd have read it, or null
db.$readGrading('product')                  // → 'open' | 'graded'
```

The fifth `$`-sibling, and it takes its subject as an ARGUMENT for
`$capabilitiesFor`'s reason: the asker holds one client and is answering about
somebody else. Every flavor answers identically for the same principal.

Three questions in the order every other layer here reads them — the **gate**
(about the caller alone, an integer comparison, and the whole answer for a
stranger), the **row policy** (`policyVerdict`, in JS against the row in hand,
no query), then the **field policies** (what of the row they may see). It fails
closed: `policyVerdict` throws on an undecidable policy and at a boundary an
undecidable policy must refuse.

**Shaping a row that has already been read is safe**, which is what makes it
affordable: `applyFieldPolicyTo` strips `@encrypted`, `@guarded` and `@hashed`
for any non-system context, so the decrypt branch cannot run for a recipient.
What it gives up is stated — the row is not re-read, so a `@from` or `@computed`
value is the writer's rather than one derived under the recipient's policies.

`$readGrading` is the half that keeps it cheap: `open` for a model whose read
gate is 0 with no read policy and no field policy, so a catalogue — the busiest
channel an app has — is skipped entirely. Read off the schema, so a policy added
later turns it graded with nothing to remember. An unknown accessor is `graded`,
which is the opposite of the other siblings' `{}`/`[]`: there uncertainty means
*I cannot judge this*, here it is a permission and has to fall the other way.

`GatePlugin` publishes `ctx.gateFor(model, op)` beside `ctx.levelFor`, so the
declared level is read off the plugin's own map — `levelPasses` stays the one
comparison, because 8 and 9 are sentinels rather than rungs and a `>=` spelled
elsewhere reads LOCKED as a high level.

## 2026-09-02 — `Int @big`: a column whose values use all 64 bits

`FJS-643`. Ruled as `FJS-D174`. 3894 pass (31 new).

SQLite's `INTEGER` is 64-bit and `safeIntegers` appeared nowhere in `src/`, so
`bun:sqlite` answered a JS `number` on every path — and a value past 2^53 was
read back as a **different number, of a value the database was holding
correctly**. Measured both ways: a raw-SQL write of `9007199254740993` stores
exactly (`CAST AS TEXT` confirms) and the ORM read back `…992`. The write and
the read were each self-consistent, which is why nothing could see it. It
arrives by two ordinary routes — a snowflake id, and `litestone import` mapping
a foreign `BIGINT`.

```prisma
model WebhookEvent {
  id         Int @id @default(autoincrement())
  externalId Int @big     // '1420070400000000000' — digits, in and out
}
```

**A `@big` column is read back and written as a string of digits**, not a
`BigInt`, because `JSON.stringify` throws on one — that is every HTTP response,
every WebSocket frame and every `before`/`after` audit snapshot. node-postgres
answers `int8` the same way and mysql2 has `bigNumberStrings` for it. The type
does not depend on the magnitude (`42` reads back `'42'`), or a caller would
have to branch on the size of the value; a JS number is still accepted going in
below 2^53. Arithmetic says `BigInt(v)` first, which is honest about a value
that does not fit a number.

**The column keeps `INTEGER` storage, and that is what makes it worth doing.**
Holding digits in `TEXT` was the standing advice and loses everything SQLite
does with a number. Measured, all of it survives: `ORDER BY` puts `100` before
`9007…` where text puts it after, a range filter compares numerically, EXPLAIN
answers `SEARCH … USING COVERING INDEX (v=?)`, and `AUTOINCREMENT` continues
correctly past 2^53 — because SQLite applies the column's affinity to a text
parameter.

**Three measurements changed the design after it was written.**

Global `safeIntegers` — the issue's own second candidate — costs **+68 %** on
every read for every app (1884 → 3171 µs over 5,000 rows) as well as breaking
every JSON boundary, so it is refused.

The first cut emitted `CHECK (typeof(col) = 'integer')` by analogy with
`@scale`. litestone emits `STRICT` on every table, and STRICT already refuses
all three ways a wide value stops being exact — past int64 (which a loose table
demotes to REAL `9.22e+18`), a non-numeric string, a fraction. A constraint that
cannot fire is worse than none, so it is emitted only under `@@noStrict`. The
distinction is the bound: `@scale`'s is NARROWER than the column's own, `@big`'s
IS the column's own.

And asking for BigInts at the statement while narrowing in the row read is an
enumeration: `count()` on a wide model answered `0n`, because a statement also
serves counts, aggregates and existence probes that reach a caller through
neither `read` nor `readAll`. The statement narrows what it returns instead.

`@big` is refused on a Float, a String, an array (a JSON column, whose number is
the double), and beside `@scale` or `@money`, which bound the column to ±2^53
for the opposite reason.

**`litestone import` carries a wide column now** rather than narrowing it, which
moves `bigint` from `changed` to `noted`. Keys and foreign keys keep the
existing structural exemption — without it a Rails import turns every id in the
app into a string.

On the wire it is `{ "type": "string", "pattern": "^-?\\d+$", "x-big": true }` —
the one attribute that changes its field's JSON type, because the column's
values do not fit a JSON number either. `x-big` picks the control:
`type="number"` would bind through a JS number and round the value back in the
browser.

## 2026-09-02 — a write is announced past this process, when the database says so

`FJS-642`, `FJS-654`, `FJS-655`. Ruled as `FJS-D173`. 3863 pass (14 new).

`$tapEvents` was a callback list on one client, so a second process announced
nothing to the first — and `docs/concurrency.md` recommended running one. Not a
gap in a mechanism: SQLite has no central server, so `sqlite3_update_hook`, the
pre-update hook and the sessions API are in-process by construction. Every real
system solving this records instead; Rails 8 ships Solid Cable, a messages table
polled at 100 ms, as its Redis-free default.

```prisma
database main {
  path     "./db/app.db"
  announce crossProcess     // default: inProcess
}
```

Each announced write records a row, and every other process on the machine hands
it to its own `$tapEvents` subscribers **on the same seam**, marked
`foreign: true` — so Junction's `announceDataWrites` needed no change and cannot
tell a foreign event from a local one.

Declared rather than default, because it costs **+14 µs on a 25 µs single-row
insert** and nothing on a bulk one (`changed` already carries a count, `FJS-D34`).
The row carries the **id and never the row**: writing the row would put the
plaintext of every `@encrypted` and `@guarded` column into a table beside the
ciphertext. The receiving process re-reads, which also makes the row the shape
its own reads produce — so a create delivered after a later update carries the
later values, which is the wanted answer for a live store and is stated.

Measured rather than assumed: `fs.watch` woke on 5 of 5 foreign commits at a
median **0.7 ms** against 50 ms for a 100 ms poll; `PRAGMA data_version` is
2.5 µs prepared, does not move for a connection's own commits, is a MARKER
rather than a counter (50 foreign transactions move it by 1), and is frozen
inside a read transaction — so it is the backstop poll's gate and nothing opens
a transaction around it.

**The flake found the real bug.** Draining advanced the cursor to `MAX(id)` to
get past its own rows, which also skipped a foreign row committed between the
two queries — 6 failures in 8 runs, and exactly the silent staleness this layer
exists to remove. The cursor now only moves over a row it actually looked at.

Two defects fell out of the boot race and are their own entries. A migration
race left the losing replica reporting `failed — duplicate column name` in 5 of
10 simultaneous boots (`FJS-654`): `autoMigrate` used a deferred `BEGIN`, so both
processes read and both applied. `BEGIN IMMEDIATE` serialises them and a guard is
what makes the loser notice — a lock alone only makes it wait its turn to do the
wrong thing — with the hash stamped and re-read inside that transaction. And
underneath it, `createClient` threw `SQLITE_BUSY_RECOVERY` in 1 of 10 boots
(`FJS-655`), because `PRAGMA journal_mode = WAL` takes a brief exclusive lock and
ran six lines before the busy timeout was applied. 30/30 clean now.

Stated rather than approximated: **one machine**, and **at-most-once across a
crash** — the row is recorded after the write's own transaction commits, the
same trade `ctx.afterCommit` makes one realm over.

## 2026-09-02 — what a `check()` delegation reaches is decided at startup

`FJS-636`. litestone 3849 pass (11 new).

`check(parent)` compiles to a correlated EXISTS over the TARGET'S POLICY, and
two shapes make it mean something other than what it reads as. Both were
decidable only where the compiler runs, which is per query — too often to warn
from, and too late for a fix that is a schema edit. `delegationProblems` answers
both once at `createClient`, in the block that already refuses a predicate no row
can satisfy.

**A cycle is refused.** Re-entry compiles to `'0'`, which is the direction
`FJS-634` fixed and the right one; failing closed is still not an answer. What
the author wrote is *readable if its parent is*, and what they got is *only rows
whose foreign key is NULL* — measured, a mutual pair reads 0 of 1 and a
self-relation thread reads only its roots. Data-dependent, so it looks like a
filter doing its job. The refusal names where the loop closed, and a
self-relation gets different advice: *point one side at its own columns* is not
available to a model delegating to itself, and there is no recursion here to
have meant.

**A target with no policy for the delegated operation is warned about.** It
compiles to `'1'` — correct where the parent is genuinely open, a hole where the
parent is held by a `@@gate` or a capability grid, both of which live a tier
above any compiled predicate. Measured: an anonymous caller reads a `Doc` whose
`@@gate("7")` vault it delegates to. A warning and not a refusal, because it is
a hole rather than an impossibility and the policy tier may be open there on
purpose; the test asserts that read alongside the sentence, so the two cannot
drift. Silent on an unprotected target — an open parent is not the subject — and
silent across all 67 existing test files and both app schemas.

## 2026-09-02 — `autoMigrate` refuses a change that would destroy data, and a rebuild SQLite declines is graded rather than thrown

`FJS-641`, `FJS-645` and `FJS-646`. litestone 3838 pass (11 new).

`diffColumns` is a name-set diff with no rename detection, so a rename is a drop
plus an add: the rebuild copies the columns the two tables share and the old
table goes. Measured across four shapes, which is what set the scope —

| change | before | now |
| --- | --- | --- |
| rename `body` → `content` | `migrated`, value gone | `blocked`, and it asks whether you meant a rename |
| drop `body` | `migrated`, value gone | `blocked` |
| retype `String` → `Int` | raw `SQLiteError` out of the migrator | `failed`, with SQLite's sentence as the reason |
| add a column | `migrated` | unchanged |

— because a plain drop was exactly as silent as a rename. The hole was never
rename-shaped, so anything narrower than *any column drop* would have left half
of it open. The row-count guard passed throughout: it counts rows, not values.

**`{ acceptDataLoss: true }` is the escape**, which is what Prisma's `db push`
demands for the same shape. The refusal uses the `blocked` machinery two rules
already share — reason returned, `console.warn`, and the hash withheld, so a
schema left this way re-announces on every boot instead of going quiet.

**The rename heuristic changes the sentence and never the decision.** One column
out, one in, same type, so a wrong guess costs a reader nothing — and the
commonest case now arrives as *did you mean to rename it to "content"?* with the
`ALTER TABLE … RENAME COLUMN` to use instead.

**The file path still applies and gains a banner.** `create()` already wrote
`- col body` into the header at the same weight as every other line of the diff;
it is now a boxed DESTRUCTIVE block naming the columns whose values go. The file
is the review step, which is the whole difference between it and `autoMigrate`.
`describeDataLoss` answers facts and not advice, because its two callers are a
refusal and a banner inside the very file that refusal tells you to write.

**`litestone db push` was printing a green tick over its own refusal** and is
the third id here (`FJS-646`). It branched on `skipped`, `in-sync` and
`migrated` and nothing else, so a `blocked` result printed nothing, fell through
to `✓ DB is already in sync with schema`, and exited 0 — true since the first
blocked rule shipped, and surfaced only because this change made it reachable by
any column drop. It now names the reason, reads `✗  DB not pushed`, exits **1**,
and takes `--accept-data-loss`.

**`state: 'failed'` is new**, and honestly distinct from `blocked`: one is a
pre-flight refusal, the other is SQLite declining what was attempted. A caller
switching on `'migrated'` treats both correctly. One existing contract moved
with it — a view the rebuild invalidates used to throw and is now `failed`,
which keeps *the migration does not half-apply* and drops *it throws*.


## 2026-09-02 — the tenant pool stops closing what it lent out, and `$close()` starts actually closing

`FJS-640`, ruled `FJS-D172`. litestone 3829 pass (7 new), junction 1692 pass,
typecheck clean.

`LRUPool.set` at capacity called `$close()` on the evicted entry — no lease, no
refcount — while `get()` hands a client to a request that holds it across every
await it makes. Measuring it first turned one defect into three.

**A closed client was not dead, it was mixed, deterministically.** After
`$close()`, `count()` off a cached statement answered `1` while `findMany()` and
`create()` threw. bun's `close()` is `sqlite3_close_v2`: it defers destruction
until the last prepared statement is finalized, and `wrapDb` holds up to 500 and
finalized none. A request failed only if it took a branch it had not taken
before, which is why this read as random rather than as a bug.

**So the eager close freed nothing.** Measured: a close with one live statement
freed **0 file descriptors**, and finalizing that statement freed 3. The pool was
paying a synchronous `wal_checkpoint(TRUNCATE)` — **7.97 ms against 0.008 ms for
a pool hit, 991×, on the request path** — for a release that did not happen, and
`maxOpen` has never bounded a connection in any process that ran one query per
tenant. At 5 fds per client the default of 100 is ~500 fds, over macOS's own
default, so it was not defending an OS limit either.

**What changed.** Eviction drops rather than closes, and `maxOpen` is a target
for how many tenants to keep warm. A lease makes the common case deterministic:
`tenants.retain(id)` returns the release, junction's `withTenantDb` pins for the
length of a request, and an eviction whose every lease has ended closes
immediately. A client from a bare `get()` was never leased, so it is dropped and
bun's finaliser closes it when the last holder lets go. `tenants.query` inserts
COLD into a ring sized to its concurrency and capped at half the pool, so an
admin dashboard no longer evicts the tenants being served. `poolStats()` reports
`{ pooled, leased, retired, overflows, maxOpen }`, and the warning fires only
when every slot was pinned — the one condition an operator can act on, and the
only one that cannot be GC lag.

**`$close()` is definitive.** It finalises the statement cache, which is what
makes it release anything, and every path afterwards throws `ClientClosedError`
naming the file. The read side needed its own fix: `conn.readDb` is replaced by
the read router, which had no `close`, so the read wrapper was reachable from
nowhere and kept answering.

Same churn, leased against unleased: 140 fds outstanding against 240, and 60
uncollected clients against 110.


## 2026-09-01 — a `@unique` under row tenancy is reported when it is not per tenant, and `@unique(global)` is how you say you meant it

`FJS-639`. litestone 3822 pass (7 new), basecamp 211 pass.

The row-tenancy desugar guards READS — two `@@deny` rules and a stamp — and never
touched the model's uniques. So `slug String @unique` on a scoped model is unique
across the whole installation: two tenants cannot both hold `"launch"`, and the
second is refused by a `UniqueConflictError` carrying the value, which tells them
a row they may not read exists. `docs/access-control.md` says a refusal must
never do that.

**Measuring it before fixing it changed both the fix and the severity.** Graded
against `basecamp` — the only `strategy row` app there is — **all 23 uniques on
tenant-scoped models were already correct**: 12 carry `workspaceId`, 10 more
reach a scoped parent (transitively, `App` → `Environment` → `Project`), and the
last is a `@guarded` token that is global on purpose. So the hole is latent
rather than live, and the two obvious fixes are both wrong: auto-prefixing the
tenant column rewrites 22 correct declarations and breaks the token, and the
naive *the constraint must name the tenant column* rule reports **ten correct
declarations** — which is how a rule gets baselined and stops running.

So the test is **transitive**: per-tenant if the columns carry the tenant column
**or** a key reaching a model that is itself scoped. It reads the `scopedSet`
fixpoint the tenancy walk already computes, so a grandchild costs nothing.

A **warning**, not an error, because the global reading is legitimate — and it
names all three ways out, the way the `@@softDelete` cascade footgun does, since
forgetting the column and meaning it look identical from here. The way to say you
meant it is `@unique(global)` / `@@unique([…], global: true)`; a mis-spelled
modifier is refused by name, because one that parsed as nothing would be a schema
saying less than its author wrote. It changes no DDL and reaches no snapshot,
correctly — it is a statement to the parser and the reader.

**It paid for itself on its first run**, reporting exactly one declaration in
basecamp: `Invitation.token`, now `@unique(global)`, which says out loud that a
credential is looked up BY its value before anybody knows whose it is.

Prior art is one step stricter for a reason that does not apply here: Citus and
MongoDB sharding both REFUSE a unique constraint that omits the distribution key,
because across shards they physically cannot enforce it. On one SQLite file it is
enforceable and merely usually unwanted, so refusing would be borrowing a
constraint from a problem this engine does not have.

## 2026-09-01 — the coordination layer: every write takes the lock, every announcement waits for the commit

`FJS-638`, and it is one design rather than five fixes. litestone 3815 pass,
junction 1692, sierra `test:safety` 5/5, caravan 188, auth 244.

`FJS-237` built the FIFO write lock and the AsyncLocalStorage ownership that
tells a genuine nesting from a concurrent caller — and only `$transaction`,
`createMany` and `upsertMany` ever acquired them. Everything else ran bare on the
shared write connection. Four measured consequences, all closed here.

**Reads consulted a global counter.** `makeReadRouter` picked its connection off
`txState.depth`, so while ANY transaction was open anywhere, every read in the
process went to the write connection and saw uncommitted rows — a dirty read
across callers, dressed as a visibility fix for the holder. It asks `ownsTx()`
now: the same question `wrapExclusive` asks to spot a nesting, so the two cannot
disagree about who is inside.

**Every write verb now runs its database region through the lock.** `create` and
`update` through `exclusive`, because their nested writes are themselves table
calls and the body has to be async; `remove`, `delete`, `restore` and the three
bulk verbs through the cheaper sync-body `wrapExclusive`. Only the DB region, not
the whole method — a plugin's `beforeCreate` may do network I/O and must not hold
the write lock. What this closes: a bare `create` arriving during a stranger's
transaction was silently enrolled in it, returned the row as a success, and was
erased by that stranger's rollback.

**A nested write is atomic.** `create({ data: { kids: { create: [...] } } })` was
a parent insert plus sequential child inserts with no transaction, so a child
violating a `@unique` left the parent committed — and a `@sequence` model kept
the counter bump its failed insert had already made, which is the same defect
`createMany` fixed for the bulk path and left in the single one.

**The post-update policy check rolls back for real.** It was a compensating
`UPDATE` writing the before-snapshot back, under a comment claiming it ran inside
a transaction. That is visible to concurrent readers in the window, permanent if
the process dies between the two, and clobbers any concurrent write that landed
in between. Inside a real transaction the throw IS the rollback, so the
compensating write is gone.

**An announcement now means committed** (`FJS-D170`). Events are held on the
transaction and flushed after `COMMIT`, dropped on rollback, with a mark taken at
`begin` so a SAVEPOINT rollback drops exactly the events queued since it. Held at
`fireEvent`, the one funnel every announcement already passes through, so no call
site is asked to remember. Before this, a create inside a transaction that rolled
back still reached `$tapEvents` → junction's `announceDataWrites` → every open
tab, and nothing retracted it.

**One contract moved, and it is ruled rather than absorbed** (`FJS-D171`).
Serializing writes makes the in-process transition race impossible, so the loser
of two concurrent named moves now gets the `TransitionViolationError` that the
same two moves in sequence always gave. The old `TransitionConflictError`
`retryable: true` was an artefact of both callers evaluating against `draft`
before either committed — the same end state answered two different classes
depending on who won by a microsecond. *Somebody moved this under me* is earned
by a declared precondition everywhere it exists (HTTP's `If-Match` → 412,
Hibernate and EF Core's version column, Postgres's `40001`), and litestone's
precondition is `@version`. The engine-detected race survives across processes,
where the compare-and-swap is the only authority.

**Cost, measured A/B on one machine at one moment**: ~60 → ~74 µs/op on the
fastest possible write — an empty model, no policies, `select: false`, which is
the largest that ratio ever gets. A first measurement of 117 µs/op was
contaminated by a benchmark still running in the background, which is worth
recording: the machinery itself (promise lock, ALS, `BEGIN IMMEDIATE`/`COMMIT`)
measures ~5% against a bare insert.

**`FJS-637`'s check is now scoped by kind.** `PRAGMA foreign_key_check` walks
every foreign key of every row, which on the 900-model erpnext corpus schema
timed a test out — so it runs only after a migration containing a statement that
can actually move or remove rows (`INSERT INTO`, `DELETE FROM`, `DROP TABLE`, a
rename). An `ADD COLUMN` or a `CREATE INDEX` cannot orphan anything.

## 2026-09-01 — four fail-open holes closed: the `where` key, the JS policy floor, the `check()` cycle, and the rebuild's missing FK check

3815 pass, 0 fail; junction 1692 pass, sierra `test:safety` 5/5. Out of a
six-pass design audit — `IDEAS/provable-enforcement.md` records what the audit
concluded about the shape of these, which is that every one of them sits in a
blind spot of the verification organ this package already ships.

**`FJS-634` — a crafted `where` KEY was injection, and an ordinary typo was a
wrong answer.** `checkWhereKeys` warned rather than threw for an unknown key on a
read (`FJS-D57`) and the key then reached `buildWhere`, interpolated as
`"${key}"` with nothing escaped. Measured: `id" = 2) OR ("id` closes the quote,
unbalances the parentheses the row policy is ANDed inside, and hands a caller
scoped to owner 1 **every row in the table** — one line on stderr, status 200.
And the ordinary case was never the harmless one the ruling assumed: SQLite reads
a double-quoted identifier it cannot bind as a STRING LITERAL, so
`{ ownerIdd: 1 }` compares two constants and answers **no rows**, which is *the
wrong rows rather than fewer* — the exact sentence the same function already uses
to justify throwing for a `@computed` key two reasons down.

Both throw now, with the did-you-mean hint moved into the error
(`FJS-D169` reverses `FJS-D57`'s read half; the write half stands). Beside the
chokepoint there is now a belt: **`quoteIdent` in `query.js` is the one owner of
putting a name into a pattern** and doubles a `"`, used at every caller-facing
clause site — Invariant 8 is about the pattern, not about one entry point.

The second door was the same class: a named aggregate's `filter` accepted a plain
STRING and emitted it verbatim, reachable through `db.order.query(req.query)`,
which the docs advertise. It takes a `` sql`` `` tag only, the rule
`orderBy: { $raw }` already applies for the reason stated there — *a plain string
is how an injected one arrives*. `$checkWhere` is untouched: a boundary that can
answer 400 still asks without throwing.

**`FJS-635` — the policy interpreter that grades CREATE failed open.**
`compileSql` throws on an unknown AST node; `evalJs` returned `true` and its
comment called that conservative. The two halves cover **disjoint operations** —
read/update/delete compile to SQL, create and post-update evaluate in JS — so a
node added to the grammar and to the SQL half alone does not fail anywhere: it
makes every `@@allow('create', …)` holding it a silent no-op, on the one check
where the payload IS the row and there is nothing to filter. This package had
already paid for the shape once and repaired only the instance (`FJS-282`,
`check()` permitting a cross-tenant create in silence); the floor underneath it
stayed. Both defaults throw now, `compare()`'s unknown operator included.

**`FJS-636` — a `check()` cycle compiled to allow-all.** Two models each holding
`@@allow('read', check(other))` are deny-by-default whitelists on both sides, and
the cycle guard's `return '1'` — its own comment said *open if recursive* — let
an anonymous caller read both. It returns `'0'` now, the direction every other
refusal here takes. A chain never reaches that line; the one shape this narrows
rather than fixes is a self-relation checking its own parent, which no schema
here writes. Deciding it at STARTUP is the better answer and stays open as
`FJS-636`, because this runs per query and cannot be the thing that says so.

**`FJS-637` — a rebuild committed foreign-key orphans.** Every migration runs
under `PRAGMA foreign_keys = OFF` and nothing ran `PRAGMA foreign_key_check`
before `COMMIT` — step 11 of SQLite's own 12-step ALTER procedure, and the one
that was missing. Measured: a plain `postId Int` holding 999 with no matching
row, given a `@relation` and migrated, answered `migrated` and left the violation
**permanently**, because SQLite checks a foreign key when the CHILD row is
written — so it surfaces at the next unrelated update of that row, months later,
as a refusal about a row somebody was only renaming. Checked inside the
transaction now, over the whole database rather than the migration's own tables
(rebuilding a PARENT is what orphans rows in a child the migration never names);
a failure rolls the migration back and names table, rowid and parent for the
first five. The row-count guard is untouched and never covered this — it counts
rows, not references.

**Filed and not fixed**, each measured: `FJS-638` (single-row writes and all
reads bypass the transaction lock — dirty reads, ghost writes, torn nested
creates, and rolled-back rows announced to every tab), `FJS-639` (`strategy row`
leaves every `@unique` global across tenants, and the refusal names the value to
the wrong tenant), `FJS-640` (the tenant pool closes clients it has lent out),
`FJS-641` (a column rename is silent data loss under `autoMigrate`), `FJS-642`
(the live layer is in-process, so a second process announces nothing — needs a
ruling), `FJS-643` (a plain `Int` past 2^53 corrupts on READ of a correctly
stored value).

## 2026-09-01 — `jsonschema --out` creates the directory it was told to write into

3814 pass, 0 fail.

`--out` is read as a directory only when that directory ALREADY EXISTS —
otherwise it is a file path — so `--out db/.json` writes a file literally named
`.json` on a fresh clone, and `--out db/.json/schema.json` failed with ENOENT
naming the FILE, which reads as a permissions problem rather than a missing
parent. Both branches (`--all-modes` and the single write) now `mkdirSync` the
parent first. The behavior that could not be fixed here is the directory
ambiguity itself: it is load-bearing for callers passing an existing directory,
so the recommended spelling states the filename.

## 2026-08-31 — `@seals` — a document seals on a MOVE, and its children seal with it

`FJS-D167`, answering the half `FJS-D162` left open. 3814 pass, 0 fail; junction
1692 pass, sierra 1141 pass.

`@immutable` freezes at CREATE, and that is the wrong moment for a document an
app assembles line by line — which is why `IDEAS/billing.md` had already removed
`draft` from the invoice rather than fight it. Two new attributes: `@seals` on a
transition, beside `@gate` and `@system`, and `@sealed` on a hasMany relation.

```lite
model Invoice {
  number String   @immutable
  total  Int      @immutable
  lines  InvoiceLine[] @sealed      // which children the document is made of
  payments Payment[]                // and which go on arriving after it
  @@transitions(state,
    issue:  draft  -> issued @seals @gate(5),
    settle: issued -> paid @system,
    void:   issued -> void)
}
```

**Measured before anything was written.** Every writable column on `example`'s
`InvoiceLine` is already `@immutable`, so the gap was two operations and only
two — `create` and `delete` on the child, the pair `@immutable` cannot reach.

**The sealed set is a CLOSURE, not a target.** Everything reachable from a
`@seals` move's target, so `paid` and `void` seal without being restated and a
move appended later seals by arriving. A one-hop reading passes every behavioral
assertion and leaves the document editable in two of its three terminal states,
which is why `test/seal-parse.test.ts` asserts the set rather than the syntax.
`src/core/seal.js` is the one owner — three readers ask it.

**Three parse refusals, and two of them are the same mistake told apart.** A
reopen move makes one value mean sealed and unsealed. A second `@seals` from an
already-sealed state seals nothing and says it does — distinguished by computing
the closure the OTHER seals produce, so the message names the seal that got there
first. And a `@seals` with nothing to seal is a typo rather than a no-op: the
move parses, the artefacts render it, and no write is ever refused.

**The guard is a PREDICATE, composed like the two beside it.** It rides the WHERE
next to the transition compare-and-swap and the `@version` check, so a refused
write is zero rows changed — which already meant five things. An insert has no
WHERE, so a guarded create is `INSERT … SELECT … WHERE NOT EXISTS (…)`; the
parent is aliased everywhere it appears, because the caller's own where is
unqualified and a self-referential `@sealed` relation is the same table twice.
Nine write paths carry it and each is paired in the tests with the same call
against a draft parent — a guard that refuses everything looks identical from the
refused side (`FJS-351`).

**The sentence comes from a follow-up read on the failure path only**, and it runs
LAST: a caller refused by a policy is told that, not told the document is sealed.
`SealedDocumentError`, 409, `retryable: false`, naming the document, the state and
the relation or the columns.

**`asSystem()` does not lift it**, which is where it parts company with
`@@transitions`, which `asSystem()` bypasses entirely. A gate is about who is
asking; a seal is about what the row IS.

**`@immutable` changes meaning on a sealing model** — *frozen at the seal* — and
that is the one shipped behavior this touches. Scoped by the declaration, so a
model with no `@seals` move keeps the create-time meaning and its
`ValidationError` exactly. The guard applies only where the payload names a
frozen column: narrowing every update would refuse `settle: issued -> paid`, a
move the machine declares out of a state the seal itself put the row in. Two back
doors were closed with it — `updateMany`, and `upsert`'s ON CONFLICT fast path,
which cannot carry a state guard and now falls through to create + update.

**It stops being `readOnly` in the update schema**, because no schema can answer
a question whose answer is in the row. `x-litestone-kind: 'immutable-until-seal'`
carries the state column and the sealed set instead; sierra's `sealedFor(rule,
record)` is the one owner of resolving it, and a create form has no record and is
correctly never frozen.

**A bulk write filters rather than throwing**, as it already does for a row policy
and as `updateMany` already does for a transition. The count change is scoped to
sealing models, or `ON CONFLICT DO NOTHING` would silently stop counting.

Both halves are in `access.snapshot.md` (a **Seals** column beside **Made by**,
and the relation list under it) and in the release surface, where gaining either
is a **contract** — an N-1 release that writes a line onto an issued invoice stops
working the moment the deploy lands.

What this does NOT build: the cross-row check at the seal. `@seals` hands it its
moment for free, which is the point of the shape, but it is its own feature.

`test/seal-parse.test.ts` (19) · `test/seal-guards.test.ts` (33) ·
`test/seal-immutable.test.ts` (14) · `test/seal-artefacts.test.ts` (14) ·
`src/core/seal.js` · `docs/modeling.md` § `@seals`

## 2026-08-31 — a caller-only field read predicate is answered once, not per row

`FJS-619`. 3731 pass, 0 fail; typecheck clean.

The audit's **M7**, its worst per-row cost, and the one place a read policy is
still answered in JS: `FJS-D129` compiles a field read predicate into the WHERE so
a caller cannot FILTER by a column they may not read, but which columns come back
ON a returned row is a per-row strip. `@allow('read', auth().isAdmin)` has one
answer for a whole result set and was asked once per field per row through the
expression interpreter.

**The classifier is an allow-list and that is the whole of its safety.**
`referencesRow` names the kinds that read only the caller — `literal`, `auth`,
`and`, `or`, `not`, `compare`, `ternary`, `list` — and everything else is assumed
to read the row: `field`, `check`, and any kind the language grows later, which is
then evaluated per row, slower and correct. A deny-list would silently stop
stripping a column the day a kind was added.

**`now()` is refused though it reads no row.** Hoisting a clock-dependent
predicate across a page answers one instant for rows read at another, and the case
is too rare to be worth a second staleness rule.

Two caches, because the two facts have different lifetimes: row-freeness is a
property of the AST and is global; the ANSWER depends on the caller and hangs on
the context, keyed by `ctx.auth` so a context that ever reassigned it invalidates
rather than going stale.

Measured, 5,000 rows × 4 protected columns, three interleaved runs on one machine:

| | µs/row |
| --- | --- |
| no field policy (floor) | 0.61 – 0.67 |
| 4× caller-only `@allow`, hoisted | 0.77 – 0.84 |
| 4× row-dependent `@allow`, per row | 1.11 – 1.21 |

About **30% off the read**, and ~70% of the gap to a model with no field policy.
`bench/audit-bench.mjs` case 12.

12 tests, and almost all of them are about the hoist NOT applying. A wrong hoist is
silent in the worst way — every row takes the FIRST row's answer, so a list looks
right whenever its rows agree — so every case reads a page whose rows disagree,
including a mixed expression with one caller-only branch beside a row-reading one,
and two `@allow` on one field of which only one reads the row.

Filed alongside it: `FJS-620` (four more audit findings in no register) and
`FJS-621` (everything measured is the write path; every expensive-by-shape feature
is on the read path).

## 2026-08-31 — a nested write survives `select: false`

`FJS-615`. 3708 pass, 0 fail.

`extractNestedWrites` returns `{ scalar, nested }` and `nested` is an OBJECT, so
`nested.length` is `undefined`. Three separate guards asked it that question and
all three read *there are no nested writes*. It is not a typo three times:
`.length` on an object is silently falsy rather than an error, which is what lets
one wrong spelling be written three times and never fail.

**`create({ select: false, data: { …, lines: { create: [...] } } })` wrote the
parent and dropped every child**, returned `null`, said nothing — the skip-RETURNING
branch leaves no parent id to attach children to. `update` carried the same guard
and the same hole, but only where the payload ALSO holds a scalar column: a
nested-only payload sets no columns, misses that branch entirely and worked by
accident, which is why the create case went unnoticed. The `upsert` fast path's two
`break fastPath` guards never fired either, so a legitimate nested write reached the
column validator and was refused as `lines: must be an array` — loud, and about the
wrong thing.

Fixed at the SHAPE rather than at the three call sites: `extractNestedWrites` now
answers a `hasNested` boolean and `nested.length` appears nowhere.

**`select: false` keeps its contract.** RETURNING is still used when children need
the parent's id — that is this method's need, not a change to what the caller asked
for — and `null` is still what comes back. The announcement keeps the row, because
it has one: `null` there means the RETURNING was skipped, which is now a different
fact.

Eight tests in `test/nested-write-guards.test.ts`, five measurements and three
controls. The controls are the point — the guards exist to keep a real saving on
the ordinary call, so a fix that simply stopped taking the fast path everywhere
would pass every other assertion and be worth nothing.

Found reading `create`'s fast path while pricing `FJS-D162`'s frozen-aggregate
option, which rests on nested create being sound.

## 2026-08-31 — a move asked for BY NAME is a different question

`FJS-611`. 3700 pass, 0 fail; junction 1672, sierra 1141, typecheck clean;
`example` green across `verify:batch` (33), `verify:payrun` (41),
`verify:employment` (61), `verify:retro` (56), `verify:billing` (29),
`verify:pay` (24), `verify:collect` (49) and `verify:stripe` (12).

**The row's diagnosis was wrong and what was there is worse.** `transition()` is
not read-then-write: the UPDATE has always carried `AND status = <from>`, so four
concurrent movers give one winner and three conflicts, measured. What was missing
is the difference between the two calls that reach that code:

- `update({ data: { status } })` carries a COLUMN, and carrying the value the row
  already holds is legitimate — a form round-trips the whole row.
- `transition(id, 'calculate')` asks for a MOVE, and the same row state means the
  opposite: it did not happen here.

`transition()` desugars into `update()`, so all that arrived was a column and a
value, and the early return on `currentValue === newValue` answered the first
question to both. **It took the gate, the capability and `@system` with it**, so a
`@gate(5)` move and a `@system` move were both makeable by any caller who could
update the model as long as the row was already at the target. Both succeeded,
measured — which makes half of this an access defect rather than an answer one.

**`$transaction` was the documented mitigation and it made things worse.**
Serializing the callers means each re-reads *after* the winner committed, which is
precisely the state the early return called a no-op: four concurrent transactions,
four successes. It now gives one winner and three conflicts like everything else.

`transition()` passes `_move` — the one thing it knows and `update()` cannot
derive. A named move resolves by NAME rather than by matching `(from, to)`, and:

- the row already at `to` → `TransitionConflictError`, `retryable: false`
- the row anywhere else → `TransitionViolationError`, as before
- the row at a legal `from` → the compare-and-swap, as before

**`retryable` now separates two opposite races under one class.** Losing to a
DIFFERENT move stays `retryable: true` — re-read and decide. The move you asked
for having already been made is `false`, because re-applying can never succeed and
`isStaleWrite()` would otherwise loop a worker against a settled row. The error
carries `expected` (the move's from-states), `actual` (where the row is) and
`move`, and declares them as `data` for the reason `VersionConflictError` does:
instance properties do not cross junction's error boundary, so without it `actual`
never reaches the browser and sierra's `toConflict()` has nothing to read.

**A named move is graded on its CALLER before its row**, which is the order every
other layer here reads in. A gate, a capability and `@system` are statements about
the caller and the declared move, true whatever the row is doing, so somebody who
could never make the move is told that rather than being told where the row is —
a refusal confirming state to a caller with no authority over the move. It applies
to a named move alone: an ordinary update matching no `(from, to)` pair has
identified no move, so there is no gate to consult. **Naming the move is what
makes its gate askable**, and that is the statable rule rather than an asymmetry.

The three grading rules moved into one `gradeMove` shared by both paths, or they
would be two answers to one question the first time either learned something.

Ten tests in `test/transition-race.test.ts`, five of them measurements of the code
as it stood. The negative controls are the point: the four-concurrent case already
passed and is kept, so a green suite cannot claim credit for the CAS; the ordinary
update round-tripping an unchanged column is still a silent no-op; and `asSystem()`
still bypasses all of it.

`example`'s `completeIfDone` and `verify:batch` each credited a mechanism that was
not operating — the transaction, and the state machine. Both run on `asSystem()`,
which bypasses `@@transitions`, so what actually held them is the `status` READ
inside `BEGIN IMMEDIATE`. Comments corrected; the boundary now backs them up for
an ordinary caller.

## 2026-08-31 — `@system` on a transition reaches the artefacts a reviewer reads

`FJS-613`. 3689 pass, 0 fail; typecheck clean. Regenerating the three committed
snapshots in `example` and `basecamp` surfaced **twelve `@system` moves** that had
been invisible in every one of them.

`@@transitions(status, cancel: … @system)` is the strongest answer a state machine
can give to *who may make this move* — from *any caller at the update level,
subject to the row policies* to *no caller, ever, the application included*. It was
parsed, enforced, carried to the browser in `x-transitions` and rendered as a
refusal by `transitionsAt`. And it appeared in **none** of the three files that
exist so a change to who may do what is a review artefact: `access.snapshot.md`
dropped it at derive, `release.snapshot.md` inherited that hole, and
`jsonschema.snapshot.md` had the fact in the document and dropped it at render.
Measured by generating each from two schemas differing in that one token: the
output differed in the filename in its own header and nowhere else.

**Two columns, because the two facts compose.** `@gate` says who may ASK;
`@system` says the APPLICATION makes it. `@system @gate(5)` is both — a move the
engine decides on behalf of a caller who must still be senior enough to ask for it,
which basecamp declares four times on `Server`. So the access snapshot grows a
**Made by** column (`caller` / `application`) beside the level rather than folding
one into the other, and folding is exactly what would lose the distinction on the
four rows where it is hardest to see.

**The deploy grade follows the same reading.** Gaining `@system` is a CONTRACT and
`narrows`; losing it is an EXPAND and `widens` — an N-1 caller still asking for a
move that has become the application's is refused, and a move the application
owned is handed to whoever holds the level. It is graded on its own axis and never
through the gate, so a change that raises the gate AND makes the move `@system`
reports two findings rather than reading as an ordinary level bump.

Also: `db.<model>.transitions()` had no `system` or `refusedBy` in its declared
type and `transition()` no `{ system: true }`, though the runtime has answered all
three since the feature shipped.

Six tests in `test/release.test.ts` — one per artefact, the two directions, the
composing case, and the two-findings case — plus `@system` added to
`litestone.test.ts`'s shared access fixture, so the derive and the render carry it
rather than testing it beside themselves. Every one fails against the code as it
stood, and the first is the whole of the defect.

## 2026-08-31 — `@@unique(where:)`: conditional uniqueness

`FJS-603`. 3683 pass, 0 fail; `example` green across `verify:employment` (61),
`verify:payrun`, `verify:retro`, `verify:batch`, `verify:payroll`, `verify:billing`
and `verify`.

*At most one OPEN row per parent* — the constraint effective dating is built on —
had no spelling. `@@index([cols], where: …)` existed; `@@unique` took no
predicate, so the near miss `@@unique([planId, effectiveTo])` was refused BY NAME
and the refusal offered `nullsDistinct: true`, which is the correct declaration
of the OPPOSITE. Three models in `example` declared it and enforced the rule they
wanted in a service.

**One word, two node kinds.** A plain `@@unique` rides inside `CREATE TABLE` as
`UNIQUE (a, b)`; no dialect takes a predicate on a table constraint, so the
predicate form parses to `partialUnique` and is emitted as a standalone
`CREATE UNIQUE INDEX … WHERE`. That is what makes every downstream reader correct
without being edited: the table emitter cannot pick one up, a one-to-one relation
cannot be satisfied by a constraint holding over only some rows, and `advise`'s
foreign-key coverage does not count an index that covers some of the rows. Django
makes the same split under the same word. The two also migrate differently — one
DROP and one CREATE where a table constraint rebuilds the table.

**The line the feature turns on is a removal.** `createIndexes` ANDs
`@@softDelete`'s `"deletedAt" IS NULL` into a declared `@@index(where:)`, because
there the clause is what makes the index reachable. It must NOT be ANDed into a
declared `@@unique(where:)`: on a unique index the predicate IS the constraint, so
ANDing it is `FJS-204`'s rejected derivation arriving through the back door — the
deleted row stops holding its `@unique` slot and `SoftDeletedUniqueError` can
never fire, because the index no longer covers the row that would raise it.
Uniqueness among live rows is written `where: deletedAt == null`, by the author.

**The grammar is wider than `@@index`'s and the reason the record predicted was
wrong.** A partial index earns its place by being MATCHED, so a predicate the
caller's own filter cannot reproduce is refused; enforcement on INSERT never
consults the planner, so `where: status == "active"` is a correct constraint that
happens to be a useless read path. But SQLite refuses a **bound parameter** in a
partial index predicate whether or not it is unique, and this compiler binds every
value — measured, `parameters prohibited in partial index WHERE clauses`, at
migration time against a table the author is no longer looking at. The literals
are inlined instead, which is safe because they are the schema's own and never a
caller's. `now()` and `auth()` are still refused by name, and `now()` for a
sharper reason here: SQLite ACCEPTS a clock in an index predicate, so a constraint
whose coverage moves under a row that never moved is a duplicate and nothing below
would refuse it.

**`release.js` carries the predicate**, which was the one correctness hole:
`describeModel` keyed a unique on its sorted column list alone, so narrowing or
widening one graded as no change. Gaining a predicate is an EXPAND, losing one is
a CONTRACT, and a move between two non-empty predicates is UNKNOWN — whether one
implies the other is implication between two SQL expressions, and a text
comparison answering it would be a deploy verdict made by a regex.

**The importer carries it now** where the reading can express it, and drops it
WHOLE where it cannot — a stronger constraint than the source declares refuses
rows the source permits. `predicateToLite` grew the value form under a flag, asked
for on the unique path alone: a partial index over a bound value is refused at
parse, so carrying one there would write a `.lite` this parser will not read
(`FJS-594`). A tuple with a nullable member is still dropped, for the same reason
— it wants `nullsDistinct: true`, and a predicate excludes it.

**The nullable-composite refusal names both answers now**, with the column list
CHANGED in the suggestion: the nullable column moves out of the tuple and into the
predicate, which is the whole of what separates *those rows are deliberately
unconstrained* from *at most one of them exists*.

## 2026-08-30 — a key the caller supplies (`FJS-608`)

`generateJsonSchema(…, { mode: 'create' })` excluded **every** `@id` as
*server-assigned*. For a model keyed by anything the server does not generate,
the key was therefore not merely un-required but absent from the schema
junction's `autoValidate` compiles.

**The symptom is the opposite of a rejection, which is what made it hard to
read.** Junction strips what the create schema does not declare rather than
refusing it, so the key was removed from the payload in silence and the refusal
came from the Data boundary one layer down. Measured through a real service
against the pre-fix emitter:

```
POST /memberships  { orgId: 'acme', userId: 'ada', role: 'admin' }
→ 400  Validation failed — orgId: orgId is required, userId: userId is required
```

Naming the two fields the request had just sent.

**It is not about composite keys**, which is only how it was found. A single
`code String @id` — a slug, a stock keeping unit, an external system's
identifier — behaved identically. Every `@id` was treated as though it were
`Int @id @default(autoincrement())`, the one case where excluding it is right.

### Two readers, one question, no owner

`jsonschema.js` excluded every `@id`. `client.js`'s required pre-flight skipped
`attrs.some(a => a.kind === 'id') && f.type.name === 'Int'` — the **type**, not
the key — so an `Int` member of a composite `@@id` was taken for a rowid alias,
and a create omitting it reached SQLite and came back as a raw
`NOT NULL constraint failed` naming a physical table: the error shape every
required field exists to avoid.

`isServerAssignedId(field, model)` in `core/ids.js` is the one owner now, and
both call it:

| The key | `create` | Because |
|---|---|---|
| a lone `Int @id` | omitted | SQLite's rowid alias — it auto-assigns with nothing declared |
| any declared `@default` | omitted | filled here, or by SQLite |
| `String @id` with no default | **present, and required** | nobody but the caller can produce it |
| every member of `@@id([a, b])` | **present, and required** | a composite key is never a rowid alias, whatever the column types |

Update mode is untouched: there the key is in the `where`, not the payload, and
it was already emitted as an ordinary property.

### What it moved in this repo

Two lines, on the one model here with a caller-supplied key — basecamp's
`OutpostNonce`. Its committed `jsonschema.snapshot.md` had been spelling the
defect out in its own words the whole time:

```diff
-**On create**: required — nothing · not accepted — `nonce`
+**On create**: required — `nonce`
```

### What is asserted

12 tests in litestone — a grid of seven key shapes, each one **run** rather than
read off the helper, plus the property that the schema's `required` and the
client's refusal agree for every shape. Five in junction, which is the layer
litestone's own suite cannot reach: there the schema is a document, here it is
compiled into a validator standing between an HTTP body and a row. That file's
negative control is that omitting the key is still a 400 naming it, so it cannot
pass against a schema that stopped validating.

## 2026-08-30 — `@@id([a, b])`, and the key order that had nowhere to live (`FJS-561`)

The register said a composite primary key was *not expressible*, and that a table
whose key is its pair *takes a surrogate id plus `@@unique`*. Both were wrong.
Two `@id` fields have always parsed clean and emitted
`PRIMARY KEY ("orgId", "userId")`, carrying `create`, `findUnique` over both
columns, `update`, `remove`, `restore`, `include` and `findManyCursor`, with a
duplicate refused by name. The implicit many-to-many join table this package
generates has been exactly that shape since it was written.

**So the question was never whether to support composite keys. It was whether to
give the model-level word a grammar** — and the answer is yes for a reason the
register did not have.

### What `@@id` adds is the ORDER

A primary key builds an implicit index, and an implicit index is prefix-matched
like any other: `PRIMARY KEY (orgId, userId)` answers `WHERE orgId = ?` and the
swap does not. With `@id` on the fields, the key's column order is the *field
declaration* order — a different fact about the model, and one nothing could
override.

That is not theoretical. `litestone introspect` read
`PRIMARY KEY ("userId","orgId")` off a real table, emitted `@id` on each column
in column order, and wrote a schema that builds the key the other way round with
nothing said. Silent until now; visible from now on, because `FJS-596` made a
reordered key migrate — so the schema it wrote asked for a table rebuild that
would have installed the wrong key.

### Shipped as sugar, deliberately

The parser marks each named field `@id` and leaves the attribute on the model,
where exactly one caller reads it — `tableConstraints`, for the order. Nothing
downstream learned a new shape, because several `@id` fields is a shape every
reader already handled.

Five refusals, each one a key that would not identify a row:

| Written | Why |
| --- | --- |
| `@@id` beside a field-level `@id` | two answers to *what identifies a row* |
| `@@id` twice | a row has one identity |
| a nullable member | SQLite permits a NULL in a primary key on a rowid table, and there is no `nullsDistinct` reading of one |
| a relation field | a primary key is over columns — name the foreign key |
| an array, or `@computed` / `@transient` / `@from` / `@derived` | not a stored column; an array is a JSON serialization |

**A guard that had never fired is now live.** `TRAIT_FORBIDDEN_MODEL_ATTRS` has
named `'id'` since traits were written, with the message *`@@id` is not allowed
in a trait (host-model concern)* — unreachable, because `parseModelAttribute`
refused the word first. `docs/traits.md` and `PROJECT_STATE.md` described it as
real, and are now accurate rather than deleted.

### The import cost is paid

All three readers that can see a composite key carry it instead of inventing
`id String @id @default(cuid())` plus a `@@unique`, which is a *different*
statement — it admits a second identity for the same tuple. The corpus,
regenerated through the shipped readers, turns the register's own measurement
into carried keys:

| | before | after |
| --- | --- | --- |
| `composite-primary-key` gaps | 7 | **0** |
| `@@id` declarations | 0 | **7** — Cal.com 4, Trigger.dev 2, Documenso 1 |

The tier keeps the kind for the one case that genuinely cannot be carried: a
source key with a **nullable** member, where the surrogate is the honest reading
and stays graded.

### What is asserted

18 tests in `test/composite-id.test.ts`. The sharpest is a **fixed point** rather
than a string — introspect the table, build a database from the output,
introspect again, same text — with the negative control beside it that the schema
it wrote migrates nothing against the database it came from.

**Still open**: a model keyed by a tuple cannot be served as a REST resource —
junction and sierra each carry a single `idField`, and `/{service}/{id}` has one
slot. And a caller-supplied primary key is absent from the create-mode JSON
Schema entirely, which is `FJS-608` and is not about composite keys at all.

## 2026-08-30 — a UNIQUE the table declares was in no diff at all (`FJS-596`)

Filed as *a reordered `@@unique` migrates nothing*, and the reorder was the small
half. `@unique` on a column and `@@unique([a, b])` are both emitted **inside**
`CREATE TABLE`; SQLite builds an implicit index for each, and an implicit index
has NULL `sql` in `sqlite_master` — which is exactly what the index read filters
on. So none of it was ever compared. Measured before anything was written:

| | |
| --- | --- |
| add a `@@unique` or a `@unique` | no `tableDiff` at all |
| remove one | no `tableDiff` at all |
| reorder a composite one | no `tableDiff` at all |
| reorder a composite primary key (two or more `@id` fields) | no `tableDiff` at all |

**The first two are correctness, not performance.** `UniqueConflictError` and
`SoftDeletedUniqueError` are this package's words for a constraint the *database*
holds, so a constraint that never reached the database is one that never fires
and the duplicate lands. The mirror is as bad the other way: a removed one left
the live table refusing writes the schema allows, in SQLite's own sentence about
a table nobody named. The two reorderings are `FJS-592`'s performance fact one
constraint kind along — the implicit index is prefix-matched like any other.

**Read off `PRAGMA index_list`, not parsed out of the CREATE text.** There is a
pragma here and it answers the column order directly, the same reason `generated`
comes from `table_xinfo` and a CHECK does not. `origin` does the separating, and
each of the three values earns its place:

- **`u`** — a UNIQUE constraint in either spelling, so `email String @unique` and
  `@@unique([email])` compare **equal**: SQLite builds the same implicit index for
  both, and swapping one for the other is not a change to the database.
- **`pk`** — a composite primary key, whose column order was invisible for exactly
  the same reason and is prefix-matched exactly the same way.
- **`c`** — an explicit `CREATE UNIQUE INDEX`, filtered out. Read here it would be
  seen by both readers and each would report the other's as missing; and an index
  the *app* made is `foreign` to `diffIndexes`, which deliberately leaves it
  alone, so this would rebuild a table to remove a constraint litestone never
  declared.

**The decision the issue left open was settled by measuring it**, the way FJS-592
was. Each real database in this repo diffed against its own schema with the
change in — `example/db/shops/flagship.db` and `packages/basecamp/db/basecamp.db`
— both **zero churn**, and no table added to any diff. Not luck: the emitter
writes declaration order, so for any database litestone created the live order
already IS the pristine order, and the only schema that migrates is one whose
declaration genuinely moved.

The cost where it does fire is a **full rebuild** — no `ALTER` reaches a table
constraint, which is why the cheap half shipped alone in FJS-592 — and a rebuild
that adds uniqueness fails on the copy where the rows already violate it, inside
the transaction, so it rolls back.

Eight tests in `test/index-predicates.test.ts`, three of them negative controls:
the same order migrates nothing, the spelling swap migrates nothing, and an
explicit `CREATE UNIQUE INDEX` is not read here at all.

## 2026-08-30 — `AGENTS.md`, and the tarball that carried neither it nor the catalogue

A compressed reference for writing a `.lite` schema from an installed copy of
this package, under the name other tools converged on (`FJS-D163`). It carries
the judgement half — which access word to reach for, the eight scalar types and
the four that are refused, the shapes where a legal spelling means something
else — and deliberately does **not** restate the language: `catalog.snapshot.md`
is generated from the parser's own switch arms and gated by CI, so a hand-written
word list beside it is a second answer that goes stale.

**`files:` was `["src/", "README.md", "LICENSE"]`**, which is the half that makes
the file real. `docs/` and every snapshot stopped at the workspace edge, so an
agent working in an installed app had the 2,452-line README and nothing else —
no catalogue, no per-word reference, no access-control page. `AGENTS.md` and
`catalog.snapshot.md` now ship. `litestone explain <word>` already worked there,
since `src/tools/` was always packed; nothing pointed at it.

Every refusal the new file claims was executed against the parser rather than
read out of a document — the four renamed types, `Decimal`, a `Float[]`,
`@@id([a, b])`, `@guarded(5)`, `@@softDeleteCascade`, `@@index([deletedAt])`
beside `@@softDelete`, and the optional-column `@@unique` in both directions.

## 2026-08-30 — what a migration does when it cannot do the thing (`FJS-604`, `FJS-605`)

Two defects on one seam, both silent, both found adding a single column to an
application that already had rows.

**A blocked column reported success.** `autoMigrate` checked its blocked list on
the REBUILD path only. A plain column add needs no rebuild, so a `NOT NULL`
column with no default was collected as `blockedAdds`, written out by the
generator as a commented `-- ALTER … -- BLOCKED`, correctly executed by nobody,
and reported as `{ state: 'migrated', applied: 0 }` — which is indistinguishable
from a schema with nothing to do. The application then ran against a table
missing a column its own seed declares, mass-assignment protection stripped
every write of it, and a required field read back `undefined`. Both paths are
graded now, and it **announces** as well as returning `blocked`: the caller that
found this discards the result, as most do.

It blocks whether or not the table holds rows, deliberately. Migrating an empty
table and refusing a populated one migrates on every developer's machine and
blocks at the deploy.

**An expression default threw a raw SQLite error at boot.** SQLite takes an
expression default in `CREATE TABLE` and refuses one in `ALTER TABLE ADD
COLUMN`, where it wants a constant — and `@default(now())` emits
`DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`. The diff called it a simple
add, so the ALTER was generated and `near "(": syntax error` came out of
`autoMigrate`, at the line an app calls on first open, naming no column and no
table. It is a rebuild now, which the rebuild path already handled correctly:
the copy omits added columns, so the new table's own DEFAULT fills every
existing row.

The classifier tests for a LITERAL rather than for a leading paren. What it
compares is SQLite's reading of the pristine database, which does not always
keep the parens the emitter wrote — so the narrow test passed the check and
threw at the ALTER anyway.

Both are shared with the migration-FILE path, which goes through the same
`diffSchemas`. Four tests, and the negative control is that an ordinary constant
default still takes the cheap ALTER: treating every default as an expression
would rebuild every table that gains a column, and take the app's own indexes
and triggers with it (`FJS-183`).

## 2026-08-30 — `@immutable`: a column written once (`FJS-D162`)

What a DOCUMENT is. An invoice's number, the instant it was issued and the total
it was issued for are a statement about a moment, and the only honest correction
is a credit note beside it rather than an edit.

`@immutable` on a column refuses any UPDATE payload naming it. Three things
about it are consequences of one fact — **nothing in this language can see the
stored row beside the incoming one** — and each is deliberate:

- **It grades the KEY, not the value.** The same number sent back is refused
  too, so a form that fetches a row and returns it whole must drop the column.
  It reaches the client as `readOnly` **in the update schema alone**, which is
  the only column kind here whose answer differs by mode: a create form still
  offers the box, or the model is uncreatable through anything generated.
- **`asSystem()` does not drop it.** It joins `@check`, `@@check` and `@@arc` on
  the short list the system client cannot bypass, against the gate, the row
  policies and `@guarded`, which it can. That is the whole point: a renewal job
  and a payment settler both run as system, so a rule they may drop is absent
  from every caller that actually writes an invoice. A raw `UPDATE` still
  bypasses it, as it does a `@check`.
- **It says nothing about DELETE, and nothing about the row.** To freeze a row
  when it reaches a state, freeze its columns and let `@@transitions` own the
  state column — a document that may not move is not a document, it is a log
  line.

Refused at parse beside `@version` and `@updatedAt`, which the engine writes on
every update, and on any field with no column to freeze. The write path defaults
to enforcing, so an entry point that forgets to declare itself a create refuses
rather than lets through — `@guarded`'s own reasoning.

11 tests, and the one that matters is *the same value is refused too*: a rule
that compared would pass every other case in the file.

## 2026-08-30 — an unknown option was dropped in silence while an unknown property threw

A client THROWS on an unknown property, by design, so a typo'd accessor is loud.
`createClient` destructured a fixed list of options with no rest capture, so an
unknown OPTION was dropped the way JavaScript drops any undeclared key — the same
typo, silently not applying (`FJS-579`).

`createClient({ autoMigrate: true })` is the shape that made it visible. It has
never been an option and it does nothing; the exported `autoMigrate(client)` is
what the documentation describes. **Five of this package's own test files passed
it** — `scale`, `arc`, `corpus`, `retention`, `one-to-one` — and none of them
could see it, because a client emits DDL for a table it does not find, so every
suite that opens a fresh database passes identically with the option, without it,
and with `autoMigrateee: true` (all three measured).

**Refused by name now**, from a rest capture, so the refusal cannot go stale: what
is unknown is whatever the destructure did not bind. A near miss suggests the
option it is one edit from; `autoMigrate` gets an ANSWER rather than a suggestion,
naming the function and the reason it stays one — *migrate on open* moves a live
database ahead of the code serving it (`FJS-566`). A misspelling of an answered
name gets the answer too, since pointing at the nearest real option would be worse
than the answer that exists.

**`CreateClientOptions` was the third statement of the same fact and it disagreed
with both**: it declared 20 of the 23 options, so a TypeScript caller passing
`resolveFrom`, `busyTimeout` or `now` — two of them the subject of live hazards —
got an excess-property error on a real option. All three now, and
`test/client-options.test.ts` parses the destructure and fails if the list, the
type or the destructure drift apart.

9 tests. litestone 3591, junction 1667, sierra safety 5/5, typecheck unmoved.

## 2026-08-29 — a column refused its own stamp, so the pairing it exists for could not be spelled

`@guarded` and `@system` refuse a write by name, and until now they graded the
payload `writeData` was handed. By that point the create path has stamped its own
columns into it — `@default(uuid()/ulid()/cuid()/nanoid())`, `@createdBy`,
`@version`, `@sequence`, `@default(auth().x)`, `@default(field)` — so a guarded
column carrying a generated default refused the value litestone itself had just
injected, and **no caller below system could create the row at all** (`FJS-565`).

The cost was a whole combination rather than an inconvenience. *A token the server
mints that nobody may read and nobody may write* is exactly what `@guarded` plus a
generated default describes, and it could not be written down; `@secret` expands to
`@encrypted @guarded(all)`, so `@secret` + `@default(uuid())` was uncreatable too.
`advise.js`'s own `required-guarded-uncreatable` rule has always offered *a
`@default` generates it at the Data boundary* as the first way out, and that advice
did not work.

**What is graded now is what the CALLER sent.** Each stamp records the columns it
injected into a `stamped` set — the keys the payload did not carry — and the two
refusals skip those. Absence is the test, not a null value: naming a guarded column
and setting it to `null` is still naming it. Six write paths pass one (`create`,
`createMany`, `update`, `updateMany`, `upsert`'s fast-path insert, `upsertMany`),
and `createMany`/`upsertMany` mint one **per row**, because rows are not required
to be uniform and a shared set would let row 0's stamp excuse row 1's caller. A
path that forgets to pass one is refused rather than let through, which keeps the
old fail-closed direction where it belongs — on the framework, not on the schema.

The prior behavior was deliberate and stated at the check, and the trade-off it
named was real: grading the caller's payload separately means every write path has
to remember to. What changed is that the remembering is now the stamp's job rather
than each path's, so there is one place to add to.

Seven tests in `test/litestone.test.ts` § *a stamped column is not a caller write*,
every acceptance paired with the refusal of an otherwise identical payload; all
seven go red with the `stamped` term removed. litestone 3591, junction 1667.

## 2026-08-29 — a delete that matched nothing, and two positions nobody validated

Both found by widening `test/matrix.test.ts`, which grew four operations
(`createSt`, `createOm`, `select`, `delWhere`) and five column kinds (`float`,
`money`, `guarded`, `system`, `transient`) — 180 cells to 320.

**`delete` and `deleteMany` were the only two call sites calling `buildWhere`
directly** instead of `buildWhereWithEncryption`, and they passed `null` for four
of its seven arguments. So a `@encrypted(deterministic: true)` or `@hashed`
column compared a plaintext operand against stored bytes and matched no row —
`findMany` answered `[1]`, `count` answered `1`, `updateMany` answered
`{count:1}`, and `deleteMany` answered `{count: 0}` with the row still there. A
zero count is the one wrong answer a caller will not question. Scope expansion,
`@from` expressions and the typed-JSON map rode on the same omission; the
typed-JSON half shows in the grid as `typedJson × delWhere` going `ref` → `ok`,
a delete that had been refusing a predicate its own `find` accepts (`FJS-600`).

**`select` and `distinct` accepted any key and ignored it.** `where` and
`orderBy` each refuse an unknown key by name; the other two positions a caller
can name a column in had no owner, so `select: { nope: true }` answered `[{}]` —
indistinguishable from a column whose value is legitimately absent — and
`distinct: ['aComputedField']` returned every row undeduplicated. `checkSelect`
sits beside `checkWhereKeys` and `checkOrderBy` in `withArgValidation`.

The two admit different sets and that is the substance. **Select** takes every
declared field minus `@transient`, plus edge namespaces: a `@guarded` column
stays nameable and keeps answering nothing, because the read strip is deliberate
and the question here is *is this a stored field at all*, never *may this caller
read it*. **Distinct** is a SQL clause and takes real columns only, so a
relation, a `@computed` field and a `@transient` key are each refused with the
reason (`FJS-601`).

`@version` is not in the new grid and the reason is worth keeping: declaring one
makes every update on the model carry a revision, so a `@version` column in a
shared fixture changes what every other row's `update` cell means. It is a
model-wide semantic rather than a column kind.


## 2026-08-29 — mutate can be pointed at an app that imports a schema

Three defects in one command, each hiding the next.

**It read the schema as TEXT.** `readFileSync` straight into `schemaMutants`, so
nothing followed an `import` — and a schema importing a fragment parses as a file
full of `extend model` statements naming models nothing declared. `packages/basecamp`
(45 models, every one gated) died at `mutationScore: the original schema does not
parse`. That is `FJS-264`'s class — *anything that loads a schema from a PATH loads
it with `parseFile`, never `parse`* — and the only instance of it that fails loudly.

Fixed with `inlineImportsFromDisk`, not `parseFile`: the mutation catalogue is
line-oriented and wants text, which is the same reason `createTestEnv` keys its
template cache on one string. An import that cannot be read is now named — its
models are otherwise silently outside the run.

**That unblocked the second.** With the fragment in, every mutant came back
*refused by the loader* and the run printed `100% killed · 14/14` having graded
nothing: `createTestEnv` cannot build a schema declaring `@secret` without a key,
so the refusal was about the schema and not about the mutation.

Counting a build refusal as a kill is right — a schema the framework will not load
cannot ship — and it is right only while the ORIGINAL builds, which nothing
checked. `mutationScore` builds it first now and refuses with the reason attached.
The same control it already kept one level down, where an `error` row from a check
is not a kill; and the same one `verifyRowPolicies` keeps about rows on one side of
a predicate. A thing that always passes and a thing that never ran are the same
observation until something separates them.

**And the third was why it could not build.** This command alone read
`cfg.encryptionKey`, which `loadConfig` does not populate. Every other command in
the CLI reads `getEncKey()` — env, because a key is not config.

Measured on basecamp: **300 mutants, all killed by the parser, run refused** →
**328 mutants, none killed by the parser**, with `guarded-drop` 1 → 6. The
`@secret` and `@guarded` columns of the credential tables had been outside
anything mutate could grade.

`FJS-597`. Whether a CI phase runs any of this is `FJS-598`, still open.

## 2026-08-29 — an index's column ORDER is part of what it is

3439 tests, 0 fail. Closes
[`FJS-592`](../../ISSUES.md#fjs-592); files
[`FJS-596`](../../ISSUES.md#fjs-596).

`indexKey` sorted the columns, so `@@index([a, b])` and `@@index([b, a])` were
one index to the diff. A composite is prefix-matched — the first answers
`WHERE a = ?` and the second does not — so swapping them was a real schema
change that reported as no change at all.

**What kept it open was the migration consequence, and that was measured rather
than argued.** Both live databases in this repo were diffed against their own
schemas after the change: `example/db/shop.db` and `basecamp/db/basecamp.db`,
zero index churn each. `createIndexes` emits columns in declaration order, so
for any database this emitter created the live order already is the pristine
one, and the only schema that migrates is one whose declaration genuinely moved.

Where it does fire the cost is one `DROP INDEX` + `CREATE INDEX` — not a table
rebuild, which is what makes being strict here cheap.

The sibling is filed and not fixed: `@@unique` emits a table CONSTRAINT, so
reordering it is invisible to the index diff, and changing a table constraint
costs a rebuild. Different price, different decision.

## 2026-08-29 — introspect writes a schema litestone can read back

`litestone introspect` is the adoption door — point it at a database you already
have and get a `.lite` to start from, which is also what `fli db:pull` runs. Its
output did not parse. Reproduced through the shipped command on a database
litestone itself built from a valid schema: three defects in ten lines of output.

```
author  Author  @relation(fields: [authorId], references: [id] onDelete: CASCADE)
@@softDelete
@@index([deletedAt])
```

No comma, so the file stops at `Expected COLON, got ')'`. `CASCADE` is SQLite's
word where the parser's `ON_DELETE_ACTIONS` wants Prisma's, and `ddl.js` had only
ever translated that one way. And `@@softDelete` beside `@@index([deletedAt])` is
refused BY NAME — both are called `idx_<table>_deletedAt` — which `FJS-480`
ruled, without anyone asking who was PRODUCING the pair.

**Why six tests missed it.** Every assertion on `generateLiteSchema` was
`expect(schema).toContain(...)`, and not one fed the result back to `parse()`.
The foreign-key test asserted a relation carrying no `onDelete`, so the case that
breaks was the case nobody wrote.

**Closed with the property, not the three fixes.** `test/introspect-roundtrip.test.ts`
asserts that reading a database built from the output is a FIXED POINT, over the
seven corpus schemas and the 188-model `openmrp` fixture — 1,565 models of input
nobody here wrote. It found four more the same day, each invisible to any
substring assertion:

- A **SQL expression default emitted as a string literal.** A `@default(uuid())`
  column came back as `@default("lower(hex(randomblob(4))) || …")`, so every row
  written afterwards got 200 characters of SQL instead of a uuid — and `ddl.js`
  doubles the quotes inside a string on the way out, so the text grew a level on
  every pass. `renderDefault` now reads the SHAPE of what SQLite hands back: `(…)`
  is an expression, `'…'` a literal. The two expressions litestone itself writes
  come back as `uuid()` and `now()`; any other is handed over rather than quoted.
- **`@@index(where:)` re-emitting the soft-delete clause.** `createIndexes` ANDs
  `"deletedAt" IS NULL` onto every index on a `@@softDelete` model, so the stored
  predicate is never the declared one. Emitted whole, the next migration ANDs it
  on again — `where: active == true` became `deletedAt == null && active == true`
  and then nested a level deeper than `predicateToLite` can read, at which point
  the predicate was dropped entirely with a comment.
- **An enum member that is not an identifier, emitted bare.** `Half-yearly` from
  a CHECK constraint. The quoted-member spelling shipped the same day and never
  reached the second producer.
- **A relation field named for the table it points at.** Two foreign keys into one
  table produce two fields with one name; worse, a relation can take the name of a
  real COLUMN, and the parser keeps one field per name — so the column is gone
  from the next migration's table. Measured on erpnext, where a self-reference on
  `amendedFrom` deleted a `supplierScorecardPeriod` column. The name comes from
  the FK column now, the way the emitter reads it in the other direction.
- **An enum name colliding with a MODEL name.** `SupplierScorecard.period` derives
  `SupplierScorecardPeriod`, which is also a doctype — and the parser resolves a
  field's type as an enum before a relation, so that model's own relations became
  TEXT columns. The same collision `frappe.js` grew a loop for; one producer was
  fixed and the other was not looked at.

The output is also ORDER-STABLE now — models and enums by name, relations by their
FK column. `sqlite_master` is in creation order, so a table a migration rebuilt
moves to the end of the file, and re-running `fli db:pull` produced an unreadable
diff.

**And it says what it could not carry.** `import` grades every construct it could
not express and `introspect` printed a prose disclaimer, which is the same job
with one of the two doors honest. The three tiers are `src/import/tiers.js` now —
one table, because two would be two answers to *how bad is this* — and
`introspect` reports partial indexes, expression indexes, collapsed indexes,
unspellable generated columns and defaults, referential actions with no `.lite`
word, and, where the DEFAULT is evidence, the two types SQLite cannot hold
(`DateTime` is TEXT, `Boolean` is INTEGER). `--report=<path>` writes the list as
JSON and `--strict` exits 1 on `changed`, as `import` already did.
`test/import.test.ts`'s totality guard reads `introspect.js` alongside the four
readers, in both directions.

**And the documented door could not reach any of it.** `fli db:pull` runs
`litestone introspect --schema <schema>` and passes no path, so the command fell
to `cfg.db` — which `loadConfig` answers as `./development.db` when nothing said
otherwise. Every app that declares a `database` block was pointed at a file its
schema never mentions. It resolves from the declaration now; a schema declaring
several is asked WHICH by name, because the output carries no `@@db` and serving
the first would answer half the question silently.

`FJS-594`.

## 2026-08-29 — an enum member may be a quoted string

`enum S { Draft }` parsed; `enum S { "On Hold" }` did not. Measured over seven
published schemas, **283 Frappe Select fields declare a closed set `.lite` could
not carry**, and almost every one is blocked by a space and nothing else — `On
Hold`, `To Receive and Bill`, `Grand Total`, `Per Week`. Every one landed as a
bare `String` with the constraint gone.

**The stored value IS the string.** No second name, nothing translates, which is
how Postgres's own enums work. Prisma answers the same problem with `@map` on
the member and buys a separate code-name for a bidirectional layer on every read
and write of the column; `@label` already covers display, so that code-name
would be a third thing rather than a missing one.

Three rules. A quoted member that is a legal identifier is the SAME member, so
`"Draft"` beside `Draft` collides rather than making two — the reading `FJS-564`
gave the redundant array default, and what lets an importer quote everything and
still emit a canonical schema. The empty string is not a member. And an unnamed
move onto a quoted member is refused, the same reasoning the boolean rule
already makes: `-> refunded` reads as `refund` and a sentence does not name an
action.

Four paths name a member and all four take it — a `@default`, a `@@transitions`
state, the JSON Schema `enum` array, and the client's own write validator, whose
refusal reads *must be one of: Draft, To Receive and Bill, Completed*. Typegen
was already a string union. The enum CHECK now escapes an apostrophe: without it
`Don't ship` closes the SQL literal and the whole CREATE TABLE stops parsing, so
the test executes the DDL rather than matching its text.

**The Frappe reader is the payoff.** An option list only has to be a SET now, so
`select-not-an-enum` fell **283 → 60** and ERPNext's `lost` fell 633 → 410. The
sixty left are single-option `naming_series` — `PUR-ORD-.YYYY.-`, a format string
wearing a Select — and one option is not a set. Widening it made one name
collision reachable, since `Supplier Scorecard Period` is a doctype as well as
`SupplierScorecard.period`; the derived name is suffixed and reported rather
than colliding. `FJS-593`.

## 2026-08-29 — an index column carries a direction

`@@index([organizationId, type, createdAt(sort: Desc)])`. SQLite walks a b-tree
in either direction, so one column never needs it; a composite index whose
columns disagree does, and trigger.dev writes exactly that twenty-one times —
every one of which imported as an ascending index serving a different set of
queries.

**Prisma's spelling, and it is ZenStack's too.** `stdlib.zmodel` in both v2 and
v3 declares `@@index(_ fields: FieldReference[], …, sort: SortOrder?, …)
@@@prisma`, byte-identical, where `@@@prisma` is their own marker for *inherited
unchanged*. So one spelling covers all three and an import carries it straight
through. Lowercase `desc` is accepted because it is the client's own `orderBy`
word for the same thing, rather than a second thing to remember.

`fields` stays a plain array of names and the directions travel beside it as
`sorts`, aligned by position — the index NAME is derived from the field list and
three other readers walk it, so changing its shape would have reached all of
them.

**Three places in the migrator were blind to a direction and all three moved.**
`indexKey` did not carry it, so a declared `sort: Desc` compared equal to the
ascending index already in the database and migrated nothing. The added-index
emit rebuilt its column list from names alone, so the drop would have been
followed by a `CREATE` of the index it had just removed. And `parseIndexColumns`
de-quoted `"createdAt" DESC` into `createdAt" DESC`, which `isIndexExpression`
then reported as an expression — the `FJS-584` shape one modifier along. A
direction change now drops and recreates in that order, which matters because
the name does not change and `CREATE INDEX IF NOT EXISTS` over a live index is a
silent no-op.

The Prisma reader carries `sort:` through. `type:`, `ops:` and `length:` are a
Postgres access method, an opclass and a MySQL prefix length, still reported as
lost because SQLite has none of them; the SQL and Rails readers do not carry a
direction yet. `FJS-591`.

**One thing found and deliberately not fixed.** `indexKey` compares a composite
index's columns as a SET, so `@@index([a, b])` and `@@index([b, a])` are one
index to the diff — and a composite index is prefix-matched, so those serve
different queries. Making the order significant changes what every existing
schema migrates on its next run, which is a decision rather than a detail:
`FJS-592`.

## 2026-08-29 — a `bigint` is a `changed` import, and two readers now say so

`litestone import` graded `bigint` `noted`, on the stated ground that *SQLite
INTEGER is 64-bit, so the range holds*. The same day's measurement of the
scaled-column ceiling says it does not: the value crosses a JS `number` at both
ends, so a `bigint` becomes an `Int` that stops round-tripping at 2^53 with
nothing raised. trigger.dev writes `TaskEvent.startTime BigInt` as nanoseconds
since the epoch — about 1.7 × 10¹⁸ — and importing it loses roughly microsecond
granularity in silence. Graded `changed` now, so `--strict` fails on it.

**Only the Prisma reader had ever reported it.** `sql.js` and `rails.js` carried
`bigint|int8|bigserial → Int` in their type tables with no `gap()` beside it, so
the three largest sources of the construct said nothing, and the regrade alone
would have made `--strict` fail a Prisma import and pass a Postgres one over the
same column. Both report it now.

**Keys and key references are exempt, and that is what makes the pass readable.**
A generated key counts from one and will not reach 9,007,199,254,740,991; a
foreign key holds one of those values. Where the source declares its relations
the exemption is purely structural — a Prisma `BigInt` that no relation owns is
supplied, which is how `GithubAppInstallation.appInstallationId` stays reported
where a rule keyed on the `Id` suffix would skip the one case it most needs. A
Postgres dump commonly declares no foreign keys at all, so `namesATable` is the
single named fallback: an unconstrained `*_id` whose prefix IS a table in the
same dump. Measured, it drops 185 of discourse's 221 conventional keys and none
of lago's.

Across the corpus that is **235 reported** — discourse 124 of its 458 bigint
columns, lago 64 of 67, because lago declares its keys as `uuid` and its values
as `bigint`, and 61 of those are `*_amount_cents`. `FJS-588`.

## 2026-08-29 — a scaled column's range is enforced, and the ceiling is 2^53

`Int @scale(n)` promised an exact round trip and stopped delivering one two
digits before the documentation said it would. `docs/exact-numbers.md` reasoned
from SQLite's 64-bit `INTEGER` and concluded that nine places still leaves nine
figures in front of the point. But the value crosses a JS `number` at both ends
and nothing here sets `safeIntegers`, so `bun:sqlite` returns a `number` on
every path — a column read and an aggregate alike. Measured: `12345678900000001`
reads back `…000`, `9007199254740993` reads back `…992`, and `sum()` rounds the
same way. The true range at nine places is **seven** figures, and two distinct
minor-unit values collided into one row value with nothing raised.

That is `prisma#20635` one layer up — the bug `FJS-D142` cites as the reason to
prefer `Int @scale` over a `Decimal` scalar, and the same silence Rails has on
SQLite, where `123456.01` stores as `123460.0`.

**Both ends now refuse it.** The boundary answers a value past
`Number.MAX_SAFE_INTEGER` by name, and it is a different sentence from the
fraction refusal because they are different mistakes — not knowing the unit
against exceeding the range. It names the bound in minor units, which is what a
caller sends, and works it out at the column's own places where they are known:
`must be at most 9,007,199,254,740,991 minor units … at 9 decimal place(s) that
is 9,007,199`. `@money` states the bound and works nothing out; at two places it
is ninety trillion away and nobody meets it.

**And the column carries a `CHECK`**, because four writers never reach the
boundary — a migration, a seed, a raw statement, and `asSystem()`, which drops
the gate, the row policies and `@@softDelete` and cannot drop a rule that is in
the table (`FJS-519`). One constant owns the bound, `validate.js`'s
`EXACT_INT_MAX`, and `ddl.js` imports it, so the two refusals cannot disagree.

A plain `Int` is deliberately not bounded: it makes no exactness promise, and
bounding every integer column in every app to buy back one is the wrong trade.
The hazard is stated in the doc instead, since a snowflake id kept in an `Int`
has the same ceiling and nothing reports it. `FJS-583`.

**`FJS-575` closes with it, and not the way it was written.** The row asked for
the nine-place cap to be raised to fifteen, because Lago writes
`numeric(40, 15)` twenty times. Measuring the ceiling answered a different
question: raising the cap would have moved the silent hole further into the
dark. What the corpus needs splits in two, and Lago's own `Fee` writes both
halves — `amountCents Int` beside `preciseAmountCents numeric(40,15)`, and
`preciseCouponsAmountCents` at scale 5, which `@scale` took cleanly. A **rate**
is small-magnitude and many-placed, and nine places holds every rate in the 25
columns found across lago, discourse and triggerdev. A **precise accumulated
total** is big-magnitude *and* many-placed, fits no 64-bit integer at any useful
scale, and is an un-rounded intermediate rather than a stored quantity — so it
belongs to rounding and allocation, which is `FJS-D154`.
Stripe writes the same split as two fields: an integer `unit_amount` beside a
`unit_amount_decimal` string of at most twelve places.

## 2026-08-29 — an array column's default, said out loud

`@default([])`, `@default(["a", "b"])` and `@default([Active, Pending])` parse.
The ruling `FJS-564` asked for turned out to be made already and unsaid: every
array column is `NOT NULL DEFAULT '[]'` because an empty array is the null state
of a list, so an omitted one already read back `[]` and a `null` was already
refused. The empty literal restates that — and it parses because a language that
refuses the redundant spelling of its own behavior fails a port on a line that
means what the tree already does. Prisma writes it 11 times across three real
schemas.

**The non-empty one is the case with no other spelling.** Elements are literals
or bare enum members, the same way a scalar enum default is written, and each is
graded against the column's own base type — which the JSON-string spelling never
was: `String[] @default("[1,2]")` was valid JSON and put numbers in a TEXT
column, and is refused now. A call is refused by name (`[now()]` is one
timestamp frozen at migrate time, and there is no runtime stamp for an element);
so is a nested array.

**Two spellings arrive and one AST leaves.** The JSON string is normalized into
the literal at parse, so `defaultExpr`, the JSON Schema and the release
classifier read one kind rather than two, and the older spelling keeps working
under a warning that names the literal.

**The empty default is stated at the second boundary too.** Every array column
emits `default: []` into its JSON Schema whether it declares one or not, so a
generated form, a factory and a generated type seed what the column can hold
instead of `undefined`. `Json` takes the literal as well, since it can hold a
list; a column that holds one value refuses it by name.

## 2026-08-29 — the open polymorphic pair, told what it may name

No language change. `@@arc` still stops around six members, the pair is still
the answer above that, and `IDEAS/polymorphic-relations.md`'s ruling stands: no
real polymorphic relation, because a relation's target is an input to the
access-control compiler and N targets is N gates.

**What was missing was an idiom, not a feature.** The pair carries no foreign
key by construction, so the type column is the one thing left that can carry a
rule — and an `enum` there was always legal and never written down. Measured: it
emits a table CHECK, so `asSystem()`, a migration, a seed and an atomic operator
are all held to it, and it reaches the browser as a set `controlFor` renders as
a picker rather than a text box. It buys no integrity; the id is still
unenforced and the sweep is still owed. It is the difference between *this
points at something* and *this points at nothing and nobody noticed*.

`docs/schema.md` § *Exclusive foreign keys* now ends with it, and all three
reference files that carry the shape are written that way:

- `Tag.lite` grows § *Tell it what it may name* and its `TagAttachment` takes a
  `TagSubject` enum — the file somebody copies should not copy the weaker form
- `Notification.lite` takes a `NotificationContext`, since a notification's set
  is the classes the app declares
- `AuditEvent.lite` takes an `ActorKind` for `actorType` and **deliberately
  keeps `subjectType String`**, with the reason stated where the two sit
  together: an audit trail names whatever it was pointed at, so the set grows
  with every service and an enum would refuse the first row a new one writes.
  That is the exemption, and it now reads as a decision rather than an omission

`fli check`'s `polymorphic-subject` is the executed half.

**The evidence for asking at all is the corpus.** ERPNext is the only source in
it that declares which kind each polymorphic field is — 17 closed, 61 open — and
the 61 do not hold up: `party_type` is declared CLOSED twice and left open
sixteen times in the same application, and `invoice_type`, `voucher_type`,
`reference_type` and `document_type` all do the same. The closed sets cluster at
three members, which is also where `@@arc`'s ceiling turns out to be correctly
placed.

## 2026-08-29 — `litestone import`: bring the schema you already have

**Four readers that were a test fixture are now a command.** `litestone import
<path>` reads a Prisma schema, a Rails `db/schema.rb`, a PostgreSQL dump or a
Frappe app into `.lite`. They live at `src/import/`, ship in the package and are
exported at `@frontierjs/litestone/import`; `test/fixtures/corpus/` imports them
rather than keeping a copy, so the corpus is now a regression fixture over the
SHIPPED importer — 1,377 models of input nobody here wrote, through the code an
app runs. The regenerated fixtures are byte-identical bar the header's
attribution line, which is the evidence the promotion changed nothing.

**The output is not the whole answer, and the product is the half that says so.**
Every construct a reader cannot express was already recorded with its model, its
field and what was emitted instead. Seven real applications produce 2,178 of
those, and undifferentiated that is the same as nothing — so each is graded:

- **changed** — the schema says something the source does not. An invented
  primary key, an exact number turned into a Float, a Postgres `NOT VALID`
  foreign key emitted as an enforced one.
- **lost** — the source says something the schema does not. Thinner, never
  wrong: a partial index's predicate, an array default, a view, an index name.
- **noted** — a decision only the author can make, or a translation that is
  exact.

`--strict` fails on `changed` alone. Failing on `lost` too would fail every real
import — 251 partial indexes in one of the seven — and a check that always fires
is one nobody reads.

**The warning has to outlive the terminal.** The written file opens with the
three counts, and every `changed` construct is marked on **its own line** —
`positionX Int @scale(2)  // ⚠ imported: Decimal with no @db.Decimal(p, s) →
Int @scale(2) — a GUESS` — because that line is the only thing anyone is looking
at when the value turns out wrong. A model-level one, an invented key, is marked
on the `model` line. The annotated output parses, which is asserted rather than
assumed.

**The tier table is total and the totality is enforced.** `test/import.test.ts`
reads every `gap('…')` literal out of the four readers and fails on one the
table does not name — which immediately found 18 refusals that exist in the
readers and had never fired on the seven corpus schemas. An ungraded kind falls
back to `changed`, fail-closed, so a reader that learns a new refusal cannot
have it filed under *ignore me*; the test is what keeps that a backstop rather
than the mechanism.

Format is detected from the path and `--from` always wins, because a dump named
`.txt` is still a dump. Without `--out` the schema goes to stdout and the report
to stderr, so `litestone import x.prisma > db/schema.lite` is a schema.
`docs/import.md` is the reference.

## 2026-08-29 — one owner for the predicate, and the corpus keeps 94 of them

`litestone introspect` and `litestone import` both answer *what does this partial
index become*, and for a few hours they answered differently — introspect emitted
the predicate and the importer, written before `@@index(where:)` existed, dropped
it. `predicateToLite` now sits beside `parseIndexColumns` and `indexPredicate` in
`core/migrate.js`: **one owner, three converters.**

It also learned Postgres's boolean. The readers consume a dump, where a boolean
is `= true`; SQLite writes `= 1`, and only the second was understood — so every
boolean partial index in the corpus fell through as untranslatable.

**94 of the corpus's 251 partial indexes now survive the conversion whole**,
where the number was 0: 45 discourse, 23 lago, 26 mastodon, 89 `where:` clauses
in the committed fixtures. The other 119 are unique and correctly dropped; 38
hold a predicate `.lite` cannot express and come back as a plain index with a
note, which only widens them.

**Building it broke the corpus, and that is the part worth keeping.** Both
readers deduped indexes on the EMITTED STRING — which worked only while the
predicate was being stripped, because two indexes over one column list then
rendered the same `@@index([a, b])` and collapsed into it. Emitting the predicate
made them different strings, so both survived; litestone names an index for its
COLUMNS, so the regenerated fixtures stopped parsing. The key is the column list
now, in both readers, and the gap reason no longer claims a predicate was
stripped.

Green: litestone 3406, typecheck clean.

## 2026-08-29 — the predicate crossing back: `litestone introspect`

Reading a database INTO a schema is the other direction, and it discarded every
index predicate. **The two halves are not symmetrical and that is the fix.**

Dropping the predicate from a UNIQUE index **strengthens** the constraint.
`CREATE UNIQUE INDEX u ON note (email) WHERE deleted_at IS NULL` is uniqueness
among LIVE rows; `@unique` is uniqueness among all of them. Both introspected to
the identical `email String? @unique`, so `introspect` → `db push` refused writes
the source database accepted — permanently, since a soft-deleted row keeps its
slot (`FJS-204`). A partial unique is now handed over as a `// FIXME` naming the
predicate, which is the call the corpus converters had already made and this
path had not got.

Dropping it from a PLAIN index only **widens** the index — same rows answered, a
bigger structure — so that stays safe, and is what happens where the predicate
is one `.lite` cannot hold. Where it can be held it is emitted whole:
`@@index([kind], where: archivedAt == null)`, `where: live == true`. That is
`FJS-578` paying for itself the same day. The soft-delete clause stays implicit,
because declaring it is refused.

**The product is a file somebody can use, so the assertion is that it PARSES**,
and asking that found three more things:

- a `///` note at the end of a model body attaches to no declaration and stops
  the parse — the notes are `//`
- litestone names an index for its **columns**, so two partial indexes over one
  column list cannot both be declared. A real database has them, precisely
  because partial indexes are what make them useful. First wins; the rest are
  handed over by name
- a composite unique over a nullable column needs `nullsDistinct: true` to be
  legal at all (`FJS-D130`) — SQL's own word for what the source database is
  already doing

`FJS-584` is closed as a byproduct, which is the only reason it was worth doing:
the two copies of the broken column regex became one owner —
`parseIndexColumns`, counting brackets rather than stopping at the first `)` —
because a converter that must read a predicate has to read the column list
correctly too. It is not a SQL parser and says so.

44 cases in `test/index-predicates.test.ts`, every guard negative-controlled.
Green: litestone 3382, typecheck clean.

## 2026-08-29 — `@@index(where:)`, and two silent things underneath it

**`@@index([kind], where: archivedAt == null)` — a partial index the schema
declares.** The corpus put partial index at 251 instances, the largest construct
`.lite` could not express; 119 of those are partial UNIQUE, which `FJS-204`
refused and this does not reopen, leaving 132 in scope.

**What a predicate may hold is asked, not described.** A grammar written here
would be a second statement about the query compiler that goes stale the first
time it moves, so the parser compiles the predicate and reads what came back.
SQLite proves that a query implies a partial index when it PREPARES the query,
so a predicate holding a bound value can never be matched — and litestone binds
every value in a `where` except a null test, which means a caller restating the
predicate binds it too. `auth()` and `now()` need no rule of their own; both
bind. Both get a sentence of their own anyway, because *this binds a value* is
not what the author did wrong.

The compiled SQL is kept on the attribute and emitted verbatim, so the index
predicate and the predicate a query compiles are the same bytes — which is what
lets the planner match them, and what keeps the migrator's comparison exact.
Proven rather than argued: 2000 rows, `ANALYZE`, `SEARCH … USING INDEX
idx_note_kind` with the predicate stated and `SCAN` without it.

On a `@@softDelete` model a declared predicate is **ANDed** with
`deletedAt IS NULL` rather than replacing it — that clause is what makes the
index reachable there at all.

**Two defects were sitting under it, and each was invisible for the other's
reason.**

`FJS-576` — `introspect` kept `{name, cols, unique}` per index and dropped the
predicate, so a partial index and a full one over the same columns compared
equal: `hasChanges: false` over two databases that genuinely differ. Litestone
has emitted partial indexes for every `@@softDelete` model since the attribute
existed, so this was live. Fixed by reading the tail — the first `)` followed by
WHERE closes the column list — and carrying it in the index identity.

`FJS-577` — `generateIndexDDL(model, softDelete = false, …)` returns
`createIndexes(model, softDelete ?? isSoftDelete(model), …)`, and `false ?? x`
is `false`, so the fallback was unreachable for every caller and the function
never emitted a partial index for anybody. The migrator's rebuild branch called
it as `generateIndexDDL(model, false, …)`, so **any** schema change that rebuilt
the table dropped the clause from every index on the model. `FJS-443`'s shape in
the branch its fix did not reach. The parameter no longer defaults, so unstated
means ask the model.

They compound: 577 degraded the index and 576 is why nothing noticed, then or
ever. Neither returns a wrong row — an index predicate changes which index the
planner may use and never which rows match — so the cost was speed and a
database drifting one rebuild at a time.

**`FJS-578` was found by building this and is fixed with it.** Two compilers
turn a predicate into SQL and they disagreed about a boolean: the policy
compiler inlined `= 1`, the query builder bound `= ?`. Ordinarily invisible —
both answer the same rows — and it costs nothing until something has to COMPARE
the two strings, which a partial index does.

`operandSql(v, push)` in `query.js` is the one decision now: a literal where
that is safe, a bound `?` otherwise. A boolean is 0 or 1 and nothing else, so
there is no escaping and no injection surface, and the plan cache grows by at
most two strings per predicate. Applied at the six sites a boolean could
reach — the scalar shorthand, an array shorthand, `equals`, `not`, `in`,
`notIn` — and `push` still coerces one for every caller that keeps binding.

So `where: live == true` is accepted, and the shipped corpus surface goes from
90 of 132 to **97 (73%)**.

The test for it EXPLAINs the bytes the client actually sent — the `sql` and
`params` captured off `onQuery`, against a file-backed database — rather than a
hand-written lookalike, which passes whatever the query builder does and is no
test of it at all. That is what makes it fail when the inlining is removed.

30 cases in `test/index-predicates.test.ts`, every check negative-controlled.
Green: litestone 3361, typecheck clean.

## 2026-08-29 — ERPNext, and a declared answer to where `@@arc` stops

`test/fixtures/corpus/frappe-to-lite.mjs`, and **ERPNext — 534 models**, the new
scale ceiling: parses in 248ms, builds in 732ms, re-boots in 470ms, zero drift.

It is here for one construct no other source can supply: **polymorphism the
schema DECLARES**. A Frappe `Dynamic Link` names the field holding its target
doctype, and that controlling field answers closed-or-open directly — a `Select`
with N options is a closed set of N, a `Link` to `DocType` is open. The question
`references/Tag.lite` leaves to the author is, here, a fact in the file:

```
78 declared polymorphic fields — 61 OPEN (78%), 17 CLOSED (22%)
closed arity:  2 ×1   3 ×7   4 ×4   5 ×1   6 ×2   7 ×1   16 ×1
               15 of 17 inside @@arc's ceiling; 3 is the mode
```

**Both halves of the taxonomy come out right and they say different things.**
Where a target set is closed it is small, which is `@@arc`'s case and agrees with
Lago from the other direction (five arcs found as hand-rolled SQL, every one
arity 2). But **open is the common case**, so the `(subjectType, subjectId)` pair
serves most real polymorphism — and case 3's stated cost, *something has to sweep
attachments whose subject is gone*, is the cost most applications actually pay.
The sweep is the half worth making cheaper.

The framework itself uses an open pair 252 times: every child table is addressed
by `(parenttype, parent)`. And 84 doctypes are submittable — a real
draft → submitted → cancelled machine `@@transitions` could carry, though it is a
framework convention rather than anything the file declares.

A Frappe app is one JSON per doctype, so this target arrives as a tarball and
`fetch.mjs` extracts it; `tar` has to be on PATH.

## 2026-08-29 — `busyTimeout` is configurable, and a failed audit write no longer crashes the process

**The second half of `FJS-569`.** The wait every connection owes a second writer
was a literal 5000 with no way for an app to change it. It is now
`createClient({ busyTimeout })`, resolved **option → env
(`LITESTONE_BUSY_TIMEOUT`) → 5000** — the same precedence `resolveTenancy` uses,
and the env var is the only channel for the callers that construct no client and
most want a different number: the CLI, a migration against a live database, a
worker under a supervisor.

**Per database, as `{ default, <db> }`**, because the database this issue came
from wants the opposite answer to main. An audit `logger` index write is
fire-and-forget and its failure is swallowed by design, so spending the loop's
next five seconds to place a row nobody awaits is worse than dropping it —
`{ audit: 250 }` is an app saying so. A malformed value, and a key naming a
database the schema does not declare, are refused **by name at `createClient`**
rather than at the connection that would have used it: a dropped key is a
database silently keeping the default, which is the class of silence the whole
issue is about.

**There is deliberately no `database { }` spelling** (`FJS-D155`). How long to
wait for another process is a fact about *this* process, and the same schema is
opened by an API answering a person and by a queue draining a batch. Same reason
a relative `database { path }` resolves against the working directory.

**Writing the end-to-end test found a second defect.** `fireLog` is documented to
never throw to its caller and its `try`/`catch` wraps a call to an `async`
`create` — so it caught nothing, and a failed audit write became an *unhandled
rejection* rather than the dropped row it claims to be. It could not be seen
while the index had a five-second wait; under `busyTimeout: { audit: 0 }` it
happens every time. Caught on the promise now, and the first loss per model warns
once, naming the model — a lost audit row is the one write whose whole purpose is
being there afterwards, and whatever produces one produces thousands.

**`docs/concurrency.md`** is the documented half the issue also asked for: what
`bun:sqlite` being synchronous actually costs, the three reasons a call is long
and the different answer each takes, why two clients on one file in one process
deadlock (measured, twelve lines), and when a worker thread is the answer —
`node:worker_threads` works, and a worker holding the write lock for 600ms left
the main loop ticking while the main thread's own write waited 639ms and
committed, where the same shape on one thread expires its whole timeout because
the holder's release never gets a turn.

## 2026-08-29 — Discourse, and the corpus reaches 843 models

`sql-to-lite.mjs` unchanged, which is what a front-end is for: **Discourse,
356 models** — nearly twice `openmrp`'s 188 and with real relations rather than a
mechanical conversion. Parses in 82ms, builds in 365ms, re-boots in 116ms, zero
drift. It is the new scale ceiling.

Six applications now, three front-ends, **843 models, 803 recorded constructs,
and every one parses, builds and re-boots with zero drift.**

**A partial index is the largest unrepresented construct in the corpus by 2.3×**
— 251 of them, in every source that has predicates at all, and `.lite` cannot say
it. A UNIQUE partial index is dropped rather than emitted whole, because
emitting it would be a stronger constraint than the source declares.

Discourse's 15 polymorphic pairs are the unambiguous kind — `bookmarkable`,
`chatable`, `votable`, `linkable`. The Rails `-able` suffix is the idiom for
*anything that can be X'd*, which is weak evidence for an OPEN target set and so
for the `(subjectType, subjectId)` shape rather than `@@arc`.

Two Postgres types earned names rather than *unknown*: `tsvector`, where the
`.lite` answer is `@@fts` — SQLite FTS5, a different engine on a different table,
so a replacement the author makes and never a conversion — and `halfvec`
(pgvector), where there is no type and no index that would make one useful.

STI detection moved into the shared pass so every front-end sees it, and is
reported as a **candidate**: 21 across six schemas, but a `type` column is a
plain category in plenty of them and only reading the application separates the
two. Same terms as the polymorphic pass, for the same reason.

## 2026-08-29 — a third corpus front-end: a PostgreSQL dump, and `@@check`/`@@arc` meet real input

`test/fixtures/corpus/sql-to-lite.mjs`, and **Lago** — 139 models, parses,
builds and re-boots with zero drift in 270ms. A `structure.sql` is the only
source that carries **CHECK constraints, views and native enums**, none of which
Prisma has and Rails' `schema.rb` mostly does not, so it is the first input
`@@check` and `@@arc` have ever had that this project did not write:

```
CHECK ((invoice_grace_period >= 0))                  →  @@check("(invoiceGracePeriod >= 0)")
CHECK ((plan_id IS NOT NULL) <> (subscription_id …)) →  @@arc([planId, subscriptionId])
                                                     →  CHECK (("planId" IS NOT NULL) + ("subscriptionId" IS NOT NULL) = 1)
```

Both survive the trip and a raw `INSERT` with neither arc member set is refused
by SQLite. 17 `@@check` and 5 `@@arc` emitted; 8 checks dropped as genuinely
inexpressible — `jsonb_typeof`, `cardinality`, the `~` regex operator, a `::text`
cast on a column.

**All five arcs are arity 2** — `plan XOR subscription`, `feature XOR privilege`,
`subscription XOR wallet` — the first real-world evidence about where `@@arc`'s
ceiling belongs. Production billing writes exclusive arcs, writes them small, and
writes them as hand-rolled SQL because it has nothing better to say.

Converting a CHECK meant two passes worth naming: a cast on a string literal is
dropped (`'approved'::public.quote_status` is an ordinary comparison wearing
Postgres punctuation), and identifiers are rewritten by a walk rather than a
regex, because a regex rewrote the words **inside** string literals.

New: `FJS-575` — 20 columns are `numeric(40, 15)` and `@scale` caps at 9, so
every per-unit rate in a real usage-based billing schema lands as a `Float`.

Views are recorded and skipped: `.lite`'s `view` needs its columns declared plus
an `@@sql` body, and a Postgres body is not SQLite.

## 2026-08-29 — a second corpus front-end: Rails `schema.rb`

`test/fixtures/corpus/rails-to-lite.mjs`. Three Prisma schemas largely agree
with each other, so a fourth confirms rather than finds; a Rails one disagrees.
Mastodon — **116 models** — parses, builds and re-boots with zero drift in
179ms, and arrived carrying what Prisma has no way to express:

- **43 partial indexes.** `unique … where: "deleted_at IS NULL"` is uniqueness
  among LIVE rows. A **unique** partial index is DROPPED rather than emitted
  whole, because emitting it would be a stronger constraint than the source
  declares; a plain one keeps its columns and loses its predicate.
- **Single-table inheritance** — a string `type` column partitioning one table
  across several classes. No spelling: the column becomes an ordinary String and
  the partition is lost.
- **Polymorphic pairs**, reported as candidates and never resolved to `@@arc` —
  `polymorphic.mjs` is the shared pass, and it refuses to guess because the
  target set lives in application code and in the data, never in the schema.
  Whether real pairs cluster below `@@arc`'s ceiling is the question the corpus
  now exists to answer.

Rails inverts one default that matters: a column is **nullable unless
`null: false`**, the opposite of `.lite`.

Writing it turned up `FJS-571` in `@frontierjs/toolbelt` — `singularize` never
reached a compound's head, so `UserStatus` became `user_statuses` and read back
as `user_statuse`, a round trip that fails open in junction. Fixed there.

## 2026-08-29 — `@@arc`, and the case for not building polymorphic relations

*This row points at an Order or a Product* is asked constantly and has one good
answer here. `@@arc([orderId, productId])` declares several optional foreign keys
of which exactly one is set, `optional: true` relaxes it to at most one, and
`message:` carries the sentence a form shows.

**The members stay ordinary relations**, which is the whole of the argument. A
real `@relation`, a real `onDelete`, a real `include` — and the attribute adds
only a table CHECK counting the non-null members, so the rule holds against a
job on `db.`, a migration, a seed, an atomic operator and `asSystem()`, which
drops the gate and every row policy and cannot drop a CHECK. The polymorphic
alternative — a `subjectType` naming a model beside a `subjectId` — keeps none of
the three: nothing refuses a deleted id, orphans need a sweep job because the
database will not do it, and reading the subject is a second query per type.

Two refusals at parse. A **required** member, because a column always set is
always the answer — two of them can never sum to one, one among optionals is not
a choice. And fewer than two members, which is `@@check` written the long way.
An unknown member was going to be a third and is not: the generic
model-attribute field-ref check already covers every `@@`-word carrying a
`fields` array, so the arc's own version was a duplicate message and was removed
rather than kept beside it.

**The expression has one owner.** `arcCheckExpr()` in `ddl.js` is what the
emitter writes and what `client.js` matches SQLite's reported CHECK text back
against to find the declaration holding the message. Two spellings would not
fail — they would fall through to `this record is not valid`, which is the
generic sentence `FJS-534` removed for `@check` one attribute earlier. Without a
`message:` the sentence is derived: `exactly one of orderId, productId must be
set`. The SQL stays on `err.constraint` for the developer.

**What was refused, and why it is written down.** Real polymorphic relations were
priced against the tree first: 158 `relationMap` threadings and 69 single-valued
`.targetModel` reads are the cheap half, and the expensive half is that
`policy.js:805` compiles the *target's own policy* into a correlated subquery —
so a polymorphic target is N branches in a `CASE`, each carrying its own
`@@gate`. A caller who reads `Order` at 4 and `Product` at 5 would then see half
a list as a 200 with fewer rows, which is exactly the shape Invariant 6 is
arranged around. Prisma refuses it too; ZenStack's `@@delegate` is the best
answer in the ecosystem and solves the *closed* set only, since `extends` is a
closed set by construction. The argument is `IDEAS/polymorphic-relations.md`
(4.28), and the open set keeps `subjectType`/`subjectId` and keeps saying what it
cannot do — `references/Tag.lite` argues both sides where somebody copies from.

19 tests. `docs/schema.md` § *Exclusive foreign keys*, and the reference snapshot
is at 97 words.

## 2026-08-29 — a one-to-one back-reference pairs, and `unknown type` means it

`FJS-563`. `model A { b B? }` where `B` holds the foreign key carries no
`@relation` and no column — the exact singular counterpart of the plural hasMany
back-reference — and it failed the type check, so it was reported as
**`unknown type 'B'` for a model that is registered**. That message sends the
reader hunting a model which is plainly there.

The parser now marks it `backRefOne` and pairs it against the unlabelled
`@relation` pointing back, the same rule the array already used. `client.js`'s
`buildRelationMap` looks for a singular back-reference as well as an array one,
which was the second half: with the parse fixed, `include: { profile: true }`
was still `Unknown relation "profile"`, because the map keyed the entry under the
model's own name when it could not find the field. It is stored as `hasMany`
carrying **`toOne`** rather than as a fourth relation kind — 29 sites branch on
kind and only the attach needed to change — so a to-one include answers the row
and an absent one is `null` rather than `[]`.

**Three refusals replace the wrong one.** A foreign key that is not unique is a
to-many written as a to-one and would answer one of many rows arbitrarily, so it
is named, with both ways out. No unlabelled back-reference at all is named, and
points at the labeled one where there is one. Two candidates are named, both of
them. Uniqueness counts a field `@unique`, an exactly-matching model `@@unique`,
and **a primary key** — `eventTypeId Int @id` being both the FK and the PK is how
calcom writes a 1:1.

Found by the corpus, and proved by it: the converter's workaround is off by
default now, and Cal.com, Trigger.dev and Documenso — **232 models** — parse,
build a database and re-boot with zero drift without it. `test/one-to-one.test.ts`
pins all nine branches, since two of the three fixtures are git-ignored.

## 2026-08-29 — a corpus of schemas nobody here wrote

`test/fixtures/corpus/` and `test/corpus.test.ts`. `fixtures/scale/openmrp.lite`
asks whether the Data realm survives SIZE; this asks whether it survives SHAPES
this project did not invent. `prisma-to-lite.mjs` converts a published Prisma
schema mechanically, `fetch.mjs` pulls the targets, and the test is openmrp's —
parse, build, boot again and migrate nothing.

**The `.lite` output is not the artifact; the refusal list is.** Three real
schemas were converted on the first run — Cal.com (100 models), Trigger.dev (81)
and Documenso (51), **232 models and 124 enums** — and all three now parse, build
a database and re-boot with zero drift, in 47–379ms each.

Two defects fell out, both invisible to any rule a checker could carry, because a
rule is written by somebody who has already thought of the case:

- **`FJS-563`** — the non-owning side of a one-to-one must be labeled, and
  unlabelled the parser reports `unknown type 'B'` for a model it has registered.
  37 occurrences, and the single cause of every `unknown type` error in all three
  schemas. A list back-reference pairs unlabelled; a singular one does not; Prisma
  requires no label either way, so every ported 1:1 arrives broken.
- **`FJS-564`** — an array column is expressible and its default is not, the empty
  array included. 11 occurrences.

`FJS-561` (no composite `@@id`) gained 7 occurrences plus 4 models with no primary
key at all, and **`FJS-D130` came out of it vindicated**: 22 composite `@@unique`
declarations over a nullable column, every one answered by `nullsDistinct: true`.

Three findings were **withdrawn after being probed at minimum size** and are worth
recording as the method's failure mode: referential actions (`onDelete`/`onUpdate`
are supported — 348 false gaps from one converter bug), a duplicate index that came
from stripping a Postgres opclass, and a `:memory:`-against-file divergence that
would not reproduce. Same shape as the withdrawn `FJS-560`: **a parser refusing a
name is evidence about the name.**

Only `triggerdev.lite` is committed — Apache-2.0. Cal.com and Documenso are AGPL,
and a schema converted from a copyleft source is plausibly a derived work, so
vendoring one into an MIT package is a licensing decision rather than a testing
one; they are fetched on demand and **skipped by name** when absent.

## 2026-08-29 — the docs stopped saying `@scale`/`@money` were coming

Documentation only; nothing in the package moved. `docs/roadmap.md` still
carried *Exact numbers — `@scale(n)`, then `@money`* under **High priority**,
opening *there is no fixed-point numeric type*, three days after `FJS-D142`
shipped both; *Typed JSON fields* proposed `Json @type(T)`, which ships; and
`@slug`'s entry proposed the attribute rather than the collision handling that
is the part still unbuilt. `docs/README.md` described the roadmap as *what's
coming: `@scale`/`@money`*, and **three shipped pages were linked from nothing**
— `exact-numbers.md`, `json-types.md` and `traits.md`, the last of which
`CLAUDE.md` cites as the reference for `extend model`.

A session took the three signposts for the current state and filed a defect
saying the language has no `Decimal` (`FJS-560`) — which is a ruling holding,
not a gap. The shipped entries are now tombstones in a `## Shipped` section at
the TOP of the roadmap, the file opens by saying it is proposals and never a
statement of behavior, and `fli check`'s `roadmap-shipped` + `docs-index` grade
both halves so the next one is a warning rather than a day.

## 2026-08-29 — a reference catalogue, in `.lite` so it can be checked

`references/`, three models to start: `Notification`, `AuditEvent`, `Tag`. Not
shipped and not importable — a shape you read before writing a model that half a
dozen apps have already written differently, and copy into your own schema.

**`.lite` rather than prose, because a reference that cannot parse is wrong** and
this is the only format where that is decidable. `test/references.test.ts` parses
every file and fails on an error, so a parser rule that moves takes the catalogue
with it instead of leaving a folder of plausible stale examples. It also asserts
no WARNINGS — a reference is the one place a footgun warning must not be
tolerated, since it is what somebody is about to copy — that the first model is
named for the file, and that the file is listed in the README, which is the
silent failure here.

**A file is self-contained, and that is measured rather than assumed.** A
standalone model parses clean; a `@relation` to a model the file does not declare
is TWO errors (`unknown type 'User'` and `@relation references unknown model
'User'`). So a reference carries the foreign key COLUMN and never the relation —
honest rather than a workaround, since the column is the shape and which model it
points at is the installing app's answer.

**Two findings on the first pass.** The polymorphic subject exists twice in this
repo under two names: basecamp's `AuditEvent` spells it `subjectType`/`subjectId`
with an index on the pair, and `example`'s `Notification` spells the same idea
`contextType`/`contextId`. One concept, two spellings, nothing anywhere able to
notice. The catalogue prefers `subject` for anything new and says so at both
files, which is a recommendation and not a demand to migrate.

And `@frontierjs/notifications` writes to a model it does not ship:
`drivers/inapp.ts` calls `asSystem().notification.create()` naming five columns
against a hand-written structural type that is the only description of the shape
anywhere. `Notification.lite` is that shape written down. Whether it should be
SHIPPED rather than referenced is `IDEAS/machinery-models.md`, deliberately not
answered here.

## 2026-08-29 — `litestone studio` moves to 8502, the port the scheme reserved for it

`FJS-557`. 3228 pass, 1 skip, 0 fail.

Studio ran on 5001 for its whole life and the framework's port scheme reserves
`studio: 8502` — dev, tooling, project 0, service 2. So the number a person
actually got was one the scheme had never heard of, the number the scheme
reserved was answered by nothing, and `fli ports:status` showed 8502 free.

Nothing failed, which is why it lasted: the only symptom was that the documented
port did not answer. It was found by the tools group on `fli gui`'s new
dashboard, which derives a tile's start command by matching a command's own
`--port` default against the reserved block — so studio was the one tile with no
start button, and that tile is the only thing in the repo that noticed.

**8502 wins because the scheme owns a global tooling port.** That block is
refused to every app precisely so a tool somebody runs beside whatever they are
working on keeps one number they type from memory; 5001 is outside it,
unreserved, and common enough to collide with something nobody started. The
literal carries a comment naming the slot, because this package sits below the
CLI that owns the formula and cannot import it.

`--port` is unchanged, and the two studio drives pass one explicitly, so they
are unaffected.

## 2026-08-26 — a finer capability grant REPLACES the coarse one

`IDEAS/permission-sets.md` step 7, found by adopting the grid in basecamp. 3226
tests, 0 fail.

**A `@capability` column and a named move both required `Model.update` as well
as their own grant**, so the two fine tiers could not do the thing they exist
for. `Environment.variables` could only be handed to somebody who already held
`Environment.update` — every other edit to the environment, which is exactly the
grant it was meant to withhold — and `Server.reboot` alone could not reboot
anything. That is the complaint this whole design was written to answer,
shipped inverted, and no unit test could see it: no fixture had ever held one
grant and not the other.

The rule now partitions an update's payload three ways. A key with a
`@capability` is graded by that column's grant; a key that is a transitions
field is graded by the MOVE it resolves to, which needs the stored row and is
therefore checked where the transition is; everything else is what
`Model.update` is for. So an update naming only graded keys never asks for the
coarse grant, and one naming anything else still does. Both spellings of a move
agree, because `update({ data: { status: 'cancelled' } })` and
`transition(id, 'cancel')` are one move and litestone enforces both. **CREATE
keeps both**: `Model.create` is the grant for making the row exist at all, which
is not what a column grant withholds.

A knock-on the wrong ordering had hidden: a `@system` move was refused as a
missing `Model.update` rather than as `@system`, which points a reader at a
grant that would not have helped.

## 2026-08-26 — a `@system` move is nobody's grant, and the picker's list had a second author

Two defects on the same seam, both found adopting the grid.

`deriveCapabilities` excluded a move at `@gate(8)`/`@gate(9)` and not one marked
`@system` — the spelling `FJS-506` added a day earlier and the one an
application actually reaches for. basecamp's `Server` therefore offered eight
move capabilities where three are human, which is the noise a role editor
carries for good.

**Three files rebuilt that list rather than asking for it**, and each got the
machine-move filter slightly differently. `access.js` did not ask — create/update/delete,
then every move below gate 8, then the opted-in columns — which is one rule with
two authors, and the two disagreed the moment the derivation learned something:
the `@system` moves left the enforced set and stayed in the committed snapshot.
`jsonschema.js` did the same for `x-capabilities`, which is the reader furthest
from the boundary: a browser was offered five grants nothing would ever consult,
which is a button that is never right to show and never fails loudly. And
`jsonschema-snapshot.js` rendered no capability line at all, so the one committed
artefact that would show a client losing the names showed nothing.

Invariant 4. `capabilitiesForModel` is the single owner and all three read it;
the snapshot carries the names now. Negative-controlled: breaking the owner
fails all three consumers together, which is the property that was missing.

`atLevel(n)` hands its synthetic caller every capability the schema declares, so
`verifyGateLadder` still grades the GATE on a model that opts in. The grid is
ANDed and refuses with the same `AccessDeniedError`, so a caller holding none
reported every write on an opted-in model as a deny no gate issued — the same
isolation problem row policies and `@guarded` columns already have here, with
the same answer (`FJS-351`). A caller that states its own principal is left
exactly as given: a set injected under it is a grant nobody wrote.

## 2026-08-26 — `findUnique` ran no plugin read hook

`FJS-541`. 3216 tests, 0 fail.

`findFirst`, `findMany` and `findManyAndCount` each end with
`plugins.afterRead(...)` and `emitLogs('read', …)`. `findUnique` had neither, on
either of its paths — while calling `beforeRead`, which is what made the gap read
as plugin support rather than half of it.

`get(id)` is the most common read an app makes, and two things were silently
wrong through it. `ExternalRefPlugin` resolves a stored file reference into a
public URL in `onAfterRead`, so a `File` column answered raw
`{"key":…,"provider":…}` by id and a URL from the same column read by `find` —
an `<img src>` that works in a list and is broken on the detail screen beside
it, and an edit form handed the storage handle instead of the photograph. And a
`@@log` model recorded reads through every path but this one.

The ultra-fast path skipping `beforeRead` is correct rather than a hole —
`_canFastFindUnique` requires there to be no plugins at all — but it can be
taken on a table that declares `@@log`, so the read entry was missing there too.

Found while wiring `FJS-409`, and asserted end to end in `example`, which asks
`get` and `find` for the same row and compares them. Either alone passes.

## 2026-08-26 — the retention sweep killed the process it swept for

`FJS-540`. 3216 tests, 0 fail.

A jsonl or logger table keeps a companion `.index.db` of byte offsets, and a
retention compaction rewrites the file, so every one of those offsets is wrong.
`compactJsonl` deletes the index and its comment says it is *rebuilt lazily*.
Nothing rebuilt it: the driver caches the handle and returns it for ever, and
SQLite marks a connection readonly once its file is unlinked underneath. The
next append threw `SQLITE_READONLY_DBMOVED` out of `insertIndexRecord`.

**On the audit path, which is fire-and-forget and deferred a tick** — so the
write that triggered it had already answered. What a reader sees is a `201`
followed by a dead API and nothing in the request log.

It is on a clock rather than a race, which is why nothing had hit it: the sweep
removes nothing until the OLDEST row is past the declared window, so a
deployment crashes the first time its retention period elapses, at whatever hour
the job runs. Latent for as long as the driver has had an index; unreachable
until `FJS-521` gave retention a schedule; and invisible to the jsonl case in
`retention.test.ts`, which compacts and never writes again.

`getIndexDb()` is the one owner of the handle, so it asks whether the file is
still there and reopens when it is not — closing the dead handle first, which
otherwise holds the unlinked inode for the life of the process. One `existsSync`
per index operation, on a driver that already appends to a file for every write.

Found by driving the job end to end in `example` rather than by reading it.

## 2026-08-26 — a schema with no file can say where it lives

`FJS-449`'s remaining half. 3215 tests, 0 fail.

`resolveFrom: 'schema'` anchors a relative `database { path }` to the app root,
and it needs a schema FILE to do it. An app that assembles its schema in memory
— auth's fragments, the outbox model, a tenant registry — has none, so it fell
back to the process CWD and every declared path followed whichever directory the
process started in. That is the shape with the sharpest consequence measured so
far: a `vite build` from a surface root prerendered twelve product pages as zero
products and exited 0, publishing a static site with nothing in it.

Two ways to say it now, and the first was already there:

  · **`path:` beside `schema:`.** An app that READ `db/schema.lite` and appended
    to it still has the file; naming it makes the string it assembled resolve
    exactly as the file would. This worked and was not written down anywhere,
    which is most of why the half stayed open.
  · **`resolveFrom: '<dir>'`** — a directory, or a `file:` URL, for a schema with
    no file behind it at all. `new URL('../..', import.meta.url)` is the shape.
    It is a statement: an anchor that is not a directory throws, because a
    statement that quietly reverts to the CWD is the failure this exists to end.

The rule moved to `core/db-path.js` on node builtins alone — `schemaAnchor`,
`resolveAnchor`, and the note below — because the CLI answers the same question
before a client exists and a second copy of it is how this started.

**A mint is announced.** Creating the database FILE is ordinary; every first run
does it. Creating the DIRECTORY it sits in is the signal, and it is the one
thing every measured instance had in common — `example/db/db/`,
`example/web/db/` and `example/site/db/` were each minted by a command run one
directory away from where the path was written, none of them failed, and the
repo's `*.db*` ignore rule kept `git status` clean, so the only way to find one
was to go looking. Four sites say it now: the SQLite open, the tenant registry's
directory, the jsonl/logger driver's first append, and the CLI's own
`ensureParentDir`. The cwd is in the message, because the resolved path alone
does not say what went wrong: `db/shop.db` from the app root and from a surface
root print the same relative string and name different files.

`example` is the proof and it lost three workarounds. `SHOPS_DIR`,
`SHOPS_REGISTRY` and `AUDIT_DIR` were absolute `join(HERE, …)` constants, each
with a paragraph explaining why the declaration could not be trusted; the app
names the schema file once and reads all three off the block. Loading its data
layer from `example/site/` mints no `site/db/`, `litestone studio` from
`example/db/` creates no `db/db/` and opens the real database, and the storefront
prerenders twelve products from the surface root.


## 2026-08-26 — `access --for`, and what a rename cost

Step 6 of `IDEAS/permission-sets.md` § *Build order*, and it amended a ruling.

**`litestone access --for <who>`** — the command `FJS-D148` names, and a CALLER of
`$capabilitiesFor` rather than a second implementation, so a support screen asking
live and an operator asking here cannot drift. It finds the person through the same
resolver `tinker --as` uses, read through `asSystem()`: you are an operator looking
somebody up, so finding the row must not depend on what that row may see. It prints
what is true NOW and says so — *what could Ada do in March* is only answerable from
what the audit trail recorded at the time, and a command that looked like it answered
that would be wrong in the silent direction.

**A renamed MOVE is invisible to the migration engine, and that is measured.** D148
expected the rewrite to fall out of `diffSchemas`/`autoMigrate`. For a renamed COLUMN
it would. But a move rename changes the capability set and emits **byte-identical
DDL** — the engine diffs a replayed shadow database against a pristine one, and a
move name is not a database object — so it reports *no migration needed* while every
grant row holding the old string goes quiet. Moves are where most capabilities come
from, so that is the main case rather than an edge.

**So the blast radius is computed from two SCHEMAS.** `capabilityDrift(before, after)`
rides the `--from <ref>` comparison, which already reads two `.lite` files, and
`litestone access --from` prints the names that disappeared, the rewrite SQL, and the
ones it will not guess about. **It pairs only where the pairing is forced** — a model
whose whole prefix moved with its target set intact, or a single loss against a single
gain on one model — because a lost name and a gained name are a rename in the author's
head and a coincidence in the data. Two moving at once, or a genuine deletion, are
reported unpaired with no SQL: a wrong rewrite hands one role another's authority and
looks exactly like it worked. The SQL is a quoted-string `replace` over the stored JSON
array, exact by construction, since a capability name is two identifiers and a dot and
can hold no quote.

**`fli check` gained `capability-ladder`** (in `@frontierjs/cli`): a model declaring
the grid whose write levels sit above its read level. The two are ANDed with the gate
as the floor (`FJS-D146`), so a laddered gate is the ladder answering what the grid was
declared to answer, and every grant is narrowed by it — the shape being a model moved
onto capabilities with its old gate left behind. A warning, because two authorities in
front of one operation is legitimate where the ladder guards something the grid does
not model.

11 tests. Litestone green: 3215. cli green: 933.


## 2026-08-26 — the affordance: `x-capabilities`, `$capabilitiesFor`, and the snapshot

Step 5 of `IDEAS/permission-sets.md` § *Build order*. Everything that has to KNOW
about the boundary without being it — a screen choosing buttons, a reviewer reading a
diff, an operator asking what somebody can do. All of it permissive-when-unknown, the
contract `x-gate` already has (Invariant 6).

**`x-capabilities` carries NAMES and never a verdict.** The caller's set is on the
principal, so the model says which capability each action requires and the client
compares. It exists so nothing downstream ever builds `Model.action` by
concatenation, which is the one spelling that must not be guessed — a wrong guess is
an affordance that silently never matches. `read` is absent unless the model wrote
`(all)`, mirroring the declaration exactly (absent = no grant required, never
refused), and a move at 8 or 9 is absent too, since an affordance for a grant nobody
can hold can only disappoint.

**`db.$capabilitiesFor(principal)` is the fourth sibling** of `$checkWhere`,
`$checkOrderBy` and `$protectedFields`, with their contract: it takes its subject as
an ARGUMENT and every flavor of client answers identically for the same one, because
what a name GRANTS is a fact about the schema. Defaulting to the client's own
principal would have broken precisely that.

**`unknown` is the half that earns the method.** A capability is a reference, so
renaming the referent renames the capability and the old string is left sitting in
every `Role` row in every tenant's database — which is why `FJS-D148` rules a rename
emits a data migration. This is the only thing that can see the migration that did
not run: a stale grant grants nothing and looks exactly like a grant. It answers what
is HELD and never the complement, which on a real application is 150 rows of nothing
happening. The other half of D148's question — *what could Ada do in March* — is not
answerable here and no argument makes it so; the roles have changed, so it can only
come from what the audit trail recorded at the time.

**`access.snapshot.md` grew a section**, derived rather than authored: every name in
it is a reference to something declared above, so a capability cannot be misspelled
into the table.

**And a grid change is graded on the access axis, which is the half that would
otherwise have been silent.** A model gaining `@@capabilities` starts refusing writes
N-1 has been making all along with no column, no type and no constraint moving —
nothing else in the release surface can see it. Four transitions grade on both axes:
opting in is CONTRACT/narrows, opting out EXPAND/widens, `(all)` arriving or leaving
moves reads, and a column opting in or out moves that column. Not a version of the
gate — the two are ANDed, so a model can narrow here while its ladder does not move.

14 tests. Litestone green: 3205.


## 2026-08-29 — one wait, on every connection

`FJS-569`, half of it. `src/core/pragmas.js` is the floor and every
`new Database(...)` in this package now calls it.

**It was set on four connections and missing from four**, so whether a database
waited for the write lock was an accident of which file opened it. Measured with
one connection holding the lock: with the timeout the second waits 5007ms, with
no pragmas at all it fails in **1ms**. Absent from the main READ connection, the
tenant registry and each tenant handle, four CLI handles — and from the
`jsonl`/`logger` companion index, which is the one that mattered: a `logger`
database is schema-global, so that index is the single file every tenant and
every process writes, and it had no wait at all. A second `example` API beside a
running one died on its first audit write.

**WAL was tried on that index and taken back out**, which is worth recording
because the argument for it is good: under a rollback journal a reader and a
writer exclude each other on the file every process touches. What kills it is
that the index is DELETED by anything rewriting the `.jsonl` — compaction, and
also `verify:jobs`, which plants an aged row by hand — and WAL puts two more
files beside it. Every one of those places silently starts owing two more
unlinks, and one that does not recovers the byte offsets the rewrite just
invalidated: measured, as a retention sweep reporting success having removed
nothing. It is a change worth making on its own terms, after finding every
hand-rewriter; it is not part of a floor.

**What the timeout is FOR is stated in the module, because it is narrower than it
looks.** `bun:sqlite` is synchronous, so a connection waiting on the lock blocks
the thread — in one process that is the event loop, and it can deadlock: the
waiter blocks the loop, the holder's continuation never runs to commit, and the
wait can only expire. Measured at 5000ms-then-failure for an 800ms hold in one
process, and 1444ms-then-commit for the same hold across two. So it is a
cross-process device, and what makes the in-process case fine is `$transaction`'s
FIFO lock, which queues two transactions on one client before SQLite ever sees
them.

Four tests, behavioral rather than a `PRAGMA` read — asserting the statement ran
does not assert that a second writer survives. Each takes the lock from a real
second PROCESS, because holding it in the test process reproduces exactly the
deadlock above and would pass for the wrong reason. Negative-controlled: with the
index pragma commented out the logger case goes red.

**Still open**: 5000 is not configurable, and a queue draining a batch and a
request answering a person want different answers.

## 2026-08-26 — `$softDelete` on every flavor, and three traps that disagreed

`FJS-536`, found by junction reaching for it.

**A capability that depends only on the schema belongs on every flavor of client.**
That is a stated rule and `$softDelete` was on one of the four — so the flavor an
application actually holds threw `"$softDelete" is not a table in this schema` at a
question about the schema, because junction scopes `ctx.locals.db` with `$setAuth`.
One owner (`softDeleteInfo`) now answers root, `$setAuth`, `asSystem` and `$scopedBy`.

It answers a **copy**. The map it used to hand back is the live one every read filters
against, so a caller could turn soft delete off for the whole client by assigning to a
property they had asked to read.

**The second half is bigger.** Each proxy listed its capability names in `ownKeys`,
denied every one of them in `has`, and described none of them in
`getOwnPropertyDescriptor` — so `'$checkWhere' in db` was **false**, on every flavor,
for every capability. `in` is the documented way to feature-detect one, precisely
because this client throws on an unknown property, and it had never worked. Each
proxy's list is hoisted so the two traps read one array; two copies is what let them
disagree. Enumerability is deliberately untouched — a capability stays out of
`Object.keys`, where it has never belonged.

Three stray duplicate branches at the wrong indent went with it, including `$scopes`
missing from the root client's own `ownKeys`.

## 2026-08-26 — the grant column: `Capability[]`

Step 4 of `IDEAS/permission-sets.md` § *Build order*. Enforcement asks *does this
caller hold X*; this is where an X comes from.

**`Capability` is synthesised from the schema's own surface, as a real enum** —
`FJS-D147` says the set is derived, so the type IS that set. Making it an enum rather
than a new kind of thing is the whole of the implementation: an enum ARRAY is already
a JSON column, already validated member by member at the write (SQLite cannot CHECK
the elements of a JSON array, so that loop already IS the boundary), already emitted
into `$defs` with its values and already answered by `db.$enums`. One declaration
therefore buys the typo refusal, the storage and a role editor's multiselect off
machinery that was already tested — the JSON Schema comes out as
`{ items: { $ref: '#/$defs/Capability' } }` with no new key to teach anybody.

Two shapes are refused rather than resolved: a hand-written `enum Capability`, because
two answers to one name is the ambiguity `FJS-D139` exists to remove, and a
`Capability[]` in a schema where nothing declares `@@capabilities`, which is a column
that could never be written and could not say why.

**A large enum suggests instead of listing.** `Capability` is 153 values on a real
application and a refusal carrying all of them is one nobody reads, so past twelve the
message names the nearest legal value and points at `db.$enums.<Name>`. General to
every enum, because any generated one grows past that eventually.

**You may only grant what you hold, and it is a property of the column.** A write to a
`Capability[]` is refused unless every value is in the writer's own effective set — so
a role editor cannot be a route from a tenant administrator to every capability in the
application, and no model can forget to write the rule. **A subset, never a rank**:
this repo's own hand-written guard compares role LEVELS ordinally, so a developer (2)
may hand out billing (1), two sets neither of which contains the other, and a sideways
move is invisible to any comparison of two numbers (`FJS-529`). Seeding roles is
consequently `asSystem()`'s job, which is the rule working rather than an obstacle.

**And a capability name written by hand is now resolved too.** The read tier has no
attribute of its own — a column read must strip rather than refuse — so it is spelled
`@allow('read', 'X' in auth().capabilities)`, and that literal referred to nothing the
parser checked. Measured: a misspelling makes the predicate permanently false, so the
column disappears for EVERYBODY including the holders, with no parse error, no read
error and nothing in a log. Refused at parse now, naming the nearest legal capability,
across `@@allow`, `@@deny`, `@@scope` and a field `@allow` — by a deep walk rather
than a switch over node kinds, since a node type a switch missed would fail silent in
exactly the way being closed. It says nothing where no model declares the grid: below
that, `auth().capabilities` is the application's own bag.

14 tests. Litestone green: 3189.


## 2026-08-26 — the clock has one owner, and the `@updatedAt` trigger is retired

`createClient({ now })` reached `now()` in a row policy and `@@softDelete`'s
stamp. It did not reach `@default(now())`, which is a column DEFAULT, or
`@updatedAt`, which was an AFTER UPDATE trigger, or the retention cutoff, which
read `Date.now()` directly. So an env frozen at 2020 stamped a fresh `createdAt`
with today, and the one thing a frozen clock exists for — **a row aging past a
window** — could not be staged at all.

```js
await env.db.note.create({ data: { body: 'x' } })   // stamped 2020, was: today
env.clock.advance('100d')
env.db.asSystem().$retain()                          // sweeps it, was: nothing
```

### Why the trigger had to go

Binding the value in JS and leaving the trigger in place looked free — both SQL
mechanisms stand down when the caller names the column. They do not. The
trigger's guard is `WHEN NEW.x IS OLD.x`, which reads as *fire whenever the value
being written equals the one stored*, and under a frozen clock that is every
write after the create. Measured on `update`, `updateMany` and `upsert`: the row
came back stamped 2020 while the database held today.

That is `FJS-396`'s shape. RETURNING is evaluated before an AFTER trigger fires,
and junction hands that row to the HTTP response *and* the `svc updated`
broadcast — so naming the column in the SET clause had only ever closed it while
the two values differed. With no trigger there is no window, and it closes at the
root rather than being narrowed again.

### What stamps what now

| | reads the client's clock |
| --- | --- |
| `@default(now())` on create | yes — `buildGeneratedDefaultMap` |
| `@updatedAt` on create | yes — same, and it was a THIRD mechanism (an implied column DEFAULT) |
| `@updatedAt` on update | yes — `stampSets` |
| `@@softDelete`'s stamp, `now()` in a policy | yes, unchanged |
| retention cutoff, SQLite and jsonl alike | yes — `nowMs`, one reading for both |
| a raw `db.sql` statement | no |
| `@derived` reading `now()` | no — compiled once at startup, no parameter to bind |

Key PRESENCE still decides, so an explicit `null` clears and a stated timestamp
wins. `isUpdatedAtField` is the one answer to *is this a stamp column*, because
the trigger earned itself off the column NAME as well as the attribute and
binding to the attribute alone leaves `updatedAt DateTime` unstamped.

### Upgrading

One generated statement. Pristine stops carrying the trigger, `droppedTriggers`
in `migrate.js` already walks for exactly that, and `litestone migrate` writes
`DROP TRIGGER IF EXISTS "<table>_updatedAt"` with **no table rebuild**.

**The price, and it is asserted rather than described**: the column DEFAULT
stays, so a raw INSERT still stamps. A raw UPDATE does not. `@updatedAt` is a
client stamp now and a hand-written statement owns its own.

`FJS-531`, ruled as `FJS-D152`.

## 2026-08-26 — capabilities are enforced

Step 3 of `IDEAS/permission-sets.md` § *Build order*. All three tiers refuse at the
Data boundary now; what is still unbuilt is the grant column that validates a role's
array and the affordance that offers the list.

**A capability THROWS where a policy filters, and that is safe here for a reason a
policy cannot borrow.** A `@@allow` decides WHICH ROWS, so refusing by name would
answer *there is a row you may not see*; a capability is verb-scoped and
row-independent, so `Invoice.void` discloses nothing about any invoice — and refusing
is the only useful answer, since a caller who does not hold it will not hold it for
the next row either. It lands as `AccessDeniedError` with the capability on its own
field, beside the gate's `required`/`got`, so a reader tells the two refusals apart
without parsing a sentence.

**The model tier rides the plugin seam the gate rides, deliberately.**
`CapabilityPlugin` is auto-installed whenever a model declares the grid — the gate's
fail-open argument, unchanged: a declared rule nothing enforces is worse than no
rule. It takes no resolver and therefore has nothing to replace, since `FJS-D151`
names the caller's set `auth().capabilities`. Riding the same hooks is what makes
`aggregate`, `groupBy`, `count`, `exists` and every other read path free — this
package's own history is three read methods that skipped the gate for as long as they
existed, and a second traversal would have been a second chance to repeat it.
`src/plugins/reach.js` is the extraction that made that shareable: *which models does
this call touch* — the `include:` walk and the nested-write walk — is a property of
the arguments and the relation graph, so it belongs to neither rule that asks.

**A move is graded where the transition's own `@gate` is**, because that is the only
place that knows which move a payload turned out to be: `transition(id, 'issue')` and
`update({ data: { state: 'issued' } })` are one move, litestone enforces both, and a
capability reaching only the named call would be a rule with a documented way around
it. Asserted both ways. A move at `@gate(8)` is not in the set and is therefore not
asked for — it is the engine's, and the gate refuses it on its own.

**A column is graded against the payload, beside `@system`.** Refused by name rather
than dropped, which is what separates it from a field `@allow('write', …)` that
happens to name a capability.

**Four contradictions are refused at parse, and one of them was measured biting.**
`@capability` beside `@default(auth().x)` made the model UNCREATABLE for every caller
without that grant — the write check reads the payload after the create path stamps,
so the stamp refused itself, naming a column the caller never sent. Also refused:
`@capability` on a field nobody writes (`@computed`, `@generated`, `@derived`,
`@from`), beside `@guarded`/`@system`/`@secret` (one says no caller ever, the other
says a granted caller does), and on a relation, which is not stored — pointing at the
foreign key.

**`asSystem()` drops it**, the way it drops the gate and the row policies: a
capability is permission, not scope (`FJS-519`'s distinction). A principal carrying
`capabilities` as anything but an array or a Set throws by name instead of reading as
an empty set, because *granted nothing* and *the resolver is broken* are the same
refusal from the outside and only one of them is somebody's afternoon.

19 tests, every one against a real client. Litestone green: 3171.


## 2026-08-26 — `@@capabilities` and `@capability` parse, and the set derives

The first shipped piece of the capability design (`IDEAS/permission-sets.md`,
seven rulings). **Two declarations and one derivation — nothing enforces yet.**

**`@@capabilities` is a switch, not a list**, because `FJS-D139` rules that a
capability is a REFERENCE to something the seed already declares. Bare covers
create, update, delete and every named move; `(all)` adds read, opt-in because
its refusal is the silent one (`FJS-D140`). **`@capability` on a column** says
that column's write is its own capability — opt-in per column and never derived
wholesale, since every writable column on basecamp is 461 of them and that is
not a list anybody picks from (`FJS-D147`).

**`src/core/capabilities.js` is the one place the set comes from.**
`deriveCapabilities(schema)` walks the models that opted in and answers
`{ name, model, kind, target, gate }` per capability, sorted; `capabilityNames`
is the same as a Set, which is what a grant column validates against. Four
forms, each already declared once: an operation on a model, a named move, a
`@capability` column, an operation on a join model.

**A move at `@gate(8)` is excluded and that is `FJS-506` paying off**: getLevel
is clamped to 7, so no caller passes and `asSystem()` bypasses — offering it in
a role editor offers something no role can use. Gate 9 goes with it, being
LOCKED to everyone.

**A `@capability` on a model with no `@@capabilities` is refused by name.** The
switch is what says the model is graded that way at all, so without it the
attribute reads as protection nobody applied.

Ten tests. The catalog's own coverage guard caught both new attributes missing a
row and then a missing docs pointer, which is what it is for; `docs/access-control.md`
has the section they point at, opening with the fact that nothing enforces this yet.
3152 pass.

## 2026-08-26 — `@time` reaches the client, and it does not borrow a standard's word

`@time` has validated on every write since it was written and emitted nothing at
all into the JSON Schema, so a `String @time` column reached a form as a bare
string, got a plain text box, and every value a person typed was accepted in the
browser and refused at the boundary. `@date` and `@datetime` each emit a `format`
and each gets a control; the third rung had neither.

The obvious fix was the wrong one. JSON Schema's `format: "time"` means RFC 3339
*full-time*, which requires seconds **and** an offset. `@time` requires neither
and admits no offset at all, so a consumer honouring the format would refuse
`09:30` — a value this boundary accepts. Two boundaries disagreeing about what a
time IS is a worse failure than one of them saying nothing.

So it emits a `pattern`, and the pattern is the validator's own regex, exported
from `validate.js` and imported by the emitter rather than restated:

```
opensAt String @time                 → pattern ^([01]\d|2[0-3]):[0-5]\d$
                                       x-time { seconds: false }
shutsAt String @time(seconds: true)  → pattern ^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$
                                       x-time { seconds: true }
```

`x-time` picks the control and enforces nothing — sierra answers
`<input type="time">`, with `step: 1` where seconds are allowed, because the
element shows HH:MM unless the step is not a whole number of minutes and a column
that ACCEPTS seconds would otherwise give nobody a way to type them.

Two things fell out of the pass. `MESSAGE_KEYWORDS` had claimed
`time: ['format']` for as long as the emitter produced no format, so an author's
`@time(message: …)` was keyed to a keyword no consumer could ever have checked —
it is `pattern` now. And the seconds variant was two alternative regexes where
one optional group says the same thing: the flag WIDENS what may be stored, it
does not make a finer value mandatory, and `09:30` is valid under
`seconds: true`.

Nothing in this repo declares a `@time`, `@date` or `@datetime` column — 141
`DateTime` columns and zero of the three — so this is covered by unit tests on
both sides of the wire and by no drive. `FJS-522`; 19 cases in
`test/time-column.test.ts`.

## 2026-08-26 — `@system` on a move: the engine decides it, the caller keeps their standing

`@gate(8)` says a move is the engine's, and it says it by admitting no caller at
all. That is right for a move nothing but a migration makes, and wrong for the
common one it was being asked to cover: a move the engine DECIDES and a person
REQUESTS. Somebody presses *sync*, the provider's answer picks the move, and the
write is on their scoped client — so at `@gate(8)` it refuses, and the only way
past was `asSystem()`, which drops the gate, the row policies and the audit actor
to make one move.

`@system` on a transition clause is the same statement `@system` already makes
about a column, and it reuses the same hatch: the application makes the move by
naming the column on the write. `transition(id, name, { system: true })` becomes
`system: [field]` on the update underneath, so writing the column directly is
refused and permitted by one rule rather than two.

```
@@transitions(status,
  drain:         online                -> draining @gate(5),
  checkIn:       [pending, unreachable] -> online   @system,
  reportStopped: [pending, online]      -> stopped  @system @gate(5))
```

The two compose and answer different questions — `@gate(N)` is how senior a
caller must be, `@system` is whose decision it is — so `@system @gate(5)` is the
person-requested engine move. `@system` with `@gate(8)` or `@gate(9)` is refused
at parse: those admit no caller, which contradicts it.

`TransitionSystemError` (403) is its own class beside `TransitionGateError`'s
403, because the remedies differ in kind: a gate refusal is answered by being
more senior and this one cannot be answered by any caller at all. `transitions()`
reports `refusedBy: 'system'` and asks it FIRST — no level to resolve, no policy
to evaluate. `x-transitions` carries the flag, so sierra's `transitionsAt` gives
a browser the one verdict on that side that is not permissive-when-unknown.

Ruled as `FJS-D150`; the counterexample came from adopting `FJS-506` in basecamp.

## 2026-08-26 — `@check` refuses in words a form can use, and `@@check` exists

Two halves of one gap (`FJS-534`), and the one that was shipping is the one
nobody would have looked for: field `@check` worked. It parsed, it reached the
DDL verbatim, SQLite enforced it — and the throw was a bare `Error` with no
status carrying SQLite's own sentence, so a **validation** problem came back as
a **500** and there was nothing for `toFieldErrors` to hang on a control. That is
the class `FJS-441` closed for uniqueness, still open one constraint over.

**It is a `ValidationError`, not a class of its own.** Two errors exist where
two RECOVERIES exist — restore-or-release against send-another-value is why
`SoftDeletedUniqueError` sits beside `UniqueConflictError` — and there is one
here. Through junction's boundary it is now a **400** carrying
`[{path:['qty'],message:'must be at least one'}]`, which is the shape `<Form>`
already reads.

**`@@check` is the half that spans columns.** Repeatable like `@@unique`,
emitted as a table CHECK. Until now a rule over two columns of one row —
`startsAt < endsAt`, `discount <= subtotal` — could only live in a service hook,
and a hook is bypassed by every other writer: a job on `db.`, a migration,
`asSystem()`, a seed, `fli tinker`.

**Both take a message as the last argument**, where every field validator
already carries one. Without it the person sees `is not valid` and the
expression goes to whoever wrote it on `err.constraint`; `qty > 0` under a form
control is SQL reaching somebody who did not write it. A field check marks its
own box, a `@@check` names no column and is therefore a record-level error with
an empty path — which turned up `ValidationError` rendering a bare `: ` in its
summary for one, fixed here.

Three things it needed and only one was work. The migrator already compared
CHECK text and rebuilt (`FJS-466`), so migration needed nothing. `fli
release:check` did need it: a new `@@check` is a **contract** and a removed one
an expand, because it is the one constraint that changes what a WRITE may be
without changing what a read answers — it is in the surface, the committed
snapshot and the classifier. And the catalog refused the attribute until it had
a row and a page, which is `docs/schema.md` § Constraints the database enforces.

## 2026-08-26 — `orderTotal(orderBy)`: the ordering a window is walked in

The tiebreaker was already litestone's — `findManyCursor` appends the model's id
where the caller's `orderBy` is not a total order, and refuses where there is
nothing to append. What nothing could ask for was that ordering itself, so
junction's first window ran an ordinary `findManyAndCount` in the caller's order
and then minted an edge in the total one. Where two rows tie on every sort key
those are different orders, and the rows between where the page stopped and
where the edge said it stopped were lost (`FJS-535`).

`orderTotal(orderBy)` answers the caller's ordering plus whatever makes it
total, in the caller-facing form, so one query can be run in it. It answers
`null` rather than throwing where no tie can be broken: a caller asking for a
cursor by name is told why, and a caller merely reading a list is asking for no
cursor at all — refusing that read would turn a window into a requirement.

## 2026-08-26 — `@scale(n)` and `@money`, and the ISO table read off the platform

17 new cases in `test/exact-numbers.test.ts`, 4 in toolbelt's `units` spec.
Typecheck clean.

`.lite` had `Int` and `Float` and nothing between them, and SQLite has no
fixed-point type to put there, so every exact quantity was a float and a hope
(`FJS-D150`).

**`Int @scale(n)`** — the column stays an `INTEGER`, the DDL is unchanged, and
the point sits n places in. **`Int @money(USD)`** is the same thing with the
scale DERIVED from the currency, because scale is not a free parameter for
money: JPY has none, USD has two, KWD has three, and an author asked for a
number has to know the ISO table by heart. `@money(field: currency)` names a
sibling column for a shop taking more than one; bare `@money` is the app's
default. `@scale` and `@money` together are refused — two answers to where the
point is.

**Almost all the value is in one refusal at the write.** A fraction now answers
`must be a whole number of minor units of USD — 12.99 is 1299`. It used to be
SQLite's `cannot store REAL value in INTEGER column line.total`: true, about a
physical column, and no use to the person who just typed a price.

**The ISO table is not shipped and the typo is still caught**, which needed both
halves of ICU. The minor units come from
`resolvedOptions().maximumFractionDigits`. Whether the code is real comes from
`Intl.supportedValuesOf('currency')` — 306 of them — and that half is
load-bearing: **`Intl.NumberFormat` does not throw on an unknown code**, it
answers two decimal places, so `@money(UDS)` would have taken a plausible scale
and been wrong by a factor of a hundred against any of the 26 currencies that do
not have two. `minorUnits()` and `isKnownCurrency()` are new in
`@frontierjs/toolbelt/units`, beside `formatMoney`, which already turned on the
same fact (`FJS-440`).

**The integer comes back in JS**, which is the half the earlier draft had
backwards. Rails hands back a `Money`, Prisma a `Decimal`, Django a `Decimal`,
Stripe an integer — none of them a float — and reading back `12.99` would put a
float at the boundary the column exists to move it off.

On the wire: `x-scale` and `x-money` beside `type: 'integer'`. The `field:` form
carries the column name and **no scale**, because it is not knowable from the
schema and a number right two thirds of the time is worse than an absent one.

**Rounding and allocation are still the application's**, stated in the docs
rather than implied: `@scale` makes the stored value exact and refuses a
fraction. It does not pick half-up over banker's, and it does not decide which
line of a split bill gets the leftover penny.

The catalog is what made this land properly — three of its checks failed in a
row and each named a real omission: no row for the new words, `POSITION_RULES`
not restating the parser's own forbidden set, and a word with no page. The last
one is why `docs/exact-numbers.md` exists.

`FJS-D150` · `docs/exact-numbers.md` · `test/exact-numbers.test.ts`


## 2026-08-26 — retention swept the wrong table, and swept it once

3074 pass, 1 skip, 0 fail (9 new). Typecheck clean.

Three defects under one declaration, and the one we went looking for was the
least of them (`FJS-521`).

**The sweep named the MODEL where the table is snake_case.** `DELETE FROM
"AuditEvent"` matches nothing — the table is `audit_event` — and the throw landed
in a `catch` commented *table may not exist yet on first run*, which is a
plausible reason for a real failure and is why nobody looked again. So every
model whose name is not a case-variant of its table kept every row for ever:
any multi-word name, and every name at all under `pluralize`. Measured — `Log`
was deleted and `AuditEvent` was not, in the same pass, silently. A single-word
test would have passed, because SQLite matches identifiers case-insensitively.

**And a table that is missing is now ASKED about rather than inferred from a
throw.** The first-run case is legitimate and stays quiet; a DELETE that fails
against a table that is there is reported. Those were one silent branch.

**Startup is not a schedule.** The pass runs inside `createClient` and nothing
reschedules it, so a server up for a month prunes on the day it booted —
`retention 90d` stops being true the day after a deploy. `db.asSystem().$retain()`
is the same pass on demand, answering `{ model, table, removed }` per table plus
`error` where one would not sweep. **Scheduling it is the app's**, and that is
two rulings rather than a gap: unattended recurring work belongs to the queue
(`FJS-D36`) and this package may not import it. `example` and `basecamp` both
have a `retention.job.ts` now — the declaration was in both schemas and the
sweep had never run twice in either.

**`asSystem()` only**, for raw SQL's reason (`FJS-D52`): it is a DELETE against
the base table through no gate, no row policy and no `@@softDelete`. The other
three flavors of client refuse it by name and say the way out.

**The jsonl half is covered too** — it compacted at `makeJsonlTable` init and
its failure was `catch { /* non-fatal */ }`, so a policy that threw every boot
looked like one with nothing to do.

**Not fixed, deliberately.** The cutoff is a rolling instant — the duration back
from the moment the pass runs, `d` a flat 24 hours, `y` a flat 365 days — with no
calendar and no zone. A calendar-aligned window needs a zone the seed cannot yet
state (`FJS-D143`), and inventing half a vocabulary here is what that record
warns against. Stated in the docs and asserted in the suite instead.

Also: `index.d.ts` declared `runSqliteRetention(db, retention)` against an
implementation taking three arguments, so a caller reaching for the export wrote
a call that swept nothing. Both retention exports are now typed as they are.

`FJS-521` · `test/retention.test.ts`


## 2026-08-26 — a cursor's tiebreaker is DERIVED, and there is one owner of it (`FJS-D145`)

`findManyCursor` took the caller's `orderBy` as the cursor's sort keys and
asked nothing about it. **An ordering with no unique column is not a total
order**, and a keyset scan over one fails silently: two rows sharing a
`createdAt` sit either side of a page boundary and the comparison cannot
separate them, so one is served twice and one is never served at all. No error,
no gap — the class this repo exists to remove, and the reason the keyset
literature calls a unique tiebreaker a correctness requirement rather than a
tuning knob.

The schema declares which columns are unique, so it is **derived**: the model's
own id is appended, in the last sort key's direction. The order the caller asked
for is unchanged; what is added is determinism among rows it left equal.
Measured on the worst case — 25 rows all sharing one `rank`, walked in slices of
five — which used to repeat and skip and now returns each row exactly once.

It **refuses** only when there is nothing to append, a model with no unique
column at all. That cannot be made correct, and `limit`/`offset` is the honest
answer.

**`cursorFor(row, orderBy)` is new and is why the derivation is a named
function.** The far side mints the FIRST window's edge off an ordinary page —
Junction's `find` runs `findManyAndCount` and then asks for the last row's
position, so growing a window costs no extra query — and an edge that disagreed
with this about the tiebreaker would name a position the next page does not
resume from. One owner, per Invariant 4. Answers `null` where a `select`
dropped a sort key, since a cursor built from an absent value names a position
that is not there.

## 2026-08-26 — the test clock moves, and what it does not move is now asserted

3065 pass, 1 skip, 0 fail (12 new). Typecheck clean.

`createTestEnv` spreads its unknown options into `createClient`, so `now` already
reached both the env client and `atLevel`'s. It was undeclared, undocumented and
asserted nowhere — and it could only be **frozen**, which is the half that is not
worth much: every bug worth a test here is a crossing, and a fixed instant
asserts one side of one.

**`env.clock` is the movable form.** `now` takes a `Date`, an ISO string or a
function; the option is normalized into a holder every client this env opens
reads through — `set(at)`, `advance('20d')` or milliseconds, `frozen`. A window
that opens can now be asserted on both sides in one test.

**A function stays the caller's**, and `set`/`advance` refuse it by name: two
things claiming to say what time it is means the loser is whichever one the
reader did not have in mind. **`advance` from the wall clock freezes**, because
an offset from a moving clock is still moving and the assertion after it is a
race. Durations go through `parseDuration` — the one owner — which grew a label
so a clock is not told it has an *invalid retention duration*.

**The lazy client is the case that would have been missed.** `atLevel()` builds
its client on first use, so one constructed mid-suite has to follow a later move
rather than holding the instant it was built at. Pinned.

**And the hole is asserted rather than left to be discovered.** The clock moves
`now()` in a row policy and `@@softDelete`'s stamp. It does NOT move
`@default(now())` or `@updatedAt`: a column DEFAULT and an AFTER UPDATE trigger,
both `strftime('%Y-%m-%dT%H:%M:%fZ','now')` — SQLite's own clock, which nothing
in JavaScript can move. The option's own comment called itself *the clock every
time-dependent rule reads* and `docs/access-control.md` said a frozen clock
*freezes every timestamp litestone writes*; both were wrong and both are
corrected. A suite that needs an old row states the timestamp on the write, which
works because a column default only applies to a column the write omits.

`FJS-524` · `FJS-531` (the fork: bind those two in JS only when `now` is
injected, or always) · `test/test-clock.test.ts`


## 2026-08-26 — `asSystem()` keeps the tenant it is standing in

`asSystem()` dropped the gate, every row policy, `@guarded`, `@system` and every
field `@allow` in one move. Right for a migration; wrong for the shipped feature
underneath it. **Row tenancy desugars to `@@deny`, which is a policy**, so a
system context read every tenant's rows — and since a `@@gate("8")` model can be
read by nothing else, the only client that could read a credential was the one
that ignored tenancy. A per-tenant credential could not be enforced declaratively
at all, and doing it in a resolver's own where-clause is what Invariant 6 refuses.

**It now means *no permission rules*, not *no scope*.** One `rulesFor()` answers
*which rules apply to this caller* for all three readers — the SQL builder, the
JS evaluator, and the builder again through a `check()` delegation — because
written at each call site a model reached through a delegation would be graded by
a different rule than the one that reached it. Under a system context it keeps
exactly the denies tenancy generated.

**And only while a tenant is IN SCOPE**, which is the clause that makes it safe
rather than breaking every boot: the generated predicate's first branch is
`auth().<claim> == null`, so applying it with no principal would deny every row
rather than widen to all of them. A migration, a seed and any job with no caller
read everything, exactly as before.

**The half that was not in the plan: `asSystem()` was memoised once, at the
root.** Every scoped client handed back that same proxy —
`db.$setAuth(u).asSystem() === db.asSystem()`, measured — so the principal was
discarded and there was no claim for the rule above to keep. It is memoised per
scope now, keyed by the context it was reached from, and `db.asSystem()` is still
identity-free because that is what a migration is. **This also makes a
composition this file has documented for its whole life actually work**: the
comment promised `db.$setAuth(user).asSystem()` for *system-level access AND a
user identity (e.g. for audit logging)* and called it "NOT memoized", and the
auth proxy returned the root function, so it was neither.

Five tests in `test/tenancy.test.ts`, including the two a column comparison does
not cover — a scoped system client placing a row in another tenant, and moving
its own row into one. `FJS-519`, cases 1 and 3 (the standing table wanting
*policies off* and *a rule kept*) deliberately still open.

## 2026-08-26 — a test fixture never invents a foreign key

`_shouldSkipField` deliberately does NOT skip a field whose default is
`@default(auth().<claim>)`: the factory has to supply a value because a
system-context create would not fire the stamp. On a REQUIRED foreign key that
value is harmless — `_freshParents` seeds a real parent and overwrites it. On a
NULLABLE one nothing seeds a parent, so the generated string reached SQLite and
came back `FOREIGN KEY constraint failed`, which `verifyGateLadder` reports as
*the call threw something that is not a refusal* — at every level of the model,
21 rows for one column.

The shape that reaches it is row tenancy over a nullable claim column, which is
what basecamp's `AuditEvent` became the day it stopped saying `@@tenant(none)`
(`FJS-432`). Null is always legal in an optional FK, so leaving it out is the
honest fixture; a generated one is refused by the CONSTRAINT rather than by
whatever rule the caller is grading, which is the failure this whole harness
exists to avoid confusing.

Also documented rather than changed: the two spellings of declared tenancy give
opposite answers about a row that belongs to no tenant. A nullable claim COLUMN
hides it from every tenant; `@@tenant(via: rel)` over an optional relation shows
it to every tenant (`FJS-382`). Both measured, both deliberate, neither
reconciled — `docs/multi-tenancy.md` § What it desugars into, and `FJS-528`.

## 2026-08-26 — a caller-supplied primary key survives the create fixture

`verifyGateLadder` strips the id from every create fixture, which is right where
the database or the client mints one and wrong where the CALLER does: a
`String @id` with no `@default` is required, so stripping it fails the required
check and **the gate is never asked** — reported as *no fixture could be built*,
at every level, for a model that creates perfectly well.

`_columnPayload` had already drawn this line for the tenancy checker, in those
words. Drawing it differently in the other harness is how one grader reports a
model the other cannot build. Found on basecamp's `OutpostNonce`, whose primary
key is the nonce because the insert is the claim (`FJS-376`).

## 2026-08-26 — `@keep`, the third fate a soft-deleted parent's children can have

When a `@@softDelete` parent was removed a child could be in one of two states
and only two: stamped with it (`@@softDelete(cascade)`) or destroyed
(`@hardDelete` on the relation field). The third — **the child stays LIVE, on
purpose** — could be produced but not SAID: it is what a plain `@@softDelete`
already does, and the parser warns about it because forgetting the cascade and
meaning it look identical from the outside.

*The customer goes, the receipts stay* is that shape, and it is not rare. Found
building `example`'s customer removal: `Order.customerId` is `onDelete:
Cascade`, so `remove()` destroyed every order the person had ever placed, and
cascading the soft delete instead only hid them. Neither is what a shop means by
taking somebody off the books, and the only way to stop the warning was to stop
being right.

`orders Order[] @keep` says it. It covers the whole subtree beneath that child —
if the order survives, its lines survive with it, or the receipt is half a
receipt — and it says nothing about removing the child directly. The footgun
warning names all three ways out now, so the third is discoverable from the
thing that complains about it. 11 tests, half of them the warning and half the
rows.

## 2026-08-25 — what `@gate(8)` means on a move, said out loud

A state machine could not say which of its moves a person makes and which the
engine makes, so applications guarded the machinery half in service hooks —
basecamp's `internalOnly()` is the shape. **The schema could already say it and
nothing documented that it could.** `@gate(8)` on a transition means
`asSystem()` and nothing else: `getLevel` is clamped to 7, so SYSADMIN is
refused by name, and a system context bypasses the check entirely.
`transitions(row)` already reported `allowed: false` for one, so a screen gets
the right buttons with nothing written. Now in the `@@transitions` reference and
in the catalog, with the consequence stated — **every move not at 8 is one a
person can make**, which is the only mechanical line between the two halves of a
machine, and the one filter a capability set could ever be derived through
(`IDEAS/permission-sets.md`).

**Two copies of the comparison went with it.** `levelPasses()` declares itself
the one definition of *does this level pass this gate*, warning that a second
copy is an artefact certifying access the plugin does not grant — while
`checkTransitions` enforced a per-move gate with `level < required` and
`transitions()` described one with `level >= gate`. Three spellings, agreeing for
every reachable level today and each reading 8 as a rung rather than a sentinel,
so the day a resolver stops clamping they disagree about `@gate(8)` in opposite
directions. Both call `levelPasses` now. `expectedVerdict` in `access.js` stays
independent on purpose and says why at its own declaration: an oracle whose
expected value comes from the code under test cannot fail.

**And a gate inside the enum's shared `transitions { }` block is refused by
name.** It was already refused — as `Expected IDENT, got '@'`, which says
neither why nor where a gate does go. A gate is a model concern because one enum
can drive the same move on two models that answer to different authority, and
the message now says that and writes out the `@@transitions` line to use
instead. The two spellings differ in exactly one thing and the reference says so.

`FJS-506`. Adoption in basecamp is the half still owed. Green: 3044.

## 2026-08-25 — `transitions()` grades the policy, not just the gate

`db.<model>.transitions(row)` answered *the legal next states for this record at
this caller's level*, and level was exactly what it meant: `allowed` was
`gate == null ? true : level >= gate`, with nothing consulting `@@allow`/`@@deny`
(`FJS-495`). A move is an update, so a row policy refuses one exactly as a gate
does — and a caller holding every level and failing the policy was shown a
button that answered 403 the moment they pressed it. `FJS-494` fixed the press;
this is the half before it.

**Two questions, and only one varies per move.** The `update` policy is about the
row as it IS, so it is one evaluation for the whole call. `post-update` is about
the row as it WOULD BE — the current row with that one column moved — so it is
one per distinct target state, and both are memoised. That is what keeps this off
the per-row cost the issue was worried about: a machine's moves share few
targets, and a model with no policies evaluates nothing at all.

**`refusedBy` is new on every entry** — `'gate'`, `'policy'` or `null`. A screen
has two different things to render, *you are not senior enough* and *not this
record*, and neither a status code nor a non-null `gate` can carry the
difference: the gate is null for every ungated move a policy refuses.

**`policyVerdict` is the one answer to *does this policy admit this row*.**
`checkCreatePolicy` and `checkPostUpdatePolicy` were the same function under two
op names, and this is now a third caller that must NOT throw. Deny-before-allow,
an empty `allows` meaning *no opinion* rather than *nobody*, and `asSystem()`
skipping outright are three rules, and a screen getting any of them wrong offers
a move the boundary refuses. It deliberately does not catch: at the boundary an
undecidable policy must refuse, and the affordance is where permissiveness
belongs.

Six new tests, including the one the issue is actually about — what the list
SAYS and what the write DOES, for one caller on one row, since a test of either
half alone passes with the two disagreeing. Green: 3028.

## 2026-08-25 — the tenancy crossing, executed (`FJS-513`)

3022 pass, 0 fail — 9 new.

**`verifyRowPolicies` reports a rule holding a `check()` as not-graded, and that
is the whole delegated half of declared tenancy.** On basecamp's 45 models it
grades 17 by column and declines 14 that are scoped through a parent —
`FJS-382` is what the declined half costs: the two implementations of `check()`
disagreed about a null foreign key, every scoped read dropped the row, and the
grader called the policy correct throughout.

Teaching it to evaluate a delegation would be the oracle problem — two
implementations of one rule grading each other. **`verifyTenantIsolation()` asks
the question the other way instead**: seed a row for tenant A, then have tenant B
and a caller holding no claim try to reach it. A row B can see is a finding
whether the rule naming it is one comparison or six delegations deep, and no
second implementation is involved.

Five moves. `read`, `update` and `delete` are B reaching into A; **`create` is B
placing a row inside A's tenant and `post-update` is B moving a row it
legitimately owns into it** — the two the generated `post-update` deny exists for
and the two a column comparison alone does not cover.

**Both sides are asserted.** A run where B reaches nothing proves nothing on its
own — a policy admitting nobody and a model nothing was seeded into are the same
observation — so A must reach its own row or the result is `unreachable` rather
than isolation. And **every model is named in the output**, because a model that
isolates correctly is silent and so is a model nothing ran against; the coverage
is the result.

Three answers that are deliberately not verdicts:

- **`unscoped`** — no tenant column, no scoped parent, no `@@tenant(none)`. The
  desugar errors on a `@@tenant(via:)` naming an unscoped parent and says nothing
  about a model that names no `via` at all, so the model every tenant can read is
  the one nobody was told about.
- **`unparented`** — a delegated model whose scoping relation is OPTIONAL. `check()`
  answers true for a null foreign key, so a row that never got a parent is in no
  tenant and every tenant reads it. That is `FJS-382`'s ruling, so it is named
  rather than called a leak; the fix is a schema decision.
- **`exempt`** — `@@tenant(none)`, listed rather than passed over.

`strategy database` is reported by name and not graded: a tenant is a file, one
client cannot hold two, and grading a predicate that does not exist would be a
green run over nothing.

Two things the build found by being run rather than reasoned about. The seeder
**fills optional scoped relations by default** — skipping them seeds only the
degenerate unparented row, which reports every tenant reaching it and says
nothing about the rows an app actually holds. And the per-model restore lands
**after** the two tenants are established: rolling back past them meant the first
model that finished cleanly took the fixture with it, and the other 28 failed to
seed with a foreign key error that had nothing to do with tenancy.

`_tenantStamp` is now one definition shared with `verifyFieldProtection`, which
had carried its own copy since `FJS-381` — two seeders stamping the claim
differently is that same defect one level up.

**basecamp, 45 models: 31 graded (17 by column, 14 by delegation), 14 exempt, 18
uncheckable ops behind a gate above 7, and no leak, no unscoped model and no
unreachable row.** The fourteen had never been graded by anything.

## 2026-08-25 — two ways a declaration meant nothing

3013 tests, 0 fail.

**A field `@allow` on a relation field parsed and enforced nothing** (`FJS-510`).
Both halves: a caller the write predicate refused moved the row to another team
anyway, and the read predicate returned the relation to everybody. A relation is
not stored, so the write half had no column for its `CASE WHEN` and the read half
stripped a key the row never carried — and the schema looked guarded throughout.

Refused at parse now, naming the column that would have worked. `@relation(fields:
[teamId])` already says which one, and that spelling guards **both doors** — the
direct `teamId` write and the `{ team: { connect: … } }` form, measured. An
implicit many-to-many gets its own sentence, because it has no column on this
model at all.

A `@derived` field is left alone deliberately. It rides the SELECT as an
expression, so the read strip does reach it — checked, rather than inferred from
`isStoredField`, which returns false for derived fields too and would have
refused a case that works.

**`@@transitions` could not name a Boolean column** (`FJS-511`). *Expected IDENT,
got 'false'* — so the two-state machine every schema has had no declaration, and
its two directions, which are routinely different authorities (suspend and
unsuspend, publish and unpublish), could only be guarded by one field `@allow`
answering both with a single predicate.

The state reader takes a boolean literal; the validator accepts any CLOSED type,
so the refusal for an `Int` now reads *not a closed type* rather than *not an
enum*; and an unnamed boolean move is refused, because `-> true` names the value
written rather than what a person did.

**The normalisations were the real work.** `checkTransitions` reads the raw
column, where a boolean is 1/0, and is handed a write payload coerced the same
way, while the declaration holds real booleans. Unnormalised, `0 === false` made
a genuine move look like a no-op that silently succeeded, and `to === 1` matched
no declared move so every legal move threw. The compare-and-swap had the mirror
problem: it bound a raw `false`, which equals nothing the column ever stores, so
every boolean move would have reported a conflict.

Both found by asking where a per-column capability would live
(`IDEAS/permission-sets.md`).

## 2026-08-25 — a refusal that told you to try again

3009 tests, 0 fail.

**A `@@allow` refusal on a transition was reported as a retryable conflict**
(`FJS-494`). `transition(id, name)` is an `update()` whose WHERE is narrowed
twice — once by the update policy, once by `AND field = <current>` as the
compare half of the swap — so a policy refusal and a racing writer both arrive
as *zero rows changed*. Both threw `TransitionConflictError`: 409, and
**`retryable: true`**.

Two failures in one. The person is told the row was modified when nothing
modified it; and `isStaleWrite(err)` says re-read and re-apply, which against a
rule that refuses every attempt is a loop with no exit.

The two cases were already separable and nothing was asking. `checkTransitions`
proves the row exists at `from` before the statement runs, so re-reading that
one column afterwards says which happened — still at `from` means nothing moved
and the policy is what refused. That is now an `AccessDeniedError` naming the
model and the move, which junction's boundary maps to 403 and which carries no
`retryable`; a `TransitionConflictError` is thrown only where the row really
moved. The extra read is on the failure path and only where an update policy
exists at all.

`throwIfVersionMoved` sits three lines above it and has always made exactly this
distinction for `@version`, for exactly this reason — the comment over it names
all three outcomes of a zero-row update. The transition branch was written
against the two that existed before policies could guard a move.

**Not fixed, and filed**: `transitions(row)` grades the gate and not the
policies (`FJS-495`), so a screen still renders the button this refusal now
answers honestly.

## 2026-08-25 — the one path a fleet does not own

**A tenant registry dropped `clientOptions.databases`** (`FJS-492`). Every
sqlite database is redirected to the tenant's own file — that is the isolation —
and a `jsonl`/`logger` one is deliberately left alone, because it is shared
across the fleet. That leaves the shared one's declared `path` as the last one
resolving against the process CWD, and `clientOptions.databases` is what an app
assembling its schema in memory has instead of a file to anchor against. The
client build spread `clientOptions` and then assigned `databases` outright, so a
stated one was replaced by the tenant overrides with nothing said. Merged now,
the tenant file still winning for every sqlite database.

Found by an orphan `example/site/db/shop.db` — two days old, and invisible
because the repo ignores `*.db*` everywhere. Every `site`/`widgets` script runs
`cd <surface>` first, so a command typed there wrote the app's audit trail into
a directory beside the surface.

`databases: ':memory:'` in `clientOptions` is refused by name rather than
merged: spreading a string yields one key per character, and the option that
means an in-memory fleet is `inMemory`.

## 2026-08-24 — two things a second tenant found

3006 tests, 0 fail.

**A jsonl index could not take a second writer** (`FJS-491`). A `jsonl` or
`logger` database is schema-GLOBAL under `tenancy { strategy database }`, so
every tenant's client writes the audit trail through its own driver instance
over one file. `insertIndexRecord` used a plain `INSERT` where the model has no
`@id`, on a table whose primary key is `_offset` — so the first write after a
second shop was opened died with `UNIQUE constraint failed: auditLogs_idx._offset`,
a crash from inside an audit write, about a table nobody named. `INSERT OR
REPLACE` either way now: `_offset` is the line's identity in the file, and
`refillIndex` beside it has always said so.

**`resolve subdomain` could not be developed against** (`FJS-486`). `tenantFrom`
wanted three labels — written for `acme.example.com` — and `acme.localhost` is
two, so the first thing anybody types trying the feature answered `null`. That
reads as the registry not knowing the tenant rather than as the host never
naming one. `.localhost` is a reserved TLD every resolver already sends to
loopback, so two labels count when the last one is it; `localhost` alone is
still not a tenant called localhost.

## 2026-08-24 — `extend model`, so an app stops pasting a package's models

3005 tests, 0 fail (+12). A package that ships `.lite` owns its columns. What it
cannot know is where those rows sit in the app that installs it: the relation
back to that app's own `User`, whether they are audited, and — under row
tenancy — that they span tenants rather than belonging to one. There was
nowhere to say any of it, so the only way in was to paste the models into the
app's own schema and edit them.

```
import "@frontierjs/auth/schema.lite"

extend model Session {
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@tenant(none)
}
```

**The opposite direction of `@@trait`, and both exist.** A trait is opted INTO
by the model, which requires the model's author to have known about it — exactly
what is not true of a model somebody else shipped.

**Adds only.** Three things are refused by name rather than resolved, and each
is a real mistake wearing the look of a working schema: an extend naming no
model (a typo, or an import that did not resolve, does nothing at all, forever),
a field the model already declares (that is editing a package's column, which is
the copy this removes), and a second answer to a single-valued attribute —
`@@gate` twice is not a narrowing, it is two statements about who may read the
table. `@@allow`, `@@deny`, `@@index`, `@@unique`, `@@check` and `@@trait` are
repeatable and compose as they do anywhere else.

Extends are collected across the whole import tree and applied once it is
merged, so textual order decides nothing — a file may extend a model it is
imported *by*. Applied before traits, so an extend may carry a `@@trait(T)`.

What it is measured against: basecamp carried hand copies of four
`@frontierjs/auth` models, and one of them had `@guarded(all)` where the package
writes `@secret` — so turning OAuth on there would have stored every provider
access and refresh token unencrypted. Its 137 tests were green either side of
the divergence, because nothing anywhere compares a copy to its original.
It imports now, and the copies are gone.


## 2026-08-24 — a schema that could not build its own database (`FJS-480`)

2993 tests, 0 fail. `@@softDelete` builds a partial index over `deletedAt`, and
a declared `@@index([deletedAt])` derived the same name. The schema validated,
the DDL was emitted, and the run died inside SQLite on `index
idx_note_deletedAt already exists` — an error naming a physical index, about a
declaration two attributes away, with nothing in between having objected.

Refused at parse. The declaration buys nothing either way: a declared index on
a soft-delete table is already given the `WHERE "deletedAt" IS NULL` clause, so
it compiled to exactly the index `@@softDelete` was about to write, and what a
dedupe at emit would preserve is the ability to write a line with no effect.
Single-column only — `@@index([deletedAt, status])` derives a different name.

Found by putting a real ERP's MySQL schema through the parser, where the source
table declared exactly that index. `litestone introspect` does not produce the
pair — it drops solo non-unique indexes altogether — so the shape arrives from a
person, or from a converter written against another database's DDL.

**Also new: a scale fixture.** `test/fixtures/scale/openmrp.lite` is 188 models
and ~1,900 columns; `test/scale.test.ts` asserts it parses and that a second
boot against the built database migrates nothing, and `bench/scale-schema.mjs`
times the realm over it (parse 62ms, DDL 13ms, JSON Schema 7ms, autoMigrate
294ms, reboot 86ms). The apps in this repo top out near 40 models, so nothing
here could see a rule quadratic in model count or two features deriving one
index name.

## 2026-08-23 — a taken @unique value says so in the caller's own words

2986 tests, 0 fail. `UniqueConflictError` (`FJS-441`) — **409**, `retryable:
false`, naming the model and the field, values redacted the way the audit trail
redacts them, because a `@unique` column may be `@encrypted` and ciphertext
belongs in an error message even less than a plaintext.

The neighbors were already done and this was the gap: a conflict a DELETED row
caused says so, a conflict inside a batch names the row, and a live single-row
conflict escaped as `UNIQUE constraint failed: product_variant.sku` inside a
500. Three separate things wrong with that — a status that pages somebody and is
retried by clients that would not retry a 4xx, no field for a form to key on,
and the physical table name, which is neither the name the caller used nor
anything a browser should learn.

**The channel is `errors`, not `data`**, matching `ValidationError` — the one
shape sierra's `toFieldErrors` already reads, so the message lands under the
control that caused it with nothing new taught to either side. A composite says
`this combination is already taken (team + slot)` per field: naming the value
would be false, since `"red" is already taken` under `team` is untrue on its own.

**The update path never translated at all.** Same defect wearing the other verb,
found by reading rather than by a report — `update`, `updateMany` and the
`select: false` variant each handed SQLite's message straight out. All three
route through the one translation now, which is also where the soft-delete
question is asked first, because the two conflicts have different ways out:
restore-or-release for a deleted holder, send another value for a live one.

`isUniqueConflict` recognises the translated error. Two paths ask it AFTER the
translation — upsert's race fallback and the factory's rebuild-and-retry — and
both would have stopped recognizing their own case.

## 2026-08-23 — the access diff reports what it cannot grade

2986 tests, 0 fail. Three failures of one idea: the axis was defined as *who may
now do more* and the command is run to ask *what did this branch do to access*
(`FJS-D131`).

**A model the baseline never had is `new`** (`FJS-444`). It had no counterpart,
so every per-model rule skipped it and it left the axis entirely — `example`
added nine gated tables and the report said *no change to who may do what*. The
bucket carries what the model declares: its gate, which operations have a row
policy, how many protected fields, and the unrestricted case leading. Ranked
below `narrows`, so `--strict` means exactly what it meant and nothing that used
to fail now passes. A removed model is graded `narrows`, the same blindness in
the other direction.

**An allow→deny inversion is undecidable, not a widening** (`FJS-380`).
`@@allow(X)` replaced by `@@deny(!X)` over the same operations admits the same
rows; the walk graded the two halves separately and took the worst, so basecamp
adopting `tenancy { strategy row }` read **15 widen · verdict WIDENS** on the
safest refactor there is. Now **0 widen · 15 undecidable**, one finding on this
axis and still two on the deploy one. Equal operation sets only — a partial
overlap is a mixed change, and grading its bare half as undecidable would hide a
widening inside a refactor.

**A baseline is graded by its own era** (`FJS-469`). Every validation rule this
parser learns is retroactive: the day `@@unique` over a nullable column became an
error, every ref before it stopped being a baseline, both commands answered *no
baseline*, and `--strict` fails on no baseline by design. A validation failure is
a named note now and the comparison runs; a syntax failure still refuses.

## 2026-08-23 — a CHECK constraint that never migrated

2973 tests, 0 fail.

SQLite has no ENUM type, so an enum is a `CHECK (col IN (…))` — and that text
was frozen at CREATE TABLE. `migrate.js`'s header has listed *change CHECK* as a
full-rebuild trigger since the file was written and nothing implemented it: the
diff reads columns, indexes, foreign keys and STRICT, and a CHECK is on none of
those (`FJS-466`).

**Adding a member to an enum is the commonest schema change there is**, and it
reached the DDL, the committed snapshot and every generated form while the live
database went on refusing the value. Measured on `example` when `PaymentStatus`
grew `refunded`: everything green, the app booted, and the first write died on
`CHECK constraint failed: status` inside a transactional method — so the rows it
had already written rolled back with it and the symptom was *the order did not
move*.

Both directions were probed rather than assumed. **Narrowing is not the
fail-open twin it looks like**: the validator refuses a value the enum no longer
declares before any SQL is built, so a removed member stops being writable
whether the constraint migrated or not. And `@gte`/`@lte`/`@length` emit no
CHECK at all, which is what makes this an enum defect rather than a
constraint-wide one.

`parseChecks` reads them out of `sqlite_master.sql`, column-level and
table-level alike. Both sides of the diff are litestone-generated text read back
the same way, so a normalized string comparison is exact here in a way it would
not be for an expression somebody typed — and *an unchanged enum migrates
nothing* is a test, because comparing a constraint by text is the exact shape
that rebuilds on every boot.


## 2026-08-23 — a relative `database { path }` can anchor to the app root, opt-in

`FJS-449`. `resolveDbPath` ended in node's one-argument `resolve()`, so a declared
path meant a different file per directory the command was typed in. `litestone
studio` started in `db/` opened an empty `db/db/shop.db` it had just created and
served it for nineteen hours; a `vite build` from a surface root prerendered
twelve product pages as zero products and exited 0.

`createClient({ resolveFrom: 'schema' })` anchors to the **app root** — the
schema file's directory, or its parent when that directory is named `db`, because
`db/schema.lite` writes `./db/shop.db` and is naming a sibling from one level up.
Anchoring to the schema's own directory, which is the obvious reading, produces
precisely the junk path.

**It is opt-in and that is measured, not cautious.** Unconditional anchoring broke
basecamp: its seed test isolates a run with a scratch CWD, redirecting `database
main` by env var and `database audit` — which has no env var — by the CWD alone,
so the audit log went back to the shared directory and the suite failed on a
locked database. Resolving against the process is an isolation contract that
apps depend on and document. The CLI opts in at all eight of its client call
sites; `tools/cli.js` kept a second copy of the resolver and now imports
`schemaAnchor` instead of restating it.

**Two observability halves shipped with it and are half the value.**
`describeDataRealm` printed every path relative to the CWD, so the correct run
and the catastrophic one logged the identical string `./db/shop.db`; the cwd is
printed beside them now. And studio's `db:` line tested `cfg.db`, which defaults
to `./development.db` and is therefore always set — so the branch that names the
real declared databases had never executed for any app that declares them.

Not fixed: an app that assembles its schema in memory hands over a string with
no location in it, and there is nothing to anchor to. `FJS-449` stays open for
that half.

## 2026-08-23 — three ways to be silently wrong

2967 tests, 0 fail. Three defects, one pass, all of them plausible answers with
no error anywhere.

**`@@unique` over a nullable column is refused at parse** (`FJS-437`,
`FJS-D130`). Two NULLs never compare equal, so the index admitted
`(1, NULL, NULL)` twice — measured, two identical creates both succeeded — while
the same pair with values was refused. The constraint worked exactly where it
was never in doubt. The refusal sits beside the `@encrypted` one, which exists
for the neighbouring cause, and names both answers: a `@default`, or
`nullsDistinct: true`, which is SQL's own word for what SQLite does and states
the shape rather than inventing an escape hatch. Composite only — on one
optional column `@unique` has a single reading and every SQL developer holds it.

**A `@from` across a composite key correlates on every column of it**
(`FJS-377`). It used to take `rel.fields[0]` and `rel.references[0]`, so a
relation declaring `[workspaceId, userId]` counted every row sharing the
workspace. Measured on a grid where each candidate join gives a different
answer — 3, 5, 7 read back as **8, 8, 7**. `inferFromFk` answers arrays now and
all three places the correlation is spelled join them: the subquery, the
`first`/`last` repick under a row policy, and the injection of the correlation
columns into a `select` that named only the derived field.

**A write naming a `@from` field is refused by name** (`FJS-395`). It was the
one virtual field kind of six that dropped the value in silence, so a caller who
seeded a count read back the real one and believed they had set it. A test
asserted that silence; it asserts the refusal now.

Worth recording: **no schema in this repo declares a `@from`**, in any app or
example. Litestone's own tests are the only user, which is how two of these
lived this long.

## 2026-08-23 — one write, one announcement

2946 tests, 0 fail.

A transition fires two events: `update`, because a row changed, and `transition`,
because a named move happened. Both are legitimate for a subscriber and they are
one write, so a consumer announcing per write had no way to pick — it either
broadcast twice or, skipping the update, said nothing at all for a move whose
transition event was deliberately suppressed (`asSystem()`, which warns and
emits nothing).

**The update now carries `transition`, and only when the transition event is
really going to fire.** That is the one fact the consumer cannot derive, and it
is decided here because it is decided here already.

The transition event also names the MODEL where it named the table, like every
other event this client fires. Two events for one write disagreeing about what
the model is called is how a lookup keyed by `model` silently misses one of them
(`FJS-463`).


## 2026-08-23 — a field predicate is compiled into SQL, both ways

2946 tests, 0 fail.

`FJS-393` closed the extraction hole for `@guarded` with a walk over the
caller's arguments, because that attribute is a set-membership test decided once
per model. `@allow('read'|'write', …)` on a FIELD is a **predicate**, and both
halves of it were being answered in the wrong place (`FJS-D129`).

**Read (`FJS-442`).** The column was stripped from the answer and left fully
filterable and sortable — measured, `salary Int? @allow('read', auth().isAdmin)`
recovered exactly as `91000` in seventeen `gt` probes, and an `orderBy` leaks the
ordering of every row in one request. The predicate is compiled with the same
`compileSql` that row policies use and AND-ed into the caller's arguments as a
**sibling** of their `where`. Sibling rather than conjunct is the whole of it: a
per-clause AND is complemented by the caller's own `NOT`, and
`NOT ((pred) AND (salary > X))` is the same oracle with a minus sign.

A row-dependent predicate still works over the rows it admits — `@allow('read',
auth().id == ownerId)` narrows a filter to the caller's own rows rather than
refusing it, which is the case the feature exists for. The cost, stated: an `OR`
branch naming the column narrows the whole read. Fewer rows, never more.

**Write (`FJS-433`).** The predicate was `evalJs`'d against the PAYLOAD, so on an
update it was wrong in both directions — a payload omitting `ownerId` graded
against `undefined` and dropped a column the owner was entitled to write, and a
payload STATING `ownerId: me` graded against the caller's own assertion and wrote
the column on somebody else's row. That one is fail-open. It is now the WHEN of
`SET col = CASE WHEN <pred> THEN ? ELSE col END`, which reads the stored row and
grades every row of a bulk update separately. The upsert fast path takes the slow
path when a model has one, because a single INSERT…ON CONFLICT has no stored row
to read.

**CREATE is unchanged and that is deliberate**: there is no stored row, the
payload IS the row being made, and grading it against that is what
`checkCreatePolicy` already does one layer up.

Through a RELATION both halves refuse by name, on `@guarded`'s reasoning: the
predicate decides rows of the other model, and a filter one hop away has no row
of it to decide against.

`test/field-predicate.test.ts`, 15 cases including the extraction, the negation
and the fail-open write.


## 2026-08-23 — a tenancy-stamped column is readOnly, for `@system`'s reason

2930 tests, 0 fail.

`tenancy { strategy row }` desugars a `@default(auth().<claim>)` and the Data
boundary fills the column from the principal. It was already out of create-mode
`required` — the same branch `@system` uses — and that was not enough, which is
the whole of `FJS-387`.

**The column was still writable, so a blank record seeded it.** `make()` seeds
every writable column, `normalizeBlanks` rewrites a blank to `null`, and a
stated null is a VALUE — so the default never applied and the write came back
`400 workspaceId must be a string`. Sixteen resources in basecamp carried a
client-side hook that filled the column before validation, which made the write
succeed and made the client look like it was choosing its own tenant.

So the column now emits `readOnly` with `x-litestone-kind: 'tenancy'`: `make()`
skips it, a generated form does not offer it, and the server is its only writer.
`@@tenant(none)` carries no generated default and is untouched — there the
column IS a caller-supplied value.


## 2026-08-23 — a Boolean column filtered by text

2937 tests, 0 fail.

`{ live: 'true' }` matched no rows and said nothing. SQLite stores a Boolean as
INTEGER 0/1 and column affinity converts numeric text before comparing — which is
why `{ qty: '5' }` on an Int column has always worked — but `'true'` is the one
spelling affinity cannot convert, so it bound as text and answered an empty list
with a 200.

It surfaced from the wire: a query string carries text, so every screen filtering
on a flag came back empty (`FJS-450`). `@frontierjs/toolbelt/query` fixes the
transports; this fixes the boundary, because an internal call or a hand-built
where can carry the same text and nothing else would have said so.

`buildWhere` converts the two spellings where `fieldKinds` already says the
column is Boolean — so the conversion is keyed on the COLUMN, and a String column
holding `'true'` is untouched. Everything else is still left to affinity.


## 2026-08-23 — the migration history is a thing you can compare against

`FJS-345`, `FJS-388`, `FJS-443`, ruled as `FJS-D123`. 2923 tests, 0 fail.

**The development workflow wrote tables and the deploy workflow applied files,
and nothing joined them.** `db push` writes tables and no file; the container
runs `migrate apply`, which runs files. A model added through push was in the
developer's database and in no image — `no migration files found`, a tick, exit
0, a healthy deploy and `no such table: user` on the first write.

**The root was that one comparison did two jobs.** `create()` diffed the schema
against the LIVE database, which a pushed database already matches, so
`migrate create` answered *already in sync* exactly when a migration was most
needed — and the deploy's refusal pointed at that command. A closed loop.

So there is a **shadow**: the migration files replayed into an in-memory
database. Two questions now have two answers — *schema ↔ shadow* is what
migration is missing, *shadow ↔ live* is whether somebody changed the database
by hand. Prisma's shadow database is the settled shape and is copied rather
than invented; ZenStack v3 is the sharper precedent, having rewritten Prisma's
ORM on Kysely and deliberately not rewritten its migration engine.

**What changed:**

- `migrate create` diffs against the shadow, so the delta a push hid gets
  written. It now needs **no database at all**, which is what lets the same walk
  run before an image is built.
- **The deploy guard is schema-granular.** The table-name check shipped on
  2026-08-22 caught a new model and not a new **column** — measured, `1
  migration applied`, exit 0, over a table missing the column. A column add is
  the common change after week one.
- **`migrate baseline`** records files as applied without running them, for a
  database that is already correct and has no history to say so. It refuses to
  record a lie: what the files build is checked against the database first.
- **`migrate dev`** is create + apply + drift-check, the verb a developer runs
  constantly. With it, `db push` is prototyping only.
- **`migrate check`** answers the deploy's question from the repo alone — no
  database, no container, no network. `fli deploy:doctor` asks it before the
  build, `migrate apply` asks the same function at container start, and `fli
  check` carries the structural half.

**It immediately found `FJS-443`, which nothing could previously see.**
`generateMigrationSQL` emitted `generateIndexDDL(model, false, …)` for a new
table, and that explicit `false` defeated the function's own `softDelete ??
isSoftDelete(model)`. So a generated migration built a `@@softDelete` model with
no `deletedAt` index and no partial clause on the others, a `@@fts` model with
**no FTS table and no triggers**, and a `@updatedAt` column with no stamp
trigger — a deployed app searching a table that does not exist and showing a
timestamp that never moves. `generateModelDDL` is the one owner of *everything
one model emits* and its own comment names the failure. Three CLI smoke tests
had been passing over the broken emit for as long as they have existed.

`test/migration-history.test.ts`, 19 cases, including the closed loop itself,
the column the old guard passed, baseline refusing a lie, and a database built
by replaying the history having the same objects as one built by pushing the
schema.



## 2026-08-23 — a `where` on a value set is a scope with a name

`FJS-430`. A value set could be narrowed two ways and only one of them crossed
to a browser. A `@@scope` is a NAME — `$checkWhere` validates it, junction's
autoFilter passes it, litestone compiles it — so a picker built from a scoped
set offers exactly what the Data boundary will accept. A `where` is raw SQL, a
browser may never send raw SQL (Invariant 8), and there was nothing to cross
with: the picker offered the whole source, somebody chose a row the set
excludes, and the save was refused with nothing before that having said the
option was not real.

So a `where` now mints one. At parse, `valueset LiveTag { … where "…" }` adds
`@@scope(LiveTag, …)` to its source model, holding the SQL rather than an
expression. `buildScopeMap` stores it, `compileScope` hands it back as the
`RawClause` a compiled scope already is, and `$scopes()` publishes it — so it
validates, composes under AND/OR/NOT, conjoins with a declared scope, and an
app may name it like any other. A name the source already declares is refused at
parse rather than shadowed.

**One mechanism where there were two.** `setFilter` lost its `$raw` branch: the
read a picker makes and the read the boundary makes are compiled from the same
declaration instead of agreeing by hand. `x-values` carries `scopes: string[]`
and the `unfiltered` flag is gone, because there is no longer a set a picker has
to over-offer.

The SQL itself still never leaves the server. What crosses is the name.

## 2026-08-23 — a @guarded column can no longer be read out by asking about it

`FJS-393`. 2896 tests, 0 fail.

**The read half of `@guarded` was only a strip.** The value never came back, and
the same caller could still put the column in a `where` — which recovers it one
comparison at a time — or in an `orderBy`, which leaks the ordering of every row
in a single request. Measured: an eleven-character SSN read out in full by a
loop over `startsWith`, against a client that reads the row and sees no `ssn` at
all. `@secret` was covered only by accident, on the unrelated ground that
ciphertext under a random IV can never equal a plaintext — which says nothing
about the guard and did not extend to a sort.

**The refusal lives at the read, not in `filterableKeysFor`.** That function
answers whether a column CAN be compared, which is a fact about the schema and
is why `$checkWhere` may be asked of any flavor of client and answers the same
thing every time. This asks who is asking. So it sits beside the write refusal
it mirrors, where `ctx.isSystem` is known, and `asSystem()` still filters and
sorts freely.

**The measured surface was wider than the report**, and the fix covers all of
it: `where` on a read and on a write (a row count is the same oracle),
`orderBy`, `distinct`, a cursor, `search`, the `db.query` dispatcher — and,
because the filter grammar crosses models, a relation filter, a relation
`orderBy` and a nested `include`, each of which asks about a model the table is
not. So the walk is per model over the relation graph, gated by a precomputed
`reaches` set: a model from which no guarded column is reachable at any depth
skips it on one boolean. It descends only into a relation key or a
logical/relation operator, because a nested object under an ordinary column is a
typed-Json path, where a key sharing a guarded column's name means something
else — asserted, not assumed.

`test/guarded-filter.test.ts`, 28 cases: the extraction loop itself, one per
shape a caller can name a column in, and five negative controls including the
Json-path collision and a model with nothing to guard.

**The same leak through a field-level `@allow('read', …)` is open** and filed as
`FJS-442` — measured at seventeen requests to binary-search a salary. It is not
folded in here because an unconditional attribute and a predicate do not have
the same fix: a predicate over `auth()` is decidable before the query, one over
the row is not, and the complete answer is to compile it into the WHERE the way
`@@allow` already does for rows. That needs a ruling.



## 2026-08-23 — the row a write hands back holds the stamp it wrote

`FJS-396`. 2868 tests, 0 fail.

**SQLite evaluates `RETURNING` before an `AFTER` trigger fires**, and
`@updatedAt` was only a trigger. So `update()` answered the previous timestamp
and a read a moment later answered the new one — same row, no other write.
Anything rendering the result of its own save showed a stale *last updated*,
anything caching the returned row cached a value already wrong, and junction
hands that row to the HTTP response and the `svc updated` broadcast alike, so
every open tab took the stale one too.

**The client names the stamp columns in its own `SET` clause now.** The other
candidate was a re-read on the write path — the shape `hydrateFromFields`
already uses for `@from`, which `RETURNING` also cannot carry — and it costs one
extra `SELECT` on every update of every model that has an `updatedAt`, which is
nearly every model in every app. Naming the column costs nothing and makes
`RETURNING` simply correct. The trigger stays and is the floor beneath it: it
covers raw SQL and a migration, neither of which comes through the client, and
it stands down for a statement that already named the column because `NEW` is no
longer `OLD`. `updatedAtFields` and `NOW_SQL` are exported from `ddl.js` so
which columns and which timestamp expression each have one owner — a second
spelling would sort differently from a row the trigger stamped.

Wired at every path that issues an `UPDATE` and hands back a row: `update`
(both branches), `updateMany`, `upsert`'s fast path, `upsertMany`'s
`DO UPDATE`, the soft-delete `remove`/`removeMany`, and `restore`. Not at the
cascade statements that soft-delete a CHILD table — those return nothing and
stay the trigger's.

**`@@external` answers no stamp columns**, decided inside `updatedAtFields` so
the client and the DDL cannot disagree. Litestone emits no DDL for that table,
so there is no trigger, and a client stamp with nothing behind it is a silent
write into somebody else's table. `@updatedAt` there is declared and inert, as
it always was.

Two consequences worth naming. An `@@log(audit)` `after` snapshot now carries
the timestamp the row actually has. And a post-update policy REVERT restores the
original stamp instead of leaving it moved by a write that was denied — the
revert writes the before-row whole, which no longer matches, so the trigger does
not fire over it.

`test/updated-at.test.ts` grew to 17 cases, one per write verb asserting the
returned row equals a re-read. That is the anti-rot mechanism: a new write path
that forgets to stamp goes red.



## 2026-08-23 — a `File` one join away resolves like one at the top

2846 tests, 0 fail.

`ExternalRefPlugin.onAfterRead(model, rows, …)` resolved the ref fields of the
model the read NAMES. An `include:` brings rows of other models back on that
same result and they were never visited, so the identical column answered a
public URL read directly and its raw stored JSON reached through a relation.
Both are strings and nothing reports the difference; it fails where the value
is finally used, as an `<img src>` pointing at a JSON document.

A relation map is built at `onInit` and the included rows are walked after the
model's own, to any depth, to-one and to-many alike. A `Set` of visited rows
guards a row object reachable through two relations — resolving it twice hands
`resolve()` a URL where it expects a ref, which is not an error, just a value
that vanishes. `select: { x: { resolve: false } }` is honored where it was
written and does not descend, because `include: { photos: true }` has no
spelling for a nested one (`FJS-425`).

Found building `example`'s basket, whose lines join line → variant → product →
images.

## 2026-08-23 — `@updatedAt` is the attribute again, and one trigger per table

`FJS-394`. 2860 tests, 0 fail.

**The trigger was generated for a `DateTime` field literally called
`updatedAt`** and never read the attribute list, so `touched DateTime
@updatedAt` compiled, read as though it worked and stood still — while a field
named `updatedAt` carrying no attribute got the trigger anyway. Decorative
wherever the two agreed, a silent no-op wherever they did not. Nothing shows it:
`@updatedAt` implies a DEFAULT, so every row carries a plausible timestamp that
has simply stopped advancing, and a list ordered by *recently changed* is wrong
with nothing on screen to say so. The attribute decides now; the name stays as a
fallback, because a schema relying on it would otherwise lose its trigger on
upgrade — the same freshness regression in the other direction.

**The fix uncovered a second defect, and it is why this is one trigger per
TABLE.** SQLite blocks a trigger from firing itself but not from firing a
sibling: with a trigger per column, the first one's nested `UPDATE` re-entered
the second, which saw its own column unchanged *by that inner statement* and
overwrote the value the caller had just named — measured, a write setting one
stamp column by hand had it replaced by `now()`. Inside one trigger the
re-entry cannot happen, so each column carries its own guard in the `WHERE`. A
model with one stamp column emits the body it always emitted, byte for byte, so
no existing app migrates a trigger that does the same thing.

`test/updated-at.test.ts`, 9 cases. `FJS-396` — the value a write RETURNS being
the pre-trigger one — is a different defect and stays open; the last case pins
it, so the day it changes is a red test rather than a surprise.



## 2026-08-23 — two things `example` found the moment a value set went into it

`FJS-434` and `FJS-435`. Both were invisible to a unit suite by construction.

**`parseFile` dropped `valuesets` entirely.** The merge that resolves
`import "..."` rebuilds the schema key by key and had no line for them, so a
declared set was lost from an imported file **and from the root one** — that
merge is what every caller of `parseFile` validates. `litestone ddl`,
`jsonschema`, `access` and `release` each refused `example`'s schema with
*no valueset 'ProductColour' in this schema*, about a `valueset ProductColour`
forty lines above the binding. The running app was fine, which is why nothing
caught it: `createClient` parses the text it is handed. One line in the merged
literal, one in the schema literal, the shape `types` and `traits` already had.

**An `open` binding on a NARROWED set reported SQLite's own words.** A value
missing from a scoped set is two different things and only one may be added by
typing it: one nobody has ever used, and one the list has retired. `open`
created a row for both, so the second hit the source's `@unique` and the caller
got `UNIQUE constraint failed: colour.name` — about a table they did not name,
saying the opposite of what happened. The `open` path now asks one unnarrowed
read before creating anything, where the set declares a `scope` or a `where`,
and refuses the ones that exist as `<value> is in <Source> but is not offered by
<Set>`. Nothing is created when it refuses: growing a shared list as a side
effect of a write that never landed is worse than the refusal. Still the
caller's own read, so a row they cannot see falls through to the create; an
unnarrowed set asks no second query.



## 2026-08-22 — a field write policy sees the payload, and the warning about a lone @@deny was false

2851 tests, 0 fail.

Both found by taking the schema rules out on a real app rather than by reading.

**`FJS-433` — a field `@allow('write', …)` is evaluated against the PAYLOAD, not
the row.** `evalJs(expr, ctx, transformed, …)`, where `transformed` is what is
about to be written — so every column of the predicate that the patch does not
name is `undefined`. Measured on a two-line schema, caller 99, row
`{ ownerId: 99 }`, patch `{ title }`: `ownerId == auth().id` **drops the column
for the row's own owner** and `ownerId != auth().id` **permits every caller
including the one it names**. The second is fail-open, and *not your own row* is
how a self-service restriction is naturally written. It reads exactly like
protection: the declaration parses, `access.snapshot.md` records it, and a field
`@allow` drops silently by design, so neither direction raises anything ever.

Found writing basecamp's `FJS-410` fix, which was green in a test asserting no
throw and moved the role anyway. Filed rather than fixed — the three answers
(read the stored row per update, refuse at parse a predicate naming another
column, or document it as payload-only) are a ruling, and refusing at parse is
the only one that cannot fail open. A predicate naming nothing but `auth()` is
unaffected, which is what auth's own fragment uses.

**The `@@deny` with no `@@allow` warning said something untrue.** It read *"all
operations are open by default, @@deny alone won't restrict access unless you add
@@allow rules"* — and a lone `@@deny('update', …)` restricts an update perfectly
well, measured. The old text reads as *this declaration is inert*, which invites
deleting a rule that is working. It now says what is actually open: the deny
restricts the operations it names, every other operation stays unrestricted, and
if that is the intent there is nothing to fix. Two tests: one drives a lone deny
through a real client from both sides (the named caller is refused, another is
not), one asserts the wording.

## 2026-08-22 — `createTestEnv` made a directory per test and removed none

**28,546 of them, 3.8GB**, on the machine that finally counted — and in every
app that uses the helper, not just here. `makeTestClient` built its database
under `os.tmpdir()` and nothing ever came back for it.

There is no moment at which a harness can delete what it made. Not in an
`afterAll`: `@@log(audit)` flushes through the jsonl driver after the awaited
call returns, so tearing the directory down there races it into
`SQLITE_READONLY_DBMOVED`. Not at exit: `process.on('exit')` does not fire under
`bun test` — probed with a one-test file whose handler printed nothing and whose
directory survived.

So a run reaps the PREVIOUS runs' on the way in. That is the one moment the
owning process is provably gone, however it exited, including the SIGKILL no
handler can see; the hour's age floor is what keeps a concurrent run of the same
suite safe. `src/tmp-dirs.js` is the one owner and
`@frontierjs/litestone/testing` exports both halves — `tempDir(prefix)`, which
cannot be used without reaping, and `reapTempDirs(prefixes)` for a harness that
names its own directory. Junction, auth and notifications read it from here;
auth's own copy, written when the class was first found, is gone. It cannot live
in `@frontierjs/toolbelt` — a filesystem sweep, and that package does no I/O by
ruling (`FJS-D26`).

This suite's own scattered directories now go under ONE root, which is the half
that stays fixed: one prefix to sweep, so a test added later cannot leak a name
nobody listed. Thirteen prefixes measured flat across a full 2,839-test rerun.
The two studio drives also killed their studio server and left Chrome running —
it does not notice its launcher has gone, and four were found alive. `FJS-361`.

## 2026-08-22 — a value set is a release contract, and `release:check` could not see one

15 in `test/release.test.ts`, 14 of which fail against the previous
`release.js`. Nothing was wrong with `@values` — it was invisible to the one
tool that grades a deploy.

`buildFieldSurface` carried `unique`, `default`, `writeRequired`, `protection`
and `allows`, so a column gaining `@values(TaskTag)` moved nothing the pivot
classifier could read. It is a **contract**: the starting release refuses values
N-1 has been writing all along, with no column, no type and no constraint
changing. That is exactly the class `release:check` exists to catch — a change
whose incompatibility is declared and nowhere near the DDL.

**The three strengths are not a ladder.** Only `required` refuses. `open`
accepts a value outside the set and adds it, `suggested` enforces nothing, so
`suggested` → `open` starts creating rows and still fails nothing N-1 does. Only
a move INTO `required` is the pivot.

**The set is carried separately from the binding**, because a set is declared
once and bound from many columns: adding a `scope` to it narrows every one of
them at once, and that is unreadable from any single field's row. It is graded
against the bindings in the release STARTING — narrowing a set nothing binds as
`required` changes what a picker offers and refuses nothing, which is an
affordance and an expand. Changing which column a record stores is a contract
whatever the strength, since the stored form itself moved.

**Not on the access axis.** `classifyAccess` grades who may do what; a value set
narrows by value, identically for every caller. Showing a reviewer a permission
change that did not happen is the failure mode that axis exists to avoid.

`value` is recorded RESOLVED — unstated means the source's own `@id` — so a
baseline that omitted it and a schema that spells it out are not a change.



## 2026-08-22 — a generated default on a column that is not the id

2822 tests, 0 fail. 10 in `test/generated-defaults.test.ts`. Closes `FJS-423`.

`@default(cuid())` on an ordinary column parsed, emitted a plausible table, and
then failed `NOT NULL constraint failed: cart.token` at the first `create()`.
So did `ulid()` and `nanoid()`. Only `uuid()` worked, and it worked for a reason
that had nothing to do with the client: it is the one kind `ddl.js` can express
as a SQL DEFAULT, so SQLite fills it. The other three carry the comment *client
generates at insert time*, and the client generated them for the **`@id` field
alone** — `buildAutoIdMap` skipped any field without `@id`.

`buildGeneratedDefaultMap` is the sibling map, applied on the four write paths
that massage a payload themselves: `create`, `createMany`, the `upsert` fast
path and `upsertMany`. The slow `upsert` delegates to `create` and needs
nothing. `uuid()` is deliberately absent from it — one owner per value, and
SQLite already has it.

**Key presence decides, not `== null`.** A stated null on a nullable column
stays null, because that is what a SQL DEFAULT does, so a nullable
`@default(cuid())` and a nullable `@default(uuid())` now answer alike whether
the key is absent or explicitly null. The id path keeps `== null`: an id is
never legitimately null.

**The generators moved to `core/ids.js`**, because the jsonl driver fills the
same defaults and cannot import the client. It knew `now()` and `uuid()` only,
so the three were silently null in a jsonl table as well.

Two smaller things the same walk turned up. `TYPE_DEFAULT_FORBIDDEN_KINDS` did
not name `nanoid`, so a `type T` could declare a runtime default that enforces
nothing. And `generateCuid` built base64url from 16 bytes and then stripped
everything outside `[a-z0-9]`, answering 11–13 characters where its own comment
promised 24 — roughly 57 bits on a value an app mints bearer tokens from. It is
`'c'` plus 24 base36 characters now, drawn with rejection sampling, since a
plain modulo over 256 would make the first four letters likelier than the rest.

`example` declares `token String @unique @guarded @default(cuid())` on `Cart`,
which is what the issue was found reaching for.


## 2026-08-22 — value sets: a name for a scoped list, enforced at the Data boundary

2776 tests, 0 fail. 24 in `test/valuesets.test.ts`.

`FJS-D120` ruled the shape; this is the Litestone half of `FJS-412`.

```
valueset TaskTag  { source Tag  value label }
valueset Assignee { source Team value name  scope active }

model Task {
  tag  String? @values(TaskTag)             // required, the default
  grow String? @values(TaskTag, open)       // a new value joins the set
  free String? @values(TaskTag, suggested)  // offered, enforced nowhere
}
```

**The check runs through the caller's own accessor**, and that is the whole of
the permission story rather than an optimization. `ctx.tables[accessor]` is the
sibling model at this client's flavor, so the set a caller sees is the set
their own `@@allow` shows them — user 1 cannot pick user 2's tag, and the
refusal reads *theirs is not in TaskTag*, which is the true statement from where
they stand. `open` creates through that same accessor, so the source model's
`@@gate` and `@@allow` answer who may extend the list. No permission concept, no
hook tier, no option. Written against `asSystem()` it would have offered every
row to everybody, and it would have passed every test that uses one principal.

**`suggested` issues no query at all.** Enforcing nothing has to cost nothing,
or nobody uses the strength that keeps the list traveling — and a check that
queried and then ignored the answer would pass every other test in the file, so
the assertion is that a `suggested` binding still works when its source is
`@@gate("8")` and unreadable.

**Six write paths carry a payload and all six call it.** The grid derives that
list from `client.js` itself rather than restating it: a seventh added later
would be silent, which is the failure the check exists to prevent one layer
down. `remove`, `delete` and `restore` take no payload and are correctly absent.

A failure to grow an `open` set is wrapped — `ValueSetExtendError` carries the
source error's own `status` and `retryable`, because nothing about arriving
through a value set changes what went wrong. A bare `ownerId is required` off a
`Task` write names a column on a model the caller never mentioned and reads as a
bug in the app.

One judgment call the ruling did not cover: **`value <field>` names the column a
record stores**, defaulting to the source's `@id`. `open` then requires it not
to be the id — a row cannot be created by naming its primary key — and requires
the source to carry `@@label`, which is the column that receives the typed text.

Not built: the client half. `x-values` is emitted and nothing reads it, so a
generated form does not yet offer a picker for a bound column.

## 2026-08-22 — the language is an index you can walk, and it writes back

2813 tests, 0 fail. 174 in `test/catalog.test.ts`, 96 in `test/reference.test.ts`,
40 in `test/advise.test.ts`, 32 in `test/opportunities.test.ts`, 11 in
`test/explain.test.ts`, 51 browser assertions in `test/verify-studio-explore.mjs`.

**The declarable surface was 86 words the morning this landed and nothing listed
them.** Nine top-level declarations, 55 field attributes, 22 model attributes,
counted off the parser's own dispatch — and 87 by the afternoon, because `@@label`
landed while this was being written and the completeness test went red naming it.
That is the number moving under a hand-written count, which is why
`catalog.snapshot.md` now carries it instead. Every artefact this repo commits answers *what did you declare*, so
a word absent from the seed is absent from all of them, and nobody has ever got
an error for never having heard of `@@fts`, `@derived`, `trait` or `@sequence`.

`src/core/catalog.js` is the inventory: one row per word as TYPED, with its
argument form, a blurb, a worked example and the context that example needs.
`src/core/advise.js` is the two things a per-word table cannot say — the
visibility truth table that separates `@computed`, `@transient`, `@system`,
`@guarded` and `@encrypted`, and five rules for schemas that are legal and wrong.
Studio's Explore panel is one reader; `GET /api/catalog`, `GET /api/advise` and
`POST /api/preview` are the seam, and the panel's *Preview* shows what an edit
does to the DDL, the access surface, the JSON Schema and the deploy verdict
before anything is written.

**What makes the inventory worth trusting is the assertion, not the table.**
`test/catalog.test.ts` holds it against the parser in both directions: every
row's example is parsed AND run through `deriveAccess`, and the `case` arms of
`parseFieldAttribute`/`parseModelAttribute` plus the nine words `parseSchema`
throws about must each have a row. A new attribute ships documented or the suite
is red — which it went, mid-session, when `@@label` landed.

**Which switch parses a word is not the same question as where it is legal.**
There are six positions and only two are a switch — a model's field, a type's
field, a trait's field, an enum member, a model, a trait — and the parser reaches
the other four by calling `parseFieldAttribute`/`parseModelAttribute` and
refusing afterwards, so the arms a source scan reads are the HOME arms and the
rest are structurally invisible to it. Found by review rather than by the suite,
which is the point: a completeness test built on reading source is blind wherever
the parser reuses a routine and filters after.

`POSITION_RULES` states them once, in the shape the parser already states them —
four named Sets, now exported so the test binds to them rather than guessing from
examples. That binding matters: a first pass measured by probing canned examples
reported traits refusing seven field attributes when the answer is one, because
six of the refusals were the example's missing context rather than the position.
The one position that is a throw rather than a Set — an enum member, where
exactly `@label` is legal — is checked by driving the parser over all 55 field
attributes.

**The catalog has a second reader, which is the whole argument for it being a
module.** `litestone explain @guarded` answers in a terminal with no server, no
schema and no database — the same rows Studio renders, looked up by what you
TYPE, because the prefix picks the level and `@unique` constrains a column while
`@@unique` constrains a tuple. A bare word that exists at both answers with both
and says the prefix decides; a near miss suggests; `--json` answers a machine.
`--visibility` is the interview as a table, which puts all five of @computed,
@transient, @system, @guarded and @encrypted on one screen — and every field
attribute that is one of those five points at it, because knowing which four you
did not pick is most of understanding the one you did. 11 tests, spawned as real
subprocesses: the failure this guards is a command that throws before printing
anything, which an in-process call to the renderer would never see.

**The editor was the fourth reader and it had its own list, which was wrong.**
`frontierjs-vscode`'s language server wrote out 50 field attributes against the
catalog's 55 and 15 model attributes against 22, and never offered `tenancy`,
`view`, `trait` or `type` at all — 29 words completion silently hid, including
`@system`, `@transient`, `@version`, `@@tenant` and `@@transitions`. Hovering any
of them produced nothing, which in an editor reads exactly like a word that does
not exist. It now bundles `core/catalog.js` beside the parser through the same
resolver and derives both from it, with `ATTR_DOCS` still winning on hover where
it has an entry. **No `exports` entry was needed** — the extension bundles
litestone at build time rather than depending on it, so the published surface is
untouched. `test/lsp.test.js` asserts the offered set against the bundle.

**The surface is committed.** `litestone catalog --snapshot` writes
`catalog.snapshot.md`, byte-compared by the `snapshots` CI phase — the twentieth
snapshot in the repo (the reference page is the twenty-first) and the first with
no `--schema`, because the language is a
property of this package rather than of an app's seed. The suite proves the table
is complete; the snapshot answers *what changed*, which no suite can: an arity
that gains an argument or an attribute that stops being legal inside a type keeps
every test green, since table and parser move together in one commit.

**The fifth reader is a page, and the measurement is what argues for it.** The
other four answer one word at a time and all four need you to already know the
word — Studio's panel, `litestone explain`, the editor, and the snapshot a
reviewer diffs. `litestone catalog --reference` writes
`docs/reference.snapshot.md`: every word with its blurb, a worked example, what
its arguments accept, where it is legal and cross-links, grouped by the question
you arrive holding. **Forty of the words had no entry anywhere else in `docs/`** —
no heading, no table row, no bullet — so `@trim`, `@@strict`, `@@index`,
`@@transitions` and `@map` appeared inside samples or not at all. They were
undocumented in the only sense that matters, which is that you could not look
them up. The page is not `docs/schema.md`, which stays a hand-written narrative
tour; it is the A–Z beside it, and it is generated because a hand-written A–Z
would drift exactly the way the editor's word list did.

Every example on it is `probeFor(row)`, which moved from the test into
`core/catalog.js` so both readers use one assembler — a renderer with its own
would publish a snippet the suite has never parsed. `test/reference.test.ts`
covers the class a byte comparison cannot: an entry missing (a renderer that
skipped a group round-trips its own output forever), a link into an anchor that
is not there, and prose losing a word. That last one is real — three blurbs say
`<Form>`, `<claim>` and `<Model>`, which markdown reads as unknown HTML tags and
renders as **nothing**, so the sentence still looks like a sentence with a noun
missing. Anchors are written explicitly rather than left to the renderer's slug,
because `type` and `@type` are different words that reduce to one. All four
assertions were mutation-tested by breaking the renderer.

**The question every artefact here was built unable to ask.** `db/access.snapshot.md`
is the access surface you HAVE, `ddl.snapshot.sql` the DDL you emit,
`surface.snapshot.md` the API you answer — all derived from the seed, so a word
absent from the seed is absent from every one of them. Nobody has ever got an
error for never having heard of `@@fts`, `trait` or `@@transitions`; they write
the application without them, at a cost nothing measures.

`src/core/opportunities.js` is nine checks for *legal and missing*, the sibling
of advise's *legal and wrong*, and the difference decides the vocabulary: a rule
carries a **severity** because it is a defect, a suggestion carries a
**confidence** because the schema is not wrong and the author may have meant it.
**Every finding names the WORD it is about, as TYPED** — which is what makes this
a route rather than a lint. In Studio the word is a button that opens its card;
in `litestone advise` each row ends in `litestone explain @@fts` and the docs
page beside it. `wordFor` resolves through `lookup`, so `@type` lands on the
attribute and `type` on the declaration rather than on whichever came first.

**Four false positives, each found by pointing it at a real schema, and each one
taught the check something true:**

- **`@guarded` is not at-rest protection.** All five of basecamp's credential
  columns are `@guarded(all)`, and the first cut said *nothing protects it*.
  `@guarded` decides who may ASK; the value is still plaintext in a file that
  gets backed up. A guarded column grades DOWN now rather than clearing.
- **A value with no column cannot be at rest.** `NotificationChannel.secret` is
  `@transient` — validated and lifted off the payload, stored nowhere — and was
  reported as a plaintext credential.
- **Nothing in a schema distinguishes a catalogue from a possession.** *A gate
  with no `@@allow`* fired on all five of `example`'s models, and every caller
  reading every `Product` is what a catalogue IS. It raises to `likely` only
  where litestone can SEE the rows belong to someone — a relation to the `@@auth`
  model, or the tenant column — and asks everywhere else. Same shape as
  `gate-over-own-standing`.
- **A `@@trait` use is ERASED at parse**, so a model that already uses one is
  indistinguishable from one that wrote the columns out. What survives is the
  DECLARATION, so the repeated-columns check compares against `schema.traits`.

On the two real apps: `example` gets 8, all `possible`. `basecamp` gets 45, two
of them `likely` — `WorkspaceMember` (the durable half of `FJS-410`: the gate is
one door and a policy is every door) and `AuditEvent`, gated `5.8.9.9` with no
row policy while carrying a nullable `workspaceId` — filed as `FJS-432`, with
what is NOT true stated in it, since the one service that serves that table
scopes the read in its own `where`.

**`litestone advise` is the terminal reader neither list had.** Rules lived only
in Studio; opportunities now have the same two doors plus `fli db:advise`. It
reads through `loadSchema`, never `parse` — a schema may `import`, and three
readers have had that wrong.

**Eleven rules, and calibration cut one of them down before it shipped.** Six
new: `fts-over-a-column-search-cannot-read` (an `@@fts` over `@encrypted` or
`@hashed` indexes a ciphertext or a digest, so the search runs and returns
nothing — `error`; over `@guarded` it matches and is then stripped, and
`snippet()` renders the text it stripped — `warn`),
`foreign-key-without-index`, `transition-to-a-state-nothing-reaches`,
`label-column-that-may-be-null`, `unique-on-an-optional-column` and
`index-another-index-already-covers`. All six parse clean — measured, not
assumed — and each is mutation-tested by breaking the rule.

**The redundant-index rule was wrong on its first real schema and the reason is
worth keeping.** It fired twelve times on basecamp and nine of those were on
`@@softDelete` models, where `createIndexes` appends `WHERE deletedAt IS NULL` to
every `@@index` and to no UNIQUE — so `@@index([workspaceId])` beside
`@@unique([workspaceId, slug])` is a smaller PARTIAL index over exactly the rows
an ordinary read wants, not a duplicate. Left alone it would have told basecamp
to delete nine of the better indexes. Soft-delete models are exempt now, twelve
findings became two, and the exemption is pinned.

`foreign-key-without-index` found ten in basecamp, filed as `FJS-413`. SQLite
indexes a PRIMARY KEY and a UNIQUE and nothing else, and litestone emits
`CREATE INDEX` only for an `@@index`, so the pattern is a composite leading with
the other side: `WorkspaceMember` declares `@@unique([workspaceId, userId])` and
gets one index, leaving *which workspaces is this person in* with nothing to use.
Four are on `ON DELETE CASCADE` join tables, where SQLite scans the child table
once per deleted parent row.

**The contract held on its first outside test.** `valueset` and `@values`
(`FJS-412`) landed in the parser from another branch and the completeness test
went red naming both — a top-level word the catalog did not know, and a
`case` arm in `parseFieldAttribute` with no row. `POSITION_RULES` went red
separately, because that feature forbids `@values` inside a `type` and the rule
block is bound to the parser's own Set. Rows added, and the hardcoded `9` in the
top-level assertion relaxed to a floor: a literal count is a number someone has
to hand-edit to add a word, which is the maintenance shape this whole exercise
exists to remove.

**`arity` is prose, and nothing checks prose.** A `values` entry states an
argument's closed set as data with a probe beside it, and the check drives the
parser twice: every declared value must parse, and an invented one must be
refused — the second half is what catches a set that has grown rather than
shrunk. `ALLOWED_TOKENIZERS`, `ON_DELETE_ACTIONS` and `DATABASE_DRIVERS` were
literals inside the arms that checked them and are now module-level exports.

Four defects found by building it:

- **`parse()` is more permissive than the layers above it.** The catalog shipped
  `@@gate("4.2.4.5")`, which parses and which `deriveAccess` refuses: the order
  is read.create.update.delete and the levels must be non-decreasing. The
  completeness test now runs the access layer over every example.
- **Per-model DDL had no owner.** Callers assembled `generateTableDDL` +
  `generateIndexDDL` by hand and silently missed the FTS virtual table and the
  `updatedAt` trigger, so adding `@@fts` showed as no change at all.
  `generateModelDDL` is the one owner and `generateDDL` calls it.
- **`@guarded` and `@encrypted` are not exclusive.** Nothing refuses the pair and
  `@secret` expands into exactly it; the root `CLAUDE.md` said otherwise. Now an
  `info` rule saying *that pair is `@secret` spelled out*.
- **A rule set is noise until it meets a real schema.** `gate-over-own-standing`
  fired five errors on basecamp — two real, one plainly wrong (`Server.role` is a
  fleet role), two arguable. It now raises to `error` only where litestone can
  SEE the model is the standing (`@@auth`, or the model carrying the tenancy
  claim that declares `@@tenant(none)`) and phrases a question everywhere else.
  The one it kept is `FJS-410`: a basecamp workspace admin can promote themselves
  to owner.

## 2026-08-22 — `@@label(field)`: which column identifies a row to a person

2551 tests, 0 fail. 21 in `test/model-label.test.ts`.

A foreign key holds an id and nobody recognises an id, so something has to
choose the human column. Until now nothing in `.lite` could say it, and the
only mechanism was a scan of eight hardcoded column names in the consumer.
FHIR calls this `display`; here it is `@@label(fullName)`, and it reaches the
client as `x-label-field` on the model def, on every mode.

**The substance is the refusals.** A picker sorts by this column and searches it
with `contains`, so a value the database cannot order and match is not a display
column however readable it looks on screen — and a schema that accepts one
produces a list of `1, 2, 3` with nothing saying why. A relation, an array, an
enum, a non-String, `@computed`, `@transient`, `@guarded`, `@encrypted`,
`@hashed` and `@omit(all)` are each refused at parse, by name, with what is
wrong with them. The non-String refusal names the route out rather than only
saying no: a number IS sometimes what a person recognises, so it points at
`@generated(\`{num}\`)`. A quoted argument points at `@label("…")` — a caption
for one field, which is the near-miss.

`@omit` is allowed: it is lists-only, and a picker is not a list of rows.

The column it names is routinely absent from `create` and `update` mode, and
that is correct — a `@generated` full name is `full`-mode only, and the consumer
reads it off a fetched row.

## 2026-08-22 — a `@generated` column is visible to the migration diff

2509 tests, 0 fail. 10 in `test/generated-rebuild.test.ts`.

**Two defects with one root: nothing in the migration path knew that a generated
column is not a stored one.**

`FJS-406` — a table rebuild listed it in the `INSERT … SELECT`, which SQLite
refuses (`cannot INSERT into generated column`), so the whole migration rolled
back. Not only when one is being added: the copy list came from every stored
field, so a table that has carried a generated column for a year hit it the
moment anything else forced a rebuild. Excluded by KIND now, because the failure
is a property of the column and not of one diff. Nothing is lost by not copying
— the rebuilt table computes it from the columns that were.

`FJS-407` — `introspect()` read `PRAGMA table_info`, which OMITS generated
columns, so both sides of the diff were blind: the schema declared a column, the
database never got one, and the generator emitted an empty migration.
`table_xinfo` lists them (`hidden` 2 = VIRTUAL, 3 = STORED), and the expression
lives only in the table's own `CREATE` statement, so it is parsed off
`sqlite_master`. **The pragma is the authority on whether a column is generated
and the parse only supplies the expression** — which is what makes a miss in the
parse harmless, since only columns the pragma flagged are ever looked up, and an
expression it could not read compares as *cannot judge* rather than as *changed*.

The two storages part company at the ALTER: SQLite refuses `ADD COLUMN` for a
STORED one on a populated table, so that add takes the rebuild path, while a
VIRTUAL one is an ordinary `ADD COLUMN` **carrying its `GENERATED ALWAYS AS`
clause** — emitting the bare column would apply cleanly and leave a plain,
writable column of the same name. A storage change and an expression change are
both `modified`, hence a rebuild, since no ALTER reaches either.

`litestone introspect` was fixed in the same pass. Those columns were absent from
its output before and would now have been emitted bare, which says a generated
column is writable; it emits `@generated("…", stored)`, converting `"col"` back
to `{col}` — the inverse of the parser's own expansion.

## 2026-08-22 — a `type` field carries its label and its messages

2404 tests, 0 fail.

**The identical declaration emitted two different schemas depending on where it
sat.** A model column with `@label("Tracking")` and
`@length(4, 40, "A tracking code is 4 to 40 characters")` emitted `title` and
`x-messages`; the same two attributes on a field inside `type T { … }` emitted
neither. The parser kept both — the loss was at emit, where the type loop called
`fieldToJsonSchema` for structure and the presentation block lived further down,
inside `modelToJsonSchema`, reachable only from the model path. The comment on
that loop already claimed the two were identical.

Every realm then wrote its default sentence over the author's, wherever a type is
what describes the value: a nested `Json @type(Address)`, and — newly — a
junction custom method whose declared input is a type, which has no model behind
it and therefore no second chance to pick the wording up.

`applyPresentation(fieldSchema, field)` is that block, extracted, with two
callers. `test/messages.test.ts` asserts the two schemas are `toEqual`, so a
third emission path cannot quietly acquire only half of them.

## 2026-08-22 — `@generated` takes a template, in backticks

2403 tests, 0 fail. 17 new in `test/generated-template.test.ts`.

**One attribute, two languages, and the quote says which.** Double quotes are
SQL, as they have always been; backticks are a template — the string the column
produces:

```
fullName String? @generated(`{firstName} {middle} {lastName}`)
total    Float?  @generated("{qty} * {price}")
```

`{field}` means this row's column in both, so the delimiter changes only what
the text *around* the braces is. A backtick is its own token, so one anywhere
that wants a plain string is refused rather than quietly accepted.

**The reason is the null rule, not the length.** Spelled as SQL, a joined name
is `trim(coalesce({first},'') || ' ' || coalesce({middle},'') || ' ' ||
coalesce({last},''))`, and that is not merely long — it is wrong. A person with
no middle name reads `Ada  Lovelace`, two spaces, a plausible string with
nothing to say it happened. Measured against a real client.

Uniform gaps with nothing outside the fields compile to `concat_ws`, which drops
a NULL argument together with the separator that would have followed it —
exactly what the template means, in one call. Mixed or outer literals have no
single separator, so each field carries the text in front of it and the pair
vanishes together: `coalesce('-' || "year", '')` is empty when `year` is NULL,
taking the dash with it.

The template compiles at parse, so nothing below it learned a field kind: it is
a `GENERATED ALWAYS AS` column, `VIRTUAL` by default and `` `…`, stored `` to
materialise, and the DDL emitter, the write refusal, the unknown-field and cycle
checks, filtering, sorting and the JSON Schema are all untouched. A refused
write says which language the field was in — *from its template* against *from
its expression*.

Written after `docs/modeling.md` grew a field-kind matrix and the entry for
this case was three lines of SQL that were also subtly wrong.

## 2026-08-22 — `migrate apply` refuses when the schema is not in the database

2386 tests, 0 fail.

`migrate apply` applies migration FILES. With none — the state every app is in that
develops through `db push`, which writes tables and no file — it applied nothing, printed
**`✓ no migration files found`**, and exited **0**. A container whose entrypoint is
`bun run db:migrate && bun run start` therefore started a server over a database holding
litestone's own bookkeeping table and nothing else: health answered, the deploy was
declared good, and the first write said `no such table: user`. That was the CI `deploy`
phase red on both sources (`FJS-388`).

**The tick was the defect** — it reported success for the one condition that guarantees the
app cannot work.

So the question asked after a run is no longer *did anything apply* but **is the schema
actually there**, which is the only one whose answer is worth an exit code. `missingTables`
reads the DDL emitter's own two filters rather than restating them — a model belongs to the
database its `@@db` names or to `main`, and `@@external` is somebody else's table — and the
refusal names every missing table, then names the way out (`migrate create <label>`, or
`db push` for development).

**It covers what a zero-files check could not**: a half-applied history, and a migrations
directory pointing somewhere else. **And it does not fire on the development path** — after
`db push` the tables exist, so `apply` still exits 0; the refusal arrives in the container,
where the database is fresh, which is where the failure actually was.

`db push` deliberately still writes no migration file. Keeping the two workflows in step is
the developer's to do, and now there is a loud failure when it has not been done.

## 2026-08-22 — three defects found by an app adopting declared tenancy

2380 tests, 0 fail. Typecheck at baseline.

`tenancy { strategy row }` had shipped and nothing had migrated ONTO it. Basecamp
moving sixteen hand-written `@@allow('all', workspaceId == auth().workspaceId)`
lines onto the declaration is what found all three, and the shape of that is
worth keeping: each one was invisible to the checks because the checks and the
defect shared an assumption.

**A caller could move their own row out of their tenant** (`FJS-378`). The
generated denies named `read`, `update`, `delete`, `create` — *may you touch this
row* — and never `post-update`, *may the row end up there*. So
`update({ where: { id: mine }, data: { workspaceId: theirs } })` succeeded with a
WHERE that matched legitimately at the moment it ran. The hand-written form never
had the hole: `all` expands to every operation, `post-update` included, so an
allow was graded against the resulting row for free. Both generated rules carry
it now, delegated included.

**A delegated child whose parent is OPTIONAL was invisible to every scoped read**
(`FJS-382`). Two implementations of `check(parent)` disagreed about a null foreign
key — `evalCheck` answers true, `compileSql` emitted a bare `EXISTS`, which is
false. A row with no parent yet was filtered out of every read with a 200 and
nothing said, and `verifyRowPolicies` could not see it because it skips `check()`
policies by name. Fixed in the SQL half, since the evaluator is the one that
matches what the declaration says.

**`verifyFieldProtection` reported every field on a scoped model as unchecked**
(`FJS-381`). It seeds a row to satisfy the model's *allow* rules; tenancy
generates a *deny*, so the seed matched nothing and every protected column came
back unchecked — a green run over an assertion that never executed. The seeder
stamps the tenancy claim now, skipping `@@tenant(none)`.

`FJS-380` is the fourth thing that migration found and it is still open:
`litestone access --from` grades the allow→deny inversion as WIDENS, so
`--strict` would fail the safest refactor in the feature.

## 2026-08-19 — a generated case has to isolate the rule it names (`FJS-351`)

2373 tests, 0 fail. Typecheck clean.

`generateValidationCases` built every case from ONE attribute with no idea what
else sat on the field, and both halves of that were wrong the moment a column
carried two rules.

**A boundary claimed a value the field refused.** `@length(3, 200)` produced
`'xxx'` and `'x'.repeat(200)`, and on an `@email` column neither is an email —
so the write was refused and the runner reported *@length allows this value and
the write was refused*: a correct schema graded as broken. Measured on a
six-field schema, **8 of 12 boundary cases were false, and 4 of 6 fields were
reported broken when nothing was.** The fix a reader reaches for is deleting a
rule from the schema, which is exactly what happened to basecamp's
`Invitation.email` before this landed.

**An invalid case was refused by somebody else's rule and counted as proof of
its own.** `''` on that column is rejected by `@email`, so the two cases naming
`@length` proved nothing about it. Measured by disabling `@length` in
`validate.js` and asking what the runner noticed: on a single-rule field it says
*the schema declares @length(3,20) and the write was ACCEPTED*; on the `@email`
field it said **nothing at all**, and the only entries against that field were
the two false alarms, which appear whether the rule is enforced or not. So the
checker could not tell an enforced `@length` from a missing one there — and the
false alarm is what hid it, because a schema that always reports something looks
like a schema being checked. The same measurement now yields four findings, all
naming `@length`, and zero on the schema with nothing wrong with it.

`attempt()` carried the message every case already declared and never compared
it; it does now, and a refusal by the wrong rule is `rejected-by-another-rule`
rather than a pass. It is the backstop rather than the cure — once a case is
built to isolate its own rule this should never fire, and what it catches is an
implementation refusing for a reason the schema did not predict.

**The judge is `validateField`**, newly exported from `core/validate.js` — the
function that decides this on a real write, and it is asked about the field's
OTHER rules only. Whether a value satisfies or breaks the rule the case NAMES is
established by construction, because asking the implementation about it makes
the runner its own oracle: the first version did, and disabling `@length` then
reported *not checked* rather than *the write was ACCEPTED* — the runner losing
the one finding it exists to produce. A table of formats in the generator
would be a second definition of every rule, drifting the moment one is tuned.

**The repair is format-blind.** It grows or trims the factory's own valid
sample and asks the validators whether each candidate passes, so an
`@email @length(_, 200)` boundary comes out as a long local part in front of the
sample's own domain, a `@url` keeps its scheme, and `@startsWith("ORD-")` keeps
its prefix — without this code containing the words *email*, *URL* or *prefix*.
Shrinking works on the sample's alphanumeric RUNS and leaves its punctuation
alone, which is how `email1@example.com` becomes `e@e.c` at five characters.
Which dimension is free depends on the rule: a boundary IS its length, an
invalid `@length` case only has to sit outside the bound, and every other rule's
length is incidental — `@url`'s `'not-a-url'` is nine characters and was refused
by a sibling `@length(10, 60)` until it could be padded.

**`litestone mutate` excludes both new outcomes from the kill count.** An
`uncheckable` row is generated from the ORIGINAL schema, so it appears
identically under every mutant — the same shape as the 22 `error` rows that once
scored a 14-mutant schema 93% with four mutations unnoticed. That lesson was
already written in `mutate.js`; the new outcomes just had to join it.

**What cannot be isolated is reported, never dropped.** `uncheckable` names the
rule, the blocking rules' own messages, and says the case was NOT checked —
because a rule that quietly stops being asked about is this runner's failure
mode one layer up. A lower bound at a format's own floor is the honest example:
the shortest string `@email` accepts is `a@b.c`, so `@length(5, …)` there can
never be violated by anything still an email, and `@length(6, …)` can.

## 2026-08-19 — `$protectedFields`, so an app's own trail can redact (`FJS-154`)

2368 tests, 0 fail. Typecheck clean.

**`db.$protectedFields('secret')` → `{ data: 'encrypted' }`.** The third sibling
of `$checkWhere` / `$checkOrderBy` and the same contract in every respect: an
unknown accessor answers `{}`, and every flavor of client — root, `$setAuth`,
`asSystem`, `$scopedBy` — answers identically, because what a schema DECLARES
protected is not a question about who is asking.

It exists because an application keeps a trail of its own. `@@log(audit)`
redacts `@encrypted` / `@guarded` / `@secret` in its own JSONL and that is
stated as a repo invariant — but basecamp writes "who did what" into an
`AuditEvent` table the UI reads, and the only thing it could do about protected
columns was hold a hand-written list of names that goes stale the first time
somebody adds a `@secret`. One reading of the schema, in the package that owns
the schema.

The value says WHICH protection rather than `true`, because the three are not
interchangeable: `guarded` locks both directions, `encrypted` hides a value from
a non-system reader and stays writable, and `hashed` has no plaintext at all.

## 2026-08-18 — `VersionConflictError` says which two revisions disagreed (`FJS-341`)

2367 tests, 0 fail. Typecheck clean.

The class already carried `expected` and `actual`; nothing downstream could read
them. Junction's error boundary copies `errors` and `retryable` and nothing
else, so the losing editor was told a retryable 409 had happened and never what
moved — which is the difference between *reload and try again* and a screen that
can offer *keep mine* against *take theirs*.

`data = { model, field, expected, actual }`, which is the field junction's
boundary now carries. One line, and the reason it is `data` rather than a new
name is that `FrameworkError.data` already means exactly this.

## 2026-08-17 — atomic update operators, and a rebuild that refuses (`FJS-D27`, `FJS-183`)

2367 tests, 0 fail. Typecheck clean.

**`{ views: { increment: 1 } }` is a write now** — `increment`, `decrement`,
`multiply`, `divide` on a numeric column and `push` on an array one, on `update`
and `updateMany`. Read-modify-write loses one of two concurrent increments and
`@version` only turns that into a conflict the caller has to retry; `UPDATE t SET
views = views + ?` needs no read and cannot race.

The objection was that the payload is otherwise VALUES, so `{ views: {
increment: 1 } }` and `{ addr: { city: 'x' } }` are one shape to a parser. **The
column decides**, as it already does on the where-side between a typed-Json path
and an operator block: a `Json @type(T)` column keeps taking an object, and
everything an operator cannot legally apply to is refused by name — wrong column
type, an operator on a create or an upsert, `divide: 0` (SQLite answers NULL and
raises nothing), two operators on one column, an enum array pushed a non-member,
and a column carrying a bound the operator would escape, since the new value is
computed inside SQLite where `validate()` never sees it.

`push` appends through `json_insert(coalesce(col, '[]'), '$[#]', ?)`. The
coalesce is the load-bearing half: `json_insert(NULL, …)` answers NULL silently,
so a push into a NULL column would drop the value and report success.

**A rebuild that would destroy an app-created trigger or index is BLOCKED.** It
used to name them in a comment above the SQL that destroyed them, which is the
wrong answer for somebody applying a generated migration without reading it —
who is who a generated file is for. The rebuild is commented out with three ways
forward, the same shape an un-defaultable new column already used, and
`autoMigrate` reports `state: 'blocked'` and writes no hash, so it resurfaces
every startup. Re-emitting a captured trigger stays rejected: its body may name a
column the rebuild drops.

## 2026-08-17 — a model is scoped through its parent (`FJS-282`, `FJS-333`)

2349 tests, 0 fail. Typecheck clean.

**`check()` is a real lookup outside a WHERE.** It answered `true`
conservatively in the JS evaluator, so `@@deny('all', !check(parent))` held for
read, update and delete and permitted a cross-tenant CREATE in silence — the
reason `tenancy { strategy row }` could not generate the rule and left 22 of
basecamp's models to hand-written ones. The foreign key is in the data being
written and `buildFilterSql` already builds the target's own filter, so the same
SQL runs uncorrelated: `SELECT 1 FROM "<target>" WHERE "<referencedKey>" = ? AND
(<target policy>) LIMIT 1`. Reads go through `ctx.readDb`, which serves the write
connection while a transaction is open — without that a parent and child created
together deny the child. An **absent** foreign key allows, the same answer the
tenant column already gives on create. `evalJs` takes the containing operation
now, so a bare `check()` asks the right question of the target.

**Tenancy generates it.** One `@@deny(read, update, delete, create, !check(rel))`
per SCOPED PARENT — and that is why there is nothing to choose. Denies are AND'd,
so a model with two scoped parents must satisfy both: the narrowing answer, and
the direction tenancy always takes. Picking one parent and ignoring the other
would widen, under a rule nobody could predict. Transitive by fixpoint, so a
grandchild is scoped once its parent is; self-relations are skipped;
`check(rel, 'read')` is stated rather than inherited, because the question is
*is that parent mine* and never *may I create that parent*.

`@@tenant(via: rel)` narrows to one named relation, and is refused if it names
something that is not a to-one relation or a parent that is not itself scoped.
The *N models are NOT scoped* report now names only the models with neither a
column nor a scoped parent, and a second line names what was delegated.

**`check()` had never worked on a model whose table is snake_cased** (`FJS-333`).
The `EXISTS` named the MODEL where it had to name the outer table, so
`model LineItem` produced `"LineItem"."orgId"` against table `line_item` and
SQLite answered `no such column`. Every single-word model hid it — identifiers
match case-insensitively, so `"Order"` finds `order`.

## 2026-08-17 — three refusals that name the thing (`FJS-206`, `FJS-207`, `FJS-332`)

2332 tests, 0 fail. Typecheck clean.

**A failing batch says which row.** `UNIQUE constraint failed: post.slug` out of a
500-row import named the column and never the row, so finding it meant bisecting
the batch by hand — and the loop already had the index. The message now opens
`data[i] of n`, names the values that collided, and says **nothing in the batch
was written**, which is true and is the difference between re-running the import
and hunting for partial rows. `batchIndex`/`batchSize` are on the error for a
caller that would rather not parse prose. The error is annotated rather than
wrapped: its class carries the status past the API boundary, and a wrapper would
flatten `SoftDeletedUniqueError`'s 409 into an unclassified 500. The values are
redacted the way the audit trail redacts them, because a `@unique` column may be
`@encrypted`. Three sites had the same silence — the insert loop, the
row-building map above it, and `upsertMany`, whose loop carried no `try` at all.

**A `Json` filter says whether the column has a shape.** `{ meta: { tier: … } }`
on an untyped column threw `Unknown where operator "tier"`, which sends the
reader after a misspelling; it now says the column is untyped Json and gives both
routes, `@type(...)` or `$raw` with `json_extract`. The mirror on a typed column
threw `Unknown field 'has' on type Address` — naming the type, calling an
operator a field, and never naming the column. `WHERE_OPS` is the one set of what
an operator is, so the typed walk can tell a sub-key from one.

**`@unique` over a randomly-encrypted column is refused.** Found probing the
first of these with a `@unique @encrypted` fixture that would not conflict: the
constraint is over the stored bytes and a random IV makes every write of one
value different, so it is declared, built, and can never fire. Measured — two
creates, two rows, no error. `@unique` and `@@unique([...])` naming such a column
are refused at parse now, beside the `@hashed` conflict rules;
`@encrypted(deterministic: true)` and `@hashed` are the two ways through.

## 2026-08-17 — a bulk write counts its own rows, not its triggers' (`FJS-320`)

2320 tests, 0 fail. Typecheck clean.

`{ count }` on a bulk write meant *rows this statement addressed* and did not
say so. bun:sqlite's `.changes` is a total-changes DELTA, not
`sqlite3_changes()`, so it also counts what a trigger or a foreign-key action
wrote inside the same statement. Filed against `@@fts`, where one updated row
answered 17; the wider case is `updatedAt`, which is a SQL trigger here, so
every model carrying the column doubled its count, and a `deleteMany` naming
one parent answered 4 for its three cascaded children. A model with no trigger
and no cascade was the only one ever right.

`rowsChanged(db)` is the one answer now — `SELECT changes()` read off the same
connection with no write in between, which counts only the rows the statement
itself named. It replaces `.changes` wherever the number means rows:
`updateMany`, both halves of `removeMany`, `deleteMany`, the two single-row
`select: false` paths whose telemetry carried the same inflation, and
`retention.js`'s log line. The `RETURNING` paths already counted rows and are
untouched; `createMany` and `upsertMany` count iterations.

The number leaves the Data realm — junction hands it to the browser and a live
store's `changed` event carries it — so a caller comparing it against what they
asked for saw a write that touched rows nobody named.

`test/bulk-count.test.ts` holds it: nine cases over five models — fts,
`updatedAt`, no trigger at all, soft delete, cascade, a write that matched
nothing, inside a transaction, and `announce: 'rows'` agreeing with the default.

## 2026-08-17 — `@transient`: the payload key that is not a column (`FJS-D23`)

2311 tests + 16 new, 0 fail.

The mirror of `@computed` — a field with no column, written by the caller and
never read back, where `@computed` is one that is read and never written. The
mirror is the design, not a slogan: it is emitted into the WRITE modes of the
generated JSON Schema (`writeOnly`, `x-litestone-kind: 'transient'`) and absent
from the read ones, out of the row type and out of `Where` in generated types,
and out of the DDL. Twenty-three attributes that describe storage, derivation or
a read are refused beside it by name, as is a field `@allow` (the rule would be
evaluated at a boundary the value never reaches) and a `@@index`/`@@unique`
naming it.

At the Data boundary it is refused by name in a write, a `where`, an `orderBy`,
an aggregate and a policy predicate, each with the reason. All five matter for
one reason: SQLite reads a double-quoted identifier it cannot bind as a string
LITERAL, so a filter over a column that does not exist matches every row or none
and reports nothing.

**`isStoredField` in `ddl.js` is now the one answer to what becomes a column.**
`CREATE TABLE` and the rebuild's `INSERT … SELECT` were each carrying their own
list and had already drifted: the rebuild's copied `@computed`, `@from` and
`@derived` fields, which is the string-literal hazard above inside a migration.

`generateValidationCases` skips a transient field — its rules are real and this
is not the layer that holds them, so every generated case would write a value
the boundary refuses and read as a broken rule. The API is where they run, and
`@frontierjs/testing` is the tier that can reach it.

Ruling in `DECISIONS.md` § API design.

## 2026-08-17 — `$inTransaction`, on every flavor of client (`FJS-D35`)

2295 tests, 0 fail. Typecheck clean.

```js
db.$inTransaction              // → false
await db.$transaction(async () => db.$inTransaction)   // → true
```

For a caller whose correctness depends on being inside one — junction's outbox
row, which is only worth writing if it rolls back with the write it belongs to.
That caller cannot ask the service declaration instead: `transactional:` is a
statement about a method, and a hook can run against a method it does not name.

A fact about the CONNECTION, so it is the same answer on every flavor — a
scoped client, the system bypass and `$scopedBy` share one write connection and
one depth counter. `litestone types` emits it too, so a generated client
declares it; `AnyLitestoneClient` deliberately does not (adding it there makes
every already-generated client unassignable, which is `FJS-018`).

## 2026-08-17 — three declarations that did not match the runtime (`FJS-034`)

2295 tests, 0 fail. Typecheck clean. `src/index.d.ts` only — no behavior moved.

Found from junction's side, driving its typecheck baseline to zero: its examples
hold a real client, and each of these was an example that could not compile
against a thing that works.

- **`LitestoneClient.$schema` is a `LitestoneSchema`.** It was `unknown`, and
  `generateJsonSchema(db.$schema)` is the documented line — so the documented
  line was a documented cast. `AnyLitestoneClient` keeps `unknown` on purpose: a
  generated client declares a `$schema` of its own, and naming a shape there
  makes the generated flavor unassignable again, which is the failure that
  interface exists to end (`FJS-018`).
- **`TableClient`'s last four parameters default off the row.** Naming an
  accessor by hand — a test, or an example whose schema is a string with no
  `litestone types` run behind it — cost five type arguments, so examples wrote
  none and stayed untyped. It costs one now.
- **`FileStorageOptions` declares `localPath` / `localUrl` / `localPort`.**
  `storage/providers/local.js` reads all three and nothing declared them, so the
  local branch of every dev storage config was a type error.


## 2026-08-16 — the generated types name the services too (`FJS-018`)

2295 tests (3 new), 0 fail. Typecheck clean.

`generateTypeScript` now emits **`ServiceTypes`** — service name → row type, one
entry per model. The key is the plural, from `@frontierjs/toolbelt/inflect`, the
same table the accessor and Sierra's registry read, so `Person` is `people` and
a name derived here matches the model derived back from it (Invariant 2).

`--augment junction` adds the module augmentation that registers the map with
`@frontierjs/junction/client`, which is what makes `client.service('posts')`
answer this schema's row in a browser. Behind a flag because an augmentation
names a package: emitted unconditionally it is a type error in every app that
installed litestone alone.

Two things fell out of using it. **`createClient` is generic** —
`createClient<Db>({ … })`, where `Db` is the generated client — because the
alternative is an assertion at every call site, which is exactly the
hand-written table shape the generator exists to replace. And the tools take
**`AnyLitestoneClient`** now: the hand-written `LitestoneClient` in `index.d.ts`
reaches its tables through an index signature, a generated one has a typed
accessor per model and therefore none, and the second is not assignable to the
first — so an app holding generated types could not call `autoMigrate(db)` at
all. `apply`, `autoMigrate`, `runSeeder`, `Seeder`, `Factory` and
`defineFactory` name the wider type.

## 2026-08-16 — the hook runner gets one call site (`FJS-288`)

2292 tests, 0 fail.

`hooks.before.all` declared sixteen operations and reached four of them. The
two sets are the contract — `expand('all')` iterates `SETTER_OPS ∪ GETTER_OPS` —
and eleven of those names had no call site, so registering on `deleteMany` or on
`setters` was silent in both directions: the hook never ran, and nothing said it
would not. An audit or a stamp registered on `all` missed every bulk write,
which is exactly the write a per-row `update` hook was covering for. `exists`
was in neither set, so `all` missed it too.

The cause was five hand-written hook pairs living inside the methods. There is
one now: `installHooks(table, ctx, modelName)` wraps a built table once, reading
the same two sets, and `makeTable` returns through it.

**A hook fires exactly once per call the caller made, named for the method they
named** — which is what the wrapper's two `this` bindings decide:

- a hooked operation runs against the RAW table, so its own internal calls
  (`upsert` → `create`/`update`, `findMany({recursive})` → `findMany`) do not
  announce a second time
- everything else runs against the wrapper, so a delegating helper
  (`transition` → `update`, `findFirstOrThrow` → `findFirst`) still reaches the
  hook of the operation it delegates to

Three consequences worth knowing before you upgrade a hook:

- **hooks are the outermost layer now.** A before hook sees the arguments as the
  caller wrote them, ahead of the plugin door and ahead of any stamping this
  file does — `@sequence` values and nested-write extraction used to happen
  first on `create`.
- **an `upsert` that inserts fires `upsert`**, where the nested `create` used to
  fire `create`. One call, one hook run.
- **an after hook on `update` can replace the result**, which it silently could
  not: the result was assigned to the context and the return value read past it.

`search` is the one method that is not `(argsObject)`, so its context carries
`{ query, ...opts }` — a before hook rewriting `args.query` rewrites the search
text.

Seventeen operations × before/after, each asserted to fire once with nothing
else, in `test/litestone.test.ts` § hook coverage. A new operation belongs in
that grid; a missing row fails rather than being skipped.

Unblocks `FJS-D10`'s `setters`/`getters` → `read`/`write` rename, which was held
because an accurate name on a broken mechanism hides the hole. Filed while
measuring this: `FJS-320`, a bulk write on an `@@fts` model reporting the FTS
triggers' work in its `count`.



## 2026-08-16 — `announce`: the dial on what a bulk write says (`FJS-D34`)

2289 tests, 0 fail.

`FJS-307` made the collection announcement always correct and always coarse: a
three-row cancel makes every subscribed tab reload its page. `announce` is the
opt-in that buys precision back.

```js
db.order.updateMany({ where, data, announce: 'rows' })   // one event per row
db.event.deleteMany({ where, announce: 'none' })         // silent, deliberately
createClient({ …, announce: 'collection' })              // the floor
```

**Per CALL, with a client-level floor** — precedence option → client →
`collection`, the shape `resolveTenancy` already uses one realm over. It is the
call and not the model because the call site is the only place the batch size is
knowable: one `Order` model carries both a three-row cancel and a two-million-row
purge, and a model-level flag would materialise the purge. It is not decidable by
size either — the count is unknowable before the statement without a second
query, so this is declared rather than guessed.

**What `rows` costs is memory proportional to the batch**, which is the whole
reason it is not the default. What it does not cost is a query: the three
statement-shaped methods already append `RETURNING *` on a logged model, so the
change is one condition wide and free where a trail is already being written.
And it is **ANDed with the audience** — an app that opts in with nobody listening
still takes no `RETURNING`, the same guard that keeps the write path free for an
app that taps nothing.

`upsertMany` gets the better answer at this tier: the create/update split is
already computed for the trail, so each half announces truthfully instead of the
whole batch calling itself an update, which is the compromise the collection form
has to make.

**An announced bulk row goes through `read()`.** Straight off `RETURNING` it
still carries `@guarded` and `@encrypted` columns that every other event path
strips, and a subscriber is not a privileged reader. `announceBulk` is the one
owner of the three-way branch so that cannot be got right at four sites and wrong
at the fifth.

Refusals are loud in both directions. An unknown value is `InvalidAnnounceError`
(400) naming the three legal ones, thrown **before** the statement — `announce:
'row'` is somebody who wanted per-row announcements, and quietly giving them the
coarse one is the class of bug `FJS-307` closed. `announce: 'rows'` on a jsonl
model is refused by name too: append-only, no `RETURNING`, no row that could ever
be announced.


## 2026-08-16 — every write announces, and says whether it can name the row (`FJS-307`)

2279 tests, 0 fail. `test/write-events.test.ts` is new and is the point.

**Seven of eleven write methods announced nothing, and never had.** Measured one
call each against a real client: `createMany`, `updateMany`, `upsertMany`,
`removeMany`, `deleteMany`, `delete` and `restore`. The filing said `restore`
fired and did not mention `upsertMany` — running it said otherwise, which is why
this starts with a grid rather than a fix.

A write event now carries **`scope`**, and it is stated rather than inferred:

- `row` — one row changed. `result` is that row, or `null` where `select: false`
  skipped the RETURNING.
- `collection` — `count` rows matching `where` changed, and the statement never
  built them.

Reading the discriminator off `result` was the tempting shortcut and it is
wrong in both directions. `result: null` already had two meanings, and the
second one — a `select: false` write, which is one row nobody can name — was
being emitted and silently dropped a layer up. That case is the argument for
the shape: it is not a bulk problem, it is the same problem one method over.

`delete` and `restore` had their rows the whole time — `delete` from its
pre-DELETE SELECT, whose sibling `remove` fires from the same region, and
`restore` from a RETURNING it already shapes and hands back — so both announce
per row, as `remove` and `update`, matching what the audit trail already calls
them. The four bulk methods announce a collection. `upsertMany` announces
`update`, because the create/update split is known only on a logged model and
`create` would be wrong for the conflicting majority.

**A write that matched nothing announces nothing.** A filter that hit no rows
sending every open tab back to the server is worse than silence, and it is the
one shape a count-based announcement can get gratuitously wrong.

The audience guard leads in both helpers, so an app that subscribes to nothing
does not build the payload — the same rule the `$tapEvents` fast path already
held. What per-row announcement for a bulk write would cost, and who should ask
for it, is `FJS-D34`.


## 2026-08-16 — `$tapEvents(fn)`: subscribing to writes after the client exists (`FJS-D04`, `FJS-010`)

2243 tests, 0 fail.

`onEvent` is fixed at `createClient`, so a layer handed a finished client had no
way to hear about a write. That is the whole of why an `asSystem()` write in a
job announced nothing to anybody: Junction is constructed after the client it is
given. `$tapEvents(fn)` is `$tapQuery`'s shape one event kind over — add to a
Set, get an unsubscribe back — and it closes `FJS-D04` in about the two lines
that ruling predicted.

**The listener Set is shared by reference**, sitting beside `_queryListeners`
for the same stated reason: `asSystem()`, `$setAuth()` and `$scopedBy()` each
SPREAD the context object, and a per-copy Set would mean a subscriber attached
to the root never hears the one write nothing else announces.

**The part the mirror had to add is the fast-path guard.** A query tap is only
read where a query fires, but an event tap has to be visible to the upsert fast
path, which skips the read-then-write split when nothing needs it — `!emitter`
was one of its conditions. Making a tap set `emitter` would have cost every app
that subscribes a measured ~6x on that path; instead `fireEvent` consults both
audiences and the guard reads `!emitter && !ctx._eventListeners.size`, so an app
that taps nothing is exactly as fast as before.

A tap's payload carries `event` folded in, because a `transition` has no
`operation` and a subscriber handling every kind would otherwise have to
re-derive the name. Dispatch is deferred and swallowed like the emitter's own:
a subscriber is an Observer and may not fail the write that announced it.

**What it does NOT cover is now filed rather than assumed** — `FJS-307`. Writing
the coverage grid found that `createMany`, `updateMany`, `removeMany`, `delete`
and `deleteMany` fire nothing, and never did; `$tapEvents` inherits `onEvent`'s
reach exactly, bulk boundary included.


## 2026-08-16 — a capability the schema does not declare is a 400, and it is said out loud (`FJS-292`, `FJS-293`)

2241 tests (7 new), typecheck clean.

**Two failures with one cause, answered in opposite directions.** A caller asked
a model for something its `.lite` never opted into: a METHOD threw a bare
`Error`, which `toFrameworkError` has no name entry for, so `?$search=widget` on
a model with no `@@fts` came back **500 GeneralError** — the server saying it
broke about a request it understood perfectly. A FLAG was dropped in silence, so
`onlyDeleted` on a model with no `@@softDelete` answered the **live rows** —
measured on `example`, where `/api/orders` and `/api/orders?$onlyDeleted=true`
both answered `total: 3`.

`CapabilityNotDeclaredError` is both: 400, `retryable: false`, carrying `model`,
`asked` and `requires`, and naming the attribute that would make the request
legal. `search()`, `optimizeFts()`, `restore()` and `transition()` throw it, and
so do `onlyDeleted` / `onlyTemplates` on a model that declares neither attribute.

**`withDeleted` and `withTemplates` deliberately do not.** They ask to WIDEN, and
on a model that hides nothing the full row set already IS everything — the answer
is right rather than accidentally right. Generic code that does not know the
model asks exactly this: Studio's row browser passes `withDeleted: true` on every
row it opens, and an admin screen with a *show deleted* toggle is the same shape.
Only the flag that cannot be satisfied at all refuses.

An include takes the same flags and reaches neither mode function — it builds
its own SQL — so `include: { books: { onlyDeleted: true } }` against a target
with no `@@softDelete` refused nowhere and answered that target's live rows. It
refuses now, naming the TARGET model.

**The silence had a mechanical cause worth naming.** `sdMode()` answered `'live'`
for a model with no soft delete, and every caller guarded the call with
`softDelete ? injectSoftDeleteFilter(…, sdMode(args)) : where` — so on exactly
the models that could not honor a flag, the function that could have refused it
was never called. `applySdFilter(where, args)` is the fix and the symmetry:
`applyHtFilter`'s sibling, asked on every read, refusing before it decides
whether there is a filter to apply. Two inline ternaries in `findManyCursor` and
`search()` were computing the mode by hand and are now the same call.

`false` is not asking. The flags default to `false` all over the client, so only
a truthy value is ever looked at.


## 2026-08-16 — tenancy is declared in the seed (`FJS-D05`)

2234 tests (28 new, `test/tenancy.test.ts`), typecheck clean.

**A `tenancy { }` block, beside `database { }`.** Two strategies:
`strategy database` is the file-per-tenant registry that already existed, now
configured from the schema; `strategy row` is one database and a tenant column,
which was not a framework concept in any form. Everything that needs to know
reads one resolution — `resolveTenancy(schema, { schemaPath })`, published as
`db.$tenancy` on every flavor of client and as `registry.tenancy` — and
precedence is **option → declaration → default**, stated once in
`src/core/tenancy.js`.

What that closes: db-per-tenant's configuration lived in three places that could
disagree — a `createTenantRegistry()` call, a `tenants:` slice in
`litestone.config.js` the CLI read three keys of (`dir`, `registry`,
`migrationsDir` — never the pool size or the key), and nothing in the schema.
`litestone tenant create` and the running app could each be correct about a
different directory. `createTenantRegistry({ path: './db/schema.lite' })` is now
the whole call, and the CLI and Studio resolve the same way.

**Row tenancy desugars into `@@deny`, and that is the correctness argument
rather than a style choice.** `@@allow` rules are OR'd within an operation, so
adding one to a model that already declares `@@allow('read', ownerId ==
auth().id)` *widens* its reads to every row in the tenant — a tenancy feature
that grants access. Deny overrides every allow and applies to a model declaring
no policy at all. Two rules per scoped model, because `checkCreatePolicy` runs
BEFORE `applyAuthDefaults`: on create the column the `@default(auth().<claim>)`
stamp is about to fill is legitimately absent, on read a row holding no tenant
belongs to nobody. Get the ordering wrong one way and every create is refused;
the other way and orphan rows are visible to everybody. Both are pinned against
a real client, because a policy that admits everything and a policy that is not
applied at all look identical from one side.

**What the block cannot judge is answered per model.** `@@tenant(none)` for a
model that spans tenants, `@@tenant(column: "x")` for one scoped differently,
and a model declaring neither is **reported once, by name** — cross-tenant data
is sometimes a plan table and sometimes the column somebody forgot, and only the
app can tell. `jsonl`/`logger` models are never scoped: no policy engine there,
so a rule would read as enforcement and not be it. The pre-existing
*@@deny with no @@allow* warning now ignores generated rules, or it would fire
once per model on a schema doing the right thing.

Deferred with a reason: a model reached only through its parent
(`check(parent)`) is not generated — `check()` is conservative-allow on create,
so the rule would hold for reads and permit a cross-tenant create in silence
(`FJS-282`).

`docs/multi-tenancy.md` is the reference.


## 2026-08-16 — migrations, second tier (`FJS-D09`)

Three questions left open when the executor took ownership of the transaction,
answered together because each is a way a migration reports success and loses
something.

**There is no `down`, and now there is a way back instead.** A generated down
cannot undo the migration it reverses — a rebuild is a `DROP TABLE`, so the
inverse of *drop a column* is *invent the values it held* — and one that runs,
succeeds and leaves a database that only looks restored is worse than none.
`litestone migrate apply --backup[=dir]` copies **every** SQLite database the
schema declares before the **first** one is migrated, and refuses to migrate
anything if a copy fails. Off by default; a deploy that wants a multi-gigabyte
copy says so. Without it, apply names what it cannot take back — a pending file
that drops a table, and every `.js` migration, whose contents nothing here can
read. `src/core/backup.js` is now the one owner of copying a live SQLite file;
`db.$backup` calls it too, because the CLI holds a raw handle and the client
holds a registry connection, and *is this copy safe under an open WAL* must not
have two answers.

**A rebuild asserts its own row count before it drops the original.** The gap
was that a copy reading fewer rows than the original holds is an error to
nobody: SQLite inserted what it was asked for, and the runner saw a statement
return. Measured by editing a generated copy step — which the file's own header
invites — the rows were gone one statement later and the run reported ✓. SQLite
has no assertion (`RAISE()` is trigger-body only), so the comparison is a CHECK
on a one-row temp table whose constraint NAME is the message: `CHECK constraint
failed: rebuild of post lost rows`. It aborts inside the migration's
transaction. Emitted even when nothing is copied, which is the case it changes
most — a rebuild sharing no column name with the old table used to empty it
under a comment reading *nothing to copy*.

**A migration is named after the last file in its directory, not after the
clock.** Filename order is apply order and the stamp is second-granular, so two
migrations made inside one second either overwrote each other (same label) or
applied alphabetically (`evolve` before `initial`). `nextMigrationName` steps
the stamp past the highest one already in the directory. Loosening the name
pattern was not available: the 14-digit prefix is where the ordering guarantee
comes from.

`DECISIONS.md` § Migrations. Tests in `test/migrations-fixes.test.ts` (6 new,
each verified by breaking the fix) and `test/cli-smoke.test.ts`.

## 2026-08-15 — a plugin has an identity, and keeps its name (`FJS-D19`)

`Plugin` gets a `name`, defaulting to the class name — right for every plugin
anyone writes here and free — with a stated `name = '…'` field winning, because a
minifier rewrites `constructor.name` and a bundled app would report `t`.
`db.$plugins` lists what is installed, in run order, on **every flavor of
client**: what is installed does not vary with auth. Its first useful answer is
the one nobody could get before — a gated schema auto-installs `GatePlugin`, so
what you passed is not what is running, and it comes last.

**The other half of that row was a rename, and it is refused.**
`IDEAS/one-mental-model.md` argued that this package's Plugin is really a *Hook*
because it intercepts queries. Tested against the three that exist: `GatePlugin`
is access control, `FileStorage` is a storage capability, `ExternalRefPlugin`
backs a field with external data — each attaches a capability, holds
configuration and has an `onInit` lifecycle, which is Junction's definition of
Plugin exactly. And this package **already has `hooks`**, one option key away, so
the rename would have collided with a live and differently shaped concept inside
the same `createClient` call.

What actually differs between the realms is the interception surface — eight
`on*` methods here, four lifecycle methods there — and that is a realm
difference, not a concept one: a Data-realm plugin intercepts queries because
queries are what the Data boundary owns. The finding mistook the mental model
working for the mental model breaking.

Ordering is the part that should still converge, and it did not need a rename to
say so: when this grows one it takes Junction's `requires: string[]` rather than
inventing `after`/`priority` beside it.

## 2026-08-15 — the console boots at a gate level (wave 4.23)

`litestone repl --as alice@example.com`, `--level 4`, `--gate ./api/gate.ts`,
with `fli tinker` over it. `db` is the standing you asked for and `sys` is
`asSystem()` — reachable on purpose, because refusing it means people run a
one-off script instead, which is the same power with none of this in front of it.

**The engine was already built, twice, and the record said it did not exist.**
`litestone repl` shipped and worked; Studio's `POST /api/repl` already evaluated
arbitrary expressions against `activeDb.$setAuth(pickedUser)` with `sys` bound
separately and every statement tapped through `$tapQuery`. What was missing was
the terminal, and one thing neither had.

**A subprocess REPL cannot say what it is running as**, and everything this
command claims rests on that. It drove `bun repl` through a temp file, `.load`
and two fixed sleeps; it is hosted here now over `node:readline`, so the standing
is in the prompt on every line rather than in a banner you scrolled past. Losing
the subprocess also removed the restriction that the REPL could not run from a
standalone binary.

**`--gate` is the flag the feature turned out to need.** Without it the console
grades with `FrontierGateGetLevel`, which is the default and not necessarily what
the app installed — and *refuses exactly what that person is refused* is false
the moment the two disagree. Measured on `example`: the default grades
`ops@acme.test` at 3 (CREATOR), the app's own `shopGateLevel` grades the same row
at 4 (USER), and `Order` is `@@gate("0.4.4.5")` — so a create is refused in the
console and permitted in the app. The banner names which resolver answered.

**`--as` and `--level` stay separate**, the split `createTestEnv` keeps between
`actingAs` and `atLevel`: one runs a resolver over a real row, the other fixes
the answer, and a ladder walked with the second says nothing about whether the
first works. A `--level` standing has no `auth()`, so every `auth().id ==` row
policy matches nothing and its model answers an empty list rather than refusing —
said out loud, because the two are indistinguishable from the result.

Where a schema marks no `@@auth` model and has no `User`, `--as` refuses and asks
(`--as Customer:ops@acme.test`) rather than guessing which table holds people.

**A REPL has to serialize its lines and `rl.pause()` does not do it.** Pausing
does not hold back lines readline already buffered, so a pasted block ran every
handler at once and the statements finished in whatever order their awaits did.
Against a database that is writes landing in an order nobody wrote. 16 tests,
the two ordering ones verified by breaking the implementation.

`src/tools/repl-server.js` is gone — it was the preload for the subprocess.

## 2026-08-15 — `@derived(expr)` (FJS-233)

A value computed in SQL from the row's own columns, so unlike `@computed` — a JS
function SQLite has never heard of — it can be **filtered and sorted by**:

```
model Task {
  overdue Boolean @derived(dueAt < now() && completedAt == null)
  urgency Int     @derived(priority > 8 ? 3 : priority > 5 ? 2 : 1)
}
```
```js
db.task.findMany({ where: { overdue: true }, orderBy: { urgency: 'desc' } })
```

**Server-computed only. The schema ships a flag, not the expression.** A
consumer needs two facts and gets exactly two: `readOnly` and
`x-litestone-kind: 'derived'` say do not write this, and
`x-litestone-volatile: 'clock'` says the value goes stale on its own — no write,
no event, nothing to announce it. Shipping the expression would invite a third
implementation of the language in a browser, beside `compileSql` and `evalJs`;
the server's answer is the only one, and the flag says how long to trust it.

**It rides `@from`'s seam**, built into the same map rather than beside it, and
that is the whole reason it reaches every read: the query pipeline, `search()`,
`findManyCursor`, all three include shapes, `select`, `distinct`,
`findManyAndCount`. A seventh site that forgot it would be silent, the way a
forgotten `@from` is. It carries no parameters — the expression compiles once at
startup and `now()` becomes SQLite's own clock, which SQLite fixes for the
duration of a statement, so every occurrence is one instant.

`aggregate` and `groupBy` build their own SELECTs and needed the expression
substituted where a bare column name goes. Without it `MAX("urgency")` reaches
SQLite as a quoted identifier it reads as a string CONSTANT and answers
`'urgency'` — FJS-202 arriving through a new field kind, one day after that row
was closed.

**`auth()` and `check()` are refused, and the refusal names `@@scope`.** A
derived field is one value for the ROW; per-caller is a different tier, and
keeping it static is what lets the expression compile once. Also refused: a
field that is not on the model, and one derived field reading another.

**The declared type is checked against the branches**, which is the obligation
the ternary brought with it (FJS-234). Branches that disagree, a `Boolean` field
whose expression produces an `Int`, and an enum-typed field naming a value that
is not a member are all schema errors rather than rows that read back something
no consumer expects. Inference is partial on purpose — unknown never fails,
because a type checker that guesses is worse than one that is quiet.


## 2026-08-15 — a ternary in the policy language (FJS-234)

`cond ? a : b`, binding looser than `||` and **right-associative**, so
`a ? x : b ? y : z` nests into the else — a four-value ladder with no CASE
keyword. Both branches parse as a full ternary, which is unambiguous because
`?` and `:` bracket the middle.

Two obligations, because this is where the language stops being predicate-only
and starts producing **values**:

**It lands in both compilers** — `CASE WHEN … THEN … ELSE … END` in `compileSql`
with the params pushed in emission order, `?:` in `evalJs`. A form in one and
not the other is FJS-195 repeating. The first draft landed in neither: an
insertion aimed at `evalJs` matched an identical line in a helper added earlier
the same day, so every create was allowed and the SQL half was doing all the
work. Caught by running it, not by reading it.

**It is gradeable.** `verifyRowPolicies` compiles the read policy into a WHERE
and grades it against the JS evaluator, and it could not see a ternary at all:
its seeder walks the expression for interesting values and had no case for one,
so every row landed on the same side and the policy was reported ungraded rather
than passing. Verified by swapping the branches in one half and watching it fail.

**A parenthesised group is now an operand on both sides of a comparison.** Only
the left side took one, so `ownerId == (open ? auth().id : auth().adminId)` — a
ternary choosing which value to compare against, which is most of what a ternary
is for here — was a parse error on the right and legal on the left. Harmless
while the language was predicate-only; in the way the moment it produces values.

**An ordering comparison is seeded on both sides of its literal**, which is not
about ternaries and was found through one. `level > 5` seeded `level = 5` — the
EXCLUDED side — so the only admitted rows were whatever the factory happened to
generate. A policy graded by luck reports *all rows on one side* the day the
factory changes, and until then grades nothing.


## 2026-08-15 — the permission diff: `litestone access --from <ref>` (wave 4.3)

**What did this branch do to who may do what.** `--from` turns the access
command from a snapshot writer into a question, graded `widens` / `narrows` /
`undecidable`, over gates, row policies, field-level `@allow`, `@guarded` /
`@encrypted` / `@secret` and transition gates. `--strict` exits 1 on a widening,
and `--json` answers the diff. Nothing is written. `bun run ci`'s new `access`
phase runs it per app against the base ref and prints the result.

**The obvious implementation was wrong, and it is the reason this is one
function rather than a new module.** `classifyPivot` already compared two
release surfaces, so pointing it at a base ref looks like the whole job — but it
grades *can Release N-1 and N serve one database*, and that axis is close to
inverted from the reviewer's. On the five-part widening in
`test/release.test.ts`, **every finding is an `expand`** and the single change
that narrows is the only `contract`: removing a `@@gate` costs the previous
release nothing and is the widest thing a schema change can do. So a finding now
carries `severity` for the deploy and, where it is about access, an `access`
direction; `classifyAccess` is a second grading of one walk, because two walks
over one set of declarations is how two answers to one question drift apart.

**A field-level `@allow` was absent from the release surface entirely**, so
`release:check` was blind to it too. It is the shape guarding `isSystemAdmin`,
`role` and `emailVerified` — the columns a permission diff exists to watch — and
it is a compatibility change as well as a permission one (adding one takes the
column out of the answers N-1 reads), so both axes gained it. Grouped by the
operations it names, exactly as `@@allow` is one level up, so an edited predicate
is one *undecidable* finding rather than a removal and an addition that read as
widening and narrowing at once. `release.snapshot.md` gains the rules in its
Notes column, with `|` escaped — a policy expression legitimately contains `||`,
which ends a markdown cell and silently drops the rest of the row.

**A `@@transitions` change has no fixed direction.** The first transition
declared on a free enum column refuses every other move; the second permits one
more. The two arrive as one added row and are counted per field instead.

A predicate whose text moved is reported undecidable on both axes. Two
expressions are not comparable by reading them, and the guess is the one that
ships.

## 2026-08-15 — `@@scope` and `orderBy: { $raw }` (FJS-228, FJS-230)

**`orderBy: { $raw: sql`…` }`** is the escape hatch `where` has had all along
and the sort side did not. Everything monotonic in a stored column already
sorts; what does not — *snoozed last regardless of due date*, a weighted score —
could not be said at all.

The fragment is the whole ORDER BY tail, direction included, because a sort no
builder can express usually needs several keys in an order only the caller
knows, and it composes with ordinary keys in the position it is written. **A
plain string is refused by name**: the `sql` tag's static text is the app
author's and its interpolations are bound, so a bare string is precisely how a
caller-supplied one would arrive. Refused where it cannot mean anything — with a
cursor (which reads every sort key's value back off the last row, and an
expression is not a column) and on `groupBy` (whose ORDER BY is over group keys
and aggregates).

Its parameters travel in their own array spliced in at the ORDER BY rather than
into the statement's as it is built: positional binds make the order the
correctness, and ORDER BY comes after both the WHERE and the row policy ANDed
onto it. FJS-215 was the same lesson.

**`@@scope(name, expr)`** is a named predicate in the expression language
`@@allow` already uses, asked for as `where: { $scope: 'overdue' }` — the policy
compiler named and made explicit rather than implicit and always-on.

It exists although `createClient({ scopes })` already chains, and the reason is
the deciding one: **a browser cannot invoke `db.task.overdue()`.** A client
sends a `where` OBJECT over HTTP, so a scope declared in JavaScript is
server-only and `$scope` is the one spelling that travels.

Implemented by desugaring `$scope` into `$raw` before the where is built, rather
than adding a case to the where builder. That is what makes it compose for free:
`{ $scope: 'overdue', status: 'open' }` conjoins, a scope nested under
`AND`/`OR`/`NOT` nests, several names AND, and the parameters land where
`$raw`'s already do — one owner of each rule instead of a second implementation.
A disjunction is written INSIDE a scope, where both compilers can see it.

Invariant 8 at the one site that invites breaking it: `$scope`'s value is
caller-supplied, and it is a KEY looked up in the table the schema declared.
Nothing a caller sends is interpolated, an unknown name is refused before any
SQL is built with the declared names listed, and `db.$scopes(accessor)`
publishes that list as source text — the same list `$checkWhere` validates
against, on every flavor of client, because filterability is a fact about the
schema.

**A policy naming a column the model does not have is now refused at startup**,
which `@@allow` needed too and never had. It reached SQLite as `"nope" > 1`,
which resolves the unresolvable identifier as a string CONSTANT — so the
predicate compared two literals and the filter silently admitted or excluded
every row. Same fallback as FJS-202, reached from the schema instead of from a
query.


## 2026-08-15 — a soft-deleted row keeps its @unique slot (FJS-204, FJS-278)

`create` a row, `remove` it, `count()` answers 0 — and creating the value it
held throws `UNIQUE constraint failed: doc.code` against a table the client just
said was empty. Every first diagnosis went to the index.

**Ruled: the slot stays held**, so no DDL changed. The alternative was a partial
unique index (`… WHERE "deletedAt" IS NULL`), and it was rejected because it
makes `@unique` false for any read that includes deleted rows:
`findUnique({ code }, { withDeleted: true })` would legitimately match two, and
every export, audit query, migration and `release:check` reading with deleted
rows would see duplicates on a column declared unique. It also makes `restore()`
conditionally impossible, which is soft delete's entire contract — a way back
that fails because a stranger took the value is not one. `DECISIONS.md` § Query
& write semantics carries the full argument, including the cost of the rejected
option: SQLite cannot make an inline `UNIQUE` partial, so it would mean
re-emitting every constraint as an index and rebuilding every affected table —
15 of basecamp's 37 models.

So the defect was the report, and `SoftDeletedUniqueError` (409, not retryable)
replaces it: the field, the value, the holding row's id, and both ways to
release a slot deliberately — move the value with
`update({ …, withDeleted: true })`, or stop keeping the row with
`delete({ …, withDeleted: true })`. Composite `@@unique` names both columns. An
ORDINARY conflict is untouched: the re-read runs only on the failing path and
only reinterprets a conflict a DELETED row caused.

**Probing it found the worse half (FJS-278): four write paths, four answers, two
silent.**

| against a soft-deleted row holding `code: 'x'` | was |
| --- | --- |
| `create` · `createMany` | SQLite's raw message |
| `upsert` | returned `null`, wrote nothing |
| `upsertMany` | wrote the update INTO the deleted row, reported `{count: 1}` |

`upsertMany` is the one that loses data: the write lands where no read returns
it and `deletedAt` is never cleared, so it is invisible for good and the caller
was told it succeeded. Two causes — `upsert`'s race-recovery fallback assumes a
UNIQUE conflict means a LIVE row appeared between its `findFirst` and its
insert, so it retried as an `update` that filtered the deleted row and matched
nothing; `upsertMany` is `ON CONFLICT DO UPDATE`, resolved by SQLite, which has
never heard of soft delete. All four answer the same error now. The fallback
re-throws rather than swallowing it — an upsert may not resurrect a row nobody
asked it to — and `upsertMany` asks BEFORE the statement runs, because
afterwards the write has already happened. The genuine race the fallback exists
for has its own test.


## 2026-08-15 — `in`, membership in the policy language (FJS-205)

`@@allow('read', auth().id in memberIds)` did not parse — `Expected RPAREN, got
'in'`, a line and a column with no statement about what was wrong. The grammar
compared scalars, so an audience held ON the row had no expression at the Data
boundary and had to become a service where-clause, which is exactly what
`@@allow` exists to prevent: a forgotten filter is an exposure.

**The list is always the RIGHT operand.** That is what makes one operator enough
for the three shapes rather than two operators facing opposite ways:

```
@@allow('read',   auth().id in memberIds)          // the row holds the list
@@allow('delete', ownerId in auth().ownedIds)      // the principal holds it
@@allow('update', status in ['draft', 'review'])   // written literally
```

An array column compiles to `EXISTS (SELECT 1 FROM json_each("memberIds") WHERE
value = ?)` — the same SQL `where: { col: { has } }` already produced, so
membership has one definition and not two. The other two compile to `IN (?, …)`,
and the empty list is answered before any SQL is built: `IN ()` is a syntax
error, and nothing is in an empty list. The literal form also retires
`status == 'draft' || status == 'review'`.

It landed in **both** compilers. A form in one and not the other is FJS-195
repeating — `field == null` was in neither, so create allowed a row that read
then hid — and `verifyRowPolicies` is the oracle that holds them together.
**It could not see this operator when it arrived**: its seeder took values off
the predicate, so it put the principal's scalar id into an `Int[]` column, the
insert failed, and every run reported one row all on the excluded side. Not a
wrong grade, but no grade. It seeds an array column with `[value]` now, and a
scalar column against a list with a member of it plus a numeric miss — the
string sentinel is refused by an Int column and `null` by a required one, so
before this the excluded side existed only by luck.

**What the schema can decide is decided at startup**, naming the model and
quoting the expression back — a wrong policy is an empty screen with a 200, so
there is nothing to notice later. Refused: a right operand that is not an array
field, an array on the left (overlap between two lists is a different question
and is not expressible yet), both operands naming a column on the same row, and
an `@encrypted`/`@hashed` list column, which holds an encoding rather than its
members.

**The parse error names the operator and lists what is legal** — asked for by
the row regardless of which spelling won. `policyExprToString` moved from
`access.js` to `core/policy.js` on the way: the startup check quotes expressions
back at the reader, and `access.js` says of itself that production code never
imports it, so the dependency had to point the other way.


## 2026-08-15 — `db.$audit()`, for what `@@log(audit)` cannot see (FJS-276/267)

`@@log(audit)` is a side effect of a write, so it covered exactly the events that
ARE writes — and the ones an app most wants are not. A failed login performs no
write and left no trace at all. A successful one left `create:session` with
`actorId: null`, because the write goes through `asSystem()` and a system context
names no principal; measured, `$setAuth(u).asSystem()` gives null too, so there
was no way for a system-context write to carry an author into the log.

`$audit({ operation, model, records, actorId, meta })` is the one owner of
putting a row in the trail. The log model is an ordinary accessor a caller could
write directly, and that is the point: two writers with no shared definition is
how a second `operation` vocabulary starts drifting from the first.

**It throws**, where `@@log(audit)` is fire-and-forget. That difference is the
whole design: there, logging is a side effect of a write that already succeeded
and must not fail it; here, the record IS what the caller asked for, and
swallowing the failure would mean a security event silently unrecorded. A caller
on a path that must not fail catches it and says so.

`actorId` defaults to the calling client's principal and a stated one wins over
`onLog`'s — `onLog` is a generic enricher over every entry, a `$audit` caller is
naming one event. Unknown keys are refused BY NAME rather than dropped. On every
flavor of client, which `$checkWhere` shipped without and paid for.

`meta` is written as given and nothing redacts it: field redaction protects
columns the SCHEMA declared protected, and this has no schema behind it.

## 2026-08-15 — an aggregate names a column (FJS-202, FJS-273, FJS-255)

`aggregate` and `groupBy` are the two reads that never build a row: they name a
column in the SELECT and take the value straight out of SQLite. So both of the
things `read()` does for a row had to be done here by hand, and neither was.

**A name that is not a column answered a constant.** SQLite reads a
double-quoted identifier it cannot resolve as a string literal, so nothing
failed — `aggregate({ _max: { comp: true } })` returned `{ _max: { comp: 'comp' } }`
and `_sum` returned `0`. Filed as a `@computed` problem; measuring it found
`@from`, a relation and a plain **typo** doing the same, across eight arguments
that can carry a field name. `groupBy`'s `by:` refused, but only by accident,
with SQLite's own `no such column: order.label` — a message naming a table
rather than the model, and never the reason.

**A column the caller may not read answered in full.** `applyFieldPolicyTo` is
the one owner of *may this caller see this field* and it answers per row, so an
ordinary signed-in caller could ask for `_max` over a `@guarded` salary and get
it. Two of these are not aggregates at all: `_stringAgg: { field: 'salary' }`
answers every value joined with commas, and `by: ['salary']` answers every
distinct value with a count.

One guard, two tiers. `by`, `_count: { distinct }` and `interval` need a real
column and nothing more — grouping stored text is self-consistent, every
distinct value is its own group, and the key is hydrated back into the shape a
row read gives it. Everything producing a VALUE also refuses the opaque bucket
`orderBy` already had: `MAX` over a JSON array orders that text, so `['10']`
ranks below `['9']`. `fieldReadRefusal` mirrors the strip ladder over a name,
and a field-level `@allow('read', …)` is refused rather than evaluated — it is a
predicate over a row and there is no row. `asSystem()` reads what it may, and
`@hashed` is refused for everyone.

The crossing matrix promoted 8 cells. Two of them, `encrypted × aggMax` and
`encDet × aggMax`, moved from `ok` to `ref`: they had been answering the maximum
CIPHERTEXT, in the right shape, which is what made the cell read as fine.

**The three lock errors are 409s** (FJS-255). They declared `retryable` and no
`status`, so `toFrameworkError` fell through to its name branch and answered
`GeneralError` — a caller told the server had broken about a lock another
request was holding. `errors.snapshot.md` flipped all three rows on
regeneration, and junction's test now also asserts that **no** Litestone class
in that table lands on 500, since every one of them is a class this repo owns.


## 2026-08-15 — a package can ship a schema fragment (FJS-265)

An import specifier was always a path, so `import "@frontierjs/auth/schema.lite"`
looked for `db/@frontierjs/auth/schema.lite` and failed. The only way to use a
package's models was to COPY them into the app, which is what `fli auth:install`
did — and an upgrade to the package reached nothing.

**A non-relative specifier now resolves through node**, from the importing file,
so the package's own `exports` decides what is importable and nothing guesses at
a path inside one. The failure message names both causes — not installed, or not
exported — always, and deliberately: node distinguishes them with
`ERR_PACKAGE_PATH_NOT_EXPORTED` while bun collapses both into `MODULE_NOT_FOUND`,
so branching on the code would make the error depend on which runtime read the
schema and say one thing under `bun test` and another under `node`.

**`import "..." into <db>`** is the other half. A shipped fragment has to spell
some database name and only the importing app knows what its own are called, so
`into` is the one parameter that varies — it is what `fli auth:install --db auth`
now emits instead of rewriting a copied file.

One rule, stated twice: the NEAREST statement about a model's database wins. An
inner `into` on a nested import beats an outer one; any `into` beats a `@@db` in
the imported file; a model naming no database gets one. Importing one file twice
under two different `into`s is an ERROR rather than a precedence puzzle — it is
merged once, so only one could ever hold.

`inlineImports` follows a package specifier too, and applies `into` on the text
with the same nearest-wins rule, so `release`'s baseline and `createTestEnv` see
what `parseFile` sees. The two paths are compared against each other rather than
described as equivalent.

## 2026-08-15 — every CLI command ignored `import` in a schema (FJS-264)

`createClient` has always resolved `import "./other.lite"` — it goes through
`parseFile`. `loadSchema()` in the CLI read the root file and called `parse()`,
so all twenty commands behind it saw the root file alone.

Nothing said so, because the comparison was internally consistent: `db push`
diffed the database against a schema with the imported models missing and
reported **already in sync** while their tables were never created. The same
blindness reached `ddl`, `jsonschema`, `access`, `types`, `migrate` and
`release` — every committed snapshot describing a split schema described half
of it.

`loadSchema` and studio's live reparse use `parseFile`. `parse` is now for text
with no file behind it — an editor buffer, a git blob — where the caller owes
the imports.

**`release`'s baseline is that caller, and it inlines them AT THE REF.** The
previous release's files live at a git ref, where there is no tree to walk;
reading them from the working tree instead would compare the previous release's
root schema against today's imported models and call every one of them
unchanged, which is the exact blindness being removed. An import that cannot be
read there is a named note on the baseline, not silence.

`test/cli-smoke.test.ts` § *a schema that imports another file* — push, ddl and
the release baseline, each checked against a negative control.

**Two more readers had it, and one of them inverts a guarantee.** Sierra's build
handed the browser a `$defs` table with the imported models missing, so
`modelNameFor` missed, `createResource` fell back to a bare `make()`, and a
generated `<Form>` rendered nothing against an app that built clean. And
`createTestEnv({ schema: 'path' })` read the root file and parsed the text, so
every executed check — `verifyGateLadder`, `verifyRowPolicies`,
`verifyFieldProtection`, `verifyConstraints` — graded a schema with the imported
models missing and **passed**. A green ladder over models it never saw is worse
than no ladder, and it is the thing that exists to catch the other two.

`createTestEnv` splices the imports into ONE text rather than deferring to
`parseFile`, because that text is the template cache key: keyed on the root file
alone, editing an imported file reuses the previous run's database. An import it
cannot read is **refused**, not warned — those models would silently go ungraded.

`inlineImports` / `inlineImportsFromDisk` are exported from `parser.js` as the one
owner of following an import line as text; `release`'s baseline and
`createTestEnv` are the two callers, and reading stays theirs because a git ref
takes posix paths and a file on disk does not.

**`parseFile` also answers a bad schema the way `parse` does now.** It let a
`ParseError` throw where `parse` returned `{ valid: false, errors }`, so every
caller that warns and keeps going got a stack trace instead — which is how this
surfaced: sierra's *warns and returns null on an unparseable schema* went red the
moment the plugin started using it. An error inside an imported file names that
file.

## 2026-08-15 — the plural rules are `@frontierjs/toolbelt/inflect` (FJS-192)

`pluralizeWord` in `ddl.js` and `toSingular` in `introspect.js` were two of five
copies of English's inflection rules in this repo, and the five did not agree.
Both now call one module. Litestone still owns the naming DECISION — snake_case,
`@@map` wins, pluralise only when asked — and no longer owns the rules.

**Seven irregulars became reachable, and that renames a table.** The table was
consulted last, behind the sibilant rule, so `index` was taken by `x$` and came
back `indexes` while the table said `indices`; the same for `matrix`, `vertex`,
`analysis`, `basis`, `crisis` and `ox`. A schema with a model of one of those
names and an existing table keeps it with `@@map` — no schema in this repo has
one, checked before the change.

The irregular table matches a WHOLE word only, so a compound is unaffected:
`audit_index` is still `audit_indexes`. Reaching inside a compound would rename
tables in schemas that already exist, which is a migration, not a fix.

## 2026-08-15 — a write takes the same flags a read takes (FJS-176, FJS-263)

`@@hasTemplates` had its intent recorded in one place — a comment in the parser
— and it covers reads only: *default reads exclude templates, opt in per call
with `withTemplates` / `onlyTemplates`*. Everything wrong with it was on the
side that sentence does not describe.

**Templates were create-once and uneditable.** `update`, `updateMany`, `upsert`
and `remove` hardcoded `instances` with no argument that opted in, so every
route answered *no such row* — `null`, `{ count: 0 }` — and **`asSystem()` did
not help**, because the template filter is not an access rule. Meanwhile
`delete` and `deleteMany` applied no filter at all and destroyed a template
happily. A row class that could not be corrected but could be lost, and a
promotion trapdoor beside it: `update({ isTemplate: true })` always worked and
nothing could ever reach the row again to demote it.

Ruled: **a template is a live parallel class, not an end state**, so the writes
take the flags. That is the difference from `@@softDelete`, which the flags
otherwise mirror exactly — a deleted row is out of play and `restore()` is its
documented way back, which is what makes "you cannot edit a deleted row"
coherent there. A template is the thing every instance was cloned from, and
maintaining it is the point.

```js
await db.quote.update({ where: { id }, data, withTemplates: true })
await db.quote.updateMany({ where: {}, data, onlyTemplates: true })
await db.quote.update({ where: { id }, data: { isTemplate: false }, withTemplates: true })  // demote
```

**One behavior change, in the safe direction.** A hard `delete`/`deleteMany`
now applies the template filter, so an ordinary cleanup stops destroying rows
that no read of the model returns. It still bypasses the *soft-delete* filter,
which is its stated contract and the reason it exists beside `remove` — and a
flag now narrows that too, so `deleteMany({ where, onlyDeleted: true })` is how
a purge is spelled rather than raw SQL.

**`withDeleted` on a write was accepted and silently dropped** — not in the
destructured signature, so it went the way an unknown key goes, while `take` and
`skip` on the same call throw by name. It works now.

**`aggregate` and `groupBy` ignored both families' flags** (`FJS-263`), pinned
to `live`/`instances` regardless of their args. So
`aggregate({ _count: true, onlyDeleted: true })` answered the count of the LIVE
rows and `onlyTemplates` counted the instances: the opposite of the question
asked, from the two methods whose whole output is a number nothing can
cross-check against a list. Found by asking the same question of both families
at once, which is also why it is one fix rather than a template bug.

`@@hasTemplates` is documented now — `docs/schema.md` § Templates. It appeared
in no file under `docs/`, which is why there was no intent to check any of this
against.

## 2026-08-15 — `@system`, the column an application writes and its caller does not

Nothing in a schema could say *the system writes this*. So a form generated from
the schema offered a person a text box for a tracking code a courier job would
overwrite a second later, and a model whose REQUIRED columns are server-side
could not be created from a browser at all — validation refused before the
request, naming fields the caller was never meant to send, which renders as
*the button does nothing* (`FJS-095`, ruled as `FJS-D22`).

`@system` is the orthogonal sibling of `@guarded`:

|            | read        | write       |
| ---------- | ----------- | ----------- |
| `@guarded` | system only | system only |
| `@system`  | anyone      | system only |

**The write is refused by name, not dropped.** The client is told `readOnly` and
a generated form does not offer the column, so a payload naming it is code that
meant to write it — and a silent drop is the shape being fixed. A field
`@allow('write', …)` still drops, and must: there the same payload is legitimate
for another caller, which is why basecamp's three `auth().isSystemAdmin` columns
keep round-tripping unchanged through an ordinary member's profile save.

**The fill path is a per-call hatch, not `asSystem()`:**

```js
db.order.update({ where: { id }, data: { trackingCode }, system: ['trackingCode'] })
```

One column is unlocked; the gate, the row policies, soft-delete and the audit
actor all still apply. `asSystem()` writes the same value by dropping every one
of them. Naming the field IS the statement — an escape hatch may not disable a
guarantee silently. It threads through create, createMany, update, updateMany,
upsert and upsertMany.

**A `@system` column is never in create-mode `required`.** It is still NOT NULL
in SQLite, so an application that forgets to fill one fails at the write with a
message that says which side is missing — *"tokenHint is @system and was not
supplied — the application fills it, with `system: ['tokenHint']` on the call"* —
rather than the browser refusing a create it was never responsible for.

Also: `@guarded(all) @system` is now spellable, which is the combination
`FJS-235` recorded as impossible — a column invisible to a client AND unwritable
by one. `@allow('write', …)` beside `@system` is refused by name, as is `@system`
on a `@computed`/`@generated`/`@from` field, which has no write to lock.

18 tests. Nothing above litestone refuses it earlier and nothing should:
Junction's `autoValidate` does not read `readOnly`, and must not start —
`@version` is readOnly in the update schema and a patch is required to carry it
back. So this is the boundary that answers, and it answers 403.

## 2026-08-15 — a read that builds its own SQL now asks what every other read asks (FJS-262)

Found while closing FJS-215, by asking a question that had not been asked
straight: *which methods evaluate the global filter?* Two did not, and what came
out of checking the rest is worse than the filter.

**`findManyCursor` and `search()` applied neither the global filter nor the row
policy.** On a model declaring `@@allow('read', ownerId == auth().id)` and a
tenant filter, `findMany` answered one row and both of those answered all three
— another owner's row and another tenant's. Both build their own SQL rather than
going through `buildSQL`, which is the fourth time that shape has been found
missing something every other read has (`FJS-173`, `FJS-178`, `FJS-185`,
`FJS-216`).

**`aggregate`, `groupBy` and `search` never called `plugins.beforeRead`**, which
is where a `@@gate` refuses. A model at `@@gate("7")` answered a level-4
caller's COUNT, its GROUP BY and its full-text search. The row policy compiles
into the WHERE and did apply to the first two, which is exactly what hid this:
the numbers looked scoped, and the gate — the layer that refuses outright — had
never been asked.

Composed in the same ORDER `buildSQL` uses: filters, soft-delete,
`@@hasTemplates`, the caller's where, then the policy appended last as raw SQL
with its params after the cursor's. Positional binds, so the order IS the
correctness. `search` merges once and both of its steps read the same value, so
the FTS pre-filter and the row fetch cannot drift apart — and the policy is
applied at both, because the pre-filter is an optimization and the second query
is what returns the rows.

**The grid is the fix, not the two methods.** A new test seeds one model where
exactly one of three rows is visible and asks every read method — `findMany`,
`findFirst`, `findUnique`, `count`, `exists`, `findManyAndCount`,
`findManyCursor`, `search`, `query`, `aggregate`, `groupBy` — then asks all of
them again against a gate. A method added without the composition now fails
rather than being discovered by the next audit.

## 2026-08-15 — a global filter is judged in both its forms (FJS-215)

A static filter has been refused at `createClient` since 2026-08-12 when it
names something SQLite cannot filter by. The FUNCTION form takes a `ctx` and has
no answer until a query asks it, so it was judged nowhere — the whole defect
survived behind one spelling. `resolveGlobalFilter()` is now the single place a
global filter becomes a value, six evaluation sites funnelled into it, and it
applies the same rule at the first moment there is something to apply it to.

**The unknown key was the other half of it.** Excluded from the refusal in both
forms, and it is the same failure: SQLite reads an identifier it cannot bind as
a string LITERAL, so `{ nope: 'x' }` becomes `'nope' = 'x'` and empties the
model, while `{ nope: 'nope' }` becomes `'nope' = 'nope'` and hands back **every
row** past a filter that was supposed to narrow. Both forms refuse it now, with
edge namespaces folded into the legal keys the way `withArgValidation` already
folds them for a caller's `where`.

An unknown key in a CALLER's `where` still warns. That trade was ruled and the
reasoning does not carry across: a caller has a hint and a stack, and a global
filter is app configuration applied to every read of the model for the life of
the process, with nobody to warn. Tier 3 (`FJS-202`) is untouched.

## 2026-08-15 — `now()`, and the six clock spellings that are refused (FJS-226)

`DateTime` is stored as ISO-8601 TEXT — `2026-08-13T07:38:31.984Z` — and every
comparison against it is string-wise. SQLite answers `datetime('now')` as
`2026-08-13 07:38:31`: space separator, no milliseconds, no zone. `'T'` (0x54)
sorts above a space (0x20), so **every row stored today compares greater than a
same-day `datetime('now')`**. Measured on four tasks:
`where: { $raw: sql\`dueAt < datetime('now')\` }` returned the one overdue by a
day and silently omitted the ones overdue by an hour and a minute.

What makes it worth a refusal rather than a note is that it is *nearly* right,
and wrong in the direction nobody checks. It is the first spelling SQLite's own
documentation shows; a demo seeded with last week's data passes; the failure
only appears for rows inside today, on the query that matters most.

**`now()`** is the spelling that matches — exported beside `sql`:

```js
import { sql, now } from '@frontierjs/litestone'

db.task.findMany({ where: { $raw: sql`dueAt < ${now()} AND completedAt IS NULL` } })
db.task.findMany({ where: { $raw: sql`startedAt > ${now('-7 days')}` } })
```

It emits `strftime('%Y-%m-%dT%H:%M:%fZ','now')` rather than a JS timestamp, so
every occurrence in one statement is the same instant — SQLite fixes `'now'` for
the duration of a statement, which two `new Date()` calls cannot promise. The
consequence, stated in the docs: `createClient({ now })` does not reach it. That
clock belongs to the policy evaluator; a test needing a frozen instant in a raw
predicate binds its own ISO string.

Modifiers are **bound**, not spliced: `strftime` takes them as parameters, so a
caller-supplied `'-7 days'` never enters the SQL pattern and Invariant 8 holds
inside the escape hatch. That is what a fragment is — litestone's own SQL, the
only thing the `sql` tag splices instead of parameterising, and nothing built
from caller text can be one.

`now()` also works written as a **token** in raw SQL — `where: "dueAt < now()"`
in a `@from`, or a plain-string `$raw` — because those two callers cannot
interpolate, and a refusal naming a spelling the caller cannot write is a
refusal that does not help.

**Six spellings are refused by name**: `datetime('now')`, `date('now')`,
`time('now')`, `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME` — each
produces a format no stored `DateTime` can equal, so a comparison against one is
not a filter returning too few rows, it is a filter answering a different
question. Checked at all three doors raw SQL comes through: the `sql` tag, a
plain-string `$raw` (which skips the tag, and is the form written when there is
nothing to interpolate — exactly the shape of the bug), and a `@from(where: …)`
string, which is refused at `createClient` because the subquery is built once at
startup and that is the last moment anything reads it.

**`julianday()` and `unixepoch()` are untouched.** They answer numbers, so
`julianday('now') - julianday(createdAt) > 30` compares like with like — the
date-arithmetic example in `docs/filtering.md` was always correct. `strftime` is
untouched too: its format string is the caller's to get right, and getting it
right is what `now()` is.

Also fixed while here: the `_litestone_seeds` ledger stamped `appliedAt` with
`datetime('now')` while `_litestone_migrations` stamps `new Date().toISOString()`
— two ledgers answering *when did this run* in two formats, which sort against
each other wrongly the moment anything reads both. Now ISO on both.

`docs/gotchas.md` taught the broken spelling in two worked examples; it and
`docs/filtering.md`, `docs/access-control.md` and both `CLAUDE.md`s now teach
`now()`.

## 2026-08-15 — the array rules join every other rule (FJS-194)

`@minItems`, `@maxItems`, `@uniqueItems` and the `Int[]`/`String[]` element
checks were enforced inline in `client.js`'s `writeData`, with their wording
built at the throw site — the one family that did not go through `validate.js`.
Two things followed. An authored `@minItems(2, "Pick at least two tags")` parsed,
stored, and reached the browser through `x-messages`, where Sierra refused the
write saying *Pick at least two tags* — while the server refused the same write
with *tags must have at least 2 item(s)*. So a caller who bypassed the form saw
wording nobody wrote, and *one authored string, all three realms* was false for
this family alone. And with no entry in `DEFAULT_MESSAGES` there was no default
for `x-messages` to fall back to either.

The five rules are now `VALIDATORS` + `DEFAULT_MESSAGES` + a `validateField`
case like every other rule, and `writeData` calls `validate()` and nothing else.
Consequences beyond the message:

- **`@uniqueItems` takes a message now.** It was the only validator that did not,
  which made *every validator takes an optional trailing message* untrue in the
  documentation. `parseOptMessage` already existed for `@email` and friends.
- **The default wording lost its field-name prefix** — `must have at least 2
  item(s)`, not `tags must have at least 2 item(s)` — because that is the shape
  every other rule in the table has and the path already carries the field.
- **All the array errors come back at once.** The inline block threw on the first
  one; a `ValidationError` from `validate()` carries every failure.
- **`buildValidationMap` flags a model with any array field.** The inline checks
  ran unconditionally, and `validate()` does not — a model whose only rule was a
  bare `String[]` would have silently stopped being checked.
- **`generateValidationCases` reads the table** instead of restating the wording.
  That second copy is what noticed this: the generator had to hand-write what the
  server said, and writing it down is what showed it did not match the client.
- `uniqueItems` joined the `x-messages` keyword table in `jsonschema.js`, so an
  authored message is keyed by the JSON Schema keyword as well as the rule name.

## 2026-08-15 — `litestone release`, the pivot classifier

A deploy replaces code and does not replace the rows already written, so the
question it has to answer is not *is this migration reversible* but **can
Release N-1 and Release N serve one database at once**. Every deployment system
surveyed ships a rollback that restores code and nothing else, and the reason is
that none of them can see the shape of the change. We can: the schema is a file
we parse.

`src/release.js` derives the **release surface** — every model with its table,
gate, fields, defaults, constraints, row policies and state transitions — and
`classifyPivot(before, after)` answers **expand** (N-1 keeps serving, so the
deploy can be taken back), **contract** (it cannot, so that deploy is the pivot)
or **unknown**, which counts as a contract because a wrong *reversible* is the
only answer that costs anything.

Two halves of it are things no generic deployer can reach. **Access is a
compatibility change**: raising a `@@gate` takes reads away from a release still
serving them, and adding an `@@allow` empties a screen with a 200 and no error.
And a **required column with no default** is the one contract with a supported
alternative, so it is not merely refused — the three steps come back with it:
declare it optional and deploy, backfill, declare it required and deploy again.

`litestone release` writes `release.snapshot.md` beside the schema and classifies
against `HEAD`; `--from v1.4.0` asks the question a deploy asks. `--check` is
staleness alone, which is what the snapshots CI phase reruns out of the file's
own header — a check that also needed git would fail in a tarball rather than in
a repository. `--strict` exits 1 on anything but expand, **including no baseline
at all**: it asks for a reversible deploy and *I could not tell* is not one.

The snapshot holds the surface and **never the verdict**. A verdict is a fact
about two schemas and the file describes one, so writing it in would make the
file depend on its own previous contents — and a file that cannot be regenerated
twice to the same bytes cannot be rechecked, which is the whole mechanism.

Falling out of it: `columnDefaultExpr()` is now exported from `core/ddl.js` and
is the one owner of *does an INSERT that omits this column succeed*. The DDL
emitter and the classifier ask the same field the same question, and a second
copy of that rule would have drifted. 31 tests; the DDL snapshots of both apps
in the repo are byte-identical across the refactor.

## 2026-08-15 — `@from(first/last)` picks under the caller's policy (FJS-224)

The subquery that resolves the id is built once when the client is created, and
a `@@allow` binds `ctx.auth` per request — so the row it picked was the newest
one that EXISTS, and the policy was applied afterwards, when the row was
fetched. An account whose newest order belongs to someone else therefore read
`lastOrder: null` even when it had older orders the caller could see: *no last
order*, where the truth was *your last order is the one below it*. A plausible
wrong answer, which is the worst kind.

The pick is now redone in `resolveFromRowRefs` whenever the target declares a
read policy: the policy goes into the WHERE and `ROW_NUMBER() OVER (PARTITION BY
<fk>)` chooses one row per parent, which is the answer a direct `findFirst`
would have given. The window runs INSIDE the policy rather than over it —
ranking first and filtering after would rank rows the caller cannot see and then
delete the winner, which is the same null wearing a second hat. Still one query
per field across every row in hand.

With no policy nothing changed: the id from SQL is already right and the cheaper
fetch-by-id runs. `@@softDelete`, `@@hasTemplates` and a declared `where:` on the
`@from` all survive the repick — they are lifted out of the static subquery and
restated with the table in place of its alias, because a policy compiling
`check(parent)` names the table and an alias puts it out of scope.

The repick correlates on the column the target points back at, so
`parseSelectArg` now injects that column the way it injects an FK for a
relation: `select: { lastOrder: true }` alone still repicks, and the key does not
appear in the answer. That path is where the residue would have lived — it
fell back to the pre-policy id and nothing said so.

## 2026-08-15 — `@guarded` locks the write too (FJS-235, FJS-248)

`@guarded` stripped its column from every read and did **nothing at all** on the
way in. A `$setAuth(user)` client could create a row carrying `riskFlag: 'HIGH'`
and patch it to `'TAMPER'`; both landed, and every read back through that same
client showed the field absent. Invisible and writable at once is the
mass-assignment shape — the caller cannot see what they are overwriting, the
owner cannot see that they did — and the read strip is what kept it quiet, since
a landed write and a refused one look identical when the answer has no column.
Junction covered the HTTP door by accident (`generateJsonSchema` omits guarded
columns for the client audience, so `autoValidate` rejects the key), which left
a Caravan job, a seeder and any service writing through `ctx.locals.db` writing
it unimpeded — the API realm enforcing what the Data boundary is supposed to own.

`writeData` now refuses a non-system write that names a guarded column, with an
`AccessDeniedError` naming every field. One owner, so `create`, `update`,
`updateMany`, `upsert`, `createMany` and `upsertMany` are all covered.

**Refused rather than dropped**, which is the opposite of what a field
`@allow('write', …)` does beside it. That predicate is per-caller — the same
form body is legitimate one level up — so dropping the key is the right answer
there. Nothing may write a guarded column, so naming one is a mistake and saying
so beats silence. `@allow` still cannot sit beside `@guarded`, and that stays
the design: two answers to one question, pick the one that describes the column.

**`@encrypted` alone is deliberately outside this.** It used to imply
`guarded: 'all'` in the field policy map, which would have made every encrypted
column system-write-only and broken the ordinary case — an admin adding a secret
through a scoped client. The read strip already had its own branch for
`encrypted`, so decoupling them changed no read behavior; `@secret` synthesises
a real `@guarded(all)` and is locked both ways as before. Audit redaction asks
for `encrypted || guarded` and is unaffected (Invariant 7).

Two consequences worth knowing. A **required** guarded column now makes its
model uncreatable below level 8 — the FJS-095 shape, one layer down — and
`verifyGateLadder` reports that create column ungraded rather than reading the
field lock as a gate verdict, the same treatment a row policy already got. And a
seed or script that wrote a guarded column through the default client now needs
`asSystem()`, which is what every caller in this repo already did.

## 2026-08-14 — `verifyFieldProtection` could not build a row on a policied model

`verifyRowPolicies` learned last week that **the field a policy compares is very
often a FOREIGN KEY** — `workspaceId == auth().workspaceId` is the whole of a
multi-tenant app — so it calls `_ensureParent()` before seeding a row with the
value taken off the predicate. `verifyFieldProtection` seeds the same way and did
not, so the moment a model with a protected field also declared an `@@allow`, the
child was refused by the constraint and the whole model reported as

```
Secret — no row could be built, so none of its 1 protected field(s) were
checked: FOREIGN KEY constraint failed
```

Which is the right kind of failure — it says out loud that nothing was checked
rather than passing on an empty set — but it made the check unusable on exactly
the models that most want it. One call, the same one, in both places.

Found by declaring row-level tenancy on basecamp's `Secret`: 15 models could
carry the policy and only one of them has a `@guarded` column, so nothing before
it had put the two attributes on one model.

## 2026-08-14 — `litestone jsonschema --snapshot` — the client contract, diffable

`generateJsonSchema` is the widest bridge in the repo: Junction validates
requests against it, Sierra's `field-rules.js` re-checks the same rules in the
browser, and `<Form>` renders a control from it. Three readers, one document,
and **nothing breaks when a keyword stops being emitted** — a form just stops
validating.

`--snapshot` writes `jsonschema.snapshot.md` beside the schema: the `$defs`
table (a name that disappears is a `$ref` resolving to nothing in a browser),
every enum's values, and per model the gate, `x-version`, each relation, each
`@@transitions` move with its own gate, then one row per field — type and
default, required, `@label`, the keywords a validator branches on, and which
rule names `x-messages` answers for. Each model closes with what CREATE mode
accepts, which is the shape `FJS-095` lives in: a required column only the
server can fill is refused before the request is ever made.

A second RENDERING, not a second generator — the raw JSON is what ships, and
thousands of lines of it is where a removed keyword hides. `--check` byte-
compares, through the same `checkSnapshot()` as `access` and `ddl`.

Two emitted shapes the first draft got wrong and now reads: a nullable
`DateTime` arrives as an `anyOf` with the format on the branch, and a `Json`
column carries no `type` at all.

## 2026-08-14 — a string operator on a column that is not text

`FJS-210`. `{ tags: { contains: 'x' } }` on a `String[]` compiled to `LIKE '%x%'`
over the stored `["x","y"]`, so it matched — and matched `["xylophone"]` too,
while `contains: '","'` matched every array of two or more elements and
`contains: '['` matched all of them. It looked like `has` and was a substring
search over a serialization; the cases where the two agree are exactly the ones
that hid it. On a `Boolean` the same operator answered `[]`, silently, because
the value is stored as 0/1.

Refused now, naming the operator that was meant — array (`has`), `Json`
(`@type(...)` and a path), `File`, `Boolean`. **`Int` and `DateTime` keep the
answers they already gave**: SQLite's coercion answers what was asked, and
`{ when: { contains: '2024-01' } }` against an ISO column is a real way to ask
for a month. A path INTO a typed `Json` column is untouched — that operand is
text.

**One map, not one per question.** `buildWhere` already took an `arrayFields`
set for a different reason (a bare array means `IN` on a scalar and `hasSome` on
an array column — the operand cannot say which). That set is now a
`fieldKinds` Map of what the column HOLDS, which is the same fact both questions
need, so the builder's signature did not grow and `buildArrayMap` is gone rather
than sitting beside a second map of the same thing.

**Both `where`-clause refusals are `ValidationError`s now**, the array-operator
guard included. Junction maps the name to a 400; they were bare `Error`s, which
is a 500, and a 500 says the server broke when the caller asked for something
the column cannot answer.

The six `210:ref` cells in `test/matrix.test.ts` are promoted to `ref`.

## 2026-08-14 — a key rotation carries every reversible column, or refuses

`FJS-253`, found while pinning `FJS-236` and the larger half of it. `$rotateKey`
re-encrypted `@secret(rotate: true)` fields and then swapped the client's key for
**all** encryption. Measured across five column kinds, four broke:

```
@secret                  rotated     reads "T"
@secret(rotate: false)   untouched   reads null
@encrypted               untouched   reads null
@encrypted(det: true)    untouched   reads null, filters 0 rows
@hashed                  untouched   matches 1 -> 0, permanently
```

Not a stale-key artefact — the bytes on disk were never rewritten, so a brand-new
client with the new key could not read them either.

Rotation now carries every key-reversible column, and **refuses before the first
write** when the schema declares one it cannot. A rotation that rewrites half a
database and then complains leaves it in two keys with nothing recording which
rows are in which.

```js
await db.$rotateKey(newKey)
// Error: $rotateKey would leave 2 column(s) unreadable and has rotated nothing:
//   User.pw     — @hashed — one-way, there is no plaintext to re-key …
//   User.legacy — @secret(rotate: false) — declared excluded from re-encryption
// Pass { orphan: ['User.pw', 'User.legacy'] } to accept that deliberately.
```

`orphan` is a **list of names, not a boolean**: a column added later must not
inherit an acknowledgement made for a different one. `classifyForRotation()` is
the one answer to *can rotation carry this column*, asked by the refusal and by
the loop, so the two cannot disagree about which columns exist.

**`@secret(rotate: false)` keeps its name and loses its promise.** The docs said
it stays *bound to the original encryption key*; one client holds one key and
nothing retains the old one, so it never did. It is now documented as what it is —
excluded from re-encryption, and unreadable after a rotation.

A deterministic column stays FILTERABLE across a rotation, not merely readable:
the where-encoder encodes its operand with the key before comparing, so a column
re-encrypted in the wrong mode answers 0 rows with a 200 and no warning.

## 2026-08-14 — the encryption key is a cell, not a copy

`FJS-236`. `$rotateKey` ended with `ctx.encKey = newKey` on the root context, and
every derived client is a spread of it. A spread copies a string by value, so the
rotation reached the root and no client already handed out — and `read()`'s catch
turned the resulting GCM failure into `null`, so the field read as **empty**
rather than as broken.

```
ctx.enc = { key }        one object, shared by reference through every spread
```

Read at all ten sites (`client.js` x8, `policy.js` x2). One assignment now
reaches `asSystem()` — memoised in `_systemProxy`, so it stayed wrong forever —
`$setAuth()` and `$scopedBy()` alike, and a context added later inherits it
without anyone remembering to propagate.

`$setAuth` is not memoised, which is why a client made AFTER a rotation always
worked and one made BEFORE did not. That is the difference that made this look
intermittent.

**The suite passed over it** because the only assertion was that the ciphertext
had CHANGED — which a rotation that scrambled every row beyond recovery also
satisfies. It reads the value back now, and three tests pin the derived clients;
two were confirmed to fail against a simulated copy-by-value before being kept.

**`FJS-253` is underneath this and is the larger half**: `$rotateKey` rotates
`@secret` fields and swaps the key for *all* encryption, so a plain `@encrypted`
column keeps ciphertext written under the old key and becomes unreadable and
unfilterable. Pinned as asserted-still-broken.

## 2026-08-14 — a column whose stored text is a storage detail is not a sort key

`FJS-200`. `orderBy: { words: 'asc' }` on a `String[]` reached SQLite as an
`ORDER BY` over the stored document, so rows came back ordered by the string
`["x","y"]` — `[10]` before `[9]`, and a re-serialized row moving for no reason.
`$checkOrderBy` answered `[]`, *no problems*, so Junction's `autoSort` passed it
through and no boundary refused it either.

`sortableKeysFor()` split a model's keys three ways — sortable, relations,
computed — and an array column fell into `sortable` by default. It now has a
fourth bucket, `reason: 'opaque'`:

| Kind | Ordering by its text means |
| --- | --- |
| `String[]` · `Int[]` · `Enum[]` | the JSON document |
| `Json`, typed or not | whichever key serialized first |
| `File` | the storage reference |
| `@encrypted` | ciphertext — stable only where the IV is derived from the value |
| `@hashed` | the digest |

**`File` was added on the row's own principle** rather than named by it: the
stored value is a reference document, which is the same failure wearing a
different type. Sorting *within* an array stays undefined, deliberately — the
question was only whether the column may be a sort key at all.

This is the rule `docs/sorting.md` already stated for `@computed` and never
applied here: a bad sort key returns the right rows in the wrong order, which
nothing can see, so it throws rather than warning.

Junction reads the new `reason` and says its own sentence, so a 400 still
separates *no such field* from *not a sort key* — `$checkOrderBy` is a bridge and
both sides moved together.

**One regression, caught by the existing suite.** An implicit many-to-many
(`tags Tag[]`) is an array in the AST and a join table in SQLite, so the array
bucket took it and `orderBy: { tags: { _count: 'asc' } }` stopped compiling. It
is claimed as a relation first now, where `buildRelationOrderBy` owns the
grammar.

The eight `200:ref` cells in `test/matrix.test.ts` are promoted to `ref`.

## 2026-08-14 — `litestone types` emitted a client no app could use

Found by wiring it into basecamp, which is the first app to use it. Four
defects, each one enough to send an app back to `any`:

- **`TableClient` was missing six methods a real accessor has** —
  `findManyAndCount`, `exists`, `aggregate`, `groupBy`, `query`, `transitions`.
  basecamp calls `exists` 16 times and `findManyAndCount` 12, so the generated
  file typed 28 correct calls as errors. A .d.ts that is missing a method is
  worse than no types: the app either casts the client back to `any` — losing
  everything the file was for — or stops regenerating it.
- **`LitestoneClient` was missing six members** — `$scopedBy`, `$checkWhere`,
  `$checkOrderBy`, `$rotateKey`, `$rawDbs`, `$walStatus`. The two `$check*` are
  the seam Junction's `autoFilter`/`autoSort` are built on.
- **`CreateClientOptions` declared `onEvent` twice** — a TS2300 that makes the
  whole file unusable — and named `encryption: { key }`, which `createClient`
  does not destructure. The real option is `encryptionKey`, and the wrong shape
  is an app that boots with no key and fails on its first `@secret`.
- **A nullable column was typed `T` on write, so clearing one did not
  typecheck.** An explicit `null` CLEARS and absent leaves the column alone
  (Invariant 9) — the one way to clear a field was a type error. Create and
  Update now emit `field?: T | null` for a nullable column, and a required
  column stays required.

Three tests hold it: two ask a LIVE client what it has and require the emitted
interface to declare each name — a method added to the client and not to the
generator now fails — and one pins the options shape, including that no key is
emitted twice.



## 2026-08-14 — `litestone ddl`, and a snapshot that names its own generator

The access snapshot's sibling. `litestone ddl` writes `ddl.snapshot.sql` beside
the schema — every `CREATE TABLE`, index, FTS table, `updatedAt` trigger, join
table and view, one section per declared database, with `jsonl`/`logger` named
and skipped. `--check` byte-compares the committed file the way `access` does;
both now go through one `checkSnapshot()` rather than two copies of the diff.

Access covers a rule nothing below the API can show you. This covers the
opposite: a name everything above it binds to. Columns are emitted verbatim
camelCase and `DateTime` as ISO-8601 TEXT, and an app's own tests go through the
client that changed with the emitter, so a renamed column is invisible in the
app it breaks.

**Both snapshots now carry a machine-readable header** — `<!-- generated by:
litestone access --schema schema.lite -->`, `-- generated by: litestone ddl
--schema schema.lite`. `scripts/ci.mjs`'s `access` phase was one hardcoded
command; it is now `snapshots`, which walks every committed `*.snapshot.*`,
reruns the command in its header with `--check` from the file's own directory,
and refuses a command that is not a known binary with a shell-free argv. A new
kind of snapshot costs a generator, not a CI edit.


## 2026-08-14 — Studio shows the access surface, and says when it has drifted

`deriveAccess()` already returned the whole access surface as an object and had
exactly one reader — the committed `access.snapshot.md`. That file is good at
being **reviewed** (the `access` CI phase byte-compares it, so a widened gate
arrives as a diff) and bad at being **read**: 37 rows of `"4.4.4.5"` answers
*what does this model require* and never *what can a level-4 caller do*.

**`GET /api/access`** is `deriveAccess()` and nothing else. **Access** panel,
four views over that one payload: the gate matrix as a grid, policies shown
beside the gate they compose with, protected fields, and **By level** — pick a
standing 0–8 and see the whole schema from it, computed with the same
`expectedVerdict()` the gate ladder is graded against.

**`GET /api/drift`** and a header badge, answering three questions kept apart
because one "out of date" would blur them: has the schema **file** changed since
Studio parsed it, is the committed **snapshot** still true, are there **pending**
migrations. The first matters most and was invisible: Studio parses once at boot,
so a schema edited in an editor left every panel describing the previous version
with full confidence. Both the badge and the access panel now read through
`currentSchemaParse()`, which re-parses only when the bytes differ and keeps the
last good parse through a half-typed edit.

**No "regenerate snapshot" button, deliberately.** The committed file is a review
artefact; one click that rewrites it to match whatever the schema now says turns
that review into a formality. The badge hands back the command instead.

Found while building it: **Studio never opened the panel its URL named.**
`showTool` was bound to `hashchange` only, so a fresh load of `#query` showed
Browse while the hash sat there disagreeing — against the file's own note that
*"a Studio link can name the panel it opens"*.

`bun run verify:studio` drives all of it in a real Chrome against a real server —
21 assertions, starts and stops its own studio.


## 2026-08-14 — `studio --port=0` binds a free port and says which one

`FJS-213`. `cmdStudio` printed the port it was ASKED for, so `--port=0` announced
`http://localhost:0` — a URL nothing can reach, describing a server that is up.
It prints `server.port` now.

That makes 0 the right thing for a test to ask for, which is what the defect was
about: `cli-smoke`'s studio test picked `5100 + Math.random() * 800` from a range
nothing reserves, and lost the draw twice in four `bun run ci` runs while passing
3/3 alone. A fixed number would only move the collision.

## 2026-08-14 — a migration file the name pattern rejects is named, not skipped

`FJS-193`. `listMigrationFiles` matches only litestone's own
`<14-digit>_<lower_snake_label>` name, and `apply()` read the empty list it
returns as *there are none* rather than *none of these matched*. A directory
holding one real, hand-named migration therefore reported `✓ no migration files
found` and exited 0 — a fresh deploy starting against an empty database and
saying so in the affirmative.

The pattern is not loosened: the ordering guarantee comes from the timestamp.
What changed is that the rejects are now visible.

```
unmatchedMigrationFiles(dir)   every .sql/.js MIGRATION_FILE turned down
describeSkipped(files)         one sentence, so apply/status/verify agree
```

`apply()` carries `skipped` on every return and sets `unmatched: true` when the
directory held candidates and none matched — a **refusal**, which the CLI prints
as `✗` and exits 1 on. The two used to share one tick and one exit code. A
misnamed file beside three valid ones is reported too, because silence one file
at a time is the same omission. `status()` gives it a `skipped` row; `verify()`'s
drift branch names it, since a skipped migration is the likeliest explanation for
a drift nothing else accounts for.

**`createTestEnv` reads the directory more loosely on purpose, and now says so.**
It replays a hand-named `001_initial.sql` because a person meant it; it warns once
per file that `migrate apply` will not. The two readers disagreeing was the state
this defect lived in — a suite green against a database no deploy could build.


## 2026-08-14 — `db/` is a default location for the schema and the config

`litestone access` run from `packages/basecamp` reported *No schema found* about a
schema that was plainly there. An FJS app keeps the Data realm in `db/` (root
`README.md` § Project Structure), so an app root is the obvious place to run these
from — and resolution looked in the cwd and stopped, one directory too high.

Two probes added, cwd still first so an app that puts either at its root wins:

```
schema:  --schema  →  config schema:  →  beside the config  →  ./schema.lite  →  ./db/schema.lite
config:  --config  →  ./litestone.config.js  →  ./db/litestone.config.js
```

The config probe matters as much as the schema one: basecamp's `litestone.config.js`
is in `db/`, so finding it also resolves `db:` and `migrations:` rather than the
schema alone. The *No schema found* message now names all four places it looked —
it listed three, and the one people expected was not among them.

## 2026-08-14 — a policy may compare an encrypted column

`FJS-214`. `@@allow('read', owner == auth().email)` over an encrypted `owner`
emitted `"owner" = ?` bound with the plaintext address while the column held
ciphertext, so the owner read their own row and got `[]`. It failed **closed**,
which is why it survived: a model that denies every row to every caller looks
exactly like a table with no data.

A `where` had never had the problem, because `buildWhereWithEncryption` rewrites
the operand to the encoding the column uses before comparing. `policy.js`
contained no reference to encryption at all — the same translation, made in one
place and not the other.

**`comparisonEncoderFor()` is now the one owner of that translation**, in a new
`src/core/encryption.js` that also holds the primitives client.js used to keep
private. Both callers ask it rather than deciding: `rewriteEncryptedWhere` for a
filter, `compileSql` for a predicate. They cannot drift apart again, and the
encoder is chosen once per column kind rather than twice.

So a policy over `@hashed` or `@encrypted(deterministic: true)` answers, on
every operation that compiles to a WHERE:

```
model Doc {
  owner String @hashed
  @@allow('read',   owner == auth().email)
  @@allow('update', owner == auth().email)
}
```

**The startup refusal stays for the shapes an encoding cannot answer, and now
says which one.** Plain `@encrypted` stores a random IV, so the same value
writes different bytes every time and no operand can be encoded to match it; an
operator other than `==` / `!=` asks for ordering neither encoding preserves;
and a column compared against a column has no value to encode. Before, the check
refused the mere presence of the field, which is why the two modes that do work
were refused along with the one that does not.

`create` is exempt — it is evaluated in JS against the data as written, which is
still plaintext, so every comparison form works there. `post-update` is refused
instead, and that is new: it is evaluated in JS too, but against the row read
**back**, where an encrypted column is `@guarded(all)` and stripped — so the
comparison would be against `undefined` and would roll back every write.

Verified with rows on both sides of the predicate, in both modes, plus the
`example` and `basecamp` drives and sierra's `test:safety`.

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
matter in opposite directions: serializing everything would deadlock a genuine
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

**Two behavior changes.** The target's row policy now applies, as it always did
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
which would cut branches out of the middle of a tree. And `select` is honored,
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
behavior is deliberate and asserted by a test; the page now says so in a warning
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
everything about behavior uses `actingAs`. `atLevel` opens a second client (a
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
field does not smuggle its inputs back. A bare fn keeps the old behavior and
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
normalized SQL.

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
because *I cannot judge this* is not *this is wrong*, and every flavor of client
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

It fails in opposite directions on the two flavors, and only one of them is
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

Nothing about the ORM's own behavior changed. `findMany` still warns, writes
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
operation, a cache with security-relevant behavior behind it — had been silently
skipping for three weeks. It reports **0 calls across 200 gated reads**, which is
the pass condition.

Several annotations were fossils: they described the pre-fix behavior of findings
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
unfrozen — the same *generalize the mechanism rather than add a second one* move
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
explicit request and excluding it would change behavior that predates the
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
- **`@sequence` columns are no longer emitted.** An explicit value is honored and
  moves the per-scope counter (verified), so writing one both defeats the feature
  and collides with any `@@unique([scope, seqField])` beside it.

### makeTestClient could open the project's real database

Found while running the above against `packages/basecamp/db/schema.lite`: rows
appeared in tables that should have been empty. `makeTestClient` builds a throwaway
db in a tmpdir and passes it as `db:` — but **a `database` block in the schema wins
over `db:`**, which is documented litestone behavior. So pointing this helper at a
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
validator honored them. `generateJsonSchema` emitted **none** of them, so a
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
path, one representation in the JSON Schema, and the existing behavior is
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
