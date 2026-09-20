# `litestone validate` — which stored rows would this schema refuse?

Every constraint here is enforced twice. SQLite holds one half, and that half
travels with the table: changing it is a migration, the differ has to agree, and
a row that breaks it cannot be written in the first place.

The other half is enforced at the client boundary and **leaves no CHECK
behind** — `@email`, `@url`, `@regex`, `@length`, `@minItems`, an array's
element type, the ISO convention on a `DateTime`, and the shape of a
`Json @type(T)`. Tightening one of those governs the next write and says nothing
whatever about the rows already down.

Those rows do not become invalid loudly:

```
$ litestone migrate status
  ✓ schema is in sync

$ litestone validate
  main: ./app.db

  ✗  Place — all 2 row(s) would be refused
       addr.zip is required
       every row breaks it, so this is the rule to look at rather than the data

  !  User 2
       email must be a valid email address

  3 of 4 row(s) would be refused by the schema as it stands.
  Nothing was written. Backfill the rows, or loosen the rule back.
```

Both statements are true at once. The migrator is right — the column did not
move, and there is nothing to apply. What moved is the rule, and three of the
four rows stopped satisfying it.

## What it costs you to not know

A stored row that breaks a boundary validator still **reads back perfectly**.
Every list renders it, every snapshot matches, every health check passes. What
fails is its next UPDATE, and it fails naming a column the caller never sent:

```js
// The row was written when `Addr` had only a city.
await db.place.findUnique({ where: { id: 1 } })
// → { id: 1, addr: { city: 'Reno' } }        ← fine

await db.place.update({ where: { id: 1 }, data: { addr: { city: 'Sparks' } } })
// → ValidationError — addr.zip: is required  ← the row is stuck
```

So the symptom reaches you as a support ticket from whoever owned that row,
about a field they were not editing, long after the deploy that caused it.

## Two findings, because they want different answers

**A model where every row is refused** is a deploy that half-landed. Nobody can
write to it at all, so the thing to look at is the rule rather than the data —
usually a required member added to a `type`, or a validator tightened past what
the app has ever written. It is printed as the model, with the rule underneath.

**A model where some rows are refused** is data that drifted, and the rows are
named individually so you can go and look at them.

Both are listed either way: *fix the schema* and *fix these rows* are both
answers somebody has to act on, and a count with no row to open is not one.

## The empty answer is not a pass

Run from the wrong directory, this command opens a database that is not there,
litestone creates it, and every model answers zero rows. That prints as a tick
in any tool that only counts findings, so it does not here:

```
  main: ./nowhere.db

  !  2 model(s) and not one row between them — nothing was checked.
       If this database should hold rows, the path above is not the one you meant.
```

The file is named before the verdict, always, for the same reason.

## Usage

```bash
litestone validate                 # every model
litestone validate --only=User,Post
litestone validate --json          # the report as data
```

Exits **1** when any row would be refused, which is what puts it in a deploy
pipeline beside `litestone release --strict`. It opens the database read-only in
effect — it runs no write, and says so in its own output.

Reads happen through `asSystem()`, deliberately: a caller-scoped read of a
`@@gate("8")` model answers `[]`, which is the same shape as a model with
nothing wrong, so the walk would pass most confidently on exactly the models
whose rows are most protected.

`jsonl` and `logger` models are skipped by name — there are no migrations and no
declared shape there to hold a row to.

## The report

Not a published entry point. `src/validate-rows.js` sits beside `release.js` and
`access.js` and is reached the way they are — through the command — because an
ops surface with two callers is two things to keep true. `--json` is the API:

```js
const report = await validateRows(db, { models: ['Place'] })
// {
//   ok: false,
//   checked:  [{ model: 'Place', rows: 2, failing: 2 }],
//   findings: [{ model: 'Place', id: 1, errors: [{ path: ['addr','zip'], message: 'is required' }] }],
//   models:   [{ model: 'Place', rows: 2, failing: 2, errors: [...] }],
//   skipped:  [],
// }
```

`checked` carries the true counts; `findings` is capped per model by `limit`
(default 100), so a capped report never reads as a smaller problem than it is.

## See also

- [json-types.md](json-types.md) — `Json @type(T)`, the feature this walk most
  often has something to say about
- [migrations.md](migrations.md) — the other half, and why it cannot see this
- [testing.md](testing.md) — `verifyConstraints()` asks the same question of a
  test database by writing rows, where this asks it of rows already written
