---
id: json-document-writes
status: shipped
dated: 2026-09-02
---

# Idea — Patching a Json column

**Status: SHIPPED 2026-09-02**, ruled as `FJS-D176`. The record is kept for the
measurements — the DX matrix, and the verification that falsified the first
grading rule before it was built. What shipped differs from what this record
first proposed in one respect and it is named where it happened. The SILENCE this record was written
against is fixed and is `FJS-658`; two claims below were measured before that
fix and are marked where they changed. Every claim about current behavior was
measured on 2026-09-02 against `packages/litestone/src/index.js` at HEAD, with
the probe's output reproduced below rather than described. See `VERIFYING.md`.

---

## Trigger

> *In Sierra, I want to be able to "patch" a json field —
> `usersService.upsert({ id, "settings.commute": { source } })`. Do we support
> anything like that in Sierra? In Junction? In Litestone?*

No, in all three. What makes it worth a record rather than an answer is that
**every layer refuses it by doing nothing**, and the shapes a caller reaches for
instead each lose something the schema was holding.

## What happens today

A four-line probe against an in-memory client, one untyped `Json` column seeded
`{"commute":{"source":"x"},"theme":"dark"}`:

```
dot key    { 'settings.commute': {...} }   → {"commute":{"source":"x"},"theme":"dark"}   unchanged
partial    { settings: { commute: {...} } } → {"commute":{"source":"bus"}}                theme gone
json_set   asSystem().sql json_set(…)       → {"commute":{"source":"train"}}              works
```

**Row one is now a refusal** (`FJS-658`, fixed 2026-09-02): the Data boundary names
the column and says a write takes the whole document. Rows two and three stand.

Three layers strip the dot key and none of them can see the other two doing it:

- **Sierra** — `stripReadOnly` takes a KEEP list and leaves a key with no field
  rule behind it alone, deliberately, because a `@transient` is legitimate and
  guessing there is how a strip breaks a working app. So the browser sends it.
- **Junction** — `createSchema` defaults `passthrough: false`; a key the
  compiled schema does not declare is silently stripped
  (`packages/junction/src/core/schema.ts`).
- **Litestone** — `writeData` strips an unknown key as mass-assignment
  protection, a deliberate policy choice recorded at the strip itself
  (`packages/litestone/src/core/client.js`).

Each strip is right about the case it was written for. Together they mean a
write that names a real column with a real path is a 200 that changed nothing.
That half was a defect, is `FJS-658`, and is fixed — litestone refuses by name and
junction carries the key to it rather than stripping it first. **This record is
about the feature underneath**, which is that there is still no spelling for the
write, so the refusal's own advice is read-modify-write: two statements, and it
races.

## What is already right, and is the reason this is smaller than it looks

**A `Json @type(T)` column already refuses a partial document by name.** Same
probe, typed:

```
typed partial → ValidationError: settings.theme: is required
```

So the silent-replacement half of the problem exists only on an **undescribed**
`Json` column — which `litestone advise` already reports as *a Json column
nothing describes* (`opportunities.js`), and which `CLAUDE.md` § Live hazards
now states outright. A schema that says what the document is is already safe
against the worst reading of a partial write. What it is not is *convenient*:
the price of the safety is that every partial change reads the row, spreads it
and writes the whole document back.

**The read side already has paths.** A typed column compiles
`where: { settings: { theme: 'dark' } }` down to `json_extract`, nested as far
as the types go (`packages/litestone/docs/json-types.md`). The asymmetry is
writes only, which is what makes the gap feel like an omission rather than a
position.

## The DX, end to end

Everything in the **today** column was run on 2026-09-02 against an in-memory
client and the output pasted. Everything in **proposed** is unbuilt.

The model both columns use:

```
type Commute { source String?  minutes Int? }
type Settings {
  theme    String
  commute  Json? @type(Commute)
  tags     String[]
}

model Account {
  id       Int  @id @default(autoincrement())
  name     String
  settings Json @type(Settings)     // described
  loose    Json @default("{}")      // undescribed
  rev      Int  @version
}
```

