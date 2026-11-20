# Coming from Prisma

A Prisma schema reads into `.lite` almost line for line, and the client keeps Prisma's verb names. `convert` does the schema half and records every construct it could not carry.

```js
import { convert } from '@frontierjs/litestone/import'

const source = `
model User {
  id    Int    @id @default(autoincrement())
  email String @unique @db.VarChar(255)
  posts Post[]
}

model Post {
  id       String  @id @default(cuid())
  price    Decimal @db.Decimal(10, 2)
  author   User    @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId Int

  @@map("posts")
}
`
const { lite, gaps } = convert({ source, format: 'prisma', label: 'schema.prisma' })

if (!lite.includes('price Int @scale(2)')) throw new Error('expected Decimal(10, 2) to become Int @scale(2)')
if (!lite.includes('@relation(fields: [authorId], references: [id], onDelete: Cascade)')) throw new Error('expected the relation unchanged')
if (gaps.map(g => g.kind).join() !== 'native-type') throw new Error('expected one lost @db.VarChar')
```

The converted schema is the same text with the money column re-spelled, and it builds as is:

```lite
model User {
  id Int @id @default(autoincrement())
  email String @unique
  posts Post[]
}

model Post {
  id String @id @default(cuid())
  price Int @scale(2)
  author User @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId Int

  @@map("posts")
}
```

```js
const u = await db.user.create({ data: { email: 'a@x.co' } })
const p = await db.post.create({ data: { price: 1250, authorId: u.id } })
if (p.price !== 1250 || typeof p.id !== 'string') throw new Error('price is whole minor units; the id is a cuid string')
```

## What else it can do

- The command is `litestone import schema.prisma --out db/schema.lite`, and `--strict` exits 1 if anything changed meaning
- Enums, `@id`, `@unique`, `@updatedAt`, `@map`, `@@map`, `@@index`, `@@unique`, `@@id` and `@relation` carry over unchanged
- `Decimal` becomes an `Int` with `@scale` in whole minor units, so `12.50` is written `1250`; with no `@db.Decimal(p, s)` the scale 2 is a flagged guess
- `@db.*` native types are dropped, `@@fulltext` becomes `@@fts`, and `Unsupported` and `@ignore` fields are skipped
- A model that declares no `@id` gets `id String @id @default(cuid())`, flagged
- Each gap is graded `changed`, `lost` or `noted`; a `changed` one is marked on its own line in the output
- The client verbs `findMany`, `findUnique`, `findFirst`, `create`, `createMany`, `update`, `updateMany`, `upsert`, `deleteMany`, `count`, `aggregate` and `groupBy` keep their names
- `include`, `select`, `_count`, nested `create` and `connect`, `increment`, `OR`/`AND`/`NOT` and `some`/`every`/`none` filters read the same
- `take` and `skip` are `limit` and `offset`, and the Prisma names are refused by name
- `delete` is a physical delete; `remove` is the soft delete on a `@@softDelete` model
- `mode: 'insensitive'` is refused, because SQLite's `LIKE` already ignores ASCII case
- `$queryRaw` is `db.sql`, or `$raw` with the `sql` tag inside a `where`
- `prisma generate`, `migrate dev`, `db push` and `studio` are `litestone types`, `migrate dev`, `db push` and `studio`
- Prisma has nowhere to say who may read or write; an imported schema stays open until the first `@@gate` or `@@allow`

**In depth:** [Importing a schema](../../import.md), [§ The output is not the whole answer](../../import.md#the-output-is-not-the-whole-answer), [§ After the import](../../import.md#after-the-import)
