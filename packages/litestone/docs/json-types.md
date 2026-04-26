# Typed JSON columns

A `type` is a reusable shape for JSON values. Used as `Json @type(T)` on a field, the type's structure is validated on every write and the field gets a real TypeScript interface instead of `unknown`.

```
type Address {
  street     Text
  city       Text
  state      Text?
  postalCode Text
  country    Text @default("US")
}

model User {
  id      Integer @id
  name    Text
  address Json @type(Address)
}
```

```ts
// generated types
export interface Address {
  street:     string
  city:       string
  state?:     string | null
  postalCode: string
  country:    string
}

export interface User {
  id:      number
  name:    string
  address: Address     // ← not unknown
}
```

```js
// Writes are validated against the type's shape
await db.user.create({ data: {
  name: 'Alice',
  address: { street: '1 Main', city: 'Boston', postalCode: '02101', country: 'US' },
}})

// Bad writes throw ValidationError with precise paths
await db.user.create({ data: {
  name: 'Bob',
  address: { street: 's', city: 'c' },     // missing postalCode
}})
// → ValidationError: address.postalCode: is required
```

## Why typed JSON

Storing structured data inside a Json column is one of SQLite's superpowers — you keep the relational core intact while letting some columns hold arbitrary nested data. The cost is that you lose all the safety nets the schema gave you on real columns: no type checks, no required-key enforcement, no validators, no IDE autocomplete on the contents.

`Json @type(T)` puts those safety nets back. The price is one type declaration per shape; the gain is end-to-end safety on data that would otherwise be a typed-as-`any` mystery.

## Syntax

```
type <n> {
  <field declarations>
}
```

```
fieldName Json @type(TypeName)
fieldName Json @type(TypeName, strict: false)
fieldName Json? @type(TypeName)         // optional + nullable
```

## What can go inside a type

A type describes a JSON value, which means anything that doesn't make sense in JSON is rejected at parse time:

| Construct | In a type? |
|---|:---:|
| Scalar fields (`Text`, `Integer`, `Real`, `Boolean`, `DateTime`) | ✓ |
| Optional fields (`Text?`) | ✓ |
| Array fields (`Text[]`, `Integer[]`) | ✓ |
| Enum fields | ✓ |
| Nested types (`Json @type(Other)`) | ✓ |
| Validators (`@email`, `@regex`, `@length`, `@gte`, `@lt`, `@url`, `@minItems`, ...) | ✓ |
| Transforms (`@trim`, `@lower`, `@upper`) | ✓ |
| `@computed` fields | ✓ |
| Literal `@default("US")` | ✓ |
| Relations (`@relation`) | ✗ |
| `Blob`, `File` field types | ✗ |
| `@id`, `@unique`, `@map` | ✗ |
| `@encrypted`, `@guarded`, `@secret` | ✗ |
| `@default(now())`, `@default(cuid())`, `@default(auth().id)` | ✗ |
| `@updatedAt`, `@from`, `@generated` | ✗ |
| Field-level `@allow` / `@deny` | ✗ |
| Model-level attributes (`@@anything`) | ✗ |

The reasoning is consistent: anything that needs a SQL column to work (encryption, FK, server-side defaults, policy gates) doesn't apply to a JSON sub-key. The error message tells you exactly why.

## Strict mode

By default, types are **strict** — extra keys in the JSON value cause validation to fail.

```js
await db.user.create({ data: {
  address: { street: 's', city: 'c', bogus: 'x' }      // ← rejects
}})
// → ValidationError: address.bogus: unknown field — type Address has no 'bogus'
```

This catches typos at write time and prevents schema drift inside JSON. If you need to accept evolving shapes (e.g. consuming events from an external service that may add new keys), opt out per field:

```
model User {
  address Json @type(Address, strict: false)
}
```

In loose mode, extra keys are silently kept on write and returned on read. The declared keys are still validated.

## Validators inside types

Validators work the same inside a type as they do on columns:

```
type Contact {
  email Text @email
  phone Text? @regex("^\\+[0-9]+$")
  age   Integer @gte(0) @lt(150)
}

model User {
  id      Integer @id
  contact Json @type(Contact)
}
```

```js
await db.user.create({ data: { contact: { email: 'not-email', age: 30 } } })
// → ValidationError: contact.email: must be a valid email address
```

Errors include the full path into the JSON value, so a validator on `Contact.email` reports as `contact.email`, not just `email`.

## Filtering inside JSON

Where queries can drill into typed JSON values using the same shape syntax as the type itself. Litestone compiles the traversal to SQLite `json_extract()` calls — no need to drop into raw SQL:

```js
// Equality on a sub-key
await db.user.findMany({ where: { address: { city: 'NYC' } } })
// → SELECT * FROM "user" WHERE json_extract("address", '$.city') = ?

// Multiple sub-keys (implicit AND)
await db.user.findMany({ where: { address: { city: 'NYC', state: 'NY' } } })
// → WHERE json_extract("address", '$.city') = ? AND json_extract("address", '$.state') = ?

// Comparison operators on numeric sub-keys
await db.place.findMany({ where: { coords: { lat: { gte: 40, lt: 50 } } } })
// → WHERE json_extract("coords", '$.lat') >= ? AND json_extract("coords", '$.lat') < ?

// LIKE-style text search
await db.user.findMany({ where: { address: { city: { contains: 'York' } } } })
// → WHERE CAST(json_extract("address", '$.city') AS TEXT) LIKE ?

// IN / notIn
await db.user.findMany({ where: { address: { state: { in: ['NY', 'CA'] } } } })

// Null check
await db.user.findMany({ where: { address: { state: null } } })
// → WHERE json_extract("address", '$.state') IS NULL

// Composes inside AND / OR / NOT
await db.user.findMany({
  where: {
    OR: [
      { address: { city: 'Boston' } },
      { name: 'Alice' },
    ]
  }
})
```

