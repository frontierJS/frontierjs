# Full-Text Search

Litestone builds FTS5 virtual tables and sync triggers automatically. `@@fts` gives you a `search()` method on any model.

## Setup

```prisma
model Message {
  id        Integer @id
  userId    Integer
  title     Text?
  body      Text
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
  rowid Integer @id
  title Text
  body  Text
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
