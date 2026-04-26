# Schema

Schemas live in `.lite` files. Syntax is close to Prisma's SDL with SQLite-native extensions.

## Types

| Schema type | SQLite storage | JS type |
|---|---|---|
| `Integer` | `INTEGER` | `number` |
| `Real` | `REAL` | `number` |
| `Text` | `TEXT` | `string` |
| `Boolean` | `INTEGER` 0/1 | `boolean` (auto-coerced) |
| `DateTime` | `TEXT` ISO-8601 | `string` |
| `Json` | `TEXT` | `object` (auto-parsed) |
| `Blob` | `BLOB` | `Buffer` |
| `File` | `TEXT` JSON ref | bytes in S3/R2/local (FileStorage plugin) |
| `File[]` | `TEXT` JSON array | multiple files |
| `EnumName` | `TEXT` + CHECK | `string` |
| `Type[]` | `TEXT` JSON | `Array` (auto-parsed) |
| `Type?` | nullable | `null` when absent |

## Field attributes

### Identity & constraints
```
@id                              primary key (auto-increment for Integer @id)
@unique                          UNIQUE constraint
@map("column_name")              custom DB column name
```

### Default values
```
@default(now())                  current UTC timestamp
@default(uuid())                 UUID v4
@default(ulid())                 ULID
@default(cuid())                 CUID
@default(nanoid())               21-char URL-safe ID
@default(true)                   boolean / number / string literal
@default(auth().id)              stamped from ctx.auth at write time (runtime only, no SQL DEFAULT)
@default(fieldName)              copy sibling field value on create (compose with @slug)
```

### Lifecycle
```
@updatedAt                       auto-set to now() on every UPDATE
@updatedBy                       stamp ctx.auth.id on every UPDATE
@updatedBy(auth().field)         stamp custom auth field on every UPDATE
@sequence(scope: field)          per-scope auto-increment — see sequences.md
```

### Visibility & security
```
@omit                            excluded from findMany/findFirst (still in findUnique)
@omit(all)                       excluded from all reads
@guarded                         excluded unless asSystem()
@guarded(all)                    excluded from all operations unless asSystem()
@encrypted                       AES-256-GCM at rest (implies @guarded(all))
@encrypted(searchable: true)     HMAC-indexed — equality WHERE still works encrypted
@secret                          @encrypted + @guarded(all) + @log(auditDb)
@secret(rotate: false)           same but excluded from $rotateKey
```

### Field-level policy
```
@allow('read'|'write'|'all', expr)
```
See [access-control.md](./access-control.md).

### Derived & generated
```
@computed                        app-layer derived field (implement in computed.js)
@generated("sql expr")           SQL GENERATED ALWAYS AS column (STORED)
@from(relation, count: true)     derived count from relation (not stored)
@from(relation, sum: field)      derived sum/max/min/first/last/exists
@from(relation, count: true, where: "sql")  filtered
```

### File storage
```
@keepVersions                    skip S3 object cleanup on File? update
@accept("mime/type")             validate MIME before upload (wildcards + comma-list OK)
```

### Validators (run on every create + update)
```
@email                           valid email address
@url                             valid URL
@phone                           E.164 + common formats
@date                            YYYY-MM-DD date string
@datetime                        ISO-8601 datetime string
@regex("pattern")                regex validation
@length(min, max)                string length (either bound optional)
@gt(n)  @gte(n)  @lt(n)  @lte(n)
@startsWith(s)  @endsWith(s)  @contains(s)
```

### Transforms (applied before validation + write)
```
@trim    @lower    @upper    @slug
```

### Annotations
```
@markdown                        semantic — field contains Markdown (no validation)
@hardDelete                      on relation field: hard-delete children in @@softDelete(cascade)
@log(dbName)                     field-level audit log to a logger database
```

## Naming conventions

**Model names** are `PascalCase` singular:

```prisma
model User { ... }
model ServiceAgreement { ... }
model BlogPost { ... }
```

**Client accessors** are `camelCase` singular — always, regardless of config:

