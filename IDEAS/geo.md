---
id: geo
status: proposed
dated: 2026-09-19
---

# Idea — where a row IS: geography in the seed

**Status: PROPOSED — every question in it is now RULED, and none of it is built.**
Dated 2026-09-19, decided 2026-09-20: `FJS-D315` through `FJS-D327` settle the
declaration, the marker, the V1 scope, how a distance is stated and travels, the
index, the cursor, the kit's boundary, the guard default, the live store and the
map control; the named-point question is moot under the declaration ruling. **So
what is left is building it, and § Holes still open is the list to start from** —
those are tasks and measurements, not choices. The engine
measurements in § *What both engines already hold* are real and were taken on this
tree today; everything else is argued. Read nothing here as behavior
(`VERIFYING.md`).

---

## Trigger, and the prior-art answer

*"Not sure if we've reserved prior art yet."* **Nothing was reserved.** Grepped
`IDEAS/`, `ISSUES.md`, `DECISIONS.md` and `IDEAS/overview.md` for `geo`, `spatial`,
`latitude`, `polygon`: zero rows, zero rulings, zero defects. `.lite` has eight
scalars — `String Int Float Bytes Boolean DateTime Json File` — and no attribute
names a place. `IDEAS/review-prior-art.md` lists what to read and names no geospatial
project. **So this file is the reservation**, and the evidence it reserves against
is a live client application that has been running the workaround for two years.

---

## What the workaround looks like, measured

`/home/j/code/CLIENTS/elitelawncare/ela` — lawn care and landscaping, Prisma +
SQLite + Svelte, a crew planner that assigns jobs to crews by where they are. It is
the most geo-shaped real application in reach, and every one of the three questions
below is answered in it by hand.

**1. Where a row is, is split across two spellings and one of them is a blob.**
`Property`, `Client` and `Crew` each carry `latitude Float?` / `longitude Float?`.
A `Job` does not — its coordinates ride `data String @default("{}")` as
`data.lat` / `data.lng`. **Four files re-hoist the blob onto the column names before
any math runs** (`Map.svelte:323`, `_planner.CrewBoard.svelte:21` and `:154`,
`_planner.MasterView.svelte:84`), and one of them does it with `||` against the
column that might also exist. That rehoist IS the tell: two spellings of one fact,
neither declared, so every consumer normalizes first and nothing checks that it did.

**2. Nothing is asked of the database.** Grepped `api/src/services/jobs` and
`.../properties` for a bounding box, a radius, a distance: **there is none.** Every
geo question is answered in the browser over rows already fetched —
`isWithinRadius()` is `visits × others` with a Leaflet `distanceTo()` per pair
(`_planner.MasterView.svelte:73`), and the crew's working area is a turf convex hull
buffered by 30% of the square root of its own area, then point-in-polygon per visit
inside the list filter (`getGeoRange()` in `_planner.CrewBoard.svelte:19`,
`getPointInArea` at `_planner.MasterView.svelte:314`). The planner is `@turf/turf`
plus `leaflet` plus a hand-written ray-cast (`isMarkerInsidePolygon`,
`Map.svelte:57`) doing in a component what an index does in a page read.

**3. The one place a bounding box IS written, it is written by hand into SQL.**
`api/src/services/turf/turf.class.js:112` — `margin = 0.0002 // ~ 70ft / 22m`,
coordinates rounded to five decimals, `latLow`/`latHigh`/`lngLow`/`lngHigh` built as
four numbers and compared in a string of SQL against a cached address table. It
works. It is also the whole feature this record proposes, written once, by somebody
who had to know that 0.0002 degrees is 70 feet **of latitude** and that the same
number is not 70 feet of longitude anywhere but the equator.

**4. A measurement carries its provenance as a string, concatenated.** `Property`
holds `turfSqft Int?`, `lotSizeSqft Int?`, `turfSource String?` — and the merge
writes `turfSource = (result.turfSource || '') + '|turfSqft:attom'` when one
field came from a second source. An area measured, the source it came from, and
which half of it came from where, spelled as pipe-joined text because there is
nowhere to declare it.

---

## What both engines already hold — measured 2026-09-19

Litestone runs on two SQL engines by ruling (`FJS-D305`), so a geo feature is only
real if it is real in both. Probed, rather than assumed:

| | `bun:sqlite` 3.51.2 | `@sqlite.org/sqlite-wasm` 3.53.4 |
| --- | --- | --- |
| `ENABLE_MATH_FUNCTIONS` (`cos`, `radians`) | yes | yes |
| `ENABLE_RTREE` | yes | yes |
| `geopoly` | **no** — `no such module` | **no** — absent from the wasm binary |

**That table is the design.** A bounding box against an R*Tree and an exact great
circle distance in SQL are portable across both engines with no extension, no
build flag and no second code path — which is the one thing that decides whether
this can be a Data-realm feature at all. **Polygon containment in SQL is not
available anywhere**, so an area test is either a bbox prefilter plus a pure
function in the caller's process, or it is not offered. Proposing `geopoly` here
would have been the shape `FJS-D190` warns about: a settled design pointing at a
module neither engine has.

---

## The three questions

1. **Where is this row?** — a point, declared, indexed, validated, one spelling.
2. **Which rows are near a place, or inside an area?** — a filter the Data boundary
   answers, so the gate and the row policies apply to it for free.
3. **How big is this area, and where did that number come from?** — a measurement
   with provenance, which is the `turfSource` column spelled properly.

**1 and 2 are the proposal. 3 is named and deferred** — it is `@from`/provenance
wearing a geo hat, and building it first gives a measurement nothing can query.

---

## Shape — how a point is DECLARED

Six options. **A and B decide how many COLUMNS a point is; C through F decide how
many FIELDS the seed spells it as**, and the last one costs nothing new because
`.lite` already has the mechanism.

**A. one column holding a composite value** — `site Geo`, stored as
`"40.71,-100.23"`, as `{lat, lng}` JSON, or as a WKB blob. **The survey says no,
and says why it looks tempting**: every system that stores a point in one column —
PostGIS, GeoDjango, Drizzle — has a geometry TYPE in the database and a GiST index
that understands it. SQLite has neither, so the column is text. Everything the
feature is for is then unavailable at the storage layer: no `BETWEEN` box to prune
with, no composite index, no `CHECK` on ±90 / ±180, no `@from(min:)`, no
`ORDER BY`, and the parser's own sentence applies verbatim — *it is Json — its text
sorts, its structure does not*. **`File` is the shape this confuses itself with**:
a structured value in one `TEXT` column works there precisely because nobody asks
the database about its parts, and litestone says so — *its order is the order
things were stored under*.

**B. two `Float` columns grouped by a model-level declaration** —
`@@geo(site: latitude, longitude)`. Storage is ordinary and every index, `CHECK`,
aggregate and comparison works unchanged. **Its weakness is not storage, it is that
`site` is not a FIELD**: it is a name only the geo machinery knows, so the JSON
Schema, `x-*`, `select`, the form control and the audit trail each have to learn
about a grouping that is not in the field list.

**C. a `Geo` scalar mapping to two columns** — `site Geo @required`, stored as
`site_lat REAL, site_lng REAL`. Best ergonomics, worst blast radius: **litestone
maps one field to one column everywhere** — `ddl.js` emits per field, the migration
differ compares per field, and so do the JSON Schema generator, `select`,
`orderBy`, patch semantics (Invariant 9 — what is `{ site: { lat: 1 } }`?), the
audit field entries, `@@index` arguments and every `x-*` keyword. Field-to-columns
1:N is a new concept in each of them.

**D. `Geo` as parse-time sugar for B** — refused. The seed reads like C and the API
returns `row.latitude` / `row.longitude`, so the sugar stops being true at the
boundary.

**E and F — a read-side FIELD over the two real columns, and `.lite` already has
this class of field.** The kinds table in `packages/litestone/docs/modeling.md` is the
authority: `@derived(expr)` is **no column, the caller may not write it, and it can
be filtered, sorted and grouped by** because it is compiled into the SELECT; `ddl.js`
already excludes `@computed` / `@from` / `@derived` from column emission. So a point
can be a field that is not a column, over two columns that are:

- **E** — `site Geo @derived(point(latitude, longitude))`. Reuses `@derived`
  wholesale, and costs the one thing `@derived` cannot do today: its body is the
  declarative expression language, which produces scalars. A `point()` constructor
  is a new VALUE KIND in three evaluators at once (`FJS-D259`, `FJS-D271`).
- **F** — `site Json @geo(latitude, longitude)`. The same field, with the geo
  attribute naming its two sibling columns instead of an expression naming them.
  **Zero change to the expression language, and the shape is already in the
  grammar**: `@money(field: currency)` is an attribute naming a sibling column, and
  the parser cites django-money for it.

**G. a declared TYPE in a JSON column, with the numbers generated back out of it**
— and this one is not a proposal about what `.lite` could hold, because **it parses
and emits valid DDL today, with no language change at all**:

```lite
model Job {
  site Json @point(lat, lng)   // the whole declaration: object, two numeric keys, ranges,
}                              // both-or-neither, plus the columns, index and CHECKs

// a type is the tool for grading the REST of the object — § What `@type` adds beside `@point`
type SiteLocation { lat Float  lng Float  accuracy Float?  source String }
model Visit { site Json @type(SiteLocation) @point(lat, lng) }
```

**Without the marker the same thing is writable today, by hand**, which is what
makes G a shape rather than a wish — and it is this spelling that was run through
the parser:

```lite
model Job {
  site    Json   @type(Geo)
  siteLat Float? @generated("json_extract(site, '$.lat')")
  siteLng Float? @generated("json_extract(site, '$.lng')")
  @@index([siteLat, siteLng])
}
```

