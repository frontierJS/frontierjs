# State machines

`@@transitions` declares which moves a column may make. An undeclared move is refused, and two writers racing for the same move cannot both win.

```lite
enum OrderStatus { pending  paid  shipped  cancelled }

model Order {
  id     Int         @id
  status OrderStatus @default(pending)

  @@transitions(status,
    pay:    pending         -> paid,
    ship:   paid            -> shipped,
    cancel: [pending, paid] -> cancelled)
}
```

```js
const o = await db.order.create({ data: {} })
await db.order.transition(o.id, 'pay')

const next = (await db.order.transitions(o.id)).map(m => m.name).sort().join()
if (next !== 'cancel,ship') throw new Error('unexpected moves: ' + next)

try { await db.order.update({ where: { id: o.id }, data: { status: 'pending' } }) } catch (e) { if (!e.name.startsWith('Transition')) throw e }
```

## What else it can do

- `transitions(row)` lists the moves this caller may make from here, for buttons
- `@gate(N)` on a move sets the minimum level that may make it
- `@system` on a move reserves it for the application
- `@stamps(sentAt)` records when a move was made, and `by:` who made it
- `while:` and `unless:` refuse a move on a condition
- A `Boolean` column is a state machine too, with named moves
- Declared once inside an `enum`, the machine applies to every model that uses it
- A new row must start at its column's `@default`

**In depth:** [Schema § State machines](../../schema.md#state-machines), [§ Asking what's legal](../../schema.md#asking-whats-legal), [§ Declaring it on the enum instead](../../schema.md#declaring-it-on-the-enum-instead)
