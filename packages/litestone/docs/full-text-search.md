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
  @@label(body)
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

A trigram index holds three-character pieces, so it has nothing to look up for a
word of one or two — `jo`, `Li`, a state code, what a person types first. Such a
word is found by a scan of the indexed columns instead, with the same answer a
substring match gives: case folded beyond ASCII, a `%`, `_`, `*` or `?` taken as
the character itself (`FJS-2332`). Beside a longer word it is one more required
word and the results still rank; a text of only short words has no BM25 to rank
by, so `_rank` is `null`, rows come back in table order, and `highlight` marks
nothing.

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
  @@label(title)
}
```

Litestone will not create the virtual table or triggers — it only exposes `search()` on it, as `db.searchIndex.search()`.

## Notes

- FTS5 is always case-insensitive for ASCII; `@@fts([…], tokenize: porter)` picks the tokenizer — `unicode61` (the default), `ascii`, `porter` or `trigram`.
- Soft-deleted rows are excluded from search results automatically
- Row-level policies apply to search results — filtered in SQL, not JS
- FTS index is updated synchronously via triggers on every write

## $search() — one ranked list across models

Every `@@fts` model is also in one shared FTS5 table, `_search`, keyed by
accessor and rowid: its `title` is the `@@label` column, its `body` the `@@fts`
columns joined. `db.$search(q)` reads it, grades each hit through its model's
own read rules before the limit, and ranks everything on one bm25 scale — which
per-model indexes cannot do, since each scores against its own vocabulary
(`FJS-D970`). A `@@fts` model with no `@@label` is refused at parse, because a
hit with no title is a palette entry with nothing to show.

`$search(q, { models: ['lemma'] })` narrows inside the MATCH, so a small model
does not walk a large one's postings (`FJS-2845`). Narrowing to the largest
model can cost more than naming none, since the model's own postings are read.

A model whose gate or capability refuses the caller contributes no hits, the
way a row its policy hides contributes none, and the call answers the models the
caller may read. Refused by every model it names, the call throws the first
refusal, so a caller who may read nothing is told so rather than shown an empty
list.

```lite
model Issue {
  id    Int    @id
  title String
  body  String?
  @@fts([title, body])
  @@label(title)
}

model Comment {
  id     Int    @id
  author String
  body   String
  @@fts([body])
  @@label(author)
}
```

```js
await db.issue.create({ data: { id: 1, title: 'quasar lattice', body: 'the plan' } })
await db.comment.create({ data: { id: 1, author: 'ana', body: 'quasar lattice, again' } })

const hits = await db.$search('quasar lattice')
// [{ model: 'issue', id: 1, title: 'quasar lattice', sub: null, _rank, _snippet },
//  { model: 'comment', id: 1, title: 'ana', ... }] — the title match ranks first

const only = await db.$search('quasar', { models: ['comment'], limit: 10 })

if (hits.map(h => h.model).join() !== 'issue,comment' || only.length !== 1) throw new Error('$search changed')
```

`models` names accessors and defaults to every `@@fts` model; one outside
`@@fts` is refused by name, as `search()` refuses. `limit`, `offset` and
`prefix` mean what they mean on `search()`. `sub` is the first `x-identify`
value the row carries, `null` where the model has none. The index is `trigram`
whatever the models' own tokenizers, so a word under three characters is a
scan over title and body, and a query of only such words answers with `_rank`
null, in index order.
