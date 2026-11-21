# Field rules

`resource.fields` is the model's schema flattened into one rule per field, enough to render a `<select>`, mark a required label or set an input's `maxlength` without restating the `.lite` file. `resource.validate(record)` checks a record against those rules.

```js
if (JSON.stringify(leads.fields.plan.enum) !== '["starter","pro","enterprise"]') throw new Error('expected the enum')
if (leads.fields.name.maxLength !== 200) throw new Error('expected a max length')

const problems = leads.validate(leads.make({ name: 'Ada' }))
const fields = problems.map(p => p.field).sort().join()
if (fields !== 'accountId,email,plan') throw new Error(`unexpected problems: ${fields}`)
```

## What else it can do

- A rule carries `type`, `required`, `nullable`, `enum`, `format`, `minLength` and `maxLength`
- `validate(record, 'patch')` skips fields the record does not carry
- Every `create` and `patch` is checked first and throws `ResourceValidationError`, whose `errors` is the `validate()` array
- `validate: false` turns the browser check off, and the server judges the record either way
- `before` hooks run first, so a hook that completes the record is what gets checked
- A bulk create is checked element-wise, and each error carries its row `index`

**In depth:** [Sierra README § Field rules](../../../README.md#field-rules)
