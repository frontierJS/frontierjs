# Idea — Generate the form, not just its parts

**Status: IDEA, and NARROWER than it was.** Dated 2026-08-06. The half of this
that was proposed on 2026-08-05 — the form state machine, and controls resolving
their own rules and errors from the schema — **shipped the next day** and is
described in `packages/ui/CHANGES.md` and that package's README. Do not cite
this file for any of it. What is below is only what is still unbuilt: emitting
the form itself. See `VERIFYING.md`.

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

`email` arrives labelled, `required`, `type="email"`, with `@length` as
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

## What blocks it

**`FJS-D12` — i18n has to be ruled first.** A generated form generates labels.
Every string authored before that decision is a string to find again, and a
generator multiplies them. This is the reason to write the design down and not
build it yet.

Secondary: `FJS-077`/`078`/`079` should land first, or the generator's output is
worse than what people hand-write today.

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
