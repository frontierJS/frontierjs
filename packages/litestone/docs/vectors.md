# What a row means — `@vector`

An embedding is a fixed-length list of float32 that is compared by angle rather
than by equality. SQLite has no vector type and no distance function of its own,
so the modelling question is not *what type is a vector* but *where does the
comparison run* — and the answer is not the same on a server and in a browser.
`@vector` declares the column; the engine decides which of the two comparisons
computes it.

Ruled in `FJS-D328`–`FJS-D333` and built as `FJS-1193`; the reasoning and the
measurements are `IDEAS/embedding.md`.

## The declaration

```
model Passage {
  id        Int     @id @default(autoincrement())
  documentId Int
  body      String
  embedding Bytes?  @vector(1536)

  @@gate("2")
}
```

**The dimension is the column's, stated once.** Two vectors of different lengths
have no comparison at all, so nothing downstream measures it off whatever bytes
are in hand — the ordering, the write validator and the emitted `CHECK` all read
the number from here.

**`Bytes` and not a scalar of its own.** `Embedding(1536)` would be this
grammar's first *parameterized type*, and the parameter would then have to
travel into the DDL, the migration differ, the JSON Schema, `select`, `orderBy`,
patch semantics and the audit trail. The storage already exists and only the
marker is new, which is `String @date` and `@point` a third time (`FJS-D332`).

**Optional is the normal shape.** A row whose vector has not been computed yet
is an ordinary state — a backfill in progress, a passage added before the job
ran — and it is absent from a similarity list rather than failing one.

## Retrieval is an ordering, not a verb

```js
const hits = await db.passage.findMany({
  where:   { documentId: 42 },
  orderBy: { embedding: { near: queryVector } },
  limit:   10,
})
```

**`search()` earned a verb of its own because FTS5 is a different engine on a
different table. A vector column is not** — it sits on the model's own table, so
the ordering composes with `where`, `select`, `include`, cursors, `@@softDelete`,
the tenant filter, both row policies and the gate **by doing nothing at all**
(`FJS-D333`). There is no second surface to keep in step with `findMany`'s.

That is the whole security argument for the feature, and it is the one thing an
external vector store cannot copy: a passage the caller may not read cannot
ground an answer, because the retrieval is a clause on a read the policy already
filtered. Measured, the filter is also a **speed-up** — a quarter of the rows ran
3–4× faster, so every gate in front of the scan pays for itself.

`near` takes the query vector as numbers — an array or a `Float32Array`:

```js
orderBy: { embedding: { near: await embed(question) } }
```

**It is a DISTANCE and it sorts ascending**: 0 identical, 1 orthogonal, 2
opposite.

**The number it sorted by comes back on the row, as `_distance`** — the shape
`search()` already has for `_rank`. There is no `threshold` option,
deliberately: a cosine cutoff is a number every corpus guesses differently, and
`FJS-D329` hands the app the value instead of a knob it has to invent.

```js
hits[0]._distance   // 0.0821…
```

A model that declares `@vector` may not also declare a field called `_distance`;
the parser refuses the pair, the way `findMany({ recursive })` refuses a field
called `_depth`.

**The `near` key must be the FIRST sort key.** Keys after it are kept and break
ties; a key in front of it is refused by name. A similarity ordering is the
whole ordering — a key ahead of the distance groups the rows and leaves the
distance as a tie-break, which is not what a nearest-first list means. The rule
holds on both engines, because permitting it on the one that can do it in SQL
would make the same query answer a different order on a server without the
extension, with nothing raised.

**Page with `limit` and `offset`, not with a cursor.** `findManyCursor` refuses a
distance ordering by name: a keyset cursor resumes from a value the row holds,
and a distance belongs to the query vector.

## The column is not in the default payload

```js
const [p] = await db.passage.findMany({ limit: 1 })
p.embedding                                     // undefined

await db.passage.findMany({ select: { id: true, embedding: true } })
                                                // …and here it is
```

Four bytes a dimension is 6 kB on a 1536-dimension column, so twenty rows of an
ordinary list carry 123 kB nobody asked for and the failure is a slow screen
attributed to anything but the schema (`FJS-D328`). The declaration already
knows the size class, so excluding it there restates nothing — and naming the
field in `select` is how you get it, which is `@omit(all)`'s contract rather than
a second word.

**It is a size rule and not an access one**, so `asSystem()` does not lift it.
The exclusion is in the SQL as well as in the payload: measured against the same
model with the attribute removed, at 1536 dimensions, a twenty-row read is
0.118 ms → 0.032 ms and a thousand-row read 2.48 ms → 0.56 ms.

