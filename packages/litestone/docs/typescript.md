# TypeScript

Litestone is written in JavaScript but ships full TypeScript support via generated declarations.

## Generate types

```bash
litestone types                        # outputs index.d.ts
litestone types ./db/types.d.ts        # custom output path
litestone types --only=users,posts     # emit types for specific models only
```

Or programmatically:

```js
import { generateTypeScript } from '@frontierjs/litestone'

const dts = generateTypeScript(db.$schema)
writeFileSync('./db/types.d.ts', dts)
```

## What gets generated

For every model, Litestone emits:

```ts
// Where type — extends WhereBase (adds $raw field)
export interface UsersWhere extends WhereBase {
  id?:        WhereOp<number>
  email?:     WhereOp<string>
  role?:      WhereOp<Role>
  deletedAt?: WhereOp<string | null>
  AND?:       UsersWhere[]
  OR?:        UsersWhere[]
  NOT?:       UsersWhere
}

// Create type — required fields only
export interface UsersCreate {
  id?:    number    // @id with auto-increment → optional
  email:  string
  role?:  Role      // has @default → optional
}

// Update type — all fields optional
export type UsersUpdate = Partial<UsersCreate>

// OrderBy type
export interface UsersOrderBy {
  id?:        OrderDir | { dir: OrderDir; nulls?: 'first' | 'last' }
  email?:     OrderDir | { dir: OrderDir; nulls?: 'first' | 'last' }
  createdAt?: OrderDir | { dir: OrderDir; nulls?: 'first' | 'last' }
}

// Full row type
export interface UsersRow {
  id:        number
  email:     string
  role:      Role
  createdAt: string
  deletedAt: string | null
}
```

## Static declarations

`src/index.d.ts` ships with the package and covers the entire public API — `createClient`, all method signatures, `WindowSpec`, `RawClause`, `WhereBase`, `Factory`, `Seeder`, etc.

## WhereBase — $raw in all Where types

All generated `Where` types extend `WhereBase`:

```ts
export interface WhereBase {
  $raw?: RawClause | string
}
```

This means `$raw` is available in every model's `Where` type automatically.

## RawClause — typed sql tag

```ts
export interface RawClause {
  readonly _litestoneRaw: true
  readonly sql:    string
  readonly params: unknown[]
}

export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): RawClause
```

Usage:

```ts
import { sql } from '@frontierjs/litestone'

const results = await db.order.findMany({
  where: { $raw: sql`amount > ${threshold}` }
})
```

## WindowSpec — typed window functions

```ts
export interface WindowFnSpec {
  rowNumber?:   boolean
  rank?:        boolean
  denseRank?:   boolean
  lag?:         string
  lead?:        string
  sum?:         string
  avg?:         string
  // ... all window function options
  partitionBy?: string | string[]
  orderBy?:     Record<string, OrderDir | { dir: OrderDir; nulls?: 'first' | 'last' }>
  rows?:        [number | null, number | null]
  filter?:      RawClause | string
}

export type WindowSpec = Record<string, WindowFnSpec>
```

## Doc comments

`///` triple-slash comments in `.lite` files are emitted as JSDoc in the generated TypeScript:

```prisma
/// User account — represents a single company or individual.
model Account {
  id    Integer @id
  /// Display name shown in the UI.
  name  Text
}
```

Generated:

```ts
/**
 * User account — represents a single company or individual.
 */
export interface AccountsRow {
  id:   number
  /** Display name shown in the UI. */
  name: string
}
```

## No TypeScript required

Litestone itself is JavaScript ESM — no TypeScript compilation needed at runtime. The generated `.d.ts` files are IDE-only. If you don't use TypeScript, simply don't run `litestone types`.
