# Encryption

Litestone provides field-level protection at rest. Three attributes, and they sit on
one axis — **can this value be read back?**

|  | recoverable | not recoverable |
| --- | --- | --- |
| **not filterable** | `@encrypted` | — |
| **filterable (equality)** | `@encrypted(deterministic: true)` | `@hashed` |

The empty cell is empty on purpose: a value you can neither read nor match is a value
you deleted. Plus `@secret`, which composes `@encrypted` with guarding, auditing and
key rotation.

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
  ssn  String @encrypted
  dob  String @encrypted
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

## @encrypted(deterministic: true)

AES-256-GCM with the IV **derived from the plaintext** instead of taken at random.
The same value therefore encrypts to the same bytes, which is what makes an equality
filter work — and it is still ciphertext, so it reads back and `$rotateKey` can re-key
it.

```prisma
model User {
  // Looked up at sign-in AND mailed to. Both, so both must work.
  email String @encrypted(deterministic: true)
}
```

```js
await db.asSystem().users.findFirst({ where: { email: 'a@example.com' } })  // → the row
user.email                                                                  // → 'a@example.com'
```

**What it trades.** Equal values are visibly equal in the column to anyone holding the
database file — the ciphertext is a stable token per distinct value, so an attacker can
count how many rows share an address and confirm a guessed one. Every searchable
encryption scheme leaks this, blind indexes included; it is why the mode is opt-in per
field rather than the default. If a value never needs reading back, `@hashed` leaks the
same fact and stores less.

## @hashed

HMAC-SHA256. **One-way**: there is no ciphertext, no key that recovers it, and
`$rotateKey` cannot touch it. Equality filters work; the value never comes back.

```prisma
model User {
  // Matched at sign-in, never shown to anyone, including an admin.
  loginToken String @hashed
}
```

```js
await db.asSystem().users.findFirst({ where: { loginToken: tok } })  // → the row
```

**Every read path refuses it, `asSystem()` included** — there is nothing to lift the
guard to. A row simply lacks the field; naming it in a `select`, a `groupBy` or an
aggregate throws, because those project the column straight out of SQLite and would
otherwise hand back the digest:

```js
user.loginToken                                            // → undefined
db.asSystem().users.findUnique({ where, select: { loginToken: true } })
// ValidationError: 'loginToken' is @hashed on User — the column holds a one-way
// digest, so there is no value to select. It can be matched in a where and never
// read back. If this field has to be readable, it wants @encrypted(deterministic: true)
```

`@hashed` is not an option on `@encrypted` because an option inherits its parent's
promise, and `@encrypted` promises the value comes back. It does not compose with
`@encrypted`, `@secret`, `@guarded` or `@allow` — each of those describes a readable
value — and it requires a `String` column, since a digest is text.

## Which equality survives

Both matchable modes answer the same set, and refuse the rest **by name** rather than
comparing plaintext against stored bytes and returning something plausible:

```js
// Works on @encrypted(deterministic: true) and @hashed alike
where: { f: v }               where: { f: { equals: v } }
where: { f: { in: [a, b] } }  where: { f: [a, b] }
where: { f: { not: v } }      where: { f: { notIn: [a] } }

// Refused, naming the field and the reason
where: { f: { contains: 'x' } }
// ValidationError: … it can answer equality (equals, not, in, notIn) and cannot
// answer 'contains', because neither preserves ordering or substrings
```

A **plain** `@encrypted` field cannot be filtered at all: the column holds ciphertext
under a random IV, so no plaintext can equal it. That is refused too, naming both cures
— it used to answer `[]`, which is indistinguishable from *no such row*.

Sorting is meaningless in every mode: an encoding preserves equality, never order.

## `@encrypted(searchable: true)` is gone

It stored an HMAC **and no ciphertext**, under a name that promises the value comes
back. The plaintext was destroyed on write, `asSystem()` was handed the digest as if it
were the value, and the page you are reading said it stored the HMAC *alongside* the
ciphertext, which was never true. It is refused at parse time rather than translated —
the two meanings it was standing in for are exactly the decision above, and guessing
either one silently is how data was lost:

```
@encrypted(searchable: true) no longer exists — it stored a one-way HMAC and destroyed
the plaintext. Use @encrypted(deterministic: true) for a value you need to look up AND
read back, or @hashed for one you only ever need to match. Existing v1s. columns cannot
be recovered by either.
```

**A column already holding `v1s.` values is unrecoverable.** An HMAC has no inverse;
the plaintext is not withheld pending a key, it is gone. Nothing reads the prefix, so
migrating means re-collecting the values from wherever they still exist. See
`FJS-211`.

## @secret

Composite attribute — expands at parse time to `@encrypted + @guarded(all) + @log(audit)`. Every read and write is logged to the audit logger database.

```prisma
database audit {
  path "./audit/"
  driver logger
  retention 90d
}

model User {
  apiKey String? @secret                        // encrypted + guarded + audited
  token  String? @secret(rotate: false)         // same but excluded from $rotateKey
  lookup String? @secret(deterministic: true)   // same, and findable by value
}
```

`deterministic: true` selects the encryption mode the composite uses, so a secret
that has to be looked up by its own value — an API key presented on a request — is
still rotatable. `$rotateKey` re-encrypts each field in the mode it was declared
with; rewriting a deterministic column under a random IV would leave it readable and
every equality filter over it answering nothing.

## Key rotation

Re-encrypts all `@secret(rotate: true)` fields (the default) with the new key:

```js
const stats = await db.$rotateKey(newKey)
// → { users: { rows: 42, fields: 1 }, orders: { rows: 18, fields: 2 } }
```

`@secret(rotate: false)` fields are skipped — useful for legacy keys that should stay bound to the original encryption key. `@hashed` fields are not rotatable at all: there is no plaintext to re-key.

**The client that calls `$rotateKey` cannot read its own output** — `asSystem()` is memoised over a snapshot of the key, so it keeps the old one and every affected field reads as `null`. Build a fresh client, or restart, after rotating. `FJS-236`.

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
  passwordHash String @guarded(all)   // excluded everywhere unless asSystem()
  internalNote String @guarded        // excluded from findMany/findFirst, returned by findUnique
}
```

`@omit` is similar but weaker — explicit `select` can unlock it. `@guarded` requires `asSystem()` even with explicit select.
