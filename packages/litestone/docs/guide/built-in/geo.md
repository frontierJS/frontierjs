# Geo points

`@point` marks a `Json` field as a latitude and longitude, indexes the two numbers separately, and adds a `near` filter and ordering over them.

```lite
model Job {
  id      Int   @id @default(autoincrement())
  address String
  site    Json? @point(lat, lng)
}
```

```js
await db.job.create({ data: { address: '12 Elm',   site: { lat: 40.71,  lng: -100.23 } } })
await db.job.create({ data: { address: '14 Elm',   site: { lat: 40.715, lng: -100.235 } } })
await db.job.create({ data: { address: 'far away', site: { lat: 51.5,   lng: -0.12 } } })

const nearby = await db.job.findMany({
  where:   { site: { near: { lat: 40.71, lng: -100.23, within: '5mi' } } },
  orderBy: { site: { near: { lat: 40.71, lng: -100.23 } } },
})
if (nearby.map(j => j.address).join() !== '12 Elm,14 Elm') throw new Error(nearby.map(j => j.address).join())
```

## What else it can do

- The point is one field, read and written whole as `{ lat, lng }`
- The key names are yours: `@point(latitude, longitude)` is as good
- The radius carries its unit: `'5mi'`, `'800m'`, `'2km'`
- Latitude and longitude outside ±90 and ±180 are refused by a CHECK
- `site: null` finds rows with no location, `{ not: null }` the ones with one
- `dir: 'desc'` in the ordering is furthest first
- `findManyCursor` pages a nearest-first list, and rows with no location sort last
- The distance is not on the row; `distance` from `@frontierjs/toolbelt/geo` computes it
- A proximity search travels in a query string as `?site[near][lat]=40.71&site[near][within]=5mi`
- Every other filter on a point field is refused by name
- A form draws two bounded number boxes, with no map

**In depth:** [Geo points](../../geo.md), [§ The declaration](../../geo.md#the-declaration), [§ Asking where](../../geo.md#asking-where), [§ Paging a nearest-first list](../../geo.md#paging-a-nearest-first-list)
