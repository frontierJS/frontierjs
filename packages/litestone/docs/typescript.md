# TypeScript

Litestone is written in JavaScript but ships full TypeScript support via generated declarations.

## Generate types

```bash
litestone types                        # writes <schema>.d.ts beside the schema — db/schema.d.ts
litestone types ./db/types.d.ts        # custom output path
litestone types --only=User,Post       # just these models — the MODEL name; an unknown one is refused
```

Or programmatically:

```js
import { generateTypeScript } from '@frontierjs/litestone'

const dts = generateTypeScript(db.$schema)
writeFileSync('./db/types.d.ts', dts)
```

## What gets generated

For every model, named for the model — `User`, never `Users`:

```ts
// Full row type — the model name itself
export interface User {
  id:         number
  email:      string
  role:       Role
  createdAt:  string
  deletedAt?: string | null
}

// Create type — a field with an @id, a @default or a ? is optional; a
// @default(now()) stamp like createdAt is absent
export interface UserCreate {
  id?:    number
  email:  string
  role?:  Role
}

// Update type — every writable field optional
export interface UserUpdate {
  id?:    number
  email?: string
  role?:  Role
}

// Where type — extends WhereBase (adds $raw); a bare value is equality
export interface UserWhere extends WhereBase {
  id?:        number | WhereOp<number> | null
  email?:     string | WhereOp<string> | null
  role?:      Role   | WhereOp<Role>   | null
  createdAt?: string | WhereOp<string> | null
  deletedAt?: string | WhereOp<string> | null
  AND?:       UserWhere[]
  OR?:        UserWhere[]
  NOT?:       UserWhere
}

// OrderBy type — one key, or a list of them
export type UserOrderBy =
  | { [K in keyof User]?: OrderDir }
  | Array<{ [K in keyof User]?: OrderDir }>
```

The accessor on the client type is camelCase: `readonly user: TableClient<User, UserCreate, UserUpdate, UserWhere>`.

## Static declarations

`src/index.d.ts` ships with the package and covers the entire public API — `createClient`, all method signatures, `WindowSpec`, `RawClause`, `WhereBase`, `Factory`, `Seeder`, etc.

## WhereBase — $raw in all Where types

All generated `Where` types extend `WhereBase`:

```ts
export interface WhereBase {
  $raw?: RawClause
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
  id    Int @id
  /// Display name shown in the UI.
  name  String
}
```

Generated:

```ts
/**
 * User account — represents a single company or individual.
 */
export interface Account {
  id:   number
  /** Display name shown in the UI. */
  name: string
}
```

## No TypeScript required

Litestone itself is JavaScript ESM — no TypeScript compilation needed at runtime. The generated `.d.ts` files are IDE-only. If you don't use TypeScript, simply don't run `litestone types`.
