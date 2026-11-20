# Full-text search

`@@fts` gives a model a `search()` method over the columns you name, backed by an FTS5 index that litestone creates and keeps in sync for you.

```lite
model Message {
  id    Int     @id
  title String?
  body  String

  @@fts([body, title])
  @@label(body)
}
```

```js
await db.message.create({ data: { id: 1, title: 'important', body: 'hello world invoice' } })
await db.message.create({ data: { id: 2, body: 'hello goodbye' } })

const hits = await db.message.search('hello world')
if (hits.length !== 1 || hits[0].id !== 1) throw new Error('both words must match')
```

## What else it can do

- Results are ranked by relevance, and each row carries its score as `_rank`
- `where`, `limit` and `offset` narrow the search
- `highlight: { field, open, close }` and `snippet: { field, length }` mark the match
- The text is what a person typed: every word must match, `"a phrase"` matches as one, punctuation is safe
- `prefix: true` matches the last word as a prefix, for search-as-you-type
- `raw: true` hands the text to FTS5 as written, for `OR`, `NEAR` and column filters
- `@@fts([...], tokenize: porter)` picks `unicode61`, `ascii`, `porter` or `trigram`
- Soft-deleted rows are hidden, and `withDeleted` or `onlyDeleted` change that
- Row policies apply to results
- `db.$search(q)` ranks hits across every `@@fts` model at once
- `optimizeFts()` and `litestone optimize` merge the index segments
- `@@external` with `@@fts` searches a virtual table you manage yourself

**In depth:** [Full-text search](../../full-text-search.md), [§ search()](../../full-text-search.md#search), [§ What the text means](../../full-text-search.md#what-the-text-means), [§ $search()](../../full-text-search.md#search--one-ranked-list-across-models)
