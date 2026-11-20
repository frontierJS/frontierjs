# Secrets, hashes and personal data

Three words say what a column is. `@hashed` is a one-way digest you can match and never read, `@secret` is an encrypted, guarded, audited credential, and `@personal` marks data about a person.

```lite
model Device {
  id    Int     @id
  label String
  token String  @hashed

  @@gate(0)
}
```

```js
await db.device.create({ data: { id: 1, label: 'kiosk', token: 'tok-123' } })

const found = await db.asSystem().device.findFirst({ where: { token: 'tok-123' } })
if (found?.id !== 1) throw new Error('a hashed column matches by value')
if ('token' in found) throw new Error('a digest is never handed back')

try { await db.asSystem().device.findMany({ select: { token: true } }); throw new Error('the select should be refused') } catch (e) { if (e.name !== 'ValidationError') throw e }
```

A hashed column is matched in a `where` and never read back, not even by `asSystem()`.

## What else it can do

- `@secret` is `@encrypted` plus `@guarded` plus an audit entry on every write, with the value redacted
- `@secret(deterministic: true)` stays findable by its own value, and `@secret(rotate: false)` is excluded from `$rotateKey`
- `@secret @hashed` is a credential a server verifies: matchable, never readable, still guarded and audited
- `@secret` needs a `driver trail` database in the schema, or its audit half is dropped with a warning
- `@guarded` is a column only the system reads or writes, and a `select` cannot unlock it
- `@omit` leaves a column out of the default payload, and `@omit(all)` out of every read
- A `@derived` Boolean such as `hasPassword` answers whether a hashed column is set without exposing it
- `@hashed` needs a `String` column and does not combine with `@encrypted`, `@guarded` or `@allow`
- `@personal` and `@personal(contact)` mark a column about a person, and the audit trail records it as `[personal]`
- `@@person` says every row is a person
- `$rotateKey` refuses while a `@hashed` or `rotate: false` column exists, unless it is named in `orphan`

**In depth:** [Encryption § @hashed](../../encryption.md#hashed), [§ @secret](../../encryption.md#secret), [§ @guarded](../../encryption.md#guarded), [Schema § Visibility & security](../../schema.md#visibility--security), [Trail § Personal data](../../trail.md#personal-data--personal-and-person)
