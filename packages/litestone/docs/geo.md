# Where a row is — `@point`

A coordinate is two numbers that have to be indexed separately and read as one.
`.lite` has no geometry type and neither does SQLite, so the modelling question
is not *what type is a point* but *what does the database have to be able to
prune on*. `@point` answers both from one declaration.

Ruled in `FJS-D316` and `FJS-D317`; the reasoning and the measurements are
`IDEAS/geo.md`.

## The declaration

```
model Job {
  id      Int     @id @default(autoincrement())
  address String
  site    Json?   @point(lat, lng)
}
```

**The value is one field, written and read whole.**

```js
await db.job.create({ data: { address: '12 Elm', site: { lat: 40.71, lng: -100.23 } } })
const job = await db.job.findFirst({ where: { id } })
job.site   // { lat: 40.71, lng: -100.23 }
```

**The keys are named rather than assumed.** `@point(lat, lng)` and
`@point(latitude, longitude)` are both ordinary; the value belongs to the
application, and inferring the keys from the shape is silently wrong for the
model whose `lat` is a lathe setting.

## What the declaration emits

```sql
CREATE TABLE "job" (
  "id"      INTEGER NOT NULL PRIMARY KEY,
  "address" TEXT NOT NULL,
  "site"    TEXT,
  "siteLat" REAL GENERATED ALWAYS AS (json_extract("site", '$.lat')) VIRTUAL,
  "siteLng" REAL GENERATED ALWAYS AS (json_extract("site", '$.lng')) VIRTUAL,
  CHECK ("site" IS NULL OR (json_type("site") = 'object'
     AND coalesce(json_type("site", '$.lat'), '-') IN ('integer', 'real')
     AND coalesce(json_type("site", '$.lng'), '-') IN ('integer', 'real')
     AND json_extract("site", '$.lat') BETWEEN -90 AND 90
     AND json_extract("site", '$.lng') BETWEEN -180 AND 180))
) STRICT;
CREATE INDEX "idx_job_site" ON "job" ("siteLat", "siteLng");
```

The columns are `VIRTUAL`: they store nothing and the **index** holds the
numbers. That is what lets a point live inside one JSON value and still be
pruned by a b-tree. They are named `<field><Key>` — camelCase, like every other
identifier the schema produces — and a model that already declares a field by
that name is refused at parse.

**A query names the columns.** A `WHERE` that repeats
`json_extract(site, '$.lat')` reads as a full `SCAN` even with the index
present, because SQLite matches the column and not the expression. This is
measured, not assumed, and it is why the columns exist at all.

## What is refused, and where

The `CHECK` is the database's, which is the point of it: a migration, a seed, a
raw statement and `asSystem()` never reach a validator, and `@point`'s promise
is that a row has a usable coordinate or has none.

| the value | |
| --- | --- |
| `{ lat: 40.71, lng: -100.23 }` | stored |
| `null` | stored — a row with no location is ordinary |
| `{ lat: 1, lng: 2, accuracy: 5 }` | stored — extra keys are `@type`'s business, not `@point`'s |
| `{ lat: 40.71 }` | refused — a half-set pair is not a location |
| `{}` · `"hello"` · `{ latitude: 1, longitude: 2 }` | refused — no coordinate under the declared keys |
| `{ lat: '40.7', lng: '-100' }` | refused — a coordinate is a number |
| `{ lat: 91, lng: 0 }` | refused — outside ±90 |

**The `coalesce()` in that CHECK is load-bearing.** A `CHECK` fails only on
`FALSE`, so the natural spelling —
`json_type(site, '$.lat') IN ('integer', 'real')` — evaluates to `NULL` for an
object with no `lat` at all, and the row is **accepted**. Every row in the
refused half of that table passes the naive version. The general form of the
trap is in `docs/gotchas.md`: a `@@check` over a nullable column admits the rows
it cannot judge.

## Beside a declared type

`@point` is the whole declaration of a coordinate. `@type` grades the **rest**
of the object, which is a question only the application can answer:

