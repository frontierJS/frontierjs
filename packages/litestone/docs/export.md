# Bulk export

> `@@export(ndjson | csv [, since: <column>])` — on a model or on a view.

Declares that a dataset may leave in bulk. It adds no way in.

```lite
model Order {
  id        Int      @id
  ref       String
  total     Int
  ownerId   String
  cardToken String   @secret
  updatedAt DateTime @updatedAt

  @@gate("1.4.4.5")
  @@allow('read', auth().isStaff)
  @@allow('read', ownerId == auth().id)

  @@export(ndjson, since: updatedAt)
}
```

```
litestone export Order --as alice@example.com
fli db:export Order --as alice@example.com --gate ./api/src/core/gate.ts
```

## The rows that leave are the rows that account can read

An export is a **paginated scoped read** — `$setAuth(principal)` and then
`findManyCursor` until the pages run out. There is no export-specific
enforcement anywhere, and that is the design rather than an economy: a second
grader would be a second answer to who may read.

Four things follow, and none of them was built:

- a **`@@gate`** below the caller refuses the whole run, at the first page;
- a **row policy** narrows the file rather than failing it — staff, a shopper and
  the system take three different extracts from one declaration;
- a **field policy** or a `@guarded` column is absent, because the predicate
  already compiled into the read;
- under **tenancy** the extract is one tenant's, because the client is.

## A `@@gate` is required beside it

Even where the schema guards nothing else. A bulk read of every row is a
different proposition from one row at a time, and the refusal is at parse:

```
Model 'Order': @@export needs a @@gate beside it. An export is a bulk read of
every row a caller may see, so an ungated one is the whole table to anybody.
Write @@gate("0") if this dataset is public on purpose.
```

`@@gate("0")` is how a schema says *public on purpose*.

## The cursor decides what a resumed run catches

`since:` names a sortable declared column, and the choice has a consequence
worth stating: a `createdAt` cursor sees **new rows and not edits to old ones**.
A model whose rows are revised wants `@updatedAt` in that slot. A dataset with no
`since:` is answered whole every time, which is what an aggregate view is.

A dataset with neither a cursor nor a primary key — an aggregate view — pages by
offset instead. `findManyCursor` rightly refuses to page a projection it cannot
order uniquely, since some rows would be served twice and others skipped.

## Protected columns do not leave by default

`@encrypted`, `@secret` and `@guarded` columns are omitted **even for a caller
who may read them**. An interactive read is a screen; an extract is a file that
leaves the machine — the same principal at a different blast radius.

`--include-protected` keeps them, and the manifest records that it was asked for.

## The manifest

Every run writes `<dataset>.manifest.json` beside the data:

```json
{
  "feed": "Order",
  "takenAt": "2026-09-07T14:22:08.417Z",
  "takenAs": { "principal": "u_31f9c2", "system": false, "declaredReadGate": 1, "reads": "graded" },
  "rows": 10432,
  "cursor": { "column": "updatedAt", "after": "2026-09-07T14:21:55.002Z" },
  "policiesApplied": [{ "kind": "allow", "expr": "ownerId == auth().id" }],
  "omitted": [{ "name": "cardToken", "reason": "protected", "by": "@secret" }]
}
```

`policiesApplied` and `omitted` are the two that matter. **A manifest listing
only what an extract contains is a receipt; one that names the omissions and the
rules that applied is evidence** — and it is what lets somebody tell an
incomplete export from a complete one a year later.

`cursor.after` is what a later run passes to `--since`.

## Naming a standing

`--as` takes an **account**, resolved the way `litestone repl --as` resolves one,
and `--gate` names the app's own `getLevel` so the run grades the way the app
does. A synthesized level is deliberately not offered: an invented principal
evaluates every claim-based policy against nothing, and an absent claim is `NULL`
— which the SQL half reads as *nobody* and the JS half as *everybody*.

`--system` is the explicit escape. It reads everything, the manifest says so, and
the run is recorded in the audit trail.

## The trail

Every run writes one `db.$audit()` row — `operation: 'export'`, the principal,
and the manifest as `meta`. Reads are not logged by default because collection
reads are high volume; a bulk extract is the opposite shape — one event per run,
and the single one most worth having a record of.

## Over HTTP

`fli db:export` is the operator's path. The application's is junction's
`exportPlugin()`, which mounts `GET /exports` and `GET /exports/{dataset}` and
streams the extract **as the calling session** — the same `runExport`, so the
same gate, the same row policies, the same tenancy.

Three differences, all deliberate:

- **`--system` and `--include-protected` have no query parameter.** Both belong
  where an operator typed them and the manifest recorded it. A query parameter is
  the easiest thing there is to add to a script once and never take out.
- **There is no manifest in the body.** The half worth reading is not known when
  the response headers go out, because the response streams; and the cursor a
  caller resumes on is the `@@export(since:)` column of the last row it received,
  which it already has. `x-export-resume-on` names that column, and
  `x-export-withheld` names what did not leave. The evidence half goes to the
  audit trail, which is where it survives.
- **A refusal is a status code.** The response is held until the first row, so a
  caller below the gate gets a 403 rather than a 200 that stops — which matters
  most for CSV, where the column header is written before the first read.

## See also

- [access-control.md](access-control.md) — the gate and the policies that bound an extract
- [querying.md](querying.md) — `findManyCursor`, and the paging this is built on
