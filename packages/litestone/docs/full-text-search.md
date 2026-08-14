# Full-String Search

Litestone builds FTS5 virtual tables and sync triggers automatically. `@@fts` gives you a `search()` method on any model.

## Setup

```prisma
model Message {
  id        Int @id
  userId    Int
  title     String?
  body      String
  createdAt DateTime @default(now())

  @@fts([body, title])
  @@index([userId])
}
```

Litestone creates:
- An FTS5 virtual table `messages_fts` with a content table pointing to `messages`
- Three sync triggers: INSERT, UPDATE, DELETE — keep the FTS index in sync automatically

## search()

```js
// Basic full-text search
const results = await db.message.search('hello world')

// With where filter — applied after FTS match
const filtered = await db.message.search('invoice', {
  where:  { userId: 1 },
  limit:  20,
  offset: 0,
})

// With highlight — wraps matched terms in <mark>...</mark>
const highlighted = await db.message.search('hello', {
  highlight: { field: 'body', open: '<mark>', close: '</mark>' }
})

// With snippet — extracts a short excerpt around the match
const snippets = await db.message.search('hello', {
  snippet: { field: 'body', length: 64 }
})
```

Results are ordered by FTS5 rank (relevance) by default.

`search()` runs two queries — the FTS5 table for the matching rowids, then the
base table for the rows — and rejoins them by id to restore rank order. A
`select` need not name the id: it is fetched for that join and trimmed from the
result like any other injected column.

## With @@softDelete

The index mirrors the table — soft-deleted rows stay in it, and `search()` is
what decides they are not visible:

```js
await db.message.search('invoice')                        // live rows
await db.message.search('invoice', { withDeleted: true })  // live + deleted
await db.message.search('invoice', { onlyDeleted: true })  // deleted only
```

`where`, the soft-delete filter and `@@hasTemplates` all narrow **before** the
`limit`, so a search for 20 answers 20 matching rows rather than whatever is
left of 20 index entries.

Keeping deleted rows out of the index instead would need a second trigger, and a
soft delete would then fire two of them: FTS5 answers a repeated delete of one
docid with `database disk image is malformed`, and only sometimes — above one
indexed row it corrupts without a word. One filter, in one place.

## FTS5 query syntax

```js
// Phrase search
db.message.search('"hello world"')

// Prefix search
db.message.search('hel*')

// Boolean operators
db.message.search('hello AND world')
db.message.search('hello OR goodbye')
db.message.search('hello NOT spam')

// Column-specific search (when multiple columns in @@fts)
db.message.search('body: hello title: important')
```

## Maintaining the index

FTS5 indexes can fragment over time. Periodically merge segments for optimal performance:

```js
await db.message.optimizeFts()
```

```bash
litestone optimize messages
litestone optimize               # optimize all FTS models
```

Best run as a scheduled job (weekly or after large bulk imports).

## @@external with @@fts

Query a FTS5 virtual table you manage yourself:

```prisma
model search_index {
  rowid Int @id
  title String
  body  String
  @@external
  @@fts([title, body])
}
```

Litestone will not create the virtual table or triggers — it only exposes `search()` on it.

## Notes

- FTS5 is always case-insensitive for ASCII (configurable with `tokenize` options via `@@fts`)
- Soft-deleted rows are excluded from search results automatically
- Row-level policies apply to search results — filtered in SQL, not JS
- FTS index is updated synchronously via triggers on every write
