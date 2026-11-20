# Paging

`findManyCursor` pages with an index comparison instead of `OFFSET`, so page 500 costs what page 1 does. Each page returns a cursor for the next.

```lite
model Post {
  id        Int      @id
  title     String
  createdAt DateTime @default(now())
}
```

```js
await db.post.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ title: `Post ${i + 1}` })) })

const orderBy = [{ createdAt: 'desc' }, { id: 'asc' }]
const page1 = await db.post.findManyCursor({ limit: 2, orderBy })
const page2 = await db.post.findManyCursor({ limit: 2, orderBy, cursor: page1.nextCursor })
const page3 = await db.post.findManyCursor({ limit: 2, orderBy, cursor: page2.nextCursor })

if (page1.items.length !== 2 || page2.items.length !== 2 || page3.items.length !== 1) throw new Error('page sizes')
if (page3.nextCursor !== null || page3.hasMore !== false) throw new Error('last page should end')
```

## What else it can do

- The cursor encodes every `orderBy` field of the last row, so end the order on a unique field such as `id`
- Multi-field ordering is supported
- `hasMore` says whether another page exists
- `limit` and `offset` with `findManyAndCount` suit a page-number UI with a total

**In depth:** [Querying § Cursor pagination](../../querying.md#cursor-pagination)
