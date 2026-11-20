# The Warden

The Warden is the access system: everything that decides whether a call may touch a row or a column. It is declared in the schema and enforced at the Data boundary, so a service, a job and an agent all meet the same rules.

```lite
model User { id Int @id  @@auth  @@gate(4) }

model Note {
  id      Int    @id @default(autoincrement())
  ownerId Int    @default(auth().id)
  body    String

  @@gate(1.4.4.5)
  @@allow(read, ownerId == auth().id)
}
```

```js
const ann = db.$setAuth({ id: 1, role: 'user' })
const bob = db.$setAuth({ id: 2, role: 'user' })
await ann.note.create({ data: { body: 'mine' } })

const annSees = await ann.note.findMany()
const bobSees = await bob.note.findMany()
const system  = await db.asSystem().note.findMany()
if (annSees.length !== 1 || bobSees.length !== 0 || system.length !== 1) throw new Error('the row policy did not apply')

try { await db.note.findMany(); throw new Error('a stranger read the table') } catch (e) { if (e.name !== 'AccessDeniedError') throw e }
```

A call passes down the layers in order: the principal, the gate, a capability, the row policy, then the field rules. A layer that reads no row throws, and a layer that reads the row filters.

## What else it can do

- `db.$setAuth(user)` returns a scoped client, and every rule reads `auth()` off it
- `@@gate` grades the kind of caller on a 0 to 9 ladder, per operation
- `@@allow` and `@@deny` grade whose row it is
- `@@capabilities` grades which action, as a grid beside the ladder
- `@guarded`, `@encrypted`, `@hashed` and a field `@allow` grade which columns
- `@@transitions` grades who may make a move
- `asSystem()` lifts authority and still holds integrity: checks, `@immutable` and the state machine
- Tenancy compiles to `@@deny`, so no extra `@@allow` can widen it

**In depth:** [Warden](../../warden.md), [§ One call, top to bottom](../../warden.md#one-call-top-to-bottom), [§ asSystem() lifts the Warden and holds integrity](../../warden.md#assystem-lifts-the-warden-and-holds-integrity)
