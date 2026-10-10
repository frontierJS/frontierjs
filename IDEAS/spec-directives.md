---
id: spec-directives
status: proposed
dated: 2026-10-10
---

# Idea — Spine entry 9, Directives: a spec draft with conformance vectors

Drafted by Fable audit run 4.2 (`IDEAS/fable-audit-plan.md`). The entry's one-paragraph
form stays in `IDEAS/specifications.md` § 14; this is the long form the caller decides
whether to promote. Findings it produced are `FJS-2458`–`2468` and `FJS-D871`.

#### 14. Directives and query values — DRAFT (spine entry 9; folds entry 15, ordering and paging)

**Status: DRAFT, audit run 4.2, 2026-10-10.** Written in the shape `IDEAS/specifications.md`
uses for an entry, with the paper sections the brief asks for below the header. Every
"held today" pointer was checked on this date by running it (the probe became `packages/junction/test/audit-directives-vectors.test.ts`).
Where the draft and the implementation disagree, § *Disagreements* says which was sided
with and why; nothing here is behavior until the caller lands it.

**Would state:** one flat bag of parameters carries two kinds of thing, and a `$`
prefix is what tells them apart: a FILTER (`status=active`, which records) and a
DIRECTIVE (`$limit=20`, how much, in what order, which fields, which rows of a
lifecycle). The directive table, closed: fourteen directives with a structured form
and two transport-only parameters with none. The value grammar of each. The split: a
reader answers `{ query, directives }`, neither half containing a `$`, and absent means
*not asked* rather than *the default*. The refusal: a `$`-name the table does not hold
is refused on a request and dropped on a URL (`FJS-D237`). The window: a count is a
non-negative integer, clamped to a host-declared ceiling, with `0` meaning *count
only*; a cursor is opaque text minted by the host and never combines with an offset
(`FJS-D145`). Ordering: three spellings → one list of `{ field: direction }`, with an
argument in the direction position left to the host. What a query-string VALUE means is
the sibling half of this entry (`@frontierjs/toolbelt/query`, `FJS-D125`) and is
assumed, not restated: number only if it round-trips, `true`/`false`/`null`, brackets
for structure, quotes as the escape.
**Held today:** `@frontierjs/toolbelt/directives` (the table, `splitParams`,
`unknownDirectives`, `directiveParams`, `orderByPair`) · `@frontierjs/toolbelt/query`
(the values) · junction `transport/bridge.ts` `toContext()` / `internal()` +
`refuseBadDirectives` / `refuseNegativeWindow` · junction `core/directives.ts`
`clampPage` · junction `core/query-values.ts` `normalizeOrderBy` / `normalizeSelect` ·
junction `core/litestone.ts` `parseQuery` / `parsePopulate` / `findWindow` · sierra
`router/index.js` L782 (`page.query` + `page.directives`) · junction `client/index.ts`
`buildQueryString` / `buildWsQuery` · Invariant 10 · `FJS-D125`, `FJS-D237`, `FJS-D145`,
`FJS-D391`.
**Neighbor:** OData system query options (`$top`, `$skip`, `$orderby`, `$select`,
`$expand`, `$search` — the same six ideas, a `$` prefix, and a committee), PostgREST's
`select=`/`order=`/`limit=` and Range headers, FIQL for filters, GraphQL Cursor
Connections for the window. OData is the one to write a *profile* of if a profile is
written at all: its `$orderby` is `field asc|desc` and its `$expand` nests `$select`,
which this table already does under other spellings.

---

## 1. Scope and non-goals

**In scope.** (a) The `$` split of one bag into filters and directives. (b) The
table: which names exist, what each value's grammar is, and the parsed form. (c) The
refusal of a name the table does not hold, on each of the two surfaces. (d) The window:
count grammar, the clamp, `0`, a negative, a cursor beside an offset. (e) The three
ordering spellings and their normal form, and the select and populate list grammars.
(f) The write direction: structured → `$` names, so a URL round-trips.
(g) Conformance vectors a host in any language can run.

**Non-goals.** What a filter VALUE means (the sibling half; `FJS-D125`). What may be
sorted, selected or populated — the schema's answer (entries 1, 3), refused by name at
the Data boundary. What a cursor CONTAINS — opaque; a host mints and redeems its own.
The envelope a list answers in (entry 12), though the window's `total: null` on the
cursor path is restated here because it is what `$after` means. Hooks that read or
rewrite directives (entry 18). The SQL any of this compiles to. The open question
whether `$or`/`$and`/`$not` are filter combinators or unknown names — `FJS-2213` holds
it; this draft keeps the table closed and the combinators OUT until that is ruled, and
says so in V-62.

