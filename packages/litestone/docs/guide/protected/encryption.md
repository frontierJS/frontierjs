# Encryption

`@encrypted` stores a column as AES-256-GCM ciphertext and hides it from every non-system read. Give `createClient` a 32-byte key as 64 hex characters and the rest is transparent.

```lite
model Patient {
  id  Int     @id
  ssn String? @encrypted

  @@gate(0)
}
```

```js
await db.patient.create({ data: { id: 1, ssn: '123-45-6789' } })

const seen = await db.patient.findUnique({ where: { id: 1 } })
if ('ssn' in seen) throw new Error('a non-system read carries no @encrypted column')

const plain = await db.asSystem().patient.findUnique({ where: { id: 1 } })
if (plain.ssn !== '123-45-6789') throw new Error('the system reads the plaintext')
```

The key comes from the environment: `createClient({ path, encryptionKey: process.env.ENCRYPTION_KEY })`. A non-system caller may still write the column, because whoever supplies a secret is routinely not the system.

## What else it can do

- `@encrypted(deterministic: true)` derives the IV from the value, so an equality `where` works and the value reads back
- Deterministic mode leaves equal values visibly equal in the file; plain `@encrypted` cannot be filtered at all
- `equals`, `not`, `in`, `notIn` and a bare value work on a deterministic column, and `contains` or sorting are refused by name
- `@unique` over a plain `@encrypted` column is refused at parse, because a random IV makes it never fire
- `@guarded` beside `@encrypted` makes a column no caller may write either
- Every stored value names the key that wrote it, so a wrong key raises instead of reading as `null`
- `$rotateKey(newKey)` re-encrypts every key-reversible column under a new key and swaps the client's key
- `previousEncryptionKeys` keeps the old keys readable, which makes a rotation resumable
- `litestone rekey` is the same rotation from a shell
- A caller cannot send a value that merely looks like ciphertext
- `encryptionKey` can be a function of the tenant for a key per tenant
- A deterministic or hashed column can be compared in a policy, and a plain `@encrypted` one is refused

**In depth:** [Encryption](../../encryption.md), [§ @encrypted(deterministic: true)](../../encryption.md#encrypteddeterministic-true), [§ Key rotation](../../encryption.md#key-rotation), [Access control § Encryption keys, and rotating one](../../access-control.md#encryption-keys-and-rotating-one), [§ Comparing an encrypted column](../../access-control.md#comparing-an-encrypted-column)