**Nested types are traversed with dotted JSON paths.** A `Json @type(Address)` containing `coords Json @type(Coordinates)` lets you filter all the way down:

```js
await db.place.findMany({
  where: { address: { coords: { lat: { gte: 42 } } } }
})
// → WHERE json_extract("address", '$.coords.lat') >= ?
```

**Unknown sub-keys are caught at query-build time** with a precise error pointing at the bad path:

```js
await db.user.findMany({ where: { address: { bogus: 'x' } } })
// → Error: Unknown field 'bogus' on type Address in WHERE clause
```

This is the same type info that drives validation on writes — type drift between client and database is impossible.

### Performance characteristics

`json_extract` parses the JSON column for each row evaluated. On a 1000-row scan, typed-JSON filters are roughly 1.5x slower than the same filter on a plain text column. For most applications this is invisible. For very hot queries on large tables, two paths help:

1. **Promote frequently-filtered keys to real columns.** If you're filtering on `address.city` constantly, model `city` as a top-level Text column and keep the rest of the address inside the typed JSON. The query becomes a column scan; the JSON column carries the rest.

2. **Use an expression index.** SQLite supports `CREATE INDEX idx_user_city ON user (json_extract(addr, '$.city'))` — Litestone doesn't currently emit these from the schema, but you can create them manually in a migration. The query planner will pick them up automatically.

### What's NOT supported

- **`has`, `hasEvery`, `hasSome`, `isEmpty`** — these operators are for plain JSON array columns (e.g. `tags Text[]`), not for typed JSON sub-keys. Inside a typed JSON path, use array-shape filtering at the leaf level if needed.
- **Filtering on array elements inside typed JSON.** A `type Tags { values Text[] }` field's `values` array can be matched as a whole or with `in`, but you can't currently express "any element matches X" inside a typed JSON path. If you need that, use a regular `Text[]` column.

## Nested types

Types can reference other types:

```
type Coordinates { lat Real; lng Real }

type Address {
  street Text
  city   Text
  coords Json @type(Coordinates)
}

model Place {
  id      Integer @id
  address Json @type(Address)
}
```

Validation walks recursively. An invalid `lat` reports at `address.coords.lat`. Cycles (`A` references `B` references `A`) are detected at parse time and rejected.

## Nullable typed JSON

Mark the field optional with `Json?` to allow null at the column level:

```
model User {
  id      Integer @id
  address Json? @type(Address)     // can be null
}
```

When the value is null, the type validation is skipped entirely. When it's present, the full shape is enforced.

## TypeScript output

Every `type` declaration becomes a top-level exported interface in the generated `.d.ts`:

```ts
export interface Address {
  street:     string
  city:       string
  state?:     string | null
  postalCode: string
  country:    string
}

export interface User {
  id:      number
  address: Address
}
```

Application code can import and use these interfaces directly:

```ts
import type { Address } from './generated/litestone.d.ts'

function formatAddress(addr: Address): string {
  return `${addr.street}, ${addr.city}${addr.state ? ', ' + addr.state : ''}`
}
```

## Migrations

Typed JSON doesn't change the column itself — `Json @type(T)` and plain `Json` both store as a SQLite `TEXT` column with the JSON contents serialized. So:

- Adding `@type(T)` to an existing Json field doesn't change the schema. Existing data is left in place; future writes are validated against the new type.
- Removing `@type(T)` doesn't change the schema either; future writes are no longer validated.
- **Changing the type's shape can leave existing rows non-compliant.** This is a JSON migration concern, not a SQL migration concern.

The shape-change scenario:

- **Add a required field** → existing rows are missing the key → reads succeed but rewriting an existing row may fail validation
- **Add an optional field** → no impact
- **Remove a field** → existing rows have an extra key → strict mode reads fail; loose mode keeps the value
- **Tighten a validator** (e.g. add `@email`) → existing rows may not validate → same as above

For now, Litestone doesn't validate on read — only on write. Existing rows that no longer match the type are returned as-is. If you need to find or fix non-compliant rows after a shape change, you'll have to walk the rows yourself.

A future `litestone validate` CLI command may help with this; not yet built.

## When to use `Json @type` vs a separate model

Use `Json @type(T)` when:

- The shape is owned by the parent row — an address belongs to one user
- You won't query the contents independently — "all users in Boston" is fine; "all addresses in Boston regardless of user" is not
- The shape is mostly read whole — you typically need the full address, not just the city

Use a separate model + relation when:

- The shape has its own identity — a `Tag` exists independently of the things tagged with it
- You'll filter by sub-fields frequently — full-text searching across all addresses
- Multiple parents may share the same instance — three users at the same office address

The first case wants `Json @type(Address)` — co-located, validated, typed, no JOIN. The second case wants `model Address { ... }` with a relation.

## Comparison to other tools

**Drizzle** has `$type<{ city: string; ... }>()` for TypeScript-only typing on JSON columns. No runtime validation. Type drift between code and database is silent.

**Prisma** has typed JSON via `prisma-json-types-generator` (community plugin) — TypeScript types only, no runtime validation. Same drift risk.

**ZenStack** has typed JSON via `Zod` integration in v2 — runtime validation supported, but requires a separate Zod plugin and feels bolted-on.

Litestone's approach: one declaration in the `.lite` schema, both runtime validation and TypeScript types generated from the same source. No drift, no separate validation library to wire up.

## See also

- [traits.md](./traits.md) — reusable model fragments (related but different concept)
- [schema.md](./schema.md) — full schema language reference
