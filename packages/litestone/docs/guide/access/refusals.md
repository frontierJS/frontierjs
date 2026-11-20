# Refusals

The layers do not all fail the same way. A layer that reads no row throws, because it discloses only the schema. A layer that reads the row filters, because a refusal would confirm the row exists.

```lite
model User { id Int @id  @@auth }

model Doc {
  id      Int    @id @default(autoincrement())
  ownerId Int    @default(auth().id)
  title   String

  @@gate(1.4.4.5)
  @@allow(read,   ownerId == auth().id)
  @@allow(update, ownerId == auth().id)
  @@allow(create, auth() != null)
}
```

```js
const ann = db.$setAuth({ id: 1, role: 'user' })
const bob = db.$setAuth({ id: 2, role: 'user' })
const doc = await ann.doc.create({ data: { title: 'Plan' } })

const read   = await bob.doc.findMany()
const update = await bob.doc.update({ where: { id: doc.id }, data: { title: 'x' } })
if (read.length !== 0 || update !== null) throw new Error('a policy should filter, not throw')

const stranger = db.$setAuth({ id: 3 })   // no role: CREATOR (3), below the create floor
try { await stranger.doc.create({ data: { title: 'x' } }); throw new Error('the gate should refuse') } catch (e) { if (e.name !== 'AccessDeniedError') throw e }
```

So a wrong policy is an empty screen rather than an error, and a refused write returns normally. Test it by reading the row back as the system.

## What else it can do

- `@@gate` throws on every verb, naming the model and the level
- `@@capabilities` throws on writes, and on read only under `(all)`
- `@@allow` and `@@deny` filter on read, answer nothing on update and delete, and throw on create
- A field `@allow` strips on read and drops on write, keeping the rest of the payload
- `@guarded` and `@system` throw on a write, because no caller was meant to send them
- `@@transitions` throws, and only at a caller who can already read the row
- The question is whose mistake it is: wrong for everyone refuses, right but narrower drops the key
- The order is gate, then capability, then row policy, then field rules, and each only narrows the one above
- A row policy that filters can be recorded as a `denied` entry in the audit trail

**In depth:** [Access control § Combining them](../../access-control.md#combining-them--what-refuses-what-goes-quiet-and-why), [§ Rule one](../../access-control.md#rule-one--a-refusal-must-never-confirm-a-row-exists), [§ Rule two](../../access-control.md#rule-two--whose-mistake-is-it)