Run through `parse()` and `generateDDL()` on 2026-09-19 this is `valid: true`, no
errors, no warnings, and the emitter writes two `GENERATED ALWAYS AS (…) VIRTUAL`
columns inside a `STRICT` table plus the composite index. Executed against
`bun:sqlite`, a row inserted as `{"lat":40.71,"lng":-100.23}` reads back with
`siteLat` / `siteLng` populated and **the planner uses the index**:
`SEARCH job USING INDEX idx_job_siteLat_siteLng`. `VIRTUAL` stores nothing — the
index holds the numbers — and a `json_set` update moves the indexed value with it.

**Recommend G.** It is the only option that is atomic in BOTH directions: `site` is
one field the caller reads AND writes, which is the predictability cost F could
only mitigate. Everything it needs already ships — typed JSON (`type X { }` +
`@type(X)`, strict by default), `@generated` with a SQL expression, `@@index`, and
`CHECK` — so what the geo feature adds is the `near` operator and the kit, not a
storage design. Three things it gets that F does not: the range validators live in
the type (`@gte`/`@lte` rather than hand-written constraints), **the JSON Schema
already carries the shape**, so a control resolves from the declared type rather
than from an `x-*` keyword, and a second geo shape later — a polygon — is the same
mechanism with a different type rather than a new attribute.

**Measured guarantees, because the DB is what enforces them under `asSystem()`**:
`CHECK ((siteLat IS NULL) = (siteLng IS NULL))` and a range `CHECK` are both legal
over generated columns and both refuse — half-set rejected, `{lat: 91}` rejected,
malformed JSON rejected at insert. Two holes stay for the emitted `json_type`
`CHECK` and for `@point`'s own boundary validation to close, and they are named
rather than assumed: `{"lat":"40.5"}` (strings) coerces past a range check, and a
non-object JSON value (`"hello"`) stores as a null point.

**Its one real cost is adoption.** F was a line added to a model that already has
`latitude` / `longitude`; G is a migration of every existing row into a JSON
column. Every app in the survey — the lawn app, every Prisma app — starts from the
pair, so the cheapest adoption and the best shape are not the same option.

**F's write hole closes itself, and G does not have one.** A read-side field cannot be written, so a
create still states `latitude` and `longitude` — which leaves *both or neither*,
the one thing C's scalar would make unsayable. **The nine-question re-run moved
this**: an app writing `@@check((latitude == null) == (longitude == null))` by hand
is restating what `@geo` already knows, so **`@geo` emits the `CHECK` itself**.
What is left of C's advantage is that a half-set pair is refused by the database
rather than made unsayable by the type — a distinction with no runtime difference
and one line of DDL.

---

## What `@type` adds beside `@point`, and when a schema needs it

The two attributes answer different questions and the word *optional* on its own
hides that, so the rule is written out rather than implied.

**`@point(lat, lng)` is the whole declaration of a coordinate.** It says: this
field holds an object, these two keys carry the coordinate, they are numbers, they
are within ±90 / ±180, and there are two of them or none. That is not a subset of
what a type could say — it is the geo floor, and it is the same floor for every app,
which is why it belongs to the attribute rather than to a shape each app declares
for itself. **`@money(USD)` is the precedent again**: nobody declares a `Money`
type to use it, because the attribute carries the semantics whole.

**`@type(Geo)` grades the REST of the object**, which is a question only the app
can answer. A point that is only a point does not need it. A point that travels
with `accuracy`, `source`, `geocodedAt` or a provider's place id does, because
those keys are the app's and nothing else can say what they are:

```lite
type SiteLocation {
  lat        Float
  lng        Float
  accuracy   Float?
  source     String  @values(GeoSource)
  geocodedAt DateTime?
}

model Job {
  site Json @type(SiteLocation) @point(lat, lng)
}
```

**Three interaction rules, because *optional* is only true if they are stated.**

1. **Strictness is what `@type` buys.** `@type` is strict by default — an
   unexpected key is rejected — while `@point` alone checks its two keys and
   leaves the rest of the object alone. So *optional* means *optional until you
   want the whole object graded*, and a misspelled `acuracy` is kept silently
   without a type and refused with one. That is a reason to reach for it, not a
   detail.
2. **The coordinate keys must exist in the type, and `@point` names them.** A
   `@point(lat, lng)` over a type with no `lat` is a parse error rather than a
   field that validates and never matches — the same class of miss as a `@geo`
   naming a column that is not there.
3. **Where both could speak, the type may only NARROW.** `@point`'s ±90 / ±180 is
   the floor; a type declaring `lat Float @gte(49) @lte(61)` for an app that only
   operates in one country is an additional conjunct, never a replacement. Two
   validators, one direction, no second origin — and an app that widens past the
   floor is refused, because a latitude of 200 is not a business rule.

**So `@type` is optional the way it is optional everywhere else in `.lite`**: it is
the tool for grading a JSON value's shape, and a coordinate is the one shape the
framework already knows.

---

## Is the pair the value? — measured, because the instinct is right and does not decide it

*When would you want one without the other?* **Never** — a geocode that half-fails
returns neither, a form with one box filled is form state rather than a row, and a
single coordinate is not a location. The pair is the value, and so the value should
be ONE field. **That settles the field question and not the column question**,
because both shapes enforce the pairing: a `CHECK` does it over two real columns
and over two generated ones, both measured refusing.

What actually separates them was measured on 2026-09-19 instead, and it cuts both
ways.

**The pair's advantage is the database's own type system.** In a `STRICT` table
two `REAL` columns refuse `'hello'` outright — *cannot store TEXT value in REAL
column* — so the shape guarantee costs nothing and holds against a migration, a
seed, `fli tinker` and `asSystem()`, none of which pass a validator. A `TEXT`
column holding JSON has no such floor: measured, `"hello"` stored happily, and so
did `{"latitude": 40.7, "longitude": -100.2}` — **right numbers, wrong keys,
stored as a row with no location at all**.

**That gap closes, but only with a constraint written the non-obvious way.** A
`CHECK` over `json_type` refuses a scalar, refuses `{"lat": "40.7"}` and refuses an
out-of-range value — and **the obvious spelling of it silently admits everything
it was written to refuse**: `json_type(site,'$.lat') IN ('integer','real')`
evaluates to NULL for an object with no `lat`, a `CHECK` fails only on FALSE, and
`{}`, `{"lat": 40.7}` and the wrong-keys row above were all accepted. With
`coalesce(json_type(site,'$.lat'),'-')` all three are refused. **So under G the
framework must emit that constraint**, and an app that hand-writes the natural
version has a table that looks constrained and is not. (The general form of this is
now in the `data-hazards` skill, because it is true of every `@@check` in the
language today: `@@check("price > 0")` on `price Int?` accepts a row with no
price.)

**The other two differences are not about safety.** Adoption favors the pair —
every app in the survey stores `latitude` / `longitude`, so F is one added line and
G is a data migration of every row. Growth favors the JSON: `accuracy`, `source`,
`geocodedAt` and a provider's place id accrete without an `ALTER TABLE`, which is
exactly the shape the client application's own data took (`turfSqft`,
`lotSizeSqft`, `turfSource` — a measurement with provenance growing around it).

**So the honest fork is narrow.** F gives a single field to READ and the database's
own type floor, and asks a write to name two columns. G gives a single field to
read AND write and room to grow, and asks the framework to emit a constraint whose
naive form is useless. Neither is decided by *is the pair the value* — both agree
it is.

---

## How the boundary knows a field is a point

G as written above has no marker on it — `type Geo { }` is a name the app chose and
`Json @type(Geo)` is an ordinary typed-JSON field. So *what earns `near`?* Nothing,
until something says so, and the answer decides three things at once: which fields
accept a spatial operator, which fields get the index, and what a wrong one is
told.

**Two mechanics were measured first, because they bound the options** (2026-09-19,
`bun:sqlite`, 3,000 rows):

| query written as | index available | plan |
| --- | --- | --- |
| the generated COLUMN — `siteLat BETWEEN ? AND ?` | on the generated columns | `SEARCH job USING INDEX i1` |
| the EXPRESSION repeated — `json_extract(site,'$.lat') BETWEEN ? AND ?` | on the generated columns | **`SCAN job`** |
| the expression repeated | an EXPRESSION index over the same two extracts | `SEARCH j2 USING COVERING INDEX i2` |

**So the compiler may not re-inline the extraction and hope.** Either it names the
generated columns, or the index is an expression index and it names the expression
— and those two are the only shapes that work. An expression index needs no
generated columns at all, which is the version where the model carries no
`siteLat` / `siteLng` fields; `@@index` takes column names today, so that half is
the one piece of machinery this would add.

**Then the marker itself was run through the parser, which answered the question
this section originally got wrong.** Each spelling, against litestone today:

| spelling | verdict |
| --- | --- |
| `type Geo @point(lat, lng) { … }` | **does not parse** — `Expected LBRACE, got '@'` |
| `type Geo { … @@point(lat, lng) }` | parses structurally, refused by name: *unknown model attribute* — and `@@index` in the same position answers **`@@index not allowed in a type — types describe value shapes, not models`** |
| `site Json @type(Geo) @point(lat, lng)` | parses as an ordinary field attribute; the only complaint is *references unknown function `point`*, which is what an unrecognized field attribute falls through to |