**One rule the whole entry rests on: a directive's value is read from the raw TEXT a
caller sent, never from the typed value the filter parser made of it.** The two
implementations that read the typed value (§ 5, F4 and F5) are each a silent misread.

## 2. The JSON form

### 2.1 The wire — the bag

A bag is a map of name → value. Over HTTP it is the query string, decoded (so `%24limit`
IS `$limit`, V-44); over a socket it is a JSON object in the frame. A name that starts
with `$` is a directive or a transport parameter; every other name is a filter.
Names are case-sensitive and never trimmed (`$LIMIT`, `$Limit`, `$limit ` are three
unknown names, V-40, V-41, V-46).

### 2.2 The table

| wire name | parsed name | value grammar (wire text) | parsed value | absent means |
| --- | --- | --- | --- | --- |
| `$limit` | `limit` | `DIGITS` — decimal, no sign, no fraction, no exponent | non-negative integer | host default |
| `$offset` | `offset` | `DIGITS` | non-negative integer | `0` |
| `$after` | `after` | any non-empty text; opaque, minted by the host as `endCursor` | string, verbatim | ordinary page |
| `$orderBy` | `orderBy` | one of three spellings, § 2.5 | list of `{ field: direction \| argument }` | host default order |
| `$select` | `select` | `NAME(,NAME)*` or the list spelling `$select[]=NAME` | list of field names | every readable field |
| `$populate` | `populate` | `REL(:NAME(+NAME)*)?(,…)*` or the list spelling | list of `{ relation, select? }` | no relation |
| `$search` | `search` | any non-empty text | string | no search |
| `$withDeleted` | `withDeleted` | FLAG | boolean | `false` |
| `$onlyDeleted` | `onlyDeleted` | FLAG | boolean | `false` |
| `$withTemplates` | `withTemplates` | FLAG | boolean | `false` |
| `$onlyTemplates` | `onlyTemplates` | FLAG | boolean | `false` |
| `$asOf` | `asOf` | RFC 3339 instant, or `YYYY-MM-DD`; which one is the model's | string, verbatim | *now* on an expiring model, no window on an effective one (`FJS-D352`) |
| `$withExpired` | `withExpired` | FLAG | boolean | `false` |
| `$onlyExpired` | `onlyExpired` | FLAG | boolean | `false` |
| `$first` | — (transport) | FLAG | the call answers one record, not a list | list |
| `$wrap` | — (transport) | FLAG | `true`: envelope a single too; `false`: bare list | the default rule (entry 12) |

**FLAG** is exactly `true`, `1`, `false`, `0` as text. Anything else is refused (V-26;
the implementation reads anything else as `false`, § 5 F7). **An empty value is
ABSENT for every directive** (V-6, V-17, V-23, V-31), which is what `$search=` already
means in the implementation and what `$orderBy=` and `$select=` do not yet mean (§ 5).

**DIGITS** is `/^[0-9]+$/`. `-1`, `1.5`, `0x10`, `1e2`, `+5`, `true`, `[]` and `"5"`
are each NOT a count (V-4, V-7 … V-13). The implementation accepts five of them as a
number it did not say (§ 5 F2, F3).

**A directive is single-valued.** The same name twice, or the list spelling (`$limit[]=5`)
on a scalar directive, is refused (V-14, V-15; implementation drops to the default in
silence, § 5 F3).

### 2.3 The parsed form

```json
{
  "query":      { "<filter name>": <typed value, per the sibling half> },
  "directives": {
    "limit": 20, "offset": 0, "after": "eyJpZCI6M30",
    "orderBy": [ { "name": "asc" }, { "createdAt": "desc" } ],
    "select": [ "id", "name" ],
    "populate": [ { "relation": "author", "select": [ "id", "name" ] }, { "relation": "tags" } ],
    "search": "acme", "asOf": "2026-01-01",
    "withDeleted": true, "onlyDeleted": false,
    "withTemplates": false, "onlyTemplates": false,
    "withExpired": false, "onlyExpired": false
  }
}
```

