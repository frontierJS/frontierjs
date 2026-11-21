# A resource

A resource is the browser's whole view of one model: `createResource('leads')` lists rows, fetches one, and saves it, and takes its field shape from `db/schema.lite` rather than restating it. A resource lives in `src/resources/Lead.mesa`, named for its model, with `createResource` in its `<script module>`.

```mesa
<script module>
  import { createResource } from '@frontierjs/sierra/resource'

  export const leads = createResource('leads', { model: 'Lead' })
</script>
```

The same resource lists a record, fetches it, and saves it through the schema's rules. A record the schema refuses is refused in the browser before a request is sent, and by the server again if one gets there anyway, with the same rule.

```js
const tags = createResource('tags')

const tag = await tags.save(tags.make({ name: 'vip' }))   // no id yet, so a create
const found = await tags.service.get(tag.id)              // one record
const page = await tags.service.find({}, { limit: 20 })   // the list envelope: data and total
if (found.name !== 'vip' || page.total !== 1) throw new Error('unexpected rows')

await tags.save({ ...found, name: 'vip+' })               // an id, so a patch of what changed

// The schema says a tag has a name. The browser refuses before sending...
try {
  await tags.save({})
  throw new Error('expected the save to be refused')
} catch (err) {
  if (err.errors?.[0]?.field !== 'name') throw err
}

// ...and the server refuses the same record when the browser's check is off.
const unchecked = createResource('tags', { validate: false })
let refused = false
try { await unchecked.save({}) } catch { refused = true }
if (!refused) throw new Error('expected the server to refuse it')
```

## What else it can do

- `createResource('children', { model: 'Child' })` names the model when the service name is an irregular plural
- `detailQuery`, `optionsQuery` and `tetheredQuery` declare what `get`, a picker and `tethered()` ask for
- `leads.tethered()` is the live list a screen shows, and `{ state: 'local' }` keeps its filters off the address bar
- `save(row, { mode: 'create' })` forces a create, and `service.patch(id, data)` sends exactly the payload it is given
- `hooks: { around, before, after, error }` wrap every call
- `<Form {resource} />` calls the same `save`, so a form gets the same rules
- A `find` answers `{ data, total }` and a `get` answers the record itself

**In depth:** [Sierra README § Junction binding](../../../README.md#junction-binding), [§ Resources](../../../README.md#resources), [§ Naming: service ⇄ model](../../../README.md#naming-service--model)
