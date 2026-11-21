# Relations

A relation has no wire form, so it is not in `fields`. `resource.relations` reads it from the schema, and a foreign key's rule says which model it points at, which is how a picker finds its options without naming a service.

```js
const rel = leads.relations.account
if (rel.type !== 'belongsTo' || rel.model !== 'Account') throw new Error('expected a belongsTo Account')
if (leads.relations.tags.type !== 'm2m') throw new Error('expected a many-to-many')
if (leads.fields.accountId.references.model !== 'Account') throw new Error('expected a reference')

const accounts = createResource('accounts', { model: rel.model })   // the picker's resource
if (typeof accounts.make !== 'function') throw new Error('expected a resource')
```

## What else it can do

- A relation carries `field`, `type`, `model`, `foreignKeys`, `references`, `optional` and `onDelete`
- `model` is the name as the `.lite` file declares it, ready for `schemaFor()` or `createResource`
- `fields.accountId.references` is `{ model, field, relation }`, so a generated form renders a picker and not a number box
- A resource built for a picker on a hosted app inherits that app's handle

**In depth:** [Sierra README § Relations](../../../README.md#relations)
