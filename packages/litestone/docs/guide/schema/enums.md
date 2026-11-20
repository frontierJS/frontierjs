# Enums

An enum is a closed set of values. The column refuses anything outside it, and the same set feeds the generated types and form pickers.

```lite
enum Plan {
  starter     @label("Starter")
  pro         @label("Professional")
  enterprise
}

enum Channel { email  sms  push }

model Account {
  id       Int       @id
  plan     Plan      @default(starter)
  channels Channel[]
}
```

```js
const a = await db.account.create({ data: { channels: ['email', 'sms'] } })
if (a.plan !== 'starter') throw new Error(a.plan)

const some = await db.account.findMany({ where: { channels: { has: 'sms' } } })
if (some.length !== 1) throw new Error('expected one account')

try { await db.account.create({ data: { plan: 'free' } }) } catch (e) { if (e.name !== 'ValidationError') throw e }
```

## What else it can do

- `Plan @default(starter)` takes a bare member as its default
- `Channel[]` holds several members; each is checked on every write
- `@label("Professional")` gives a member the text a picker shows
- A member may be a quoted string, `"On Hold"`, and the stored value is that string
- `///` above a member documents what it means
- `@@transitions` turns an enum field into a state machine

**In depth:** [Schema § Enums](../../schema.md#enums), [§ Labeling a member](../../schema.md#labeling-a-member), [§ A set of enum values](../../schema.md#a-set-of-enum-values)
