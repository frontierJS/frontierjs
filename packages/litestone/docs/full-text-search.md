# Full-Text Search

Litestone builds FTS5 virtual tables and sync triggers automatically for full text search. `@@fts` gives you a `search()` method on any model.

## Setup

```lite
model Message {
  id        Int @id
  userId    Int
  title     String?
  body      String
  createdAt DateTime @default(now())
  deletedAt DateTime?

  @@softDelete
  @@fts([body, title])
  @@index([userId])
}
```

Litestone creates:
- An FTS5 virtual table `message_fts` with a content table pointing to `message`
- Three sync triggers: INSERT, UPDATE, DELETE — keep the FTS index in sync automatically

## search()

```js
await db.message.create({ data: { id: 1, userId: 1, title: 'important', body: 'hello world invoice' } })
await db.message.create({ data: { id: 2, userId: 2, body: 'hello goodbye' } })

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

if (results.length !== 1 || filtered.length !== 1 || highlighted[0]._highlight !== '<mark>hello</mark> goodbye' || !snippets[0]._snippet) throw new Error('search changed')
```

Results are ordered by FTS5 rank (relevance) by default, and each row carries
its BM25 score as `_rank` — lower is better, and comparable only within one
model's index. `withRank: false` leaves it off. `_rank`, `_highlight` and
`_snippet` are not columns, so a `select` keeps them.

`search()` runs two queries — the FTS5 table for the matching rowids, then the
base table for the rows — and rejoins them on the row's `rowid`, so a String id
is fine. A `select` need not name the id: it is fetched for that join and
trimmed from the result like any other injected column.

The filter it applies before its LIMIT — soft-delete, the caller's `where`, the
row policy — runs once per match, so a policy several hops deep costs what the
matches cost, not what the table holds.

## With @@softDelete

The index mirrors the table — soft-deleted rows stay in it, and `search()` is
what decides they are not visible:

```js
await db.message.create({ data: { id: 1, userId: 1, body: 'invoice paid' } })
await db.message.create({ data: { id: 2, userId: 1, body: 'invoice void' } })
await db.message.remove({ where: { id: 2 } })

const live    = await db.message.search('invoice')                        // live rows
const all     = await db.message.search('invoice', { withDeleted: true })  // live + deleted
const deleted = await db.message.search('invoice', { onlyDeleted: true })  // deleted only
if (live.length !== 1 || all.length !== 2 || deleted.length !== 1) throw new Error(`${live.length} ${all.length} ${deleted.length}`)
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
await db.message.create({ data: { id: 1, userId: 1, title: 'important', body: 'hello world' } })

// Phrase search
await db.message.search('"hello world"')

// Prefix search
await db.message.search('hel*')

// Boolean operators
await db.message.search('hello AND world')
await db.message.search('hello OR goodbye')
await db.message.search('hello NOT spam')

// Column-specific search (when multiple columns in @@fts)
await db.message.search('body: hello title: important')
```

## Maintaining the index

FTS5 indexes can fragment over time. Periodically merge segments for optimal performance:

```js
await db.message.optimizeFts()   // → { optimized: true, table: 'message_fts' }
```

```bash
litestone optimize message 
litestone optimize               # optimize all FTS models
```

Best run as a scheduled job (weekly or after large bulk imports).

## @@external with @@fts

Query a FTS5 virtual table you manage yourself:

```lite
model SearchIndex {
  rowid Int @id
  title String
  body  String
  @@external
  @@map("search_index")
  @@fts([title, body])
}
```

Litestone will not create the virtual table or triggers — it only exposes `search()` on it, as `db.searchIndex.search()`.

## Notes

- FTS5 is always case-insensitive for ASCII; `@@fts([…], tokenize: porter)` picks the tokenizer — `unicode61` (the default), `ascii`, `porter` or `trigram`. A trigram index matches nothing for a term under three characters (`FJS-2332`)
- Soft-deleted rows are excluded from search results automatically
- Row-level policies apply to search results — filtered in SQL, not JS
- FTS index is updated synchronously via triggers on every write
