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

**Filterable is also what `@unique` means.** A UNIQUE constraint is over the stored
bytes, and plain `@encrypted` uses a random IV — the same plaintext stores different
ciphertext every write, so the constraint is built and can never fire. `@unique` and
`@@unique([...])` are refused over such a column at parse rather than left to be
discovered by a duplicate that nothing rejected. Reach for
`@encrypted(deterministic: true)`, or `@hashed` if the value only ever has to be
matched.

## Setup

Pass a 64-character hex string (32 bytes) as `encryptionKey` to `createClient`:

```lite
model User {
  id  Int     @id
  ssn String? @encrypted
}
```

```js
const ENC_KEY = process.env.ENC_KEY ?? 'a'.repeat(64)   // 64 hex chars = 32 bytes; a real one comes from the environment

const db = await createClient({
  path:          './schema.lite',
  db:            ':memory:',
  encryptionKey: ENC_KEY,
})
```

## @encrypted

Encrypts the value at rest using AES-256-GCM, and hides it from every non-system
read — a non-deterministic ciphertext has nothing to hand back. A non-system
caller may still WRITE one: whoever supplies a secret is routinely not the
system. For a column no caller may set either, add `@guarded`.

```lite
model User {
  id   Int     @id
  ssn  String? @encrypted
  dob  String? @encrypted

  @@gate(0)
}
```

```js
// Write — value is encrypted transparently
await db.user.create({ data: { id: 1, ssn: '123-45-6789' } })

// Read — hidden: the key is absent from the row unless asSystem()
const user = await db.user.findUnique({ where: { id: 1 } })
user.ssn  // → undefined — stripped, not null
if ('ssn' in user) throw new Error('a non-system read carries no @encrypted column')

const sysUser = await db.asSystem().user.findUnique({ where: { id: 1 } })
sysUser.ssn  // → '123-45-6789'
if (sysUser.ssn !== '123-45-6789') throw new Error('the system reads the plaintext')
```

## @encrypted(deterministic: true)

AES-256-GCM with the IV **derived from the plaintext** instead of taken at random.
The same value therefore encrypts to the same bytes, which is what makes an equality
filter work — and it is still ciphertext, so it reads back and `$rotateKey` can re-key
it.

```lite
model User {
  id    Int    @id
  // Looked up at sign-in AND mailed to. Both, so both must work.
  email String @encrypted(deterministic: true)

  @@gate(0)
}
```

```js
await db.user.create({ data: { id: 1, email: 'a@example.com' } })
const user = await db.asSystem().user.findFirst({ where: { email: 'a@example.com' } })  // → the row
user.email                                                                               // → 'a@example.com'
if (user?.email !== 'a@example.com') throw new Error('expected the row back by its value')
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

```lite
model User {
  id         Int    @id
  // Matched at sign-in, never shown to anyone, including an admin.
  loginToken String @hashed
}
```

```js
const tok = 'the-token-the-client-presented'
await db.user.create({ data: { id: 1, loginToken: tok } })
const user = await db.asSystem().user.findFirst({ where: { loginToken: tok } })  // → the row
if (user?.id !== 1) throw new Error('expected the row matched by digest')
```

**Every read path refuses it, `asSystem()` included** — there is nothing to lift the
guard to. A row simply lacks the field; naming it in a `select`, a `groupBy` or an
aggregate throws, because those project the column straight out of SQLite and would
otherwise hand back the digest:

```js
await db.user.create({ data: { id: 1, loginToken: 'tok' } })
const user = await db.asSystem().user.findUnique({ where: { id: 1 } })
user.loginToken                                            // → undefined
if ('loginToken' in user) throw new Error('a digest is never handed back')

try {
  await db.asSystem().user.findUnique({ where: { id: 1 }, select: { loginToken: true } })
  throw new Error('expected the select to be refused')
} catch (e) {
  if (e.name !== 'ValidationError') throw e
}
// ValidationError: 'loginToken' is @hashed on User — the column holds a one-way
// digest, so there is no value to select. It can be matched in a where and never
// read back. If this field has to be readable, it wants @encrypted(deterministic: true)
```

`@hashed` is not an option on `@encrypted` because an option inherits its parent's
promise, and `@encrypted` promises the value comes back. It does not compose with
`@encrypted`, `@guarded` or `@allow` — each of those describes a readable value — and
it requires a `String` column, since a digest is text.

**`@secret @hashed` is the credential a server verifies**, a device token for one:

```lite
database audit { path "./audit/"  driver trail }

model Device {
  id    Int    @id
  token String @secret @hashed
}
```

The digest replaces the `@encrypted` half, so the column is matchable in a `where`
and never readable, `asSystem()` included. `@guarded` (only the system issues one)
and the audit trail stay, and `$rotateKey` skips it unless it is orphaned by name,
the way it skips `@secret(rotate: false)` — a digest cannot be re-keyed.
`@secret(deterministic: true)` beside `@hashed` is refused: there is no ciphertext
to derive an IV for.

## Which equality survives

Both matchable modes answer the same set, and refuse the rest **by name** rather than
comparing plaintext against stored bytes and returning something plausible:

```lite
model User {
  id         Int     @id
  email      String? @encrypted(deterministic: true)
  loginToken String? @hashed
}
```

```js
const sys = db.asSystem()
await sys.user.create({ data: { id: 1, email: 'a@example.com', loginToken: 'tok' } })