```js
db.user.findMany()
db.serviceAgreement.findFirst()
db.blogPost.create({ data: {...} })
```

**Table names** are `snake_case` of the model name by default:

| Model | Table | Accessor |
|---|---|---|
| `User` | `user` | `db.user` |
| `ServiceAgreement` | `service_agreement` | `db.serviceAgreement` |
| `BlogPost` | `blog_post` | `db.blogPost` |

With `pluralize: true` in `litestone.config.js`, table names are pluralized:

| Model | Table | Accessor |
|---|---|---|
| `User` | `users` | `db.user` |
| `ServiceAgreement` | `service_agreements` | `db.serviceAgreement` |
| `Category` | `categories` | `db.category` |

`@@map("custom_name")` always wins over any derivation — use it for irregular plurals or legacy table names:

```prisma
model Person {
  @@map("people")    // table: people, accessor: db.person
}
```

## Model attributes

### Database routing
```
@@db(dbName)                     assign to a named database block
@@external                       table managed outside Litestone — queryable, no DDL/migrations
```

### Table structure
```
@@index([col1, col2])            composite index (partial on soft-delete tables automatically)
@@unique([col1, col2])           composite unique constraint
@@map("table_name")              custom DB table name
@@strict                         SQLite STRICT mode (default)
@@noStrict                       opt out of STRICT mode
```

### Soft delete
```
@@softDelete                     requires deletedAt DateTime? field
@@softDelete(cascade)            cascade remove/restore through FK children
```
See [soft-delete.md](./soft-delete.md).

### Full-text search
```
@@fts([field1, field2])          FTS5 virtual table + sync triggers
```
See [full-text-search.md](./full-text-search.md).

### Access control
```
@@gate("R.C.U.D")                level-based access (read.create.update.delete)
@@auth                           marks model as auth subject for auth() expressions
@@allow('read'|'create'|'update'|'delete'|'all', expr)
@@allow('op', expr, "custom error message")
@@deny('read'|..., expr)
@@deny('op', expr, "custom error message")
```
See [access-control.md](./access-control.md).

### Audit logging
```
@@log(dbName)                    log all writes to a logger database
```
See [audit-logging.md](./audit-logging.md).

## Enums

```prisma
enum Plan { starter  pro  enterprise }
enum Role { admin  member  viewer }

model User {
  plan Plan @default(starter)
  role Role @default(member)
}
```

### Enum state machines

Litestone can enforce valid transitions:

```prisma
enum OrderStatus {
  pending
  paid     @from(pending)
  refunded @from(paid)
  cancelled @from(pending, paid)
}
```

Any attempt to transition outside the declared `@from` values throws `TransitionViolationError`. Use `updateMany` if you need to skip enforcement (power tool — caller takes responsibility).

## Schema functions

Reusable named SQL expressions — define once, reference on any model:

```prisma
function slug(text: Text): Text {
  @@expr("lower(trim(replace({text}, ' ', '-')))")
}

function fullName(first: Text, last: Text): Text {
  @@expr("COALESCE({first}, '') || ' ' || COALESCE({last}, '')")
}

model User {
  firstName   Text?
  lastName    Text?
  displayName Text  @fullName(firstName, lastName)  // → STORED generated column
}

model Post {
  title Text
  slug  Text  @slug(title)   // same function, different model
}
```

Generated columns are `STORED` in SQLite and indexable.

## Multi-file schemas

```prisma
// schema.lite
import "./functions.lite"
import "./enums.lite"
import "./models/users.lite"
import "./models/posts.lite"
```

Paths resolve relative to the importing file. Circular imports are deduplicated. Use `parseFile()` when your schema uses imports so paths resolve correctly from the file's location.

## Doc comments

`///` triple-slash comments become JSDoc on generated TypeScript types and `description` in JSON Schema output:

```prisma
/// A registered user account.
model User {
  id    Integer @id
  email Text    /// The user's primary email address.
  role  Role    /// Access level — affects what the user can see and do.
}
```