Every key of `directives` is optional and **a key that was not asked is not present** —
never `null`, never the default (the parse answers *what was asked*; the clamp, § 2.6,
answers *what will be done*). No key of either half begins with `$`. `$first` and
`$wrap` appear in neither half; they are consumed by the transport.

The implementation's parsed form differs from the JSON above in two places that are
stated rather than hidden: `orderBy`, `select` and `populate` are carried RAW (the
wire's own string, object or list) through `ctx.directives` and normalized one step
later by `normalizeOrderBy` / `normalizeSelect` / `parsePopulate`; and `populate`
normalizes to the host's include map (`{ author: { select: { id: true, name: true } } }`,
§ 4 L6, L7). A second implementation may carry either; the vectors assert the
normalized list form.

### 2.4 The split and the refusal

`split(bag) → { query, directives }`. Filters are every non-`$` name, value untouched.
Directives are the table rows present, read by their grammar. A `$`-name not in the
table (`$`, `$$limit`, `$limitt`, `$LIMIT`, `$nope`) is **refused on a request**:

```json
{ "name": "BadRequest", "code": 400,
  "message": "<names joined ', '> is not a directive this API knows. … Case matters: <table, sorted>.",
  "data": { "directives": [ "$nope", "$also" ], "available": [ "$after", "$asOf", … ] } }
```

The spec pins `code: 400`, `data.directives` (the unknown names, in arrival order) and
`data.available` (the whole table, every `$`-name including the two transport ones,
sorted). The sentence is the implementation's. A negative count is refused the same
way with `data: { directive: "$limit" | "$offset", value: n }` (V-4, V-20). **On a URL
surface (a router) an unknown `$`-name is DROPPED, not refused** — a navigation has no
error channel (`FJS-D237`, V-63).

### 2.5 Ordering — the three spellings

```
string:  NAME | -NAME | NAME(,(-)?NAME)*            'name'  '-createdAt'  'status,-createdAt'
object:  { NAME: DIRECTION | ARGUMENT, … }           { createdAt: 'desc' }   { name: 1 }
list:    [ { NAME: DIRECTION | ARGUMENT }, … ]       the normal form; on a URL, $orderBy[][name]=desc
```

`DIRECTION` is `asc` | `desc` | `1` | `-1`, lowercase; `1` is `asc`, `-1` is `desc`.
Any other scalar in the direction position is refused (V-30; implementation reads it as
`desc`, § 5 F8). An ARGUMENT is an object in the direction position (`{ dir, nulls }`,
`{ near: {…} }`, a relation hop `{ name: 'asc' }`) and is **host-defined**: it travels
intact and the Data boundary grades it. The URL list spelling is `[]` (append); the
indexed spelling `$orderBy[0][name]=desc` is an OBJECT with a field named `0` and is
refused by the boundary as that field (V-29; `orderByPair` disagrees, § 5 F9). Normal
form: a list of single-key objects, in order.

### 2.6 The window — clamp, zero, negative, cursor

```
limit  = min(limit, max)   when limit is present;  default   when absent
offset = offset            when present;            0         when absent
```

`default` and `max` are the host's, declared per service (FrontierJS: `paginate:
{ default: 20, max: 100 }`). **The clamp is silent and the answer's envelope carries the
limit that was applied** (`limit: 100` for `$limit=1000`, V-3) — `FJS-1972` holds the
open question whether it should be loud. `limit: 0` is a real request for the count
alone (V-2). A negative count is refused at the request boundary (V-4, V-20); an
implementation that clamps rather than refuses has a floor at `0`, which is what a host
whose database reads a negative LIMIT as *unbounded* needs (§ 4 L1) — but the floor is a
second answer, and today it is the only one on the internal path (§ 5 F10).

**`after` present** is the keyset path: `offset` is ignored and reported as `0`, no count
runs and `total` is `null`, the answer carries `endCursor` and `hasMore` (V-21,
`FJS-D145`, its precedence clause). A cursor the host did not mint is refused by name
(V-23b). A list whose ordering is not total carries no `endCursor` rather than a wrong
one (entry 15's sentence, kept).

### 2.7 The write direction

`params(directives) → bag`: each present, non-null key → its `$` name. Values keep their
types except `select` and `populate`, which are written as comma strings (V-57).
`parse(params(d))` is `d` for every value the table carries. A URL encoder that quotes a
string the value parser would retype (`"603"`) is what keeps a numeric-looking `$search`
or `$after` text across the wire (V-24, V-37); a caller that writes the URL by hand has
no such protection and is where F5 bites.

## 3. Conformance vectors

**Format.** `input` is the raw search string as sent (before decoding). `expect` is
either `{ query, directives }` after the split — directives in the normalized form of
§ 2.3 — or `refuse: { code, directives | directive }`. Where a vector depends on the
host's declared window, `default = 20, max = 100` is assumed and the applied page is
given as `page`. **A host runs every row; the negative controls (V-40 … V-48 refusals)
are what make a passing run mean anything, and the set asserts its own count: 64 rows.**
`impl` is what FrontierJS answered on 2026-10-10 (`✓` agrees; `F#` a finding in § 5;
`D#` a disagreement the draft kept, no row).