### Create — a document is a value, and it is whole

```js
await db.account.create({ data: {
  name: 'a',
  settings: { theme: 'dark', commute: { source: 'bus', minutes: 20 }, tags: ['x'] },
  loose:    { a: 1, b: { c: 2 } },
}})
```

Measured:

| | |
| --- | --- |
| full document | stored verbatim |
| missing a required type key | `ValidationError` — `settings.theme: is required` |
| unknown key, strict type | `settings.nope: unknown field — type Settings has no 'nope' (set strict: false to allow)` |
| `Json?` omitted | `null` |
| undescribed column omitted | its `@default`, `{}` |
| a bare scalar or array | stored — `Json` is any JSON value, not only an object |

**Nothing changes on create and nothing should.** There is no stored value to
merge into, so an operator here is a caller who thinks they are updating —
which is what `create` already says, by name:

```
"increment" changes a value that is already there, so it belongs on update,
not create. State the value itself
```

`$merge` inherits that refusal unchanged.

### Update — whole today, and the two columns behave differently

```js
await db.account.update({ where: { id }, data: {
  settings: { theme: 'light', commute: { source: 'car' }, tags: [] },
}})
```

| | today |
| --- | --- |
| whole document | replaces |
| **partial, described column** | **refused** — `settings.tags: is required` |
| **partial, undescribed column** | **replaces, silently** — `{a:1,b:2}` + `{a:9}` = `{a:9}` |
| `null` on a `Json?` | clears the column (Invariant 9) |
| a path key | refused by name (`FJS-658`) |
| `push` on an array INSIDE the document | refused — an operator applies to a column |

The middle two rows are the whole argument. **A described column already cannot
lose a key by accident**, because the type's required set catches it. An
undescribed one has nothing to catch it with, and that is the only place the
silent-replacement hazard lives.

### Upsert — refused, and for a reason worth keeping

`FJS-D54` already refuses every operator on `upsert`: the fast path SETs from
`excluded` and the slow path calls `update()`, so one could apply the operator
and the other could not. Measured:

```
upsert + increment -> "increment" changes a value that is already there, so it
                      belongs on update, not upsert. State the value itself
```

**`$merge` takes the same refusal.** *Merge into whatever is there, or create
this if it is not* is two different writes wearing one word, and the branch that
creates has nothing to merge into. An app that wants it writes the two calls.

### Merge — the proposal

```js
await db.account.update({ where: { id }, data: {
  settings: { $merge: { commute: { source: 'bus' } } },
}})
// SET "settings" = json_patch("settings", ?)
```

| | |
| --- | --- |
| where it applies | `update` and `updateMany` — the two the operators already take |
| where it is refused | `create`, `upsert`, `upsertMany` — no stored value |
| the SQL | one `json_patch`, no read, no round trip |
| concurrency | two callers merging different keys both land; read-modify-write loses one |
| the return | RETURNING answers the merged document, as `increment` answers the new number |
| the announcement | `update` / `scope: 'row'` **carrying the merged row**, so every open tab moves |
| `updateMany` | `update` / `scope: 'collection'` with a count — a live store reloads |
| `@version` | unchanged; a stale `rev` is still a `VersionConflictError` |
| `asSystem()` | merges, and still cannot get a value past a `@check` |
| the audit trail | `before`/`after` are the whole documents either side, as they are for any update |

**The spelling is `$merge` and not `merge`.** `extractWriteOps` reads an
operator off a plain key and skips `Json` columns deliberately, because a
document's own sub-key can be spelled `increment`. It can be spelled `merge` for
exactly the same reason. Today that skip has a cost nobody has measured:

```js
await db.account.update({ where: { id }, data: { loose: { increment: 1 } } })
// → loose is now {"increment":1}
```

That is correct by the stated rule and it is a footgun. The `$` is what removes
it, and it should be ruled rather than assumed, because it diverges from the
five operators that already exist.

