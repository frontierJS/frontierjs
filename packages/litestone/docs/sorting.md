# Sorting

## Basic orderBy

```js
// Single field
orderBy: { createdAt: 'desc' }

// Multiple fields — array, applied left-to-right
orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }]
```

## NULLS FIRST / LAST

By default SQLite sorts NULLs last on ASC and first on DESC. Override with the object form:

```js
// NULLs sorted to the end regardless of direction
orderBy: { deletedAt: { dir: 'asc',  nulls: 'last'  } }
orderBy: { priority:  { dir: 'desc', nulls: 'first' } }

// Mixed in a multi-field sort
orderBy: [
  { name:      { dir: 'asc', nulls: 'last' } },
  { createdAt: 'desc' },   // plain string still works
]
```

## Relation field orderBy (belongsTo)

Sort by a field on a related model. Emits a `LEFT JOIN` — no row duplication, composes with all other args:

```js
// Single hop — sort posts by author name
db.post.findMany({ orderBy: { author: { name: 'asc' } } })

// Two-hop — sort users by their company's country name
db.user.findMany({ orderBy: { company: { country: { name: 'asc' } } } })

// Mixed flat + relation
db.post.findMany({
  orderBy: [
    { author:    { name: 'asc' } },
    { createdAt: 'desc' },
  ]
})
```

**Restriction:** only `belongsTo` (FK on this model's table) relations work. `hasMany` is inherently ambiguous for sorting. Use aggregate orderBy instead.

## Relation aggregate orderBy (hasMany / manyToMany)

Sort by COUNT/SUM/AVG/MIN/MAX of a related collection. Uses a correlated subquery — no row duplication, works on any table size:

```js
// Sort authors by number of books (hasMany)
db.authors.findMany({ orderBy: { books: { _count: 'desc' } } })

// Sort authors by total revenue (hasMany _sum)
db.authors.findMany({ orderBy: { books: { _sum: { price: 'desc' } } } })

// Sort authors by highest-rated book (hasMany _max)
db.authors.findMany({ orderBy: { books: { _max: { rating: 'asc' } } } })

// Sort authors by number of tags (manyToMany — _count only)
db.authors.findMany({ orderBy: { tags: { _count: 'asc' } } })
```

**Available:** `_count` on `hasMany` and `manyToMany`. `_sum`, `_avg`, `_min`, `_max` on `hasMany` only (aggregating a scalar through a join table requires specifying which field, which manyToMany doesn't have).

## Window function orderBy

Window function `orderBy` uses the same syntax, including NULLS FIRST/LAST:

```js
db.order.findMany({
  window: {
    rn: {
      rowNumber: true,
      partitionBy: 'accountId',
      orderBy: { createdAt: { dir: 'desc', nulls: 'last' } },
    }
  }
})
```

See [window-functions.md](./window-functions.md).

## groupBy orderBy

```js
db.order.groupBy({
  by:      ['status'],
  _count:  true,
  _sum:    { amount: true },
  orderBy: { _count: 'desc' },            // by aggregate
  // orderBy: { _sum: { amount: 'asc' } } // by aggregate field
  // orderBy: { status: 'asc' }           // by group field
})
```