| # | input | expect | impl |
| --- | --- | --- | --- |
| V-1 | `?$limit=5` | `{query:{}, directives:{limit:5}}` · page `{limit:5, offset:0}` | ✓ |
| V-2 | `?$limit=0` | `directives:{limit:0}` · page limit 0 · answer: no rows, `total` counted | ✓ |
| V-3 | `?$limit=1000` | `directives:{limit:1000}` · page limit 100 · envelope `limit: 100` | ✓ (silent; `FJS-1972`) |
| V-4 | `?$limit=-1` | `refuse:{code:400, directive:'$limit', value:-1}` | ✓ over HTTP; F10 internal |
| V-5 | `?$limit=abc` | `refuse:{code:400, directive:'$limit'}` | D1: dropped → default 20, 200 |
| V-6 | `?$limit=` | `directives:{}` (empty is absent) | ✓ |
| V-7 | `?$limit=1.5` | `refuse:{code:400, directive:'$limit'}` | F2: **500** `datatype mismatch` |
| V-8 | `?$limit=0x10` | `refuse` | F3: `limit:16` |
| V-9 | `?$limit=1e2` | `refuse` | F3: `limit:100` |
| V-10 | `?$limit=+5` | `refuse` | F3: `limit:5` |
| V-11 | `?$limit=true` | `refuse` | F3: `limit:1` (one row, 200) |
| V-12 | `?$limit=[]` | `refuse` | F3: `limit:0` (no rows, 200) |
| V-13 | `?$limit="5"` | `refuse` (quotes are the filter escape, not a count) | F3: `limit:5` |
| V-14 | `?$limit=5&$limit=6` | `refuse` (single-valued) | F4: dropped → default 20, 200 |
| V-15 | `?$limit[]=5` | `refuse` | F4: `limit:5` |
| V-16 | `?$offset=10` | `directives:{offset:10}` · page `{limit:20, offset:10}` | ✓ |
| V-17 | `?$offset=` | `directives:{}` | ✓ |
| V-18 | `?$offset=abc` | `refuse` | D1: dropped → 0 |
| V-19 | `?$offset=10&$limit=5` | page `{limit:5, offset:10}` | ✓ |
| V-20 | `?$offset=-1` | `refuse:{code:400, directive:'$offset', value:-1}` | ✓ |
| V-21 | `?$offset=10&$after=eyJpZCI6M30` | `directives:{offset:10, after:'eyJpZCI6M30'}` · answer: cursor path, envelope `offset:0`, `total:null` | ✓ |
| V-22 | `?$after=eyJpZCI6M30` | `directives:{after:'eyJpZCI6M30'}` | ✓ |
| V-23 | `?$after=` | `directives:{}` | ✓ |
| V-23b | `?$after=zzz` | parsed `after:'zzz'`; answer `refuse 400` *not a cursor this list minted* | ✓ |
| V-24 | `?$after=123` | `directives:{after:'123'}` (text, verbatim) → then V-23b's refusal | F5: dropped, 200 ordinary page |
| V-25 | `?$orderBy=-createdAt` | `orderBy:[{createdAt:'desc'}]` | ✓ |
| V-26 | `?$orderBy=name,-createdAt` | `orderBy:[{name:'asc'},{createdAt:'desc'}]` | ✓ |
| V-27 | `?$orderBy[name]=desc` | `orderBy:[{name:'desc'}]` | ✓ |
| V-27b | `?$orderBy[name]=1` / `=-1` | `[{name:'asc'}]` / `[{name:'desc'}]` | ✓ |
| V-28 | `?$orderBy[][name]=desc` | `orderBy:[{name:'desc'}]` | ✓ |
| V-29 | `?$orderBy[0][name]=desc` | `orderBy:[{'0':{name:'desc'}}]` → boundary refuses field `0` | ✓ boundary; F9 `orderByPair` |
| V-30 | `?$orderBy[name]=sideways` | `refuse` (not a direction) | F8: sorted `desc`, 200 |
| V-30b | `?$orderBy[name]=DESC` | `refuse` (lowercase only) | F8: sorted `desc`, 200 |
| V-31 | `?$orderBy=` | `directives:{}` | D2: 400 *unknown field ''* |
| V-32 | `?$select=id,name` | `select:['id','name']` | ✓ (as `{id:true,name:true}`) |
| V-33 | `?$select[]=id&$select[]=name` | `select:['id','name']` | ✓ |
| V-34 | `?$select=` | `directives:{}` → every readable field | F6: **200, rows with no columns** |
| V-35 | `?$select=id,,name` | `select:['id','name']` (empty names dropped) | ✓ |
| V-36 | `?$populate=author:id+name` | `populate:[{relation:'author', select:['id','name']}]` | ✓ (as include map) |
| V-36b | `?$populate[]=author&$populate[]=tags` | `populate:[{relation:'author'},{relation:'tags'}]` | ✓ |
| V-37 | `?$search=603` | `search:'603'` | F5 (= `FJS-2333`): dropped, every row |
| V-37b | `?$search="603"` | `search:'603'` | ✓ |
| V-38 | `?$search=acme` | `search:'acme'` | ✓ |
| V-39 | `?$search=` | `directives:{}` | ✓ |
| V-40 | `?$LIMIT=5` | `refuse:{code:400, directives:['$LIMIT']}` | ✓ |
| V-41 | `?$Limit=5` | `refuse` | ✓ |
| V-42 | `?$=1` | `refuse:{directives:['$']}` | ✓ |
| V-43 | `?$$limit=5` | `refuse:{directives:['$$limit']}` | ✓ |
| V-44 | `?%24limit=5` | `directives:{limit:5}` (decoded first) | ✓ |
| V-45 | `?%24foo=1` | `refuse:{directives:['$foo']}` | ✓ |
| V-46 | `?$limit%20=5` | `refuse:{directives:['$limit ']}` (never trimmed) | ✓ |
| V-47 | `?$limit=5&$nope=1&$also=2` | `refuse:{directives:['$nope','$also']}` (all named, arrival order) | ✓ |
| V-48 | `?$limitt=5` | `refuse:{directives:['$limitt']}` | ✓ |
| V-49 | `?$withDeleted=true` | `withDeleted:true` | ✓ |
| V-50 | `?$withDeleted=1` | `withDeleted:true` | F7: **`false`** — typed wire turns `'1'` into `1` |
| V-50b | `?$withDeleted="1"` | `refuse` (quoted text is not a FLAG) | D3: `true` |
| V-51 | `?$withDeleted=false` / `=0` | `withDeleted:false` | ✓ |
| V-52 | `?$withDeleted=yes` | `refuse` | F7: `false`, 200 |
| V-53 | `?$withDeleted=` and `?$withDeleted` | `directives:{}` | D4: `{withDeleted:false}` (same effect) |
| V-54 | `?$asOf=2026-01-01` / `=2026-01-01T00:00:00Z` | `asOf:` verbatim | ✓ |
| V-55 | `?$asOf=20260101` | `asOf:'20260101'` → boundary refuses by name | F5: dropped, 200 |
| V-56 | `?$first=true` / `?$first=1` | the call answers a single; `directives:{}` | ✓ / F11 (`1` is a number, truthy — passes by accident) |
| V-56b | `?$first=no` | `refuse` | F11: answers a single |
| V-56c | `?$first=false` / `=0` | list | ✓ |
| V-57 | write `{limit:5, after:'123', select:['id','name'], orderBy:[{name:'desc'}], withDeleted:false, limit2:null}` | `{$limit:5, $after:'123', $select:'id,name', $orderBy:[{name:'desc'}], $withDeleted:false}` — null and absent are both absent | ✓ |
| V-58 | `?$wrap=false` on a list | bare array | ✓ |
| V-58b | `?$wrap=0` on a single | bare record | F11: reads only `false`/`'false'` |
| V-59 | `?status=active&$limit=5&$orderBy=-id` | `query:{status:'active'}, directives:{limit:5, orderBy:[{id:'desc'}]}` | ✓ |
| V-60 | `?title=$5` | `query:{title:'$5'}, directives:{}` (a `$` inside a value is text) | ✓ |
| V-60b | `?price[gte]=$10` | `query:{price:{gte:'$10'}}` | ✓ |
| V-60c | `?$search=$foo` | `search:'$foo'` | ✓ |
| V-61 | `?$limit=5&status=active&status=closed` | `query:{status:['active','closed']}` (a repeated FILTER is a list; a repeated DIRECTIVE is V-14) | ✓ |
| V-62 | `?$or[][name]=a` | `refuse:{directives:['$or']}` until `FJS-2213` rules otherwise | ✓ (and `FJS-2213` open) |
| V-63 | router: `/list?$limit=5&$nope=1` | `page.directives:{limit:5}`, `$nope` dropped, no error | ✓ (`FJS-D237`) |
| V-64 | `` / `?` / `?status=active` | `{query:{}, directives:{}}` / same / `{query:{status:'active'}, directives:{}}` | ✓ |