### Deleting a key — the part that is not obvious

`json_patch` is RFC 7396 merge-patch, and merge-patch **deletes with `null`**:

```js
{ settings: { $merge: { commute: null } } }   // commute is GONE, not set to null
```

That is Invariant 9's word (*an explicit `null` clears*) meaning the same thing
one level down, so it is arguably consistent — and it is arguably the sharpest
edge in the feature, because the same payload means *set this to null* on a
column and *remove this key* inside a document. It has to be stated at the
operator, and on a **described** column it is also checkable: deleting a key the
type requires is refused before the write.

### Arrays — replaced whole, and there is no path-push

`json_patch` replaces an array wholesale. So:

```js
{ settings: { $merge: { tags: ['a', 'b'] } } }   // the whole list
{ settings: { $merge: { tags: { push: 'c' } } } } // NOT a thing — `push` is a column operator
```

The second is worth refusing by name rather than storing `{push:'c'}` as the
value of `tags`. An array inside a document is a value; `push` applies to an
array COLUMN, which is a different thing that happens to look the same.

### Reading — and why the symmetry argument does NOT decide it

An earlier draft of this record argued the design from the read side:

```js
// described — a path, compiled to json_extract
await db.account.findMany({ where: { settings: { commute: { source: 'car' } } } })   // works

// undescribed — refused BY NAME
await db.account.findMany({ where: { loose: { a: 9 } } })
// → "loose" is an untyped Json column, so there is no declared shape to traverse
```

— *you can traverse the shape you declared*, so `$merge` should work on a
described column and be refused on an undescribed one.

**That argument is wrong and it is worth writing down why**, because it is
seductive and it survived two drafts. The read refuses because it cannot
COMPILE: SQLite comparison semantics depend on the type, so `loose.a = 9` has no
single meaning without a declared shape. **A merge needs no type knowledge at
all** — `json_patch(col, ?)` operates on any JSON — and an undescribed column
has no invariant a merge could break. Measured, every one of these stores:

```
add a key · replace nested · delete with null · replace an array · deep create
```

The two refusals are not one rule seen twice. They are two different reasons
that happen to fall on the same column kind for reads, and only one of them
applies to writes.

**So `$merge` belongs on both**, with the described column getting the extra
grading described below. That is strictly better than either earlier position:
it works everywhere, and it is safer exactly where more was declared.

`orderBy` on a `Json` column is refused by name in both cases, and stays so.

### The form — the finding that is bigger than the operator

A `Json @type(T)` column reaches the browser with its shape **fully described**:

```json
"$defs": { "Settings": {
  "type": "object", "title": "Settings",
  "properties": { "theme": {"type":"string"}, "count": {"type":["integer","null"]} },
  "required": ["theme"], "additionalProperties": false
}}
```

and `controlFor` answers, measured:

```
settings   type: object   control: "json"      ← a raw document editor
loose      type: null     control: "json"      ← a raw document editor
```

**The described column and the undescribed one get the same control.** A person
edits raw JSON in a textarea for a shape the schema completely describes — no
labels, no per-field validation, no required marker, and a typo is a
`ValidationError` on submit rather than a red box on the field.

This matters here rather than being a separate note, because **a generated
fieldset would naturally produce a partial document** — that is what a form
under `only`/`except`, or a screen editing one section of a settings page,
hands back. So *generate controls from a type* and *merge a partial document*
are the same feature seen from two ends, and building the write half first is
what makes the read half safe to build later.

Not proposed here, and it is the obvious next question: a `Json @type(T)`
column could render as a nested fieldset over `$defs.T`, with the write going
back as `{ $merge: … }` for the keys the form actually holds.

### What the transport does — measured, and it is nothing

`autoValidate` passes any object through for a `Json` field; litestone owns
typed-JSON validation. So `{ settings: { $merge: … } }` reaches the Data
boundary over HTTP and WS unchanged, and the operator needs no transport work:

