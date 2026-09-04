---
id: forms-from-the-seed
status: shipped
dated: 2026-08-15
---

# Idea — Generate the form, not just its parts

**Status: SHIPPED 2026-08-15.** Both halves are now built. The state machine and
per-control resolution shipped 2026-08-06; the field list — what this file was
written for — shipped 2026-08-15 as `<Form {resource} />` over a control table in
`sierra/src/junction/field-rules.js`. `packages/ui/CHANGES.md` and
`packages/sierra/CHANGES.md` are the record; this file is kept for the argument,
not as a description of anything unbuilt. See `VERIFYING.md`.

**What shipped against what is below.** The `only` / `except` props are as
proposed. The per-field snippet override is NOT built: children win instead —
passing any control means the caller is writing the form, and `auto` renders the
generated fields first and the children after, which covers the same case with
one fewer concept. The control table landed where this file proposed, for the
reason it proposed, plus a stronger one found while building: `@frontierjs/ui`
peers only on mesa and css, so a form component that imported Sierra to learn
what a `Float` is would invert the dependency. It asks the resource
(`resource.formFields()`, `resource.options(fk)`) instead.

**Three things the design did not anticipate.**

- **A field the table cannot place must be reported.** An array, a `Json`
  column, a name that is not a field: `controlFor` answers `control: null` with a
  reason and `<Form>` warns naming it. Filtering them out would reproduce, inside
  the generator, exactly the bug the generator exists to end — a column added to
  `.lite` that does not appear and nothing says so.
- **`@markdown` is the textarea signal**, not string length. It is a declaration
  (`contentMediaType: 'text/markdown'`); "this string looks long" would have been
  a guess, and the schema had already made the distinction.
- **A comment counted as children.** `<Form>` decides to generate when the caller
  passed none, and Mesa treated a slot holding one HTML comment as content — so a
  comment above the buttons turned the whole form off in silence. Fixed in the
  compiler (`packages/mesa/CHANGES.md` 2026-08-15).

**And two blockers named below turned out not to block.** `FJS-D12` (i18n) does
not, because the generator authors no string: a label is `@label` where the
schema declares one and the title-cased column name otherwise, which is what a
hand-written `<Input name="email" />` already resolved. Generation multiplies
call sites, not strings. `FJS-079` (no control for a `DateTime`) does not either
— a generated form emits the same text box a hand-written one gets today, so the
output is not worse than what it replaces. `FJS-078` did block and was fixed
first; `FJS-077` blocked only for `Checkbox`, which was fixed with it.

---

## What shipped, so the boundary is clear

`<Form resource={leads}>` owns the state machine, and nine controls resolve
their own label, constraints, `aria-invalid` and server message from
`$context.form`. `createResource` coerces, blank-strips and validates by
default. `toFieldErrors` is the one owner of "a thrown value → per-field
messages" and works over both transports.

So this is now true, and it is most of the value:

```svelte
<Form {leads} ondone={r => goto(`/leads/${r.id}`)}>
  <Input name="name" />
  <Input name="email" />
  <Button type="submit">Save</Button>
</Form>
```

`email` arrives labeled, `required`, `type="email"`, with `@length` as
`maxlength`, and its rejection lands under it. Nothing in that markup states
what a Lead is.

## What is still hand-written

**The list of fields, and which control each one gets.** The markup above names
`name` and `email` because a person typed them. `db/schema.lite` already knows
the model has exactly those columns, in an order, with types that imply
controls — and `createResource` already hands back `fields` and `relations`
describing all of it. Nothing consumes that to *emit* anything: `CLAUDE.md`
records the gap as "JSON Schema → UI drives `make()` only".

The receipt is `example/web/src/routes/orders/create.mesa`. It is ~150 lines,
and roughly half of them are a hand-rolled loop over `Object.entries(fields)`
deciding control-per-type, with `customerId` lifted out and given a picker
because it is a relation. Every app writes that loop. It is the same loop.

Three concrete holes feed it, each already its own row:

- **`FJS-078`** — `<Select>` does not derive options from `fields.status.enum`,
  so every enum select in the repo maps it by hand.
- **`FJS-079`** — a `DateTime` column gets no control at all. `Input` refuses
  `format: date-time` on purpose (Litestone stores a zone,
  `<input type="datetime-local">` neither accepts nor emits one, so the round
  trip shifts the time silently), and `DatePicker` is 1200 unverified lines.