// Works on @encrypted(deterministic: true) and @hashed alike
await sys.user.findMany({ where: { email: 'a@example.com' } })
await sys.user.findMany({ where: { email: { equals: 'a@example.com' } } })
await sys.user.findMany({ where: { email: { in: ['a@example.com', 'b@example.com'] } } })
await sys.user.findMany({ where: { email: ['a@example.com', 'b@example.com'] } })
await sys.user.findMany({ where: { loginToken: { not: 'x' } } })
await sys.user.findMany({ where: { loginToken: { notIn: ['x'] } } })

// Refused, naming the field and the reason
try {
  await sys.user.findMany({ where: { email: { contains: 'a' } } })
  throw new Error('expected a refusal')
} catch (e) {
  if (e.name !== 'ValidationError') throw e
}
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

Composite attribute — expands at parse time to `@encrypted + @guarded + @trail(audit, reads: false)`, `audit` being the first `driver trail` database the schema declares. Every write is logged to it; a read is not, because reads are high-volume — declare `@trail(audit, reads: true)` on the field beside `@secret` to log those too. With no trail database declared the audit half is dropped with a parse warning. A client built with `untrusted: true` refuses `@secret` by name, because schema text held as data can declare no trail database (`FJS-D1101`).

```lite
database audit {
  path "./audit/"
  driver trail
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

Re-encrypts every key-reversible column — `@encrypted` in both modes, and `@secret` — with the new key, then swaps the client's key. The stats are keyed by model name:

```lite
model User {
  id  Int     @id
  ssn String? @encrypted

  @@gate(0)
}

model Order {
  id   Int     @id
  card String? @encrypted
  iban String? @encrypted(deterministic: true)

  @@gate(0)
}
```

```js
const newKey = 'b'.repeat(64)
await db.user.create({ data: { id: 1, ssn: '123-45-6789' } })

const stats = await db.$rotateKey(newKey)
// → { User: { rows: 1, fields: 1 }, Order: { rows: 0, fields: 2 } }
if (stats.User.rows !== 1 || stats.User.fields !== 1) throw new Error(`unexpected stats ${JSON.stringify(stats)}`)
```

**The key swap is global, so a column rotation cannot rewrite is left behind on the old key.** One client holds one key for writing. Two kinds cannot be carried, and `$rotateKey` refuses while either is present rather than orphaning it in silence:

| Declaration | Why it cannot be carried |
| --- | --- |
| `@hashed` | One-way. There is no plaintext anywhere to re-key, so every match becomes 0 permanently and no later fix can undo it. |
| `@secret(rotate: false)` | Declared excluded from re-encryption. The client that rotated keeps the old key on its ring and goes on reading it; the next process to start reads the column as empty unless it is given `previousEncryptionKeys: ['<the old key>']`. |

```lite
model User {
  id     Int     @id
  pw     String? @hashed
  legacy String? @secret(rotate: false)
}
```

```js
const newKey = 'b'.repeat(64)
try {
  await db.$rotateKey(newKey)
  throw new Error('expected the refusal')
} catch (e) {
  if (!/orphan/.test(e.message)) throw e
}
// Error: $rotateKey would leave 2 column(s) unreadable and has rotated nothing:
//   User.pw     — @hashed — one-way, there is no plaintext to re-key …
//   User.legacy — @secret(rotate: false) — declared excluded from re-encryption
// Pass { orphan: ['User.pw', 'User.legacy'] } to accept that deliberately.

await db.$rotateKey(newKey, { orphan: ['User.pw', 'User.legacy'] })   // proceeds
```

`orphan` is a list of names rather than a boolean so that acknowledging one column cannot silently acknowledge a second one added later.

The client that rotated keeps working — the key lives in one cell every derived client reads through, so `asSystem()`, `$setAuth()` and `$scopedBy()` all see the new key immediately.

## Multi-tenant key-per-tenant

The tenant registry accepts a function for per-tenant keys:

```js
const getKeyForTenant = async (tenantId) => 'a'.repeat(64)   // a KMS or a vault in a real app

const tenants = await createTenantRegistry({
  dir:           './tenants/',
  path:          './schema.lite',
  encryptionKey: async (tenantId) => getKeyForTenant(tenantId),
})
```

## @guarded

Not encryption, but related. **A system-context column, in both directions**:
stripped from every read, and refused on every write, unless the client is
`asSystem()`.

```lite
model User {
  id           Int     @id
  passwordHash String? @guarded   // system only, and a select cannot unlock the read
  internalNote String? @guarded
}
```

```js throws
await db.asSystem().user.create({ data: { id: 1, passwordHash: 'h' } })
const userDb = db.$setAuth({ id: 1 })
await userDb.user.update({ where: { id: 1 }, data: { passwordHash: 'x' } })
// AccessDeniedError: User: "passwordHash" is @guarded — a system-context column
// on write as well as read.
```

The write half matters because the read half hides the evidence: without it the
column is invisible and settable at once, so a caller cannot see what they are
overwriting and the owner cannot see that they did.

`@omit` is the weaker neighbor — a read-shaped rule only, and an explicit
`select` unlocks it. `@guarded` is not unlockable that way, and takes no argument.

**They stack, and they answer different questions** (`FJS-D205`): `@guarded`
says who may see the column, `@omit` says whether it is in the default payload.
`@guarded @omit(all)` is therefore *system context AND asked for by name* — the
shape a large blob or an audit payload wants, where even `asSystem()` should not
be dragging it into every read.

For a column *some* callers may write, the tool is field-level
`@allow(write, …)`; it cannot sit beside `@guarded`, which already answers
both halves.