```
whole document      -> passed: {"settings":{"theme":"d"}}
$merge shaped       -> passed: {"settings":{"$merge":{"theme":"d"}}}
partial (no theme)  -> passed: {"settings":{"count":3}}   ← 400 comes from litestone
```

That closes what this record listed as open question 3.

### The shapes that stay the caller's

- **A read-modify-write is still correct** and is what the `FJS-658` refusal
  advises. It is two statements and it races; `$merge` is the version that does
  not. Both stay legal.
- **`asSystem().sql json_set(…)`** stops being the only way to do this, and it
  should stop being used for it: it enforces no gate, no row policy and no
  `@version`, and — the part that bites — **it announces nothing**, so a merged
  row reaches no open tab.
- **Promoting the key to a column** is still the right answer whenever the app
  filters, sorts, indexes or shows it. `example`'s slot pool over
  `Customer.fields` is that, built. A record proposing a merge operator without
  saying so is selling the wrong half.

## The matrix

Every cell was run on 2026-09-02 and the refusal text is the real one, trimmed.
Written while `$merge` was still a proposal; it has since shipped, and its row is
marked.

### What a payload form does, per operation

| payload form | `create` · `createMany` | `update` · `updateMany` | `upsert` · `upsertMany` |
| --- | --- | --- | --- |
| whole document | **stores** | **replaces** | **both branches** |
| partial, `Json @type(T)` | ✗ `settings.theme: is required` | ✗ `is required` | ✗ `is required` |
| partial, `Json` (undescribed) | **stores** — it *is* the document | ⚠ **replaces, silently** | ⚠ **replaces, silently** |
| `null`, nullable column | **clears** | **clears** | **clears** |
| `null`, required column | ✗ *is required* | ✗ `NOT NULL constraint failed: a.typ` | ✗ same |
| path key — `'settings.commute'` | ✗ path refusal (`FJS-658`) | ✗ path refusal | ✗ path refusal |
| operator on a numeric/array column | ✗ *belongs on update, not create* | **applies** | ✗ *belongs on update, not upsert* |
| operator-shaped object on a `Json` column | ⚠ **stored as the document** | ⚠ **stored as the document** | ⚠ **stored as the document** |
| **`$merge`** — shipped | ✗ *nothing to merge into* | **✓** | ✗ *two writes in one word* |

Three cells carry a ⚠ and they are the whole case for the operator:

- **partial into an undescribed column replaces it** — `{a:1,b:2}` + `{a:9}` =
  `{a:9}`, no warning. The only place the silent-loss hazard lives; a described
  column's required set already catches it.
- **an operator-shaped object on a `Json` column is a VALUE** —
  `{ loose: { increment: 1 } }` stores `{"increment":1}`. Correct by the stated
  rule (`extractWriteOps` skips `Json` columns, because a document's own key can
  be spelled `increment`) and a footgun. This is why the operator must be
  `$merge` and not `merge`.
- **a required `Json` column set to `null`** answers SQLite's own sentence,
  naming a physical table (`a.typ`) rather than the field. Cosmetic, and the
  same class the unique-conflict translation already fixed elsewhere.

### What `$merge` does to a value, by what the patch holds

`json_patch` is RFC 7396 merge-patch. Measured against real SQLite:

| patch holds | target | result |
| --- | --- | --- |
| a scalar | anything | **replaces** |
| an object | an **object** | **merges, recursively** — `{a:{x:1}}` + `{a:{y:2}}` = `{a:{x:1,y:2}}` |
| an object | **null or absent** | **REPLACES** — `{a:null}` + `{a:{x:1}}` = `{a:{x:1}}` |
| an array | anything | **replaces whole** — no element merge, no path-push |
| `null` | anything | **DELETES the key** — `{a:1}` + `{a:null}` = `{}` |
| `{}` | anything | no-op |

Row 3 is the one that falsified the original design claim, and row 5 is the one
that will surprise a caller: `null` inside a patch does not set a key to null,
it removes it — Invariant 9's word meaning the same thing one level down.

