# Seeded from the schema

At build time Sierra reads `db/schema.lite` and registers every model before any route runs, so a resource file names a model and nothing else. `make()` returns a blank record with the schema's defaults, and `fields`, `relations` and `gate` come from the same place.

```js
const blank = leads.make({ status: 'new' })   // defaults from db/schema.lite
if (blank.status !== 'new' || blank.value !== 0) throw new Error(`unexpected defaults: ${JSON.stringify(blank)}`)
```

## What else it can do

- The schema is found at `db/schema.lite`, then `../db/schema.lite`, then `schema.lite`, relative to the Vite root
- `schema: 'path/to/x.lite'` in `sierra.config.js` points at another file, and `schema: false` turns seeding off
- A plural service name finds its model (`leads` is `Lead`, `companies` is `Company`), and `model: 'Child'` names it where the plural is irregular
- `resource.context.model` reports the model as the `.lite` file declares it
- Enums, `type` declarations and `FileRef` are registered as definitions, not resources

**In depth:** [Sierra README § Schema seeding](../../../README.md#schema-seeding), [§ Naming: service ⇄ model](../../../README.md#naming-service--model)
