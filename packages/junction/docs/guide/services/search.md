# Search across models

`searchService` is one route over several models, answering a ranked list of hits for a palette or a search box. A caller may narrow the models it names and never widen them.

```ts
import { createClient } from '@frontierjs/litestone'
import { searchService } from '@frontierjs/junction/search'

const db = await createClient({ db: ':memory:', schema: `
  model Issue   { id Int @id  title String  @@fts([title])  @@label(title) }
  model Comment { id Int @id  title String  @@fts([title])  @@label(title) }
` })
const app = createApp({ db })

await db.asSystem().issue.create({ data: { title: 'The quasar report' } })
await db.asSystem().comment.create({ data: { title: 'Notes on a quasar' } })
await db.asSystem().comment.create({ data: { title: 'Lunch' } })

app.services.register(searchService({ models: ['issue', 'comment'] }))

const hits = await app.service('search').find({ q: 'quasar' })
if (hits.data.length !== 2) throw new Error(`expected 2 hits, got ${hits.data.length}`)
```

## What else it can do

- `GET /search?q=quasar` over HTTP, answering the same list, with `models=issue` to narrow and `$limit=8` to cap
- A hit is `{ model, id, title, sub, _rank, _snippet }`, ranked on one scale across models
- The caller's own client grades every hit, so a row the caller may not read never appears
- The last word of `q` is a prefix and an empty `q` answers `[]`
- `name:` moves the route off `/search`
- Each mounted model declares `@@fts` and `@@label` in the schema

**In depth:** [README § One search across models — searchService()](../../../README.md#one-search-across-models--searchservice)
