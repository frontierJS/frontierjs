# Checking stored rows

Some rules, such as `@email` or a `Json @type`, live only in the client and leave no CHECK in the table. `litestone validate` re-reads every stored row and names the ones the schema would now refuse.

```lite
type Addr {
  city String
  zip  String
}

model Place {
  id   Int  @id
  addr Json @type(Addr)
}
```

```js
// written when Addr had only a city
db.$rawDbs.main.run(`INSERT INTO "place" ("id", "addr") VALUES (1, '{"city":"Reno"}')`)

const row = await db.place.findUnique({ where: { id: 1 } })
if (row.addr.city !== 'Reno') throw new Error('the old row still reads back')

let refused = false
try {
  await db.place.update({ where: { id: 1 }, data: { addr: { city: 'Sparks' } } })
} catch (e) {
  if (e.name !== 'ValidationError') throw e
  refused = true
}
if (!refused) throw new Error('the next write should be refused')
```

```sh
litestone validate    # lists Place 1: addr.zip is required, exits 1
```

## What else it can do

- `--only=User,Post` limits the walk to some models
- `--json` prints the report as data
- Exits 1 when any row would be refused, so it fits a deploy pipeline beside `litestone release --strict`
- A model where every row fails is a rule to fix; a model where some fail is data to fix
- It runs no write, and reads through `asSystem()` so gated models are checked too
- An empty database is reported as not checked, never as a pass
- `jsonl` and `trail` models are skipped by name

**In depth:** [validate](../../validate.md), [§ Two findings](../../validate.md#two-findings-because-they-want-different-answers), [§ Usage](../../validate.md#usage)
