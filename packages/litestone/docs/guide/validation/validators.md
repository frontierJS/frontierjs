# Validators

A validator is an attribute that says what a value may be: an email, a length, a range. It runs on every create and update, and the same rules reach the client for forms.

```lite
model Member {
  id    Int    @id
  email String @email @lower @trim
  name  String @length(2, 40, "A name is 2 to 40 characters")
  age   Int    @gte(18)
}
```

```js
const m = await db.member.create({ data: { email: '  Ann@Example.COM ', name: 'Ann', age: 30 } })
if (m.email !== 'ann@example.com') throw new Error('transforms did not run: ' + m.email)

try { await db.member.create({ data: { email: 'nope', name: 'A', age: 12 } }) } catch (e) { if (e.name !== 'ValidationError') throw e }
```

A `ValidationError` carries one entry per refused field in `errors`.

## What else it can do

- `@url`, `@phone`, `@date`, `@datetime`, `@time` and `@zone` check a format
- `@regex("pattern")` checks a pattern
- `@gt(n)`, `@gte(n)`, `@lt(n)` and `@lte(n)` bound a number
- `@startsWith(s)`, `@endsWith(s)` and `@contains(s)` check a string
- `@minItems(n)`, `@maxItems(n)` and `@uniqueItems` bound an array, or a relation's child rows
- Every validator takes a trailing message, which the client shows too
- `@trim`, `@lower`, `@upper` and `@slug` rewrite the value before it is validated and stored

**In depth:** [Schema § Validators](../../schema.md#validators-run-on-every-create--update), [§ Transforms](../../schema.md#transforms-applied-before-validation--write)
