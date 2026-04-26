# Encryption

Litestone provides field-level encryption at rest using AES-256-GCM, with HMAC-based searchable equality and a composite `@secret` attribute that bundles encryption with auditing.

## Setup

Pass a 64-character hex string (32 bytes) as `encryptionKey` to `createClient`:

```js
const db = await createClient({
  path: './schema.lite',
  encryptionKey: process.env.ENC_KEY,   // 64 hex chars = 32 bytes
})
```

## @encrypted

Encrypts the value at rest using AES-256-GCM. Implies `@guarded(all)` — only readable via `asSystem()` or explicit select from a system context.

```prisma
model User {
  ssn  Text @encrypted
  dob  Text @encrypted
}
```

```js
// Write — value is encrypted transparently
await db.user.create({ data: { id: 1, ssn: '123-45-6789' } })

// Read — guarded: returns null unless asSystem()
const user = await db.user.findUnique({ where: { id: 1 } })
user.ssn  // → null (guarded)

const sysUser = await db.asSystem().users.findUnique({ where: { id: 1 } })
sysUser.ssn  // → '123-45-6789'
```

## @encrypted(searchable: true)

Stores an HMAC of the plaintext alongside the ciphertext, enabling equality WHERE filters without decrypting:

```prisma
model User {
  email Text @encrypted(searchable: true)
}
```

```js
// Equality search works — HMAC compared, not plaintext
const user = await db.asSystem().users.findFirst({ where: { email: 'alice@example.com' } })

// Range queries, LIKE, contains — not possible on encrypted fields
// Use $raw only if you know what you're doing
```

## @secret

Composite attribute — expands at parse time to `@encrypted + @guarded(all) + @log(audit)`. Every read and write is logged to the audit logger database.

```prisma
database audit {
  path "./audit/"
  driver logger
  retention 90d
}

model User {
  apiKey Text? @secret                   // encrypted + guarded + audited
  token  Text? @secret(rotate: false)    // same but excluded from $rotateKey
}
```

## Key rotation

Re-encrypts all `@secret(rotate: true)` fields (the default) with the new key:

```js
const stats = await db.$rotateKey(newKey)
// → { users: { rows: 42, fields: 1 }, orders: { rows: 18, fields: 2 } }
```

`@secret(rotate: false)` fields are skipped — useful for legacy keys that should stay bound to the original encryption key.

## Multi-tenant key-per-tenant

The tenant registry accepts a function for per-tenant keys:

```js
const tenants = await createTenantRegistry({
  dir:           './tenants/',
  schema:        './schema.lite',
  encryptionKey: async (tenantId) => getKeyForTenant(tenantId),
})
```

## @guarded and @guarded(all)

Not encryption, but related — these hide fields from reads unless `asSystem()` is used:

```prisma
model User {
  passwordHash Text @guarded(all)   // excluded everywhere unless asSystem()
  internalNote Text @guarded        // excluded from findMany/findFirst, returned by findUnique
}
```

`@omit` is similar but weaker — explicit `select` can unlock it. `@guarded` requires `asSystem()` even with explicit select.
