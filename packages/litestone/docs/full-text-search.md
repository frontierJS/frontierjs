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

## What the text means

`search(text)` takes the words a person typed, never FTS5's query language. Each
word must match, a `"quoted phrase"` matches as one, and punctuation is part of
the word — `mini-redis`, `c++`, `(512) 555-1234` and `o'brien` find their rows
rather than reaching FTS5 as a column filter or an operator (`FJS-1440`). A text
with no word left in it, `''` or a lone `"`, answers no rows.

```js
await db.message.create({ data: { id: 1, userId: 1, title: 'important', body: 'hello world, see c++' } })
await db.message.create({ data: { id: 2, userId: 1, body: 'goodbye' } })

const both    = await db.message.search('hello world')      // every word required
const phrase  = await db.message.search('"world see"')      // one phrase
const literal = await db.message.search('c++')              // a word, not syntax
const typing  = await db.message.search('hel', { prefix: true })  // the last word as a prefix
if (both.length !== 1 || phrase.length !== 1 || literal.length !== 1 || typing.length !== 1) throw new Error('words changed')
```

`prefix: true` is for a box searched as it is typed: the last word also matches
the start of a word. A last word ending in punctuation is kept whole, since
`c++` as a prefix tokenizes to `c` and would match every c-word. Under
`tokenize: trigram` a word already matches anywhere inside one, so `prefix`
changes nothing there.

`raw: true` hands the text to FTS5 as written — phrases, `foo*`, `AND`/`OR`/`NOT`,
`NEAR`, column filters. It is for text your code writes, never for what a person
typed: a syntax error is thrown as one, and its message names the term.

```js
await db.message.create({ data: { id: 1, userId: 1, title: 'important', body: 'hello world' } })
await db.message.create({ data: { id: 2, userId: 1, body: 'goodbye' } })

const either = await db.message.search('hello OR goodbye', { raw: true })
const titled = await db.message.search('title: important', { raw: true })
if (either.length !== 2 || titled.length !== 1) throw new Error('raw changed')
```

The `$search` directive over HTTP is always words; nothing a caller sends reaches
the raw form.

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
