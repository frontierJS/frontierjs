---
id: schema-variants
status: idea
dated: 2026-08-28
---

# Idea — A named variant of a discriminated model

**Status: IDEA. Nothing here is built.** No `alias` or `variant` declaration
exists in the `.lite` grammar; `view` is read-only SQL and `valueset` narrows a
column's legal values, and neither is this. Dated 2026-08-28.

## The shape

One table holds several nouns, told apart by an enum column, and every layer
above has to remember the filter:

```lite
enum DocumentType { estimate quote invoice }

model Document {
  id     Int          @id
  type   DocumentType
  status String?
  …
}
```

A variant declares one of those nouns as a thing in its own right — same table,
same columns, its own name, its own rules:

```lite
variant Quote of Document(type: quote) {
  // additional computed fields
  // its own @@gate, @@transitions, @@check, @@unique
}
```

It reaches `db.quote`, a Junction service `quotes`, a `$def` named `Quote` in the
JSON Schema, and `createResource('quotes')` in a browser — the same three
resolvers every model name already crosses (Invariant 2). The discriminator must
be an **enum**, because a closed set is what makes the rest of this checkable.

## Why the language is already leaning this way

This is not a new kind of thing. `valueset` declares a narrowing over a source
model and **mints a `@@scope` named after itself** so the narrowing can cross the
wire as a name rather than as SQL (`FJS-430`). `view` declares a projection with
its columns written down so everything downstream of the seed can see them. A
variant is the same move one level up: a **writable** narrowing that mints an
accessor.

It is also the shape four models in a real app already have and cannot say.
Reviewed 2026-08-28: `Document[estimate|quote|invoice]`,
`Offer[service|product]`, `Client[client|lead]`, `Message[email|call|text]`.

**And Litestone has already built it twice, one column at a time.**
`@@hasTemplates` is, verbatim from the reference: *"Some rows are templates
rather than records, flagged on a boolean column. Reads exclude them unless
`withTemplates` is asked for; `onlyTemplates` on a model without this is refused
by name."* `@@softDelete` is the identical shape — a column partitions the table,
reads default to one side, two directives opt into the other, and the two sides
need different authority: `remove` declines `$withDeleted` **by name**, because
destroying a hidden row is not the same permission as removing a live one.

Two attributes, two directive pairs, one mechanism. That is the argument for a
general one, and it is stronger than any single use case below.

## The hard part — a variant may only WIDEN

`@@gate` and `@@allow` are enforced at the Data boundary (Invariant 6), and with
a variant there are **two doors to the same rows**. That makes the intuitive
reading unsound:

> `Document @@gate("4.4.4.5")`, `variant Invoice` wants read at 5.
> A caller at level 4 is refused `db.invoice.find()` — and served
> `db.document.find({ where: { type: 'invoice' } })`.

A **stricter** variant gate is a fiction. The other direction holds:

> `Document @@gate("5.5.5.5")`, `variant Quote` reads at 4.
> A caller at 4 gets `db.quote` and is refused `db.document`.

Sound, and not novel — it is SQL's *grant on a view without grant on the base
table*, which works for precisely this reason: the view is the only door.

So the rule is one line and it covers policies too, since `@@allow` are OR'd
within an operation and a variant's would widen the base the same way:

**A variant may only relax. The narrowing is the discriminator itself.**

Which means the base model carries the *strictest* variant's rules and each
variant relaxes from there. Backwards from intuition, checkable at parse, and a
variant gate stricter than its base should be refused by name rather than
silently not applied.

The alternative is to **seal the base** — declaring any variant leaves `Document`
with no accessor, so gates are real in both directions. Rejected for now: it
makes *every document for this client* a union, and it breaks the
`source`/`derivations` self-relation that is the reason the table was merged in
the first place.

## What it would be for, ranked

Two of these only make sense after the rule above, which is why they are here
rather than up front.

### 1. A public door onto a private table, declared rather than hand-written

When a table is gated high but some of its rows are public, the only move today
is to gate the model and then write a service method that reaches for
`asSystem()` and re-implements the filter. That bypass **drops the gate, every
row policy and `@@softDelete` at once** — it is outside the Data boundary,
re-deriving in application code what the schema was meant to own, against
Invariant 6.

```lite
model Page { … @@gate("5.5.5.5") }                 // staff only

variant PublishedPage of Page(state: published) @@gate("0.5.5.5")
```

Anonymous reads `db.publishedPage`; nobody reaches `db.page`. Nothing is
re-derived and the rule is where a reviewer looks.

**The reason to chase this one first is what it does to the static build.**
Sierra taps every read a prerendered route makes and grades it against `@@gate`,
fail-closed; the escape is a per-route `publishes: N` in frontmatter, which is a
human promise. A read of `db.publishedPage` at gate 0 is publishable *by
declaration*, which turns that escape hatch into a derivation. Conditional on the
tap grading the ACCESSOR's gate rather than the base table's — the wiring
question, not a freebie.

### 2. The two the language already special-cases

