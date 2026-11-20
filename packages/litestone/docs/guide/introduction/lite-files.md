# `.lite` files

A `.lite` file holds models, enums, types and functions. Its syntax is close to Prisma's, with SQLite-native additions.

Models are `PascalCase` and singular. The client accessor is the same name in `camelCase`, and the table is the `snake_case` name.

```lite
/// A signed agreement with a client.
model ServiceAgreement {
  id    Int    @id
  title String /// What the agreement covers.
  slug  String @slug(title)
}

function slug(text: String): String {
  @@expr("lower(trim(replace({text}, ' ', '-')))")
}
```

```js
const a = await db.serviceAgreement.create({ data: { title: 'Weekly Cleaning' } })
if (a.slug !== 'weekly-cleaning') throw new Error(a.slug) // table service_agreement, accessor serviceAgreement
```

## What else it can do

- `import "./models/users.lite"` splits a schema across files; open it with `parseFile()`
- `///` doc comments become JSDoc on generated types and `description` in JSON Schema
- `@@map("people")` names a table that differs from the model
- `pluralize: true` on `createClient` pluralizes table names
- `function` declares a reusable SQL expression, used as a field attribute on any model

**In depth:** [Schema § Naming conventions](../../schema.md#naming-conventions), [§ Schema functions](../../schema.md#schema-functions), [§ Multi-file schemas](../../schema.md#multi-file-schemas), [§ Doc comments](../../schema.md#doc-comments)
