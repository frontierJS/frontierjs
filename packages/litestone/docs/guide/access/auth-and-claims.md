# `auth()` and claims

`auth()` is the caller a policy reads. `auth().teamId` is a claim: a fact the principal carries, and the schema declares which claims exist so a misspelling is refused when the client is built.

```lite
model User {
  id     Int @id
  teamId Int?
  @@auth
}

model Ticket {
  id     Int    @id @default(autoincrement())
  teamId Int
  title  String

  @@gate(0)
  @@allow(read, teamId == auth().teamId)
}
```

```js
await db.asSystem().ticket.createMany({ data: [{ teamId: 1, title: 'ours' }, { teamId: 2, title: 'theirs' }] })

const member  = db.$setAuth({ id: 1, teamId: 1 })
const nobody  = db.$setAuth({ id: 2 })
const mine    = await member.ticket.findMany()
const none    = await nobody.ticket.findMany()
if (mine.length !== 1 || mine[0].title !== 'ours' || none.length !== 0) throw new Error('claims did not scope the reads')
```

A caller who does not carry the claim is not "false", they are unknown, and an unknown never satisfies an `@@allow`.

## What else it can do

- The claims a policy may name are the framework's own, the columns of the `@@auth` model, and any declared with `claim`
- `claim cartToken` at the top level declares a claim that is on no row, resolved per request by the app
- `claim contactId bearer` marks a claim carried by someone with no account, such as a link holder
- `claim siteId from Employee(userId).siteId` reads a claim off a row pointing at the caller, on every request
- `db.$claimsFor(principal)` answers what a principal carries, for a tool or a test
- `@@deny` fires on true and on unknown, so a deny naming an absent claim refuses an anonymous caller
- `auth().x == null` is how a policy asks whether the caller carries no such claim
- `auth().level` is the gate's grade for the model being read
- `createClient({ claims: [...] })` states the same set in code, for a schema you do not own

**In depth:** [Access control § What auth().x may name](../../access-control.md#what-authx-may-name), [§ A claim that lives on another row](../../access-control.md#a-claim-that-lives-on-another-row), [§ An absent claim is UNKNOWN](../../access-control.md#an-absent-claim-is-unknown-in-both-halves)