```
type SiteLocation {
  lat        Float
  lng        Float
  accuracy   Float?
  source     String
  geocodedAt DateTime?
}

model Visit {
  site Json @type(SiteLocation) @point(lat, lng)
}
```

Three rules hold between them:

1. **Strictness is what `@type` buys.** `@type` is strict by default, so a
   misspelled `acuracy` is refused; `@point` alone checks its two keys and
   leaves the rest of the object alone.
2. **The coordinate keys must exist in the type.** `@point(lat, lng)` over a
   type with no `lat` is a parse error, not a field that validates and never
   matches.
3. **The type may only narrow.** `@point`'s ±90 / ±180 is the floor; a type
   declaring `lat Float @gte(49) @lte(61)` for an application that operates in
   one country adds a conjunct. Widening past the floor is refused — a latitude
   of 200 is not a business rule.

## What cannot carry a point

- **`@encrypted` / `@secret`** — `json_extract` over ciphertext answers `NULL`
  for every row, so the point would be absent everywhere rather than refused
  once.
- **`@computed` / `@derived` / `@from` / `@transient`** — there is no stored
  column to extract from.
- **An array** — the attribute describes one coordinate.

## Asking where

`near` is the only filter a point answers, and distance is the only ordering
(`FJS-D318`).

```js
await db.job.findMany({
  where:   { site: { near: { lat: 40.71, lng: -100.23, within: '5mi' } } },
  orderBy: { site: { near: { lat: 40.71, lng: -100.23 } } },
})
```

**Box first, then exact.** The radius is turned into a list of bounding boxes,
those prune on the index, and the surviving rows are measured with a haversine
in SQL — the same two steps in the same order as the browser's `isNear`, so a
live list and the server cannot disagree about a row on the edge. Both engines
carry the math functions this needs; that was measured rather than assumed.

**The radius carries its unit** (`FJS-D319`) — `'5mi'`, `'800m'`, `'2km'`,
parsed by `parseLength` in `@frontierjs/toolbelt/units`. A bare `'5'` is refused
by name rather than guessed at, and so is `'5 parsecs'`.

**The ordering is the query's, not the page's** (`FJS-D321`). A list sorted
after it was selected is the wrong twenty rows the moment there is a second
page. `{ site: { near: centre, dir: 'desc' } }` is furthest first.

**The distance does not come back on the row** (`FJS-D320`). The row carries its
point and the caller knows the centre, so `distance(row.site, centre)` from the
kit answers *2.3 mi away* with no server contract at all.

Everything else on a point field is refused by name: `equals`, `contains` and
`gt` each say that the column holds JSON and would compare as text, a bare
`site: 'x'` says the same, and `orderBy: { site: 'asc' }` names the shape that
works. `where: { site: null }` is ordinary and finds the rows with no location.

## Off a query string

A proximity search travels as the bracket notation
`@frontierjs/toolbelt/query` already carries structure in (`FJS-D323`) — no
second syntax, and the three readers that exist parse it rather than a fourth:

```
?site[near][lat]=40.71&site[near][lng]=-100.23&site[near][within]=5mi
&$orderBy[site][near][lat]=40.71&$orderBy[site][near][lng]=-100.23
```

**A coordinate may arrive as text, and is read as the Float the column is.** The
query kit turns a string into a number only when it round-trips, which is the
right rule with no model in the room and which `51.507400` fails — and
`toFixed(6)` is how a GPS reading reaches a URL. The `@point` declaration is the
model having the last word, exactly as the kit's own contract says it should.
An EMPTY coordinate is not zero: `?site[near][lat]=` is refused, because
`Number('')` is `0` and the alternative is a silent search of the Gulf of
Guinea.

## The arithmetic

Distance, bounding boxes, point-in-polygon, area and centroid are
`@frontierjs/toolbelt/geo` — pure functions both the server and the browser
import, so a live list grades an arriving row with the same code the query used.
`boundingBox` returns a **list** of boxes: a radius crossing ±180° is two, and
one reaching a pole widens to the whole parallel. A caller that expects one box
is the defect Elasticsearch, qdrant and GeoBlacklight each shipped — fewer rows,
status 200.
