---
id: polymorphic-relations
status: argued
dated: 2026-08-29
---

# Argued — polymorphic relations, refused; `@@arc`, proposed

**Status: ARGUED. The refusal is the finding.** Litestone has no polymorphic
relation and this record argues it should not grow one. What it proposes instead
is `@@arc`, which is sugar over machinery that already ships. Dated 2026-08-29.

## Two different things wear the word

The question arrives as one and is two, and conflating them is how a project buys
the expensive answer and still does not get what it wanted.

**A closed set of models you own, sharing an identity** — *a Content is a Post or
a Video*. Every participant is declared, known at design time, and yours to
change. This is solvable, and a real foreign key is available at the end of it.

**An open set, pointing at anything** — *this tag, audit row, notification or
comment is about any row in the app*. The participant set is not closed, not
known at design time, and often not yours. **No relational database gives this
referential integrity**, with or without an ORM's help, and no ORM in this
ecosystem changes that.

Litestone has three instances of the second and none of the first:
`AuditEvent.subjectType/subjectId`, `Notification.contextType/contextId`, and the
`TagAttachment` sketch in the reference catalogue. All three are two plain
columns and a naming convention, which is the honest shape.

## What a real polymorphic relation would cost

Measured against the tree on 2026-08-29 rather than estimated.

| | |
| --- | --- |
| `relationMap` threaded through | **158** call sites across 7 modules |
| `.targetModel` read as a single value | **69** |
| Modules holding the single-target assumption | `client` · `policy` · `query` · `gate` · `capability` · `reach` · `ddl` · `jsonschema` · `typegen` |

The count is the cheap half of the argument. **The expensive half is that a
relation's target is an input to the access-control compiler**, at
`policy.js:805` and `policy.js:883`:

```js
const subSql = buildFilterSql(rel.targetModel, checkOp, subParams, ctx, policyMap, schema, relationMap, visited)
```

A `check(rel, 'read')` in a policy compiles the **target's own policy** into a
correlated subquery against the target's own table. One relation, one table, one
WHERE. A polymorphic target means N compiled branches inside a `CASE` on the
discriminator, each carrying that target's `@@gate` and its `@@allow` set.

Then the question with no good answer. A caller reads `Order` at 4 and `Product`
at 5. They list the attachments on a tag. Do they see the order ones and not the
product ones? **Filtered by policy is a 200 with fewer rows** — a wrong policy is
an empty screen and not an error, which is the shape Invariant 6 is arranged
around. A polymorphic relation makes *who may read this* a per-row runtime
question in a system whose entire access story is compiled at the Data boundary
before a caller is known.

Everything downstream inherits the same unanswerable question. There is no
foreign key for `ddl.js` to emit. `typegen` has to answer a union, so sierra's
`field-rules.js` finds no control for it and `controlFor` answers `null` — a
column warned about by name and absent from every generated form. `x-gate`
cannot answer on the client, because the gate is per target and the target is per
row. And `announceDataWrites` cannot say which service announces the write.

That is not a feature with a large diff. It is a change to the meaning of the
access core, and the framework's one non-negotiable is that access is declared in
the schema and enforced at the Data boundary.

## What the neighbours do

**Prisma does not support it.** The request has been open since 2020 with no
delegate, no single-table inheritance and no discriminated relation. Prisma's own
documentation answers it with three workarounds, and one of them is the good
answer — see `@@arc` below.

**ZenStack does, and it is the strongest thing in this ecosystem.** `@@delegate`
declares a base model with a discriminator column, concrete models `extends` it,
and the runtime implements class-table inheritance: a base table plus one table
per subtype, joined on the shared id. A relation points at the base, and a read
comes back as the concrete subtype. The foreign keys are real, because they point
at the **base table** rather than at a union. This shipped in v2; v3 is a rewrite
onto Kysely that carries polymorphism forward as a headline feature — worth
checking against their current documentation rather than taking this record's
word for the version.

**It answers the first problem and not the second, which is the part worth
noticing.** Delegate requires every participant to `extends` the base. That is a
closed set by construction. Expressing *tag any row of any model* through it
would mean `Order`, `Product` and `Contact` all becoming subtypes of a `Taggable`
base — a schema-wide refactor that adds a join to every read of all three, in
exchange for a tag. The open set stays open under delegate exactly as it does
here.

## What to build instead — `@@arc`

Exclusive nullable foreign keys: several optional relations, of which exactly one
is set. Prisma's own best workaround, and **it is writable in `.lite` today with
no feature at all**:

```
model TagAttachment {
  tagId     Int
  orderId   Int?    @relation(fields: [orderId],   references: [id], onDelete: Cascade)
  productId Int?    @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@check("(orderId IS NOT NULL) + (productId IS NOT NULL) = 1")
}
```