### How a patch is graded, and by what

Static — decided from the schema, never from a read of the stored row.

| the column / field | graded as | why |
| --- | --- | --- |
| `Json` — undescribed | **not graded** | no declared shape, so no invariant a merge can break |
| `Json @type(T)` — required column | **partial** | the column is NOT NULL, so a valid row always holds a valid `T` |
| `Json? @type(T)` — nullable column | **create** | may stand at `null`, and `json_patch` replaces a null target |
| a **required** field inside `T` | **partial** | present in every valid parent, by induction |
| an **optional** field inside `T` | **create** | may be absent, so the patch replaces rather than merges |

*Graded as partial* — every key the patch names is checked against `T`'s rules;
absent keys keep their stored value; a `null` on a key `T` requires is refused.
*Graded as create* — the same, plus every required key of that type must be in
the patch.

Verified: **0 unsound over 90 (stored × patch) pairs at three levels of
nesting**, 3 conservative refusals, all of them a partial patch into an optional
nested object that happened to be present.

### What each write costs and announces

| | statements | races | announces | live tabs |
| --- | --- | --- | --- | --- |
| read-modify-write in a service | 2 (+ a transaction) | **loses a concurrent key** unless `@version` | `update` / `scope: 'row'` + the row | update |
| **`$merge` on `update`** | **1** | **cannot** — two callers merging different keys both land | `update` / `scope: 'row'` + the merged row | update |
| **`$merge` on `updateMany`** | 1 | cannot | `update` / `scope: 'collection'` + a count | **reload** |
| `asSystem().sql json_set(…)` | 1 | cannot | **nothing** | **stay stale** |

`@version` is unchanged by any of it: a stale `rev` is still a
`VersionConflictError`, and `asSystem()` skips that check by design, as it does
for every write.

## The claim, verified

Open question 1 was *verify before anything else*: **the result of a merge is
still `T` if the patch's present keys satisfy `T`'s field rules and no `null`
deletes a required key.* It was run on 2026-09-02 against real SQLite
`json_patch` for the merge and litestone's own validator for the truth — a
whole-document `update()`, because that is the only thing that answers *does
this satisfy `T`*. The rule was implemented separately and the two verdicts
compared over every (stored state × patch) pair. A pair where the rule ACCEPTS
and the validator REFUSES falsifies it.

### It is false as stated — 2 counterexamples in 68

```
stored=commute absent  patch={commute:{source:'car'}}  → settings.commute.minutes: is required
stored=commute null    patch={commute:{source:'car'}}  → settings.commute.minutes: is required
```

Both are one mechanism, and it is the thing nobody would think of:
**`json_patch` REPLACES rather than merges when the target at a path is absent
or null.** Measured directly:

```
{"a":null}      + {"a":{"x":1}}  =  {"a":{"x":1}}      ← replaced
{"a":{"x":1}}   + {"a":{"y":2}}  =  {"a":{"x":1,"y":2}} ← merged
```

So a partial patch aimed at an optional nested object is not a partial write at
all — it is a CREATE, and the keys the type requires are not optional after all.
Validating the patch alone cannot see it, because the missing keys are merely
absent, which is exactly what a partial patch looks like.

### The repair is static, and it is sound

The condition the claim was missing is not *read the stored row*. It is
decidable from the schema:

> **Grade a patch as PARTIAL where the target is guaranteed to be present, and
> as a CREATE where it may be absent.** A required field is present in every
> valid parent, by induction from the column's own type. An optional one may be
> null, and `json_patch` replaces a null target rather than merging into it.

The same rule applies one level up and that was measured too: a
`Json? @type(S)` COLUMN standing at `null` takes `{count:3}` and becomes
`{"count":3}`, refused for the missing `theme`, while the required column
merges to `{"theme":"d","count":3}` and validates.

Re-run with the repair, on a harder corpus — three levels of nesting, an
optional nested type with required keys inside, a required nested type, and a
nested type with nothing required:

```
checked 90 (stored × patch) — agree 87
UNSOUND (rule accepts, result is not T):                  0
CONSERVATIVE (rule refuses, result would have been fine): 3
```

**Zero unsound.** The three conservative refusals are all one shape: a partial
patch into an OPTIONAL nested object that happened to be present. The rule
cannot know it was present without a read, and a read is the thing the operator
exists to avoid — so it refuses, and the message can name the way out exactly
(*`commute` is optional, so this write may create it; give `minutes` too, or
make `commute` required*).

### What the verification changes

1. **The claim needed a third condition**, and it is the one that would have
   shipped as a data-corruption bug: a partial patch into an optional nested
   object writes a document the type forbids, silently, on a column whose whole
   purpose is that it cannot hold one.
2. **It is still static.** No read, so the operator keeps the property it
   exists for.
3. **The cost is real and small**: partial patches into optional nested objects
   are refused. Nothing else is.

### The finding that decides whether to build it at all

**`@type(T)` is bound to zero fields in this repo.** Measured across every
`.lite` file: `@type(` appears in none of them. The 11 `type` declarations in
`example` and `basecamp` are all service `input:` types — `SegmentQuery`,
`CheckoutDetails`, `StockReceipt` — reached through `methods: [{ input }]` and
never through a column.

Meanwhile `litestone advise` reports **24 undescribed `Json` columns on
basecamp alone**, and both apps store documents in every one of them.

So the described-column grading verified above, however sound, has **no users
today**. What has users is the undescribed column, and that is the case that
needs no grading at all. That is an argument for building the operator for both
from the start — which the retraction above already concluded on separate
grounds — and it is an argument against treating the typed grading as the
feature. It is the part that makes the feature safe for people who have
declared more; it is not the part anyone is waiting for.

## The three mechanisms, and which is which

**1. A `$merge` atomic operator.** The surface, the refusals and the SQL are the
DX section above. It is the only one of the three that is unbuilt.

**2. Promote the key to a column.** Already built and already the right answer
more often. If the sub-key is something the app filters, sorts, indexes or
shows, it is not a document key — `example` carries a POOL of twelve
`@generated` columns over a slot-keyed mirror of `Customer.fields`, because a
column is a migration and a migration is a deploy, so the divergence lives in
the binding rather than the file (`verify:custom-fields`).

**3. A service-level `patchSettings` doing read-modify-write inside
`transactional:`.** What an app writes today, and what the `FJS-658` refusal
advises. It should stay application code and never become a helper: the moment
it is a helper it is one that does not know about `@version`, about the gate, or
about whether the caller may write that sub-key — all of which the ordinary
update path already answers.

**The position this record started from is retired.** The first draft argued
`$merge` should be refused on a `Json @type(T)` column and allowed on an
undescribed one. Two things killed it: the read side already draws the line the
other way (traverse what you declared), and `validateTypedJson` can grade a
patch without seeing the result. Kept here as a note because the argument is a
natural one to arrive at twice.

## Recommendation

**Build 1 for BOTH column kinds, and say 2 loudly in the same documentation.**

An undescribed column has no invariant a merge can break, so it needs no
grading — measured. A described one is graded by the rule verified below, which
is static and costs no read. The earlier position (typed only, or undescribed
only) came from a symmetry with the read side that does not hold; both drafts of
it are retracted above.

The operator is small — one entry beside `NUMERIC_OPS`/`ARRAY_OPS`, one
`json_patch` call, a partial-mode pass over `validateTypedJson`, and the
refusals — and it inherits the gate, the row policies, the field write
predicate, the audit row, `@@log`'s before/after snapshots and **the write
announcement** for free. The announcement is the strongest argument for building
it at all: `asSystem().sql json_set(…)` is atomic and race-free today and
reaches no open tab.

| | |
| --- | --- |
| **Effort** | S |
| **Payoff** | ●●○○ — ●●●○ if the generated fieldset follows it |
| **Edge** | parity — Prisma, Drizzle and Ecto all reach for raw SQL here |
| **Realms** | D |
| **Status** | ~~idea~~ **shipped** — `FJS-D176` |