**A marker on the type is therefore a new concept twice over**: a grammatical
position that does not exist (an attribute between a type's name and its brace),
and a widening of what a type is allowed to say, against a refusal the language
already states in those words — *types describe value shapes, not models.* A
marker on the FIELD is neither: adding `@point` to the known field attributes is
how `@money`, `@date` and every other semantic attribute arrived.

**Five ways to mark it.**

1. **By the type's NAME** — any `@type(Geo)` field is a point. Refused: the name is
   the app's (`Location`, `LatLng`, `Coordinates` are all likelier), nothing stops
   `type Geo { x Int }`, and a framework that reads meaning out of a user-chosen
   identifier is the magic this repo refuses everywhere else.
2. **By SHAPE inference** — a type with `lat Float` and `lng Float` is a point.
   Refused for the same reason one layer down: it is derived where it should be
   declared, and it is silently wrong for the model whose `lat` means something
   else.
3. **A marker on the TYPE** — `type Geo @point(lat, lng) { … }`. Refused on the
   measurement above: two new concepts for a saving that was overstated (see 4).
4. **A marker on the FIELD** — `site Json @type(Geo) @point(lat, lng)`. **The
   existing mechanism, and the `@money` precedent is exact**: a currency is a
   shape fact that lives in one place, and `@money` is still written on every money
   column — `example` carries it on dozens — because the attribute states this
   column's ROLE rather than restating the shape. A point is the same:
   `@point(lat, lng)` names which keys of THIS field carry the coordinates.
5. **A framework-SHIPPED type the app imports** — the shape `@frontierjs/auth`
   already uses for its models, so the type is known by identity rather than by
   name. Cheapest to reason about, and it forbids the app an extra field
   (`altitude`, `accuracy`, the provider's place id) unless types become
   extendable. It also does not answer the question on its own: identity still has
   to be READ by something, which is 1 with extra steps.

**Recommend 4.** It is a new word in an existing grammar rather than a new place
for words to live, the language's own refusal message says why the type is the
wrong home, and `@money` settles that a per-field semantic marker is this
language's normal shape. **What it earns is unchanged**: `@point` is what makes
`near` available on that field and refused by name everywhere else, what emits the
generated columns (or the expression index) and the range and pairing `CHECK`s, and
what lets `fli check` ask *a point with no index* and *a spatial filter on a field
that is not one*. `@type(Geo)` stays beside it for the object's OTHER keys — see § *What `@type`
adds beside `@point`*, which states the three interaction rules, since `@point`
already carries the coordinate floor whole.

---

## What derives from the declaration

The test of B is whether one line in the seed pays for more than one thing. Six
readers, all of which exist already and none of which is given a new owner:

- **The index, and the pairing rule.** A declared point earns a composite index
  (or, once an app is actually slow, an R*Tree shadow table — measured ~2× faster
  end to end at every scale from 5k to 1M rows, since a composite index prunes
  only its leading column and walks a latitude band) without anybody writing
  `@@index`, the way `@@tenant` earns its own — and a hand-written `@@index` on the same two columns is a
  duplicate the schema advisor names rather than a second index built quietly. The
  same declaration emits `CHECK ((latitude IS NULL) = (longitude IS NULL))`, since
  a half-set pair composes without complaint and then leaves every `near` result
  with a 200.
- **The filter, and only the filter.** `where: { site: { near: { lat, lng, within:
  '5mi' } } }` compiles to a bbox against the index plus an exact haversine in SQL
  — one owner, at the Data boundary, so `@@gate` and `@@allow` are already in front
  of it. The client app's `isWithinRadius()` is this query, run in a browser, over
  rows the server already decided to send. **Every other operator on the field is
  refused by name** — `equals`, `contains`, an `orderBy` that is not `near` —
  because the composed value is JSON and JSON compares as text, which is the trap
  litestone already has a message for.
- **Validation.** Latitude outside ±90, longitude outside ±180, and one of the pair
  set without the other — three refusals nothing checks today in any app here.
- **The JSON Schema, and therefore the form.** `x-geo` beside `x-gate` and
  `x-transitions`, which is what lets `@frontierjs/ui` resolve a map control the way
  `controlFor()` resolves every other control.
- **The audit trail.** A precise coordinate for a residential property is a
  person's address. `@guarded` composes with the pair as it stands (Invariant 7) —
  what needs saying is that it must be declared on the PAIR, since redacting one
  half of a coordinate redacts nothing.
- **Nothing on the wire.** A filter is `ctx.query`, never a `$`-prefixed key
  (Invariant 10), so this adds no directive and no row to the directives table.

---

## The pure half — a `@frontierjs/toolbelt/geo` kit

The math is pure functions over numbers, which is exactly `FJS-D26`'s admission
test, and both ends need it: the server to answer a query, the browser to grade a
record already on screen (`matchesQuery`'s problem, one realm over). Sized by what
the client app actually calls rather than by what turf ships:

| Needed | What it replaces there |
| --- | --- |
| `distance(a, b)` | Leaflet `L.latLng().distanceTo()` |
| `boundingBox(center, radius)` | the hand-rolled `margin = 0.0002` |
| `pointInPolygon(p, ring)` | `isMarkerInsidePolygon`, a ray-cast in a component |
| `polygonArea(ring)` | `turf.area` |
| `centroid(points)` | `getGeoCenter`, a mean of raw degrees |
| `convexHull(points)` · `buffer(ring, m)` | `turf.convex` · `turf.buffer` |

The first five are small and well-defined. **The last two are the line**: a hull
and a spherical buffer are a real geometry library, and shipping half of one is how
a kit stops being severable (§ IV, batteries vs. smallness). They are listed as
what the real application needed, and proposed as *out* until a second consumer
asks.

**Geocoding is not in this.** An address becoming a coordinate is a third party
answering a question, which is `app.conduit.send()` and a vendor the framework does
not name (`FJS-D153`). The client app calls Nominatim from the browser
(`Map.svelte:17`); that is a conduit target, not a kit function.

---

## The nine questions — run on F, then on G

**Run three times, and each run is named for when it happened, which is the
answering-late the skill requires.** The first pass graded the proposal as B and
passed it. The second is the body below, against F — `site Json @geo(latitude,
longitude)` — and **it changed three things**, each marked ⇒. The third is § *What
the third run changed*, against G, and it moved the recommendation. A pass that
changes nothing is usually a pass that was written afterwards.

- **Another origin of truth?** No. The two `Float` columns are the only storage and
  `site` is composed from them per read; nothing can disagree with them because
  nothing else holds a coordinate. The near-miss is the INDEX: an app that also
  writes `@@index([latitude, longitude])` by hand now has the pairing stated twice.
  ⇒ **the index is emitted from `@geo` and a hand-written duplicate is named by the
  schema advisor**, rather than both being built.
- **Concept budget?** One attribute and one filter operator. It is the cheapest of
  the six: C adds a scalar type AND field-to-columns 1:N, E adds a value kind to an
  expression language with three evaluators, D adds a sugar that has to be undone
  mentally at the boundary. F adds a word.
- **Whose complexity?** The problem's. A point is two numbers that must be indexed
  separately and read as one; F is that sentence and nothing else.
- **Predictability?** **This is F's weak question and it is a real cost.** You READ
  `site` and you WRITE `latitude` and `longitude`. The asymmetry is not new — every
  `@derived` / `@computed` / `@from` field has it — but those are visibly
  expressions, and a point looks writable. Two things keep it honest, both of which
  already exist: litestone refuses a write to a read-side field **by name and says
  why**, and `x-geo` publishes which two columns the value came from, so one form
  control writes two payload keys without anybody guessing. ⇒ **the refusal text is
  part of the feature, not a detail**: *`site` is read-side — write `latitude` and
  `longitude`*. The other half of the cost is the declared type: `Json` says
  *arbitrary* where the truth is `{lat, lng}`, which is what `x-geo` is for and is
  the honest price of not coining a scalar.
- **Derivable rather than restated?** F's entire thesis, and the strongest of the
  nine. The field is derived from the columns; the index, the validation, the
  schema keyword, the control and the audit treatment are all derived from the one
  declaration. Under B the same information exists and `site` is not a field, so
  five consumers restate a grouping that is not in the field list.
- **Exactly one owner?** Yes, and asking it exposed a seam worth stating: the
  VALUE is composed once (in the SELECT, or in JS after the read — an
  implementation choice, not a second owner), while `near` never filters the
  composed value at all — it is rewritten onto the two columns the attribute names.
  ⇒ **anything but `near` on `site` is refused by name** (`site: { equals: … }`,
  `orderBy: { site: 'asc' }`), because a JSON value that silently compares as text
  is the `@computed` trap litestone already has a message for.
- **Boundary explicit?** Named (`@geo`), typed (two `Float`s with range checks),
  published (`x-geo`), and testable on both engines — which the measurements
  establish is possible with no extension and no second code path.
- **Failure proportional?** An out-of-range coordinate is a refused write. A `@geo`
  naming a missing or non-`Float` column is a parse error. A `near` filter on a
  model with no point is refused by name. A too-wide query is slow, not wrong.
  Nothing here can widen access.
- **Can it be wrong silently?** **Two ways, and both get a mechanism rather than a
  warning.** The first is the bbox at the antimeridian or a pole: fewer rows,
  status 200 — the field shipped this defect repeatedly (Elasticsearch, qdrant,
  GeoBlacklight), and the known fix is to SPLIT a wrapping range into two
  envelopes, graded against a brute-force scan. The second is F's own and the
  re-run is what found it: **a half-set pair**. `{ lat: 40.7, lng: null }` composes
  without complaint, every kit function returns `NaN`, every comparison is false,
  and the row quietly leaves every `near` result with a 200. ⇒ **`@geo` emits the
  both-or-neither `CHECK` itself** — `CHECK ((latitude IS NULL) = (longitude IS
  NULL))` — rather than leaving the app to write `@@check`. The declaration already
  knows both columns, so making the app restate the pairing would fail the
  derivable question two rows up. It also shrinks C's best argument: *the pair can
  be half-set* is answered by the DDL, not by a type.

**Verdict on F: passes nine, weakest on predictability, and the run changed the
proposal three times** — the emitted `CHECK`, the emitted index with a named
duplicate, and the refusal of every non-`near` operator on the field.

### What the third run changed

Run against G — `type Geo { }` + `site Json @type(Geo)` + two `@generated`
columns — and only the answers that MOVE are restated; the rest are F's, unchanged.

- **Predictability**, F's weak question, **is no longer weak.** G is atomic in both
  directions: the caller writes `{ lat, lng }` and reads `{ lat, lng }`. The
  read-side asymmetry, the write refusal that had to name two columns, and the one
  control that had to write two payload keys all stop being needed. The declared
  declaration is also what a reader sees — `site Json @point(lat, lng)` says the
  shape where F's `Json` said *arbitrary*.
- **Another origin of truth?** The question G has to answer that F did not: the
  coordinate exists as JSON text AND as two numeric columns. It passes because
  **the second copy is the database's own** — `GENERATED ALWAYS AS` is maintained
  by SQLite, measured moving with a `json_set` update, and `VIRTUAL` means it is
  not even stored, only indexed. A derivation the engine owns is not a second
  origin; a derivation the application writes on save would have been.
- **Derivable rather than restated?** Still the strongest answer, and better: under
  G the range checks are the type's own `@gte`/`@lte`, and the JSON Schema carries
  the object shape, so the form control resolves from the declared type rather than
  from an `x-*` keyword that F had to publish.
- **Can it be wrong silently?** The half-set hole is closed by the same `CHECK`,
  measured legal over generated columns and measured refusing. **Two new holes,
  both at the JSON boundary and both named rather than assumed**: `{"lat":"40.5"}`
  coerces past the DB checks, and a non-object JSON value stores as a null point.
  Those are the emitted `CHECK`'s to refuse — measured closable, and closable only
  in the `coalesce()` spelling, since a `CHECK` that evaluates to NULL passes — so
  the mechanism exists; what is owed is a test that offers it the null-shaped row
  as well as the bad one.
- **Concept budget?** Lower than F's, which is the surprise. F coined an attribute;
  **G coins nothing** — `type`, `@type`, `@generated`, `@@index` and `CHECK` all
  ship, and the schema above is `valid: true` through litestone's own parser today.
  What the geo feature adds is the `near` operator and the kit.
- **Failure proportional?** One regression, and it is not runtime: **adoption**.
  Every app in the survey stores the pair, so G is a data migration where F was an
  added line. A wrong answer here costs a migration, not a defect.

**Verdict on G: passes nine, no weak question, and it is the one option that
required no language change** — which is why the recommendation moved. The six
months out tiebreak (§ V) holds either way, since both are predictable from
mechanisms already in the seed.

**Adjudications in tension** (§ IV): *ergonomics vs. strictness* decides the write
asymmetry, and it is resolved by cost — a wrong point is a wrong visit, a wrong
delivery or a wrong technician, so the strict answer (read-side field, named
refusal, emitted CHECK) is right and the ergonomic one (C's writable scalar) does
not buy enough to pay for 1:N field mapping. *Familiarity vs. precision* governs
the words: PostGIS's `geometry` / `geography` / SRID half-fit a two-column SQLite
point and are rejected; `near` and `within` are kept because they name what is
asked. *Batteries vs. smallness* governs the kit and is answered by leaving the
hull and the buffer out. *Paved road vs. the workaround* is why the record exists:
the same workaround, in the same place, in a real application, four times in one
file.

**Tier** (§ VII): Assessment. It becomes a ruling when question 0 is answered, and
a map only once something enforces it.

---

## Open questions

Twelve, ordered by what blocks the first line of code. The first two decide how a
point is spelled and what earns it a spatial operator, the third decides the
feature set; the rest are answerable in any order once it is picked. **Every
option below is written out as code in § *The options as code*, numbered to
match**, against the client application the evidence came from.

- ~~**How is a point DECLARED — two fields or one?**~~ **Answered 2026-09-20 (`FJS-D316`): G — a declared TYPE in a JSON column with the numbers generated back out: `type Geo { lat Float @gte(-90) @lte(90) · lng Float … }` + `site Json @type(Geo)` + two `@generated("json_extract(site, '$.lat')")` columns and an index over them.** The storage answer and the
  spelling answer are separable; § *Shape* argues all six, and `.lite` already has
  a field class that is not a column (`@derived` / `@computed` / `@from`).
  - **A** — one column holding a composite value (`site Geo` as text, JSON or WKB).
  - **B** — two `Float` columns grouped by `@@geo(site: latitude, longitude)`.
  - **C** — a `Geo` scalar the DDL expands to `site_lat` / `site_lng`.
  - **D** — `Geo` as parse-time sugar that expands to B before anything else sees it.
  - **E** — a read-side FIELD over the two real columns, spelled as an expression:
    `site Geo @derived(point(latitude, longitude))`.
  - **F** — the same read-side field, spelled as an attribute naming its two sibling
    columns: `site Json @geo(latitude, longitude)`.
  - **G** — a declared TYPE in a JSON column with the numbers generated back out:
    `type Geo { lat Float @gte(-90) @lte(90) · lng Float … }` + `site Json
    @type(Geo)` + two `@generated("json_extract(site, '$.lat')")` columns and an
    index over them.
  - **Recommend G** — it is the only option atomic in BOTH directions: `site` is one
    field the caller reads AND writes, which is the one cost F could only mitigate
    (F is read-side, so you read `site` and write the pair). **It needs no language
    change**: run through litestone's own `parse()` and `generateDDL()` it is
    `valid: true` and emits two `GENERATED ALWAYS AS (…) VIRTUAL` columns in a
    `STRICT` table plus the composite index, and against `bun:sqlite` the planner
    uses that index (`SEARCH job USING INDEX idx_job_siteLat_siteLng`) while
    `VIRTUAL` stores nothing. The range checks live in the declared type, the JSON
    Schema already carries the shape so a control needs no `x-*` keyword to find
    it, and a polygon later is a second type rather than a second attribute. Both
    guarantees hold at the DB: a `CHECK` over generated columns is legal and
    refuses a half-set point and an out-of-range one. **Its cost is adoption** —
    every app in the survey starts from a `latitude`/`longitude` pair, and G is a
    data migration where F is one added line; that is the trade to weigh, since
    the cheapest adoption and the best shape are not the same option, and § *Is the
    pair the value?* prices both sides. **The other half of G's cost is measured**:
    a `TEXT` column has no type floor, so `"hello"` and `{"latitude": …,
    "longitude": …}` both store as a row with no location, where two `REAL` columns
    in a `STRICT` table refuse the first outright — and the `CHECK` that closes it
    must be emitted by the framework, since its natural spelling
    (`json_type(site,'$.lat') IN ('integer','real')`) evaluates to NULL for a
    missing key and a `CHECK` fails only on FALSE. A is refused
    outright by the survey; C adds field-to-columns 1:N; D's sugar stops being true
    at the boundary; E needs a `point()` value kind in three evaluators.
- ~~**What is in V1?**~~ **Answered 2026-09-20 (`FJS-D318`): B — A, plus distance ordering, so a nearest-first list paginates correctly.** The three questions in § *The three questions* are not one
  feature, and the cut decides whether an app can delete its client-side geo math
  or only half of it. **Two things are out under every option below and each needs
  its own record**: a geo predicate inside `@@allow` (*a technician reads jobs
  inside their territory*), which needs C's polygon and needs the `.lite` expression
  grammar to grow an operator in three evaluators at once (`FJS-D259`, `FJS-D271`);
  and a **coarsened read**, where a lower standing sees two decimal places rather
  than a refusal — the most interesting idea in this file, since the access ladder
  has only ever granted or redacted a read and never degraded one, and smuggling it
  in as a column option is how a new access primitive arrives undiscussed.
  - **A** — the declaration and the filter: `@@geo`, a `near` filter at the Data
    boundary, the index, the range refusals, `x-geo`. Nothing leaves the boundary
    that is not a row.
  - **B** — A, plus distance ordering, so a nearest-first list paginates correctly.
  - **C** — B, plus areas: a polygon column, containment, and the measurement's
    provenance.
  - **Recommend B** — under A a list screen can filter but cannot sort, and
    nearest-first is most of what anybody asks a coordinate for; sorting a page in
    the client is wrong by construction the moment there is a second page, which
    sends the app straight back to the math this record exists to delete. C is a
    second noun, a second storage question and a provenance design, and it is the
    half neither engine can index (§ *What both engines already hold*).
- ~~**Where does the marker live — what earns a field `near`?**~~ **Answered 2026-09-20 (`FJS-D317`): D — a marker on the FIELD: `site Json @type(Geo) @point(lat, lng)`.** Under G nothing on
  the field says *this is spatial*; § *How the boundary knows a field is a point*
  argues all five, and two mechanics are measured there.
  - **A** — the type's NAME: any `@type(Geo)` field is a point.
  - **B** — SHAPE inference: a type with `lat`/`lng` Floats is a point.
  - **C** — a marker on the TYPE: `type Geo @point(lat, lng) { … }`.
  - **D** — a marker on the FIELD: `site Json @type(Geo) @point(lat, lng)`.
  - **E** — a framework-SHIPPED type the app imports, known by identity.
  - **Recommend D** — measured against the parser: `type Geo @point(lat, lng) {`
    **does not parse** (`Expected LBRACE, got '@'`), and the same marker inside the
    braces is refused with the language's own sentence — *`@@index` not allowed in
    a type — types describe value shapes, not models*. So C is two new concepts, a
    grammatical position and a widening of what a type may say, while D is a new
    WORD in an existing grammar: `site Json @type(Geo) @point(lat, lng)` already
    parses and fails only as an unknown attribute name. **`@money` is the
    precedent** — a currency is a shape fact declared once and the attribute is
    still written on every money column, because it states the column's ROLE — so a
    per-field marker is this language's normal shape rather than a redundancy. A is
    magic over a user-chosen identifier, B is derived where it should be declared
    and silently wrong for the model whose `lat` means something else, and E does
    not answer the question on its own: an identity still has to be read by
    something, which is A with extra steps.
- ~~**Is the point named, or is there one per model?**~~ **Moot 2026-09-20** — the
  declaration ruling (`FJS-D316`) makes a point a FIELD, and a field has a name, so
  `depot` and `lastSeen` are simply two fields. The question existed only under the
  model-level `@@geo(name: latitude, longitude)` spelling, and is live again only if
  that ruling is reopened.
- ~~**How is a distance stated?**~~ **Answered 2026-09-20 (`FJS-D319`): A — a string carrying its unit: `within: '5mi'`, parsed by one function in the kit.**
  - **A** — a string carrying its unit: `within: '5mi'`, parsed by one function in
    the kit.
  - **B** — meters, always, a bare number.
  - **C** — an object, `within: { miles: 5 }`.
  - **Recommend A** — B is the shape that ends in callers multiplying by 1609.34 by
    hand, which both geo files in the client app do, and a bare number in a URL is
    unreadable at the one moment somebody is debugging it. `@frontierjs/toolbelt/units`
    already owns *what a quantity means*, so the parse has an owner and is not a
    second vocabulary.
- ~~**Does the distance come back with the row?**~~ **Answered 2026-09-20 (`FJS-D320`): B — no; the row carries its point and the caller knows the center, so the client computes it with the same kit function the server used.**
  - **A** — yes, as a transient the query adds when it filtered or sorted by `near`.
  - **B** — no; the row carries its point and the caller knows the center, so the
    client computes it with the same kit function the server used.
  - **Recommend B** — it is derivable from data already on the row, which is the
    question § V asks first; A spends an envelope field and a name that can collide
    with a real column to save a subtraction. If a screen wants *2.3 mi away*, one
    kit call answers it with no server contract at all.
- ~~**Can a query order by distance, and how does that travel?**~~ **Answered 2026-09-20 (`FJS-D321`): A — `orderBy: { home: { near: center } }`, structured, the way `@frontierjs/toolbelt/query` already carries structure in a query string.**
  - **A** — `orderBy: { home: { near: center } }`, structured, the way
    `@frontierjs/toolbelt/query` already carries structure in a query string.
  - **B** — no distance ordering; filter with `near` and sort the page client-side.
  - **Recommend A**, and it is what makes V1 = B above — a page sorted after it was
    selected is the wrong twenty rows, silently, and the expression is already
    computed to do the filtering. The `$orderBy` DIRECTIVE is untouched (Invariant
    10): the directive is still one key on the wire, and what changed is the shape
    of the value it carries.
- ~~**Does the bbox use a composite index, an R*Tree, or a cell id?**~~ **Answered 2026-09-20 (`FJS-D315`): A — composite `(lat, lng)` index. No second table, no triggers, no join, and the filter stays a `WHERE` on the same table that every policy, gate and other filter already AND-s into.** **Measured
  twice, because the first measurement was wrong and said 11×.** That run compared
  a COVERING count over the R*Tree — which never touches the base table — against a
  composite-index query that fetched rows, so it priced two different questions.
  Re-run with both sides returning real rows, and again end to end with the exact
  haversine on top, at 5k / 50k / 200k / 1M rows over a one-degree square: **the
  R*Tree is 1.8× to 2.3×, and the ratio is flat.** At 200k rows a 5-mile box
  costs 2.2 ms composite and 1.2 ms R*Tree, and both return the identical 1,026
  rows. The composite index really does prune only its leading column — a latitude
  BAND, index-only, which is why the band is cheap in absolute terms rather than
  free.
  - **A** — composite `(lat, lng)` index. No second table, no triggers, no join,
    and the filter stays a `WHERE` on the same table that every policy, gate and
    other filter already AND-s into.
  - **B** — an R*Tree shadow table: measured present in both engines, documented on
    D1, available on Turso, and measured ~2× faster at every scale tested. Costs a
    virtual table per point, three triggers to keep it honest, a migration differ
    that must not drop what it did not declare, a `@@softDelete` interaction (a
    soft delete is an UPDATE, so the row stays unless a trigger says otherwise),
    and a query that becomes a JOIN. **Also: R*Tree coordinates are 32-bit
    floats**, so it is a PREFILTER and never the answer — one run showed 2 rows of
    1,304 differing at the boundary. That is exactly how it would be used here
    (bbox, then exact haversine), so it is a constraint rather than a defect.
  - **C** — a cell id column (geohash / S2 / H3).
  - **Recommend A** — for V1, and the honest reason is the corrected number: 2× for
    a shadow table, three triggers, a differ rule, a soft-delete rule and a JOIN in
    the one code path every other filter composes into is not a trade to take
    before a real app is slow. It was arguably a trade to take at 11×. B changes no
    declaration when it lands, so the app that gets big pays for it then; what it
    does change is the query path, which is the reason to write that path once with
    the join in mind. C stays rejected: a second representation of a coordinate,
    recomputed on every write, and geohash's prefix seam brings the eight-neighbor
    probe back anyway.
- ~~**How does a `near` filter travel on a query string?**~~ **Answered 2026-09-20 (`FJS-D323`): B — the kit's existing bracket notation: `?site[near][lat]=40.71&site[near][lng]=-100.23&site[near][within]=5mi`.** It is a filter value, so
  the owner is `@frontierjs/toolbelt/query` (Invariant 10's sibling module) and
  three readers parse it — junction's transport, junction's client writing one, and
  sierra's router onto `page.query`.
  - **A** — a compact triple the geo layer parses: `?site.near=40.71,-100.23,5mi`.
  - **B** — the kit's existing bracket notation:
    `?site[near][lat]=40.71&site[near][lng]=-100.23&site[near][within]=5mi`.
  - **C** — split keys: `?site.near=40.71,-100.23&site.within=5mi`.
  - **Recommend B** — the kit already owns *what a query string MEANS*, and
    structure in it is bracket notation; A and C each invent a second structure
    syntax that only the geo feature knows, which is the shape `FJS-D125` exists to
    prevent. It is longer to read and it is parsed by the three readers that
    already exist rather than by a fourth.
- ~~**What is the cursor key for a distance-ordered page?**~~ **Answered 2026-09-20 (`FJS-D324`): A — `(distance, id)`, with the center carried inside the cursor so the next page recomputes the same order.** `$after` / `endCursor` /
  `resource.more()` page by something the row carries; a distance is computed per
  query from a center the next page must also know.
  - **A** — `(distance, id)`, with the center carried inside the cursor so the next
    page recomputes the same order.
  - **B** — no cursor pagination on a distance order: offset only, and say so.
  - **C** — return the distance as a column and cursor on it like any other.
  - **Recommend A** — a nearest-first list is exactly the screen that scrolls, so B
    gives the feature away at the moment it is used; C is the transient this record
    already declined, and it makes the cursor depend on a value the caller could
    have changed. A needs the center in the cursor and a tiebreak on `id`, both of
    which the existing cursor machinery can carry.
- ~~**Are the convex hull and the spherical buffer in the kit?**~~ **Answered 2026-09-20 (`FJS-D325`): A — out. Distance, bbox, point-in-polygon, area, centroid — five small functions with no shared machinery.**
  - **A** — out. Distance, bbox, point-in-polygon, area, centroid — five small
    functions with no shared machinery.
  - **B** — in, because a crew's working area is the one thing the real application
    could not do without them.
  - **Recommend A** — a hull and a buffer are a geometry library with a spine, and
    half a geometry library is a battery that has stopped being severable (§ IV).
    One consumer asked; a second one flips this.
- ~~**Does `@@geo` imply `@guarded`?**~~ **Answered 2026-09-20 (`FJS-D322`): A — no. Declare it, and the parser warns when a point is ungated on a model whose `@@gate` is above STRANGER.**
  - **A** — no. Declare it, and the parser warns when a point is ungated on a model
    whose `@@gate` is above STRANGER.
  - **B** — yes, opt out — a residential coordinate is a person's address.
  - **Recommend A** — a shop's location is public and a silent default that redacts
    it produces the empty-screen failure in the audit trail instead of the UI, which
    is worse than the same mistake on a screen because nobody is looking. The warning
    is where the safety lives.
- ~~**Does the live store grade an arriving record against a `near` filter?**~~ **Answered 2026-09-20 (`FJS-D326`): A — teach `@frontierjs/toolbelt/match` the `near` predicate.**
  - **A** — teach `@frontierjs/toolbelt/match` the `near` predicate.
  - **B** — answer `null`, the *ask the server* escape that kit already has.
  - **Recommend A** — `/match`'s `null` exists for facts the client cannot know, and
    a distance between two points it is holding is not one of them; under B every
    live list re-fetches on every arriving row, which is the cost that made the kit
    exist.
- ~~**Does `@frontierjs/ui` ship a map control?**~~ **Answered 2026-09-20 (`FJS-D327`): A — no. `x-geo` is published, `controlFor()` resolves a validated lat/lng pair, and an app that wants a map brings its own.**
  - **A** — no. `x-geo` is published, `controlFor()` resolves a validated lat/lng
    pair, and an app that wants a map brings its own.
  - **B** — yes, a `<MapField>` over a tile provider.
  - **Recommend A** — a map is a rendering library plus a tile VENDOR (the client
    app carries `leaflet`, `leaflet-draw` and `svelte-map-leaflet` for one), which
    is a battery with tendrils and a vendor choice `FJS-D153` keeps out of this
    repo. Two number inputs that refuse ±90/±180 and show the point's own value is
    a control the kit can own without lying about what it is.

---

## The options as code

Every question above, written out. The domain is the client application the
evidence came from — a `Job` at a property, a `Crew` that works out of a depot —
so the comparison is against work somebody actually does rather than against
`Foo`. **None of this runs**; it is what each option would look like if it were
picked.

### 0 · How a point is declared

```lite
// A — one column, composite value.
model Job { site Geo @required }          // stored "40.71,-100.23" / {"lat":…} / WKB
```
```sql
-- what A costs, in the one query the feature exists for
SELECT * FROM job WHERE site BETWEEN ? AND ?;   -- meaningless: the column is text
-- and there is no CHECK to write, no index to build, and @from(min:) sees a string
```

```lite
// B — two columns, one declaration. Nothing new at the storage layer.
model Job {
  latitude  Float?
  longitude Float?
  @@geo(site: latitude, longitude)
}
```
```sql
CREATE INDEX job_site_idx ON job (latitude, longitude);
ALTER TABLE job ADD CHECK (latitude BETWEEN -90 AND 90);
```
```ts
row.latitude, row.longitude          // two fields, and either can be set alone
```

```lite
// C — one field, two columns underneath.
model Job { site Geo @required }     // DDL: site_lat REAL NOT NULL, site_lng REAL NOT NULL
```
```ts
row.site                             // { lat, lng } — atomic, cannot be half-set
await db.job.update({ where: { id }, data: { site: null } })        // clears both
await db.job.update({ where: { id }, data: { site: { lat: 1 } } })  // …and this means what?
// every one of these has to learn that one field is two columns:
//   ddl.js · the migration differ · generateJsonSchema · select · orderBy
//   patch semantics (Invariant 9) · audit field entries · @@index args · x-*
```

```lite
// D — sugar. The seed reads like C; everything above the parser is B.
model Job { site Geo }               // parses to: latitude Float? · longitude Float? · @@geo(site: …)
```
```ts
row.site        // undefined — the API returns row.latitude and row.longitude
```

```lite
// F — a read-side field over the two real columns. No new column kind, no new
// scalar, no new expression value: `@derived`/`@computed`/`@from` are already
// fields that are not columns, and `@money(field: currency)` is already an
// attribute naming a sibling column.
model Job {
  latitude  Float?
  longitude Float?
  site      Json  @geo(latitude, longitude)
}
// the declaration emits both, because it knows both columns:
//   CREATE INDEX job_site_idx ON job (latitude, longitude);
//   CHECK ((latitude IS NULL) = (longitude IS NULL))     -- no half-set pair
```
```ts
row.site                              // { lat: 40.71, lng: -100.23 } — one value to read
await db.job.create({ data: { latitude: 40.71, longitude: -100.23 } })   // the write is the pair
await db.job.findMany({ where: { site: { near: { lat, lng, within: '5mi' } } } })
//                              ^ compiles to the two columns the attribute names,
//                                the way a @derived field compiles to its expression

// everything else on the field is refused BY NAME rather than compared as text:
await db.job.findMany({ where:   { site: { equals: '40.71,-100.23' } } })   // refused
await db.job.findMany({ orderBy: { site: 'asc' } })                        // refused
await db.job.create({ data: { site: { lat, lng } } })
//   → site is read-side — write latitude and longitude
```

```lite
// G — a declared type in a JSON column, with the numbers generated back out.
// `@point` on the FIELD is what earns `near`; everything under it is emitted.
model Job {
  site Json @point(lat, lng)   // written AND read as one value; `@type` only when the
}                              // object carries more than the coordinate

// the same thing written by hand, with no marker and no new language — this is the
// spelling that was run through litestone's parser: `valid: true`, no warnings
model Job {
  site    Json   @type(Geo)
  siteLat Float? @generated("json_extract(site, '$.lat')")   // VIRTUAL — stores nothing
  siteLng Float? @generated("json_extract(site, '$.lng')")
  @@index([siteLat, siteLng])
}
```
```sql
-- what litestone's own emitter writes for it, verbatim
CREATE TABLE IF NOT EXISTS "job" (
  "id"      INTEGER NOT NULL PRIMARY KEY,
  "address" TEXT NOT NULL,
  "site"    TEXT NOT NULL,
  "siteLat" REAL GENERATED ALWAYS AS (json_extract(site, '$.lat')) VIRTUAL,
  "siteLng" REAL GENERATED ALWAYS AS (json_extract(site, '$.lng')) VIRTUAL
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_job_siteLat_siteLng" ON "job" ("siteLat", "siteLng");

-- and the planner uses it
EXPLAIN QUERY PLAN SELECT id FROM job WHERE siteLat BETWEEN ? AND ? AND siteLng BETWEEN ? AND ?;
--> SEARCH job USING INDEX idx_job_siteLat_siteLng (siteLat>? AND siteLat<?)
```
```ts
await db.job.create({ data: { address: '12 Elm', site: { lat: 40.71, lng: -100.23 } } })
row.site                    // { lat, lng } — the same shape going in and coming out
await db.job.findMany({ where: { site: { near: { lat, lng, within: '5mi' } } } })
//                              ^ compiled onto the generated COLUMNS by name — never by
//                                re-inlining json_extract, which measures as a full SCAN
await db.job.findMany({ where: { notes: { near: { lat, lng, within: '5mi' } } } })
//   → `near` needs @point on the field — Job.notes does not carry it
```

### 1 · What is in V1?

```lite
model Job {
  id        Int      @id
  address   String
  latitude  Float?
  longitude Float?
  scheduledFor DateTime

  site      Json  @geo(latitude, longitude)   // the recommended spelling (F)
  @@gate("0.4.4.5")
}
```

```ts
// A — filter only.
const nearby = await db.job.findMany({
  where: { site: { near: { lat: 40.71, lng: -100.23, within: '5mi' } },
           scheduledFor: { gte: today } },
  limit: 50,
})
// …and the screen still sorts 50 rows by hand, or shows them in id order.

// B — filter and order. The page is the nearest 50, not 50 of the near ones.
const nearby = await db.job.findMany({
  where:   { site: { near: { lat: 40.71, lng: -100.23, within: '5mi' } } },
  orderBy: { site: { near: { lat: 40.71, lng: -100.23 } } },
  limit:   50,
})

// C — B, plus an area. Neither engine indexes this, so it is a scan the kit
// filters after the fact; that is the whole reason it is not in V1.
const inTerritory = await db.job.findMany({
  where: { site: { inside: crew.territory } },   // crew.territory is GeoJSON in a Json column
  limit: 500,
})
```

### 2 · Named point, or one per model?

```lite
// A — named. Under F a point is a field, so a second one is a second field and
// this question answers itself; under B it is a second @@geo line.
model Crew {
  depotLat    Float?
  depotLng    Float?
  lastSeenLat Float?
  lastSeenLng Float?

  depot    Json @geo(depotLat, depotLng)
  lastSeen Json @geo(lastSeenLat, lastSeenLng)
}
```

```ts
await db.crew.findMany({ where: { lastSeen: { near: { ...here, within: '10mi' } } } })
await db.crew.findMany({ where: { depot:    { near: { ...here, within: '30mi' } } } })
```

```lite
// B — anonymous. The model has *a* location and the query does not name one.
model Crew {
  latitude  Float?
  longitude Float?
  @@geo(latitude, longitude)      // only expressible under B — a field must have a name
}
```

```ts
await db.crew.findMany({ where: { near: { ...here, within: '10mi' } } })
// The second point has nowhere to go. It arrives as `@@geo2`, or as a `CrewPosition`
// model, or as the JSON blob this record exists to delete.
```

### 3 · How is a distance stated?

```ts
// A — a string carrying its unit.
where: { site: { near: { lat, lng, within: '5mi' } } }
where: { site: { near: { lat, lng, within: '800m' } } }
// on the wire:  ?site.near=40.71,-100.23,5mi

// B — meters, always.
where: { site: { near: { lat, lng, within: 8046.72 } } }
//                                          ^ every caller writes radius * 1609.34,
//                                            which is what both lawn-app files do

// C — an object.
where: { site: { near: { lat, lng, within: { miles: 5 } } } }
// on the wire:  ?site.near[within][miles]=5   — bracket notation, three levels deep
```

### 4 · Does the distance come back with the row?

```mesa
<!-- A — the boundary adds it when the query asked for it. -->
{#each jobs as job}
  <li>{job.address} — {job.$distance} away</li>   <!-- a transient, only present on a `near` query -->
{/each}
```

```mesa
<!-- B — the row carries its point; the screen computes what it wants to show. -->
<script>
  import { distance, formatDistance } from '@frontierjs/toolbelt/geo'
</script>
{#each jobs as job}
  <li>{job.address} — {formatDistance(distance(here, job.site))} away</li>
{/each}
```

Under B the same function answers *how far is this row* for a row that arrived
over the live socket, for a row the user dragged onto a crew, and for a row that
was never in a `near` query at all. Under A each of those is a second code path.

### 5 · Ordering by distance

```ts
// A — the order is part of the query, so the page is right.
const page1 = await db.job.findMany({
  where:   { site: { near: { lat, lng, within: '25mi' } } },
  orderBy: { site: { near: { lat, lng } } },
  limit: 20,
})
const page2 = await db.job.findMany({ /* …same, */ offset: 20 })
```

```ts
// B — filter server-side, sort client-side.
const rows = await jobs.list({ site: { near: { lat, lng, within: '25mi' } }, $limit: 20 })
rows.sort((a, b) => distance(here, a.site) - distance(here, b.site))
// Page 1 is 20 rows in id order, sorted. Page 2 is the NEXT 20 in id order, sorted.
// Neither page is the nearest 20, and nothing says so.
```

### 6 · What the index is

```sql
-- A — composite. One line of DDL, written by the migration the declaration produces.
CREATE INDEX job_site_idx ON job (latitude, longitude);

-- the query it serves
SELECT * FROM job
 WHERE latitude  BETWEEN :latLow AND :latHigh
   AND longitude BETWEEN :lngLow AND :lngHigh
   AND (6371000 * acos(min(1.0,
        cos(radians(:lat)) * cos(radians(latitude)) *
        cos(radians(longitude) - radians(:lng)) +
        sin(radians(:lat)) * sin(radians(latitude))))) <= :meters;
```

```sql
-- B — R*Tree. A second table, plus three triggers the differ and @@softDelete must know about.
CREATE VIRTUAL TABLE job_site_rtree USING rtree(id, minLat, maxLat, minLng, maxLng);
CREATE TRIGGER job_site_ai AFTER INSERT ON job BEGIN
  INSERT INTO job_site_rtree VALUES (new.id, new.latitude, new.latitude, new.longitude, new.longitude);
END;
-- …plus AFTER UPDATE and AFTER DELETE, and a soft delete is an UPDATE.
```

```ts
// C — a cell id column. Rejected: a second spelling of the coordinate, written on
// every save, and the neighbor probe comes back anyway.
row.geohash = encode(lat, lng, 7)
const cells = [center, ...eightNeighbors(center)]   // or two points 40m apart miss each other
await db.job.findMany({ where: { geohash: { startsWith: cells } } })
```

### 7 · Are the hull and the buffer in the kit?

```ts
// A — five functions, no shared machinery, no geometry spine.
import { distance, boundingBox, pointInPolygon, polygonArea, centroid } from '@frontierjs/toolbelt/geo'

// the crew board's working area, under A: the box the crew's jobs fit in
const area = boundingBox(centroid(crew.jobs.map(j => j.site)), '3mi')
const candidates = jobs.filter(j => inBox(j.site, area))
```

```ts
// B — the kit grows a geometry spine to keep the exact shape the app had.
import { convexHull, buffer, pointInPolygon } from '@frontierjs/toolbelt/geo'

const area = buffer(convexHull(crew.jobs.map(j => j.site)), Math.sqrt(areaOf(hull)) * 0.3)
const candidates = jobs.filter(j => pointInPolygon(j.site, area))
```

A is a rougher answer to the same question — a box rather than a buffered hull —
and it is five small functions instead of a library. B is exactly what the client
app does today, and it is the whole of `@turf/turf`'s reason to exist.

### 8 · `@@geo` and `@guarded`

```lite
// A — declared, with a warning when it is missing on a gated model.
model Property {
  address   String  @guarded("4")
  latitude  Float?  @guarded("4")
  longitude Float?  @guarded("4")
  site      Json    @geo(latitude, longitude)
  @@gate("0.4.4.5")
}
// fli check:  Property.site is a point on a model gated above STRANGER and is not
//             @guarded — a coordinate is an address. Declare it, or say why not.
```

```lite
// B — implied, opt out where it is public.
model Shop {
  latitude  Float?
  longitude Float?
  site      Json @geo(latitude, longitude, guarded: false)   // a shop's front door is public
}
```

Under B, the storefront that forgets `guarded: false` renders a map with no pins
and a 200, and the redaction is in the audit trail where nobody is looking.

### 9 · Does the live store grade an arriving row?

```js
// A — /match answers the geo predicate the same way it answers every other one.
matchesQuery(fields, arrivingJob, { site: { near: { lat, lng, within: '5mi' } } })
// → true  : the row appears in the open list, no round trip
// → false : it is ignored

// B — /match returns null for anything geo.
// → null  : "ask the server" — every arriving row re-fetches the list, on every
//           socket frame, for a question the client could have answered with
//           two numbers it already holds.
```

### 10 · Does `@frontierjs/ui` ship a map control?

```mesa
<!-- A — the kit renders the pair; the app renders the map. -->
<Form resource={properties} record={property}>
  <GeoField name="site" />          <!-- two validated numbers, ±90 / ±180, a "use my location" button -->
  <slot name="map">                  <!-- the app's own leaflet/maplibre island, if it wants one -->
</Form>
```

```mesa
<!-- B — the kit ships the map. -->
<Form resource={properties} record={property}>
  <MapField name="site" tiles="osm" zoom={14} />
</Form>
<!-- …and the kit now has a rendering library, a tile VENDOR, an attribution
     requirement, a usage policy and an offline story. -->
```

---

## Holes still open

Asked deliberately at the end rather than discovered later. Each is named here so
that building this starts from a list rather than from optimism; none of them
changes the shape above.

- **Cursor pagination over a distance order is a question in the queue now**, not a
  hole — a nearest-first list is the screen that scrolls, and the cursor has to
  carry the center it was ordered from.
- **`@from` over a point is free and nobody has asked for it.** With the generated
  columns present, `@from(Job, min: siteLat)` and its three siblings give a parent
  the bounding box of its children — which is the client application's crew working
  area, without the convex hull the kit is refusing to carry. It is either a
  worked example or a reason to keep the generated columns visible as fields.
- **Null island.** A geocoder that fails often returns `0, 0`, which is a valid
  coordinate in the Gulf of Guinea, so no `CHECK` may refuse it. It is a data
  quality fact rather than a constraint: worth a `fli check` count or an advisor
  note, never a parse error.
- **A `near` filter has to say what it does with rows that have no point.** They
  are excluded — but that is NULL semantics again, the same three-valued logic that
  makes the naive `json_type` check useless, and it should be asserted rather than
  assumed.
- **How a `near` filter travels on a query string is in the queue too**, and its
  owner is `@frontierjs/toolbelt/query` rather than this record — three readers
  parse that convention and a geo-only syntax would make a fourth.
- **Prerender.** A `target: 'static'` page that bakes a customer's exact coordinate
  publishes it, and the existing proof — reads tapped around `load()` and compared
  to `@@gate` — grades the MODEL rather than the precision. Nothing new is needed
  if the point is `@guarded`; the sentence is owed anyway, because the prerender
  gate is the one place a wrong answer ships to a CDN.
- **No drive names this yet.** A geo feature touches Data (the filter), API (the
  query string) and UI (a control), and `DRIVES.md` has no row that would cover it
  — so building it without adding one means `fli proves` answers *these files
  changed and no row covers them*, which is a finding rather than a pass.
- ~~**The wasm engine measurement is owed.**~~ **Measured 2026-09-20 and it holds.**
  `@sqlite.org/sqlite-wasm` 3.53.4 compiles with `ENABLE_MATH_FUNCTIONS`, so
  `asin` · `sqrt` · `power` · `sin` · `cos` · `radians` are all there — the
  compile-time worry was the right one to have, since the same build carries
  `OMIT_LOAD_EXTENSION`, which is why `@vector` can never run here. Six
  assertions in `packages/litestone/test/browser/verify-browser-client.mjs`,
  over OPFS in Chrome: the generated columns, the `CHECK`, a `near` filter, a
  row with no point in no circle, `NULLS LAST` on a distance order, and a
  distance-ordered page continuing without repeating its boundary row.
  **It found a defect that was not geo's**: `encodeCursor` used node's `Buffer`,
  so EVERY cursor threw `ReferenceError` on a device, not only a distance one.
- **The adoption path from a pair to a point has no recipe.** Every app in the
  survey stores `latitude` / `longitude`; under G they migrate, and the migration
  is a `json_object` update plus a column drop. That is an afternoon, but it is an
  afternoon nobody has written down, and it is the first thing a real adopter
  meets.

---

## Prior art — the field, surveyed 2026-09-19

Read before the shape above was settled; three of its findings changed the
proposal and are marked. **Web-sourced, so every claim here is a lead with a
citation rather than a measurement** — the two engine rows in the table earlier
are the only geo facts in this file that were run (`VERIFYING.md`).

### What SQLite can actually do, across the places people deploy it

| | R*Tree | `geopoly` | trig functions |
| --- | --- | --- | --- |
| `bun:sqlite` 3.51.2 (measured) | yes | **no** | yes |
| `@sqlite.org/sqlite-wasm` 3.53.4 (measured) | yes | **no** | yes |
| Cloudflare D1 | yes, documented | **no** — only `rtreecheck()` of the module's functions | — |
| Turso / libSQL | yes | reported `no such module: geopoly` | — |
| SpatiaLite | yes | n/a — it is the extension tier | yes |

**`geopoly` is not a thing this framework declined; it is a thing the SQLite
ecosystem does not ship.** It is [built on top of the same R*Tree
module](https://www.sqlite.org/geopoly.html) and handles simple non-self-
intersecting 2D polygons, and it is absent from both engines here, from D1, and in
practice from Turso. **R*Tree is the portable floor** — every row above has it —
which is the strongest argument available for the second open question below.

**Measured with them, on the same day, because option G rests on it**: a `STRICT`
table may carry `GENERATED ALWAYS AS (json_extract(site,'$.lat')) VIRTUAL`
columns, an index over that pair is used by the planner
(`SEARCH job USING INDEX idx_job_siteLat_siteLng` over 5,000 rows), `VIRTUAL`
stores nothing, a `json_set` update moves the indexed value, and a `CHECK` over
those generated columns is legal and refuses both a half-set point and an
out-of-range one. Generated columns (3.31) and `json_extract` (json1, built in
since 3.38) are core rather than compile-time options, so they are expected
wherever the versions above hold — **but the numbers here were run on
`bun:sqlite` only, and the same run against the wasm engine is owed** before G is
called portable.

**The trig column is the one the field is out of date about.** Math functions
landed in SQLite 3.35 (2021) but only under `-DSQLITE_ENABLE_MATH_FUNCTIONS`, and
the canonical builds did not set it for years. Both engines here do, measured. That
matters because of the next entry.

### Rails `geocoder` — the workaround this repo's client app reinvented

The most-used geo gem in any framework, and **its SQLite path is knowingly
degraded**: *"SQLite's lack of trigonometric functions requires an alternate
implementation of the `near` scope… results of this algorithm should not be
trusted too much as it will return objects that are outside the given radius,
along with inaccurate distance and bearing"*. Its documented advice is a square
instead of a circle, sized by *divide your radius in miles by 69.0* — which is the
lawn app's `margin = 0.0002 // ~ 70ft` arrived at independently, by the same
reasoning, in a different decade. For MySQL and Postgres it does the correct
thing: **a bounding box to limit the rows a full distance calculation runs over,
over a composite index on `(latitude, longitude)`**.

**Changed the proposal (1):** the exact circle is available to FJS and is not
available to the best-known implementation of this feature in the field, because
the premise geocoder degrades on — no trig in SQLite — is false for both engines
here. *Bbox against the index, then an exact haversine in SQL* is not a compromise;
it is geocoder's Postgres path, on SQLite, in the browser too.

### GeoDjango — the ergonomics, and the honesty to steal

`models.PointField(srid=…)` on the model; `Model.objects.filter(point__distance_lte=(pnt, D(km=7)))` for the query. The
part worth copying is not the API, it is **the published per-backend compatibility
matrix**: `distance_lte`, `dwithin` and the rest are listed against PostGIS,
SpatiaLite, MySQL, MariaDB and Oracle, so a developer learns what their backend
cannot do from a table rather than from an empty result. Litestone has two engines
(`FJS-D305`), and the same obligation.

**Changed the proposal (2):** either every geo operator answers identically on
both engines, or the difference is a published table. Given the measurements
above, identical is achievable — so the rule to write into the design is *one path,
no per-engine operator*, and the `geopoly` question never reopens as an engine-only
fast path.

### Prisma — the closest neighbor, and the reason the client app looks like it does

`.lite`'s nearest analog in shape. **It has no geo types**: the open requests are
years old ([#2789](https://github.com/prisma/prisma/issues/2789),
[#25768](https://github.com/prisma/prisma/issues/25768)), and the sanctioned
answer is `Unsupported("geometry(Point, 4326)")` plus `$queryRaw`. The lawn app is
a Prisma app; its `latitude Float?` / `longitude Float?` pair and its hand-written
SQL box are exactly what that answer produces in a real codebase. **A schema
language that refuses to model place does not stop anybody modeling it — it moves
the model into four files and a string.**

### Drizzle — proof a JS schema layer can carry it first class

`geometry('location', { type: 'point', mode: 'xy', srid: 4326 })` with
`index('spatial_index').using('gist', t.location)`. Postgres only, but it settles
that a TypeScript-shaped schema can hold a declared point and a declared spatial
index without a type system built for geometry.

### Ash / `AshGeo` — the split this proposal is making

`review-prior-art.md`'s convergence table gains a row after all. AshGeo is **an extension,
not core**: PostGIS-backed types for resource attributes, `st_*` available inside
Ash expressions, and — the interesting half — **validations backed by `Topo` that
answer `contains?` without hitting the database.** That is precisely the division
proposed here: a declared column and a Data-boundary filter on one side, pure
geometry usable on either end on the other. Two designs arriving separately at the
same seam is the evidence `review-prior-art.md` says to weight.

### Cell indexes — geohash, S2, H3

The other way to answer *what is near here*: encode a cell id per row and search by
prefix or range. Worth recording because it is the option this proposal does not
take. **Geohash's failure is the one that would bite an app here** — proximity
rides a shared string prefix, so points either side of a top-level bit boundary
share zero leading characters, and any correct query has to probe the eight
neighboring cells anyway. S2 gets closer with a Hilbert ordering (neighbors become
an id range, with known breaks at the curve's turns); H3 makes neighbors a `k`-ring
but its parent–child containment is approximate, which is why precise geofencing is
where people reach back for S2. All three add a derived column that must be
recomputed on every write and a vocabulary to learn.

**Not taken**, on the concept-budget question: a cell id is a second representation
of a coordinate, and the R*Tree/composite-index path gives the same query with
nothing new stored. Recorded here so the next person does not have to re-derive the
rejection.

### The antimeridian, confirmed as a field-wide bug class

Not a hypothetical risk invented for § *The nine questions*: a box crossing 180° is
[treated as wrapping the long way around the
Earth](https://www.jasondavies.com/maps/bounds/) — Elasticsearch, qdrant
([#2357](https://github.com/qdrant/qdrant/issues/2357), which names the poles too)
and GeoBlacklight
([#616](https://github.com/geoblacklight/geoblacklight/issues/616)) each carry the
same defect, and the standard fix is to **split a wrapping longitude range into two
envelopes** rather than to widen one.

**Changed the proposal (3):** the ship gate is no longer *write a test for it*. The
filter splits the box at the seam and clamps the pole case, and the test that
proves it compares against a brute-force scan. A feature whose failure mode is
*fewer rows, status 200* gets the mechanism, not the reminder.

### Geocoding, and why it is not in the kit

The lawn app calls Nominatim **from the browser** (`Map.svelte:17`). [OSM's
policy](https://operations.osmfoundation.org/policies/nominatim/) is an absolute
maximum of one request per second, no heavy or distributed use, a `User-Agent` or
`Referer` that identifies the application, and **results cached on the caller's
side** — there is an issue on another project titled *Browser-side Nominatim calls
violate its usage policy; proxy and throttle geocoding*. Two of those four
obligations (identify, cache) cannot be met from a page at all. That is the
argument for `FJS-D153`'s boundary holding here with no exception: geocoding is a
conduit target with a cache and a rate policy — seven numbers it already
has — not a function in a pure kit.

### The client-side cost the kit replaces

`@turf/turf` is imported **as a namespace, twice** (`import * as turf from
'@turf/turf'`), for three functions — `convex`, `area`, `buffer` — beside
`leaflet`, `leaflet-draw` and `svelte-map-leaflet`. Turf is modular per
`@turf/<fn>` package, but the monolith is the documented bundle-size complaint
([#1846](https://github.com/Turfjs/turf/issues/1846)) and a namespace import is the
shape tree-shaking does worst on. Nothing here needs measuring to conclude the
obvious thing: five small pure functions in `@frontierjs/toolbelt/geo` cover every
geo call that application's planner makes except the hull and the buffer, which is
the line § *The pure half* already draws.

---

## Sources

- [The Geopoly Interface To The SQLite R*Tree Module](https://www.sqlite.org/geopoly.html) · [Built-In Mathematical SQL Functions](https://sqlite.org/lang_mathfunc.html) · [SpatiaLite R*Tree cookbook](https://www.gaia-gis.it/gaia-sins/spatialite-cookbook/html/rtree.html)
- [D1 R*Tree docs PR](https://github.com/cloudflare/cloudflare-docs/pull/32682) · [D1 geospatial request](https://github.com/cloudflare/workers-sdk/issues/9324) · [libSQL geopoly issue](https://github.com/tursodatabase/libsql/issues/1226)
- [geocoder README (SQLite `near`)](https://www.rubydoc.info/gems/geocoder/1.4.5) · [geokit-rails](https://github.com/geokit/geokit-rails)
- [GeoDjango database API](https://docs.djangoproject.com/en/3.2/ref/contrib/gis/db-api/) · [GeoDjango functions](https://docs.djangoproject.com/en/3.2/ref/contrib/gis/functions/)
- [Prisma #2789](https://github.com/prisma/prisma/issues/2789) · [Prisma #25768](https://github.com/prisma/prisma/issues/25768)
- [Drizzle PostGIS point guide](https://orm.drizzle.team/docs/guides/postgis-geometry-point) · [Drizzle PostGIS schema PR](https://github.com/drizzle-team/drizzle-orm/pull/2803)
- [AshGeo](https://github.com/bcksl/ash_geo) · [AshGeo docs](https://ash-geo.hexdocs.pm/readme.html)
- [Location indexing: geohash, quadtree, S2, H3](https://joudwawad.medium.com/location-indexing-complete-guide-36a143569555) · [H3 vs S2 vs geohash](https://cellandshape.com/h3-vs-s2-vs-geohash)
- [Geographic bounding boxes](https://www.jasondavies.com/maps/bounds/) · [qdrant #2357](https://github.com/qdrant/qdrant/issues/2357) · [GeoBlacklight #616](https://github.com/geoblacklight/geoblacklight/issues/616)
- [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) · [browser-side Nominatim issue](https://github.com/egeyigit/fieldpoint/issues/46)
- [Turf bundle size #1846](https://github.com/Turfjs/turf/issues/1846) · [Turf getting started](https://turfjs.org/docs/getting-started)