- **`FJS-077`** — 35 controls still resolve nothing from the form context, so a
  generator that emitted a `Checkbox` would emit one that shows no error.

## The idea

```svelte
<Form {leads} />                       <!-- every writable column, in schema order -->
<Form {leads} only={['name','email']} />
<Form {leads} except={['internalRef']} />
```

with a per-field override that does not force you out of generation:

```svelte
<Form {leads}>
  {#snippet field(name, rule)}
    {#if name === 'plan'}<PlanPicker bind:value={record.plan} />{/if}
  {/snippet}
</Form>
```

The control table is the whole design, and it should live in **one** place that
both the generator and a hand-written form can read — `fields[name]` → control
— rather than being a `{#if}` ladder inside `Form.mesa`. `sierra`'s
`field-rules.js` is the natural home by precedent: it is a leaf module, it
already owns the rule shape, and putting the table there means a generated form
and a hand-written one cannot disagree about what a `Float` is.

A relation is the interesting row in that table: `rule.references` already
carries `{ model, field, relation }`, so "this is a picker over `Customer`" is
derivable, and `example` already derives it — by hand, at
`create.mesa:24`.

## What blocks it — **and what it turned out to be**

**`FJS-D12` — i18n has to be ruled first.** A generated form generates labels.
Every string authored before that decision is a string to find again, and a
generator multiplies them. This is the reason to write the design down and not
build it yet.

> **This did not hold, and the reason is worth keeping.** The generator authors
> no string. A label is `@label` where the schema declares one and the
> title-cased column name otherwise — the same resolution a hand-written
> `<Input name="email" />` already did through `$context.form`. What generation
> multiplies is call sites, not strings, so an i18n ruling has exactly the same
> job before and after: one fallback, in `Field`. **`FJS-D12` was then ruled the
> same day** — English only for alpha, the key derived rather than authored, the
> build deferred to V2 — and it was never a gate on this.

Secondary: `FJS-077`/`078`/`079` should land first, or the generator's output is
worse than what people hand-write today.

> `FJS-078` was real and was fixed first — an enum column had to be able to
> render itself before a generator could emit one. `FJS-077` was real for
> `Checkbox` alone, because a boolean column is the only one of the five a
> generated form emits, and it was fixed with it. `FJS-079` was not: a generated
> form emits the same text box for a `DateTime` that a hand-written one gets
> today, so the output is not worse than what it replaces — the hole stays, and
> it is the same hole it was.

## Why bother, given how much shipped

The remaining hand-written part is the part that **restates the schema**. A
field list in a component is a second source of truth for what a model has, and
it drifts the same way every duplicated list in this repo has drifted — a column
added to `.lite` simply does not appear in the form, and nothing says so. The
context layer removed the restatement of a field's *rules*; this removes the
restatement of the field *set*.

It is also the last piece of `FJS-D17` ("the UI plugin system is limited") that
has an obvious shape. A UI plugin contributing a control for a type is a
one-line entry in the table above.

> **That sentence was almost true and shipped as false**, which is what
> `FJS-D17` was ruled on 2026-08-16. The table landed where this file proposed —
> and as a `switch` inside a published package, with an `{#if}` ladder over its
> five answers inside a second one, so a one-line entry meant forking both. It
> is a registry now: `registerControl(name, resolve)` names the control,
> `registerFormControl(name, Component)` binds it, and the kit's own five are
> entries in the same table a contribution enters. The two halves are two
> packages because this module must run in plain Node and the kit may not import
> Sierra — a name is the only thing that crosses. `DECISIONS.md` § UI substrate.
> The other three surfaces a plugin might contribute to — a table cell, a detail
> row, a filter — inherit the mechanism and wait for their generators.

## Relationship to the other files

- `cascading-fields.md` — a field whose options depend on another field's value.
  Strictly harder, and it needs the control table this proposes to exist first.
- `one-mental-model.md` — the argument that the same fact should be stated once.
- `ecosystem-gaps.md` 4 — where `FJS-D12` is argued.
- `ecosystem-gaps.md` 15 — conditional fields. **A blocker on the field list this
  file wants to generate**: a form whose fields appear and disappear with another
  field's value cannot have its field set derived until something says so, and it is
  currently the one part of a generated form that stays hand-written.
- `bulk-data.md` — the import screen is the same generator's other output. Same
  inputs (writable columns, enum members, `@label`, per-field messages), same
  error protocol (`toFieldErrors`), a different shape on the page.
