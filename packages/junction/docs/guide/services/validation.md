# Schema validation

`createSchema` describes a payload with the `v` builders and checks it, as a hook or by hand. A model service takes the same checks from its Litestone schema, so this is for a payload no model owns.

```ts
const CreateUser = createSchema({
  name:  v.required.string({ minLength: 2, trim: true }),
  email: v.required.email(),
  role:  v.string({ enum: ['user', 'admin'], default: 'user' }),
})

app.services.register(createService({
  name: 'users',
  async create(ctx) { return ctx.data },
  hooks: { before: { create: [CreateUser.hook()] } },
}))

const made = await app.service('users').create({ name: ' Alice ', email: 'a@example.com', extra: 1 })
if (made.name !== 'Alice' || made.role !== 'user' || 'extra' in made) throw new Error('payload was not shaped')

const { valid, errors } = CreateUser.validate({ name: 'A' })
if (valid || !errors.length) throw new Error('a short name passed')
```

## What else it can do

- `v.string()`, `number()`, `boolean()`, `email()`, `url()`, `uuid()`, `date()`, `array(items)`, `object(schema)` and `any()`, each with a `v.required.` form
- Constraints such as `minLength`, `maxLength`, `min`, `max`, `enum`, `default`, `trim`, `minItems` and `maxItems`
- `parse(data)` returns the shaped value or throws `BadRequest`
- `.partial()`, `.omit(...)` and `.pick(...)` derive a schema from another
- An unknown field is stripped; `{ passthrough: true }` lets it through
- `jsonSchemaToJunctionSchema` builds one from a JSON Schema

**In depth:** [README § Schema validation](../../../README.md#schema-validation)
