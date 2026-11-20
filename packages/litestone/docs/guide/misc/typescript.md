# TypeScript

`litestone types` writes a `.d.ts` from the schema: a row type, create, update, where and order-by types per model, and a typed client. Nothing is needed at runtime; the file is for the editor.

```lite
enum Role { admin member }

model User {
  id    Int    @id
  email String @unique
  role  Role   @default(member)
}
```

```js
import { generateTypeScript } from '@frontierjs/litestone'

const dts = generateTypeScript(db.$schema)
if (!dts.includes('export interface User {') || !dts.includes('export interface UserCreate {')) throw new Error('expected User and UserCreate')
if (!dts.includes("export type Role = 'admin' | 'member'")) throw new Error('expected the enum as a union')
```

From a shell it is `litestone types`, which writes `schema.d.ts` beside the schema.

## What else it can do

- `litestone types ./db/types.d.ts` picks the output path, and `--stdout` prints
- `--only=User,Post` limits the output to these models
- `--audience=system` includes the fields a client never sees, and registers the typed client so `createClient()` needs no type argument
- `--augment=junction` adds the module augmentation Junction's service types read
- A field with an `@id`, a `@default` or a `?` is optional in the create type
- `///` doc comments become JSDoc
- `WhereBase` puts `$raw` in every where type, and `sql` is typed
- A plain JavaScript app never runs any of it

**In depth:** [TypeScript § Generate types](../../typescript.md#generate-types), [§ What gets generated](../../typescript.md#what-gets-generated), [§ The typed client](../../typescript.md#the-typed-client), [§ Doc comments](../../typescript.md#doc-comments)
