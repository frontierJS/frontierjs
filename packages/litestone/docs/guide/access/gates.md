# Gates

A gate is a floor on the caller: the minimum level on a 0 to 9 ladder that a model requires for each of read, create, update and delete. It is answered from the session alone, before any SQL runs.

```lite
model User { id Int @id  @@auth  @@gate(4) }

model Report {
  id    Int    @id @default(autoincrement())
  title String

  @@gate(2.4.4.6)
}
```

```js
const reader = db.$setAuth({ id: 1, role: 'user', verifiedAt: null })   // signed in, not verified: VISITOR (1)
const member = db.$setAuth({ id: 2, role: 'user' })                     // USER (4)

await member.report.create({ data: { title: 'Q1' } })

try { await reader.report.findMany(); throw new Error('a visitor read the reports') } catch (e) { if (e.name !== 'AccessDeniedError') throw e }
const rows = await member.report.findMany()
if (rows.length !== 1) throw new Error('a member should read')
```

Four positions are `Read.Create.Update.Delete`, and a position left off takes the one before it, so `@@gate(4)` is `4.4.4.4`.

## What else it can do

- Levels run `STRANGER` 0, `VISITOR` 1, `READER` 2, `CREATOR` 3, `USER` 4, `ADMINISTRATOR` 5, `OWNER` 6, `SYSADMIN` 7, `SYSTEM` 8 and `LOCKED` 9
- `@@gate(0)` says a model is public on purpose
- Once a schema declares any access rule, a model with no gate and no `@@allow` or `@@deny` is system-only
- A declared gate installs the standard level resolver itself, so none is silently inert
- `GatePlugin({ getLevel })` replaces the resolver with your own, answered synchronously
- A standing the app does not model is absent and is no objection; `null` means not yet reached and grades down
- `8` means `asSystem()` and nothing else, and `9` is not passed by anything
- A gate refuses the whole query, and names the model, even four `include`s deep
- A row policy reads the same grade as `auth().level`

**In depth:** [Access control § Gates](../../access-control.md#gates--level-based-access-control), [§ Levels](../../access-control.md#levels), [§ The default resolver](../../access-control.md#the-default-resolver-and-undefined-vs-null), [§ @@gate syntax](../../access-control.md#gate-syntax)
