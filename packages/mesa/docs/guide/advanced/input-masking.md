# Input masking

You need this page for an input that must keep a fixed format as the user types:
a date, a phone number, a card number, a code.

```mesa
<script>
  let birthday = ''
  let phone = '5551234567'
  let card = ''
  let cardType = 'visa'

  const cardPattern = cardType === 'amex' ? '9999 999999 99999' : '9999 9999 9999 9999'
</script>

<input bind:value|mask({"99/99/9999"})={birthday} placeholder="mm/dd/yyyy">
<input bind:value|mask({"(999) 999-9999"})={phone}>
<input bind:value|mask({cardPattern})={card}>
```

The `|mask` modifier formats the field as the user types and writes the
formatted value back through the binding. `birthday` holds `'04/12/1990'`, not
`'04121990'`.

## The pattern

| Character | Accepts |
|---|---|
| `9` | A digit |
| `a` | A letter |
| `*` | A letter or a digit |
| anything else | A literal, inserted for you as the user reaches it |

The user types `04121990` and sees `04/12/1990`. They never type the slashes.
A character that does not fit the next slot, such as a letter in a `9`, is
dropped.

## The argument is required, and in braces

The pattern is wrapped in `{ }`. Pass a string literal for a fixed pattern, or an
expression for a pattern that depends on state. A bare `|mask` with no argument
is a compile error that shows the form.

```js
bind:value|mask({"99/99/9999"})={birthday}    // fixed
bind:value|mask({cardPattern})={card}         // from state
```

When the expression reads reactive state, a change to the pattern re-applies it
to the text that is already in the field. The target of the binding must still be
a `let`, like any `bind:`.

## What bites

- **The signal holds the formatted text.** If the server wants digits only,
  strip the separators when you submit: `phone.replace(/\D/g, '')`.
- **The starting value is formatted on mount**, so `let phone = '5551234567'`
  shows as `(555) 123-4567`.
- **It is a character filter, not validation.** `99/99/9999` accepts `99/99/9999`.
  Check that it is a real date yourself.

---

Spec: [VISION.md § 10.1](../../VISION.md#101-two-way-binding--bindvalue) · RULE 41