Socket (typed) bags, the same rows read off JSON rather than text — `{ "$limit": "5" }` →
`limit:5`; `{ "$limit": 5 }` → `limit:5`; `{ "$withDeleted": 1 }` → `true` (impl: F7
`false`); `{ "$after": 123 }` → refuse, a cursor is text (impl: F5 dropped);
`{ "$limit": [5, 6] }` → refuse (impl: F4 dropped). A JSON bag that arrives already
typed reads a number as DIGITS if it is a non-negative integer and refuses otherwise;
a flag as a boolean, or `1`/`0`; a text directive as a string only.

## 4. Where the implementation leaks Bun, SQLite or TypeScript into spec

| # | leak | where | what the spec must say instead |
| --- | --- | --- | --- |
| L1 | The `0` floor on a count exists because *SQLite reads a negative LIMIT as UNBOUNDED* | `packages/junction/src/core/directives.ts:96-101` (`clampPage`), `FJS-683` | A negative count is refused; a host's own LIMIT sentinel is its own problem |
| L2 | *No limit* is spelled `LIMIT -1` | `packages/litestone/src/core/query.js:1329` (`pageSql`) | Absent is the host default; `-1` is never a wire or parsed value |
| L3 | The count grammar is enforced by SQLite, not the parser: `1.5` reaches `LIMIT 1.5` and SQLite says *datatype mismatch* | `packages/toolbelt/src/directives/directives.js:40-44` (`asNumber` = `Number()`), `directives.ts:103-105` | DIGITS, § 2.2; F2 |
| L4 | `normalizeOrderBy`'s output `[{field:'asc'|'desc'}]` IS litestone's `orderBy` argument, and the ARGUMENT escape (`{dir,nulls}`, `near`, relation hop) is litestone's grammar passed *untouched* | `packages/junction/src/core/query-values.ts:63-77`, header L17-26 | The list form is the normal form; an argument is host-defined and the spec names only that it is an object in the direction position |
| L5 | `comparatorFor` reproduces *SQLite's storage-class order* (NULL < number < text < blob, BINARY collation, booleans as 0/1, DateTime as ISO text) | `query-values.ts:30-41, 101-130` | Entry 15's ordering semantics must be stated host-neutrally (nulls placement, type rank, collation = codepoint) or declared host-defined with the client told to re-read |
| L6 | `normalizeSelect` answers `{name: true}` because that is *what every query builder here takes* | `query-values.ts:91-99` | A list of names; the map is the host's |
| L7 | `parsePopulate` answers litestone's `include` shape `{rel: true | {select:{…}}}`, and `rel:a+b` is a wire grammar invented for it | `packages/junction/src/core/litestone.ts:409-427` | `[{relation, select?}]`; keep `rel:a+b` as the wire spelling if the owner likes it, state it |
| L8 | The cursor is `base64url(JSON.stringify(values))` and the window needs duck-typed litestone methods `findManyCursor` / `orderTotal` / `cursorFor`; the tiebreaker is litestone's `orderTotal` | `packages/litestone/src/core/query.js:2033`; `litestone.ts:663-695` (`findWindow`) | Opaque text; *refused unless minted by this list*; tiebreaker = the model's identity (entry 1) |
| L9 | The parsed form exists only as a TypeScript interface (`QueryDirectives`) and a hand-written `.d.ts`; the one machine-readable schema (`DIRECTIVE_SCHEMAS`) says *OPAQUE* for `orderBy`, `select`, `populate` | `packages/junction/src/core/directives.ts:28-62`; `packages/toolbelt/src/directives/directives.d.ts:13-29`; `directives.js:70-75` | § 2.3 is the JSON form; the three OPAQUE rows get the grammars of § 2.2/2.5 |
| L10 | `$search` is *FTS5 via table.search()* and the term reaches `MATCH` as typed (`FJS-1440`) | `litestone.ts:191`; the Data boundary | The term is text; its query language is host-defined and the spec says a host MUST NOT let the term be query syntax by default, or must document that it is |
| L11 | `$asOf` is *validated nowhere here* and left to the Data boundary; a day vs an instant is *the model's* | `directives.js:107-115`; `litestone.ts:258-262` | RFC 3339 instant or `YYYY-MM-DD`; which is legal is the model's, which is well-formed is the spec's |
| L12 | The window constants `20` / `100` are literals in four places | `litestone.ts:215-216, 300-301, 709`; `hooks-builtin.ts:49` | Host-declared per service; one declaration |
| L13 | The refusal MESSAGE embeds the sorted table and English plurals | `bridge.ts:427-440` | Pin `code`, `data.directives`, `data.available`; the sentence is the host's |
| L14 | `$wrap` is read off `ctx.query` in `app.ts` BEFORE the bridge strips, and `$first` by JS truthiness in the bridge | `packages/junction/src/core/app.ts:2341-2344`; `bridge.ts:107` | Both are FLAGs by § 2.2's grammar, read by the one splitter; F11 |
| L15 | A second `$`-parser, `parseQuery`, destructures the fourteen names off `query` and reads flags as `=== true \|\| === 'true'` — a third truthy grammar with no `'1'` | `litestone.ts:220-238, 255-264` | One reader (run 2.1's finding; `audit-parsequery-directives.test.ts` pins the fix); F12 |
| L16 | The composition order *type the values, then split* (`query.js` header L17-20) means `asBool`/`asText` see `1`/`123`, not `'1'`/`'123'` | `packages/toolbelt/src/query/query.js:15-20`; `directives.js:33-48` | § 1's one rule: directives read raw text; F5, F7 |
| L17 | The bridge's negative-window refusal runs only in `toContext` (HTTP); `internal()` (socket, in-process) relies on L1's floor | `bridge.ts:128` vs `bridge.ts:276-294` | One refusal on every path; F10 |

L2, L4-argument, L5, L8-contents, L10 and L11 are *the spec must say this is
host-defined* notes, not defects. L3, L14, L15, L16, L17 are defects and have rows in
§ 5.

## 5. Disagreements between the three implementations and this draft

**Findings (rows in the run report).** Each was RUN on 2026-10-10 unless marked.

- **F2** `?$limit=1.5` → **500** `GeneralError: datatype mismatch`. `asNumber` passes
  `1.5`, `clampPage` keeps it, `pageSql` emits `LIMIT 1.5`, SQLite refuses at prepare.
  `directives.js:40-44` · `directives.ts:103-105` · `query.js:1329`. Confirmed.
- **F3** Lenient count reads: `true`→1 (one row), `[]`→0 (no rows), `0x10`→16, `1e2`→100,
  `+5`→5, `"5"`→5, all 200. `directives.js:40-44` (`Number()` where the value half uses a
  round-trip rule). Confirmed.
- **F4** A repeated or list-spelled scalar directive is dropped to the default in silence:
  `?$limit=5&$limit=6` → 20 rows' worth, 200; `{$limit:[5,6]}` on a typed bag the same;
  `?$limit[]=5` → 5. `directives.js:40-44` (`Number([5,6])` is NaN → undefined). Confirmed.
- **F5** A text directive that LOOKS numeric is dropped in silence because the typed wire
  retypes it before the table reads it: `?$after=123` → ordinary page, 200 (where
  `?$after=zzz` is correctly refused); `?$asOf=20260101` → 200 unfiltered. Same class as
  `FJS-2333` (`$search=603`). `directives.js:46` (`asText`) · `query.js:98-113`
  (`parseValue`) · `body.ts:335`. Confirmed.
- **F6** `?$select=` → **200 with rows that have no columns** (`[{},{}]`, `total:2`).
  `normalizeSelect('')` is `{}` and litestone selects nothing. `query-values.ts:91-99` ·
  `litestone.ts:252`. Confirmed.
- **F7** `?$withDeleted=1` → `false`: the toolbelt table says `'1'` is truthy and its own
  spec passes the STRING, but over the real wire `parseValue('1')` is the number `1` and
  `truthy(1)` is false. Soft-deleted rows withheld, 200. Same for `yes` (any non-FLAG
  text is silently false). `directives.js:33` (`truthy`) · `query.js:111`. Confirmed on
  HTTP and on a typed socket bag.
- **F8** Any scalar direction that is not `asc`/`1` sorts DESCENDING: `sideways`, `DESC`,
  `null` all answer `desc`, 200. `query-values.ts:73-76` (`isDirection` is *not an
  object*, then a two-way ternary). Confirmed.
- **F9** `orderByPair` reads `$orderBy[0][name]=desc` as `{key:'name', dir:'desc'}` and
  marks the header, while `normalizeOrderBy` and the Data boundary refuse it as field
  `0` (400). The kit comment claims bracket notation yields `{'0':…}`; the kit's own
  encoder emits `[]`. `directives.js:258-262, 282-296` vs `query-values.ts:70-71`. Confirmed.
- **F10** `bridge.internal({ query: { $limit: -1 } })` → `directives.limit = -1`, no
  refusal; `clampPage` floors it to `0`, so the in-process and socket paths answer *no
  rows, 200* where HTTP answers 400. `bridge.ts:276-294` (no `refuseNegativeWindow`) ·
  `directives.ts:104`. Confirmed.
- **F11** `$first` and `$wrap` each read truthiness their own way: `?$first=no` answers a
  single record, `?$first` (bare) answers a list, `?$wrap=0` is read as `true`.
  `bridge.ts:107` · `app.ts:2341-2344`. Confirmed.
- **F12** `parseQuery`'s fallback reads flags with `=== true || === 'true'`, so a
  `$withDeleted: '1'` placed on `ctx.query` by a hook is `undefined` where the bridge's
  table says `true` — a third flag grammar beside `truthy()` and the typed wire.
  `litestone.ts:255-264`. Confirmed (`parseQuery({ $withDeleted: '1' }, …).withDeleted
  === undefined`). Folds into run 2.1's `parseQuery` row.

**Disagreements the draft keeps without a row** (the implementation's answer is loud,
or harmless, or a ruling the owner should make rather than a defect):

- **D1** `?$limit=abc` / `?$offset=abc` → the draft refuses; the implementation drops to
  the default and the toolbelt spec PINS that (*a non-numeric limit is dropped, not
  passed on as NaN*). `FJS-D237` refused unknown NAMES rather than silently dropping;
  the same argument applies to a value, and the draft follows the ruling's reasoning.
  Owner's call; a `decision-rules` act.
- **D2** `?$orderBy=` → the draft says absent; the implementation answers 400 *unknown
  field ''*. Loud and safe; the draft's rule is consistency with `$search=`.
- **D3** `?$withDeleted="1"` → the draft refuses (quotes are the filter escape); the
  implementation unquotes to `'1'` and answers `true`. Harmless.
- **D4** `?$withDeleted=` and bare `?$withDeleted` → draft `{}`; implementation
  `{withDeleted:false}`. Same effect at the boundary.

**Vectors where the draft was changed to side with the implementation**: the silent
clamp with the envelope carrying the applied limit (V-3; `FJS-1972` owns loudness);
`limit: 0` as count-only (V-2); cursor beside offset → cursor wins, `offset: 0`,
`total: null` (V-21); `%24limit` decoding to a directive (V-44); names never trimmed
(V-46); `'1'`/`'0'` as FLAG spellings (V-50, V-51, from the table's own test); `1`/`-1`
as directions (V-27b); the `rel:a+b` populate grammar (V-36); an empty name inside a
select list dropped rather than refused (V-35); the router dropping rather than
refusing (V-63); and the bad-cursor refusal wording *not a cursor this list minted*
(V-23b).

## 6. Second implementation

The cheapest credible one is a query-string reader in any language fed §3's table —
no database needed for V-1 … V-64 except V-2, V-21, V-23b, V-29, V-34, which assert
the Data boundary's answer and can be run against FrontierJS alone until a second host
exists. `scratchpad/audit/probe-directives.ts` is the FrontierJS runner for the whole
set; its Part A is the kit chain and Part B a real app.