`ddl.js:239` emits a `@@check` expression verbatim into the table's `CHECK`
clause, and SQLite spells a boolean as 0 or 1, so that expression sums to the
number of set columns and the database refuses anything but exactly one. The
constraint holds for a migration, a seed, an atomic operator and for
`asSystem()`, which drops the gate and every row policy and cannot drop a CHECK.

**The whole argument for it is that these are ordinary relations.** A real
foreign key, a real `onDelete: Cascade`, a real `include`. All 69 `.targetModel`
reads stay single-valued and the policy compiler gets one target per branch — so
each branch's authority is the authority on a relation the existing machinery
already knows how to compile. Nothing in the access core moves.

What the attribute would add over writing the CHECK by hand is a parse-time
refusal: every column named must exist, be nullable, and carry a `@relation`, and
the emitted constraint is derived rather than typed. A hand-written check is a
string nothing validates — a renamed column leaves it referring to a column that
is gone, and SQLite will say so at migration time rather than at parse.

**The cost, stated where somebody choosing it will read it: one column per
member, and it does not scale past roughly six.** That ceiling is a feature
rather than a limitation. Reaching it is the signal that the participant set is
open, and an open set is the case no relation can serve.

## What stays as it is

**The open set keeps `subjectType`/`subjectId` and keeps admitting what it cannot
do.** Two plain columns, an index on the pair, and a job to sweep attachments
whose subject is gone — because the database will not. `AuditEvent.lite` and
`Tag.lite` in the reference catalogue already say this at the place somebody
copies from.

The worst outcome available here is a declaration that *looks* like a relation
while silently not cascading, not enforcing and not compiling into a policy. Two
honest columns beat one lying attribute, and that is the reason the pair has no
sugar over it.

**What the pair CAN be told, and 2026-08-29 is when it started being told.** The
discriminator is the one column left that can carry a rule, and an `enum` is it —
a table CHECK, so `asSystem()`, a migration and a seed are all held to it, plus
the set reaching the browser so `controlFor` gives a picker. No new syntax; it
was always legal and nobody wrote it down. `docs/schema.md` § *Exclusive foreign
keys* ends with it, all three reference files are written that way, and `fli
check`'s `polymorphic-subject` asks. It buys no integrity — the id is still
unenforced and the sweep is still owed — so it changes nothing above, and it is
the difference between *this points at something* and *this points at nothing
and nobody noticed*.

**How often the genuinely-open case turns up is now measured.** ERPNext is the
only source in the corpus whose schema declares which kind each of its
polymorphic fields is: 17 closed, 61 open — and the 61 do not survive reading.
`party_type` is declared CLOSED twice (Customer, Supplier, Employee) and left
open sixteen times in the same application; `invoice_type`, `voucher_type`,
`reference_type` and `document_type` all do the same. **Openness in the data is
mostly an author not bothering rather than a domain requirement**, which cuts
two ways: `@@arc`'s coverage of real need is much better than 17-of-78 suggests
(the closed sets cluster at three members, well inside its ceiling), and a pair
should be assumed constrainable until shown otherwise. The genuine case is the
cross-cutting table — an audit trail, `Version.item`, an attachment record —
where the set grows with every model and an enum would refuse the first row a
new one writes.

## The neighbouring idea

`schema-variants.md` (4.26) is the **other** half of what gets asked for as
polymorphism, and it is much cheaper: `variant Quote of Document(type: quote)`
narrows one table's rows to a named noun with no storage change at all — Django's
proxy models, which is delegate's 80% without class-table inheritance's join. It
answers *a Document is a quote or an invoice*. It does not answer *this tag
points at anything*, and it is not trying to.

The two records share a wall and approach it from opposite sides: a variant
cannot alias a **relation**, because a foreign key names a table and not a subset
of one, which is the same fact that stops `@@arc` from scaling to an open set.

## Open

- Does `@@arc` want a discriminator column beside the FKs, so a caller can filter
  by member without testing N nulls? Derivable rather than stored, and a stored
  one is a second source of truth for something the columns already say.
- Should `include` on an arc answer `{ order, product }` with one populated, or a
  single `subject` key holding whichever was set? The second is friendlier and is
  a shape `typegen` has to express as a union — the same problem, one layer up,
  but bounded here because the member set is declared.

## See also

- `packages/litestone/references/Tag.lite` — the open-set case, with both honest
  answers argued at the file somebody copies
- `packages/litestone/references/AuditEvent.lite` — the polymorphic subject in
  production, and the spelling the catalogue prefers
- `schema-variants.md` — 4.26, the closed-set narrowing
- `packages/litestone/docs/roadmap.md` § `resolveMany()` — an unbuilt batch
  resolver for the open set. It fixes the N+1 on reading polymorphic subjects and
  fixes nothing about integrity, cascade or declaration