`@@softDelete` and `@@hasTemplates`, above. Reframing those as instances is the
cheapest possible test of the general mechanism: **if variants cannot express the
two Litestone already ships, they are not general enough**, and that is decidable
before any of the rest is built.

The discriminator there is a nullable `DateTime` and a `Boolean` rather than an
enum, so either the enum requirement relaxes for a two-valued column or these
stay special cases with the general form built beside them. Worth deciding early;
it moves the grammar.

### 3. The lifecycle merging currently costs outright

`@@transitions` is single-valued per model, so a merged `Document` gets one
machine for quote, estimate and invoice — which is why the reviewed app carries
**none**: a bare `status String?` with no enum, beside an `Order.status` on an
unmerged table with a full machine enforced at the boundary on both spellings.

Per-variant transitions is the difference between merging being a trade and
merging being free: `draft → sent → accepted | rejected` for a quote,
`draft → sent → paid | overdue` for an invoice.

### 4. Immutability as the default, with the mutable window named

The widening rule forces an inversion that turns out to be the better design.
*A closed-period invoice is locked* cannot be written as a stricter variant, so
it is written the other way round:

```lite
model Invoice { … @@gate("5.9.9.9") }                          // 9 = LOCKED

variant OpenInvoice of Invoice(period: open) @@gate("5.5.5.9")
```

Immutable is the base and the editable window is the exception, named. Fail-closed
by construction, and it is what an accounting period, a signed contract and a sent
quote all actually want. The constraint produces the right posture rather than
fighting it.

### 5. Keeping the merged table honest

The one nothing else in the language can express. An invoice needs a `dueDate`;
a quote does not, so merged both are nullable and no rule says which. A variant
**restating a column the base already has** — `dueDate DateTime`, without the
`?` — generates exactly what `@@check` is for, a rule reading a second column of
the same row:

```
@@check("type != 'invoice' OR dueDate IS NOT NULL")
```

Same for `@@unique`: *number unique among invoices* is a partial index
(`… WHERE type = 'invoice'`), which SQLite supports and no model-level `@@unique`
can say.

Restating is the whole of what is allowed here. The column is the base's; the
variant tightens a rule on it and adds no storage, which is the line the prior
art below turns on.

This is what stops a discriminated table drifting into sixty unconstrained
nullable columns — the failure mode that makes people avoid merging in the first
place.

### Below the line

A name and a form (`createResource('quotes')` resolving model `Quote`, the
discriminator absent from the generated form because the variant answered it —
the treatment `@system` gets today), and a Junction service per variant with its
own validator off its own `$def`. Both real, both mostly obtainable with a
service-level filter, and neither worth the grammar on its own.

## What it cannot do

**Relations do not become variants.** A foreign key points at a table, not at a
subset, so `Offer.document Document?` cannot become `Offer.quote Quote?` — which
of the three it is cannot be known statically. A variant is a read/write
projection, not a type. Say so up front or every user will expect otherwise.

**The discriminator is not writable through the variant.** `db.quote.create()`
stamps it; `db.quote.update()` may not change it, because that moves the row out
of the variant. Refused by name. Conversion is a new row through a `source`
relation, which is what a quote becoming an invoice already is.

## What the parser must refuse

Four, and each one is a rule the feature does not survive without. The
discriminator being a literal enum member is what makes all of them decidable.

| Refused | Why |
| --- | --- |
| a field the base does not already declare | a variant RESTATES a column to tighten it (`dueDate DateTime` over a base `DateTime?`) and never introduces one — it adds rules, never storage, which is the whole of the prior-art argument below |
| a discriminator that is not a literal enum member | `auth()` or `now()` in there makes it `@@scope` with worse ergonomics, and makes the generated partial index unbuildable |
| a variant gate or policy **stricter** than its base | unenforceable while the base accessor exists — the reason above |
| an enum member with no variant, once the model has any | a warning rather than an error, naming the member; those rows are reachable only at the base's strictest gate, which is fail-closed but silent |

## Cons, and what it must not become

### The prior art is decisive, and the axis is storage

This pattern has shipped widely twice, and the two results diverge on exactly one
thing.

**Django proxy models** — same table, a different default manager (so a filtered
queryset), different `Meta` including permissions and ordering. Django **refuses
to let a proxy declare a field**; it raises. Reputation: unremarkable, used
without complaint.

**Rails STI** and **Hibernate `SINGLE_TABLE`** — same table, a `type`
discriminator, and subclasses *may* add columns, which become nullable for
everyone. Reputation: the canonical regret — sprawling tables, nullable
everything, and an eventual painful split.

Same feature. The difference is whether a variant may add **storage**. That is
the line, and it belongs in the parser the way Django puts it there, not in a
paragraph asking people to be careful.

### Must not #1 — a type system

Variants look like subtypes, and every request after the first will pull that
way: a variant of a variant, polymorphic relations (`Offer.document` typed
`Quote | Invoice`), variant-only columns, `instanceof` dispatch in a service.
Each is a step toward joined-table inheritance.