## Open questions

Three of the five were settled by the ruling and the build. **Two survive**, and
they are very different sizes.

1. ~~**Verify the partial-validation claim.**~~ **Done** — § The claim,
   verified. False as stated (2 counterexamples in 68), repaired with one static
   condition, sound over 90 pairs at three levels.
2. ~~**The `$` spelling.**~~ **Ruled** — `FJS-D176`. **But its second half is
   open and is question A below.**
3. ~~**`null` deletes.**~~ **Ruled and tested** — stated at the operator, and on
   a described column deleting a required key is refused by name.
4. ~~**`updateMany`.**~~ **Shipped and tested** — it announces
   `scope: 'collection'` with a count, so a live store reloads.

### A. Should an operator-shaped object on a `Json` column be refused?

Still true after the build, measured:

```js
await db.a.update({ where: { id }, data: { doc: { increment: 1 } } })
// → doc is now {"increment":1}
await db.a.update({ where: { id }, data: { doc: { push: 'x' } } })
// → doc is now {"push":"x"}
```

This is `FJS-D54` working as ruled — the COLUMN decides, and a `Json` column
carries objects, so these are values. It is also the exact ambiguity that forced
`$merge` to wear a `$`, and now that the `$` exists the argument for leaving the
bare spellings alone is weaker than it was: a caller writing `{ increment: 1 }`
against a document column is reaching for an operator roughly always, and gets
their document replaced by the operator with nothing said.

**The question is whether the five bare operator names become reserved keys at
the TOP LEVEL of a `Json` column's value** — refused with *did you mean
`$merge`, or is this really a document key?* — or whether that is a rule about
what a document may contain, which the schema deliberately does not have.

Cheap either way. What makes it a question rather than a fix is that refusing
narrows what a `Json` column can hold, which is the one column kind whose whole
point is that it holds anything.

### B. Does the generated fieldset follow?

**The measurement in § The form is the finding, not this operator.** A
`Json @type(T)` column reaches the browser with its shape completely described —
properties, required, `additionalProperties: false` — and `controlFor` answers
`json`, the same raw-document textarea an undescribed column gets. A person
edits JSON by hand for a shape the schema fully describes: no labels, no
per-field validation, no required marker, and a typo is a `ValidationError` on
submit rather than a red box on a field.

A `Json @type(T)` column could render as a nested fieldset over `$defs.T`, with
the write going back as `{ $merge: … }` for the keys the form holds — which is
what `$merge` was built underneath.

**Two things have to be decided before it is worth starting**, and they are the
reason this is a question and not a ticket:

- **Does a fieldset compose with `<Form>`'s existing generation?** The form
  generates one control per column over `field-rules.js`'s one table. A nested
  fieldset is a control that contains controls, which that table has no shape
  for, and `$context.form` keys errors by field name — the boundary already
  answers a path (`['typ','theme']`, measured), so something has to decide
  whether a nested control reads a path or a flattened key.
- **Is a fieldset even the right answer for the undescribed case?** It cannot
  be, since there is no shape — so `json` stays the control there, and the kit
  ends up with two controls for one column type chosen by whether `@type` is
  present. That is either exactly right or a seam that will confuse people, and
  it should be argued before either is built.

**And the adoption fact sits under both**: `@type(` is bound to zero fields in
this repo, so whoever builds B is also the first user of the declaration it
depends on.

## See also

- `FJS-658` — the dot-path key stripped in silence at three layers
- `FJS-D176` — the ruling this record is asking for · `IDEAS/overview.md` 5.26
- `packages/litestone/docs/json-types.md` — `Json @type(T)`, and the read-side paths
- `IDEAS/tenant-declared-fields.md` · `example`'s `verify:custom-fields` — mechanism 2, built
- `FJS-D54` (`DECISIONS.md`) · `FJS-D27` (`ISSUES.md`) — why the atomic operators exist at all