## What the declaration emits

A `BLOB` column and one `CHECK`:

```sql
"embedding" BLOB,
CHECK ("embedding" IS NULL OR (typeof("embedding") = 'blob' AND length("embedding") = 6144))
```

**No index, and that is measured rather than lazy.** At `sqlite-vec` 0.1.9 the
`vec0` virtual table is exact brute force — it measured *slower* than a plain
scan at 50,000 rows — so a shadow table, its triggers, a differ rule, a
soft-delete rule and a JOIN in the one code path every policy composes into
would be paid in full for a ratio below one (`FJS-D332`). What prunes a
similarity read here is the caller's own `where`.

The `CHECK` is the database's rather than the boundary's for the usual reason: a
migration, a seed, a raw statement and `asSystem()` never reach the boundary.
`typeof(...) = 'blob'` rides along because `length()` counts *characters* on a
text value and bytes on a blob.

## Two writes that are refused, and why they have to be

The `CHECK` grades length and nothing else. These two pass it and are refused at
the boundary, because neither is visible afterwards:

**A zero vector.** `[0, 0, …, 0]` is exactly what an empty or failed `embed()`
call returns. Its cosine distance is `NULL` — there is no angle to a vector with
no direction — and **`NULL` sorts first ascending**, so one such row becomes the
best match for every question anybody ever asks, with a 200 and nothing logged.
`WHERE embedding IS NOT NULL` does not catch it: the column holds a perfectly
valid blob and it is the *distance* that is null.

**A `NaN` or an `Infinity`.** Every distance involving the row is then `NaN`,
which sorts unpredictably rather than losing.

```
embedding: must be a 1536-dimension float32 vector — it is every-dimension zero,
which is what an empty or failed embed() returns …
```

A wrong dimension, a wrong byte length and a non-blob are refused the same way,
naming the field and the model — which is the half a table constraint cannot do.

## The two engines

**The comparison has two implementations and the extension is the optional
one.** `FJS-D331`:

| | how a distance is computed |
| --- | --- |
| a server with `sqlite-vec` installed | `vec_distance_cosine(…)` inside SQLite |
| everything else | `core/vector.js`, in JavaScript |

The reason it is not a fallback is the browser. SQLite's own wasm build is
compiled with `SQLITE_OMIT_LOAD_EXTENSION` — the string is in the binary's own
compile-option list, beside `ENABLE_FTS5` — so the browser engine cannot load an
extension at any version, and a design whose retrieval path *was* the extension
would have no browser half at all.

To install the accelerator on a server:

```sh
bun add sqlite-vec
```

Nothing else. The engine detects it and arms the connections that need it; there
is no flag, because *a server may install it* is the whole of the decision.

**Measured, it is about 2×** — and what it buys is not faster arithmetic but
arithmetic that never materializes the blob into JavaScript.

### What the accelerator changes, and what it does not

Nothing about the query. The same `findMany` runs on both, the refusals are the
same sentences, and the ordering is the same ordering — graded row for row by an
oracle that runs one battery of queries under both paths and compares
(`test/vector.test.ts` § *the two paths answer the same thing*). `FJS-D331` puts
both in service precisely so that neither is the one nobody runs.

What moves to JavaScript when there is no distance function is the ORDER, and
therefore the PAGE. `limit` and `offset` cannot travel in the statement, because
SQLite is ranking nothing and `LIMIT 10` would take the first ten rows it
happened to read — so the scan is the whole filtered set.

**That is why the caller's `where` is the prune rather than an optimization**,
and why every gate and row policy in front of the read pays for itself: measured,
a quarter of the rows ran 2.3× faster in Chrome and 3–4× on Bun.

## What is deliberately not here

**Chunking is the app's.** Where a document breaks is domain work, and a
framework guessing it is a config flag with a paragraph attached.

**The model that produces the vector is the app's.** It is a Conduit target like
any other third party (`FJS-D153`), and `near` takes floats rather than text —
litestone calling a model would put a vendor deadline inside a read, and inside
whatever transaction that read is in (`FJS-D330`).

## Not combinable with

`@encrypted`, `@secret`, `@hashed` — the distance is computed over the stored
bytes, and encoded bytes rank by nothing.
`@unique` — two embeddings are near or far, never equal.
`@@fts` — FTS5 indexes text, and these bytes are not text.
`@computed`, `@from`, `@derived`, `@transient`, `@edge` — there is no column to
compare.
A sibling field named `_distance` — the ordering writes the computed distance
there.

Each is refused at parse, by name. Aggregating the column is refused at the read
for the same reason a bare sort is: packed float32 has no maximum and no sum.
