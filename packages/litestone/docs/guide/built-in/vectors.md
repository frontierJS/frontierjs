# Vectors

`@vector(n)` stores an embedding on a `Bytes` column and lets you order rows by how near they are to a query vector.

```lite
model Passage {
  id        Int    @id @default(autoincrement())
  body      String
  embedding Bytes? @vector(4)
}
```

```js
await db.passage.create({ data: { body: 'east',  embedding: new Float32Array([1, 0, 0, 0]) } })
await db.passage.create({ data: { body: 'north', embedding: new Float32Array([0, 1, 0, 0]) } })
await db.passage.create({ data: { body: 'near',  embedding: new Float32Array([0.9, 0.1, 0, 0]) } })

const hits = await db.passage.findMany({
  orderBy: { embedding: { near: [1, 0, 0, 0] } },
  limit: 10,
})
if (hits.map(h => h.body).join() !== 'east,near,north') throw new Error(hits.map(h => h.body).join())
```

## What else it can do

- Retrieval is an ordering on `findMany`, so it composes with `where`, `select`, the gate and row policies
- Each row carries its cosine distance as `_distance`, 0 identical, 1 orthogonal, 2 opposite
- There is no threshold option; compare `_distance` yourself
- `near` must be the first sort key, and later keys break ties
- Page with `limit` and `offset`; `findManyCursor` refuses a distance ordering
- The vector is left out of a default read, and `select: { embedding: true }` brings it back
- A row with no vector yet is absent from a nearest list
- A `where` that prunes rows first makes the scan cheaper
- With `sqlite-vec` installed (`bun add sqlite-vec`) the distance runs inside SQLite, about 2x faster
- Without it the same query runs in JavaScript, which is the only path in the browser
- Embedding the text is your app's job, and chunking too
- Not combinable with `@encrypted`, `@secret`, `@hashed`, `@unique` or `@@fts`

**In depth:** [Vectors](../../vectors.md), [§ Retrieval is an ordering, not a verb](../../vectors.md#retrieval-is-an-ordering-not-a-verb), [§ The two engines](../../vectors.md#the-two-engines)
