# JSON Schema

`generateJsonSchema` turns the schema into one JSON Schema document: types, formats, bounds, required keys and the rest of what a validator can say. It is what a service validates a request against and a form reads its labels from.

```lite
enum Role { admin member }

model User {
  id    Int    @id
  email String @unique @email
  role  Role   @default(member)
  age   Int?   @gte(0)
}
```

```js
import { generateJsonSchema } from '@frontierjs/litestone'

const doc = generateJsonSchema(db.$schema, { mode: 'create' })
const user = doc.$defs.User
if (user.properties.email.format !== 'email') throw new Error('expected the @email format')
if (user.required.join() !== 'email') throw new Error('only email is required on create')
if (doc.$defs.Role.enum.join() !== 'admin,member') throw new Error('expected the enum')
```

A field with a default, an `@id` the server assigns, or a `?` is not required on create.

## What else it can do

- `litestone jsonschema` writes `schema.json` beside the `.lite`; `--stdout` prints
- `mode` is `create`, `update` (a partial patch) or `full`; `--all-modes` writes all three
- `--format=flat` puts every definition at the document root instead of `$defs`
- `--include-timestamps` and `--include-deleted-at` keep those columns
- `audience`, `inlineEnums` and `title` are options of the function only
- `x-` keys carry what JSON Schema has no word for: gates, relations, transitions, versions and labels
- `x-opaque` names the rules a document cannot state, and `x-messages` the one sentence for several keys
- A committed copy can lag the `.lite`, so regenerate before citing it

**In depth:** [JSON Schema § Producing one](../../jsonschema.md#producing-one), [§ Modes](../../jsonschema.md#modes), [§ `x-` extensions](../../jsonschema.md#x--extensions), [§ Audience](../../jsonschema.md#audience), [§ Type mapping](../../jsonschema.md#type-mapping)
