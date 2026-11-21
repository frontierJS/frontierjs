# Coercion and blanks

A DOM input hands over strings and an untouched box hands over `''`. The resource turns `"42"` into `42` for a number column and `''` into `null` for a nullable one before it validates, so a form bound straight to `make()` sends what the schema meant.

```js
const sent = leads.normalize(leads.coerce({ value: '42', accountId: '1', slug: '', notes: '' }))
if (sent.value !== 42 || sent.accountId !== 1) throw new Error('expected numbers')
if (sent.slug !== null || sent.notes !== null) throw new Error('expected nulls')
```

## What else it can do

- `coerce: false` and `blankToNull: false` turn each off per resource
- Every write runs coerce, then blank to `null`, then validate, so validation judges exactly what is sent
- `''` is never coerced to a number, and a string that is not a clean number is left for `validate()` to refuse
- Only nullable fields turn `''` into `null`, so a required `String` keeps its empty string
- Only fields the record carries are touched, so a patch is never widened
- `normalize(data)` and `coerce(data)` run on demand with the flags aside

**In depth:** [Sierra README § Coercion](../../../README.md#coercion), [§ Blank → null](../../../README.md#blank--null)