> **A variant is a named subset carrying rules. It has no identity of its own,
> no storage of its own, and no subtypes of its own.**

A column wanted on one variant is a nullable column plus a `@@check`, or a second
table. Never a variant-scoped column. If that request wins once the feature is
Rails STI and the ending is already written.

### Must not #2 — a permissions mechanism

The gate-relaxation case is the most attractive thing here, which is what makes
this the likely drift: carving variants to express who-may-see-what.

A variant discriminates on **a column value describing the row**, never on the
caller. `ownerId == auth().id` is a row policy. The moment a variant's predicate
can name `auth()` there are two mechanisms for one job, which is what Invariant 4
exists to stop.

### The footguns

**The base gate is the one that matters, and it is the one people stop reading.**
With `Document @@gate("5.5.5.5")` and a public quote variant, all the attention
is on the variant; someone later relaxes the base to `4` for an unrelated reason
and every type becomes readable at 4, including the ones the variant structure
appeared to protect. Nothing errors. The mitigation is not documentation —
`litestone access --from` has to report a base relaxation as widening **every
variant, by name**, or the diff understates what happened.

**`asSystem()` and raw SQL see the whole table.** A variant is a filter and the
system client drops filters, so any rule a variant states that is not a `@@check`
is invisible to a job. True of models already, so not new — but more surprising
here, because a variant reads like a type and types are not supposed to have
holes.

**Wrong-variant addressing needs an error of its own.** `db.quote.update(id, …)`
where the row is an invoice: a 404 is the correct refusal (a variant boundary
must not confirm a row exists on the other side of it) and reads as *the row is
gone* to somebody holding the id. Wants a named class saying which variant holds
it — subject to whether the caller may be told.

**Every name → table tool has to learn to stop.** `db.quote` and service `quotes`
sit in the same namespace as real models, so Invariant 2's three resolvers now
resolve names with no table behind them. `litestone ddl` must emit none,
`ddl.snapshot.sql` must not grow phantom tables, Studio's browser must render a
filtered view. A broad surface for *works everywhere except one tool*.

**Partial indexes are textual, and there is already a scar there.** A constraint
compared by text rebuilds on every boot; variant-generated partial unique indexes
walk into it, and the migration case that has to stay green is *an unchanged
schema migrates nothing*.

**The verifier matrix multiplies.** `verifyGateLadder` walks every gated model ×
level × op and variants multiply that; `verifyRowPolicies` grades a compiled
WHERE against a JS evaluator, and with a variant there are two WHEREs composed.
More surface for the thing whose job is catching a wrong policy to be wrong
itself.

### The cost nobody feels at declaration time

Merging becomes free to *write* and stays expensive to live with. Every query
needs the discriminator in its index or it scans the other variants, and the
table accretes the union of everyone's columns. The exit is a one-way door:
splitting `Quote` out later means moving rows, rewriting every foreign key that
pointed at `Document`, and deciding what `source`/`derivations` means across two
tables.

So the risk is not that the feature works badly. It is that it makes a
**high-stakes** modelling decision feel low-stakes, at the moment there is least
information to make it with.

### The bar

Two bars, because one of them a machine can hold and the other it cannot.

**The parser's**: a variant declares no column the base does not have. Adding one
is an edit to the base model — deliberate, visible in a diff, and widening the
table for every variant at once. That is the Django line and it is the one that
separates the two outcomes in the prior art.

**The author's**, which no rule can enforce: if declaring a variant sends you to
the base to add three nullable columns nothing else uses, you wanted two tables.
The parser sees one honest edit; forty of them is the Rails STI ending arrived at
one honest edit at a time.

The test that agrees with both is whether one variant *becomes* another. A quote
becoming an invoice is one table, because the conversion is a row pointing at a
row and the columns are already shared. A Payment and a Credit are two tables,
because neither ever becomes the other and merging them means carrying each
one's columns as nulls on the other's rows — which is the failure, stated
exactly.

## Naming

`alias` is the wrong word: elsewhere it means *this also goes by these names*,
and this is a named subset with rules of its own. `variant` reads as a subtype
and does not collide with `view`. Enum members are written bare everywhere else
in `.lite` (`@@transitions(status, pay: pending -> paid)`), so
`Document(type: quote)` rather than a quoted string. `of` rather than `from`,
which reads like SQL's FROM and invites the read that this is a query.

## Open

- Whether a variant may name **several** enum members (`Document(type: [quote,
  estimate])`), which is a `IN` rather than an `=` and still a partial index.
- What `litestone access --from` and `release:check` classify a variant as —
  `new` on the access axis is easy, but a changed discriminator moves every row
  in and out at once and is neither widen nor narrow.
- Whether `@@fts`, `@@log` and `@@softDelete` stay base-only. Probably yes; all
  three are properties of the table.

## See also

- [value-sets.md](value-sets.md) — the same move on a column's values, shipped
- `packages/litestone/docs/traits.md` — `@@trait` and `extend model`, the two
  existing ways one model is described in more than one place
- `packages/litestone/docs/reference.snapshot.md` — `view`, `valueset`
