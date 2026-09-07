---
id: typed-json-forms
status: proposed
dated: 2026-09-07
---

# Idea — A `Json @type(T)` column should generate a fieldset, not a textarea

**DEFERRED, 2026-09-07.** Not started, and deliberately not scheduled. The
reason is in § Why it is deferred: the declaration it depends on has no users
yet, so whoever builds this is also the first person to bind `@type` to a
column, and two design questions have to be answered before either is worth
doing. Raised as question B of `IDEAS/json-document-writes.md`, which shipped
`$merge` — the write half this would sit on top of.

Measurements below were taken on 2026-09-02 and are reproduced from that
record rather than restated from memory. See `VERIFYING.md`.

---

## The finding

A `Json @type(T)` column reaches the browser with its shape **completely
described**:

```json
"$defs": { "Settings": {
  "type": "object", "title": "Settings",
  "properties": { "theme": {"type":"string"}, "count": {"type":["integer","null"]} },
  "required": ["theme"], "additionalProperties": false
}}
```

and `controlFor` answers, measured:

```
settings   type: object   control: "json"      ← a raw document editor
loose      type: null     control: "json"      ← a raw document editor
```

**The described column and the undescribed one get the same control.** A person
edits raw JSON in a textarea for a shape the schema fully describes — no
labels, no per-field validation, no required marker, and a mistake is a
`ValidationError` on submit rather than a red box on the field that caused it.

That is the whole of it. Everything the generator would need is already emitted
and already crosses the wire; nothing reads it.

## What it would be

A `Json @type(T)` column renders as a nested fieldset over `$defs.T` — one
control per type field, resolved through the same `field-rules.js` table that
already answers for columns — and the write goes back as `{ $merge: … }` for the
keys the form holds.

`$merge` is what makes that safe rather than a rewrite: a fieldset editing one
section of a settings document hands back a partial, and a partial written as a
value would replace the document. The operator was built underneath this
(`FJS-D176`) and the grading it does — *partial where the target is guaranteed
present, create where it may be absent* — is exactly the question a partial form
submission asks.

## The two questions to answer first

Neither is a detail, and getting either wrong is a seam that outlives the
feature.

**1. Does a fieldset compose with `<Form>`'s existing generation?** `<Form>`
generates one control per column over one table, and a nested fieldset is a
control that *contains* controls, which that table has no shape for. Underneath
it, `$context.form` keys errors by field name while the Data boundary already
answers a PATH — `['typ','theme']`, measured through the real error boundary —
so something has to decide whether a nested control reads a path or a flattened
key, and that decision reaches every control the kit ships.

**2. Is a fieldset the right answer for the undescribed case?** It cannot be:
there is no shape to generate from, so `json` stays the control for a plain
`Json` column. The kit then has two controls for one column type, chosen by
whether `@type` is present. That is either exactly right — the declaration buys
you the better control, which is the framework's whole argument — or a seam
people trip on, and it should be argued before either half is built.

## Why it is deferred

**`@type(` is bound to zero fields in this repo.** Measured across every `.lite`
file: it appears in none of them. The 11 `type` declarations in `example` and
`basecamp` are all service `input:` types — `SegmentQuery`, `CheckoutDetails`,
`StockReceipt` — reached through `methods: [{ input }]` and never through a
column. Meanwhile `litestone advise` reports **24 undescribed `Json` columns on
basecamp alone**.

So this feature has no users until somebody adopts the declaration, and the
person who adopts it is the person who would build this. That is not a reason it
is wrong; it is a reason it cannot be scheduled off the strength of a
measurement, because the measurement is of a thing nobody uses yet.

**What would un-defer it**: an app in this repo binding `@type` to a real column
and then wanting to edit it on a screen. `basecamp`'s `HubConfig.settings` or
`Workspace.settings` are the obvious candidates, and adopting `@type` there is
worth doing on its own merits — `advise` already recommends it, the write is
validated, and the read-side path filters start working. The form question
becomes answerable the moment one of them has a screen.

| | |
| --- | --- |
| **Effort** | M — the generator is small; question 1 is the work |
| **Payoff** | ●●●○ if `@type` is adopted · ●○○○ if it is not |
| **Edge** | edge — it follows from the schema being the seed, which is the thesis |
| **Realms** | U (D for the declaration it depends on) |
| **Status** | proposed · **deferred** |

## See also

- `IDEAS/json-document-writes.md` — the DX matrix and the `$merge` ruling this sits on. Question B there is this record.
- `FJS-D176` (`DECISIONS.md`) — `$merge`, the write half
- `packages/litestone/docs/json-types.md` — `Json @type(T)`
- `packages/sierra/src/junction/field-rules.js` — `controlFor`, and the one table a control comes from
- `FJS-D17` — a contributed control is two registrations, which is the seam a fieldset would arrive through
