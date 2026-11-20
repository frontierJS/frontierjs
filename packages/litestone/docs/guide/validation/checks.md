# Checks

A check is a rule the database itself refuses. `@@check` spans columns, which no single-field validator can, and it holds for every writer, including jobs and seeds.

```lite
model Booking {
  id       Int    @id
  startsAt Int
  endsAt   Int
  qty      Int    @check("qty > 0", "Book at least one")

  @@check("startsAt < endsAt", "An end must come after its start")
}
```

```js
await db.booking.create({ data: { startsAt: 1, endsAt: 2, qty: 1 } })

try { await db.booking.create({ data: { startsAt: 5, endsAt: 2, qty: 1 } }) } catch (e) { if (e.name !== 'ValidationError') throw e }
try { await db.booking.create({ data: { startsAt: 1, endsAt: 2, qty: 0 } }) } catch (e) { if (e.name !== 'ValidationError') throw e }
```

## What else it can do

- `@check("expr")` on a field is a SQLite `CHECK` on that column
- The last argument is the message a person sees; without one the expression goes to `err.constraint`
- `@@check` is repeatable
- A violation is a `ValidationError`, so a form shows it like any other refused value
- `@validate` and `@@validate` mark a rule written in code, for what SQL cannot state
- A rule that reads child rows belongs in the function that writes the document, not in a check

**In depth:** [Schema § Constraints the database enforces](../../schema.md#constraints-the-database-enforces-check-check), [§ What a @@check cannot say](../../schema.md#what-a-check-cannot-say), [§ A check written in code](../../schema.md#a-check-written-in-code-validate-validate)
