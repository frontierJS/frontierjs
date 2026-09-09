# Extensible columns — a field the tenant declares

Every CRM, help desk, ATS and marketing tool has the same pair: a customer of your app adds a field at three o'clock on a Tuesday, and builds an audience out of it on Wednesday. A column is a migration and a migration is a deploy, so the field cannot be a column — but a JSON blob alone says nothing, and a blob nobody has described cannot be put on a form or filtered on.

`@@extensible` is the declaration that a column's keys belong to somebody else, and a model whose rows are those declarations.

```lite
enum CustomFieldType { text number }

model CustomField {
  id           Int             @id
  model        String          @length(1, 40)
  key          String          @lower @length(1, 40) @regex("^[a-z][a-z0-9_]*$")
  label        String          @length(1, 80)
  type         CustomFieldType
  defaultValue String?
  show         Boolean         @default(true)

  @@unique([model, key])
  @@gate("5.5.5.5")
}

model Product {
  id     Int    @id
  name   String
  fields Json   @default("{}")

  @@extensible(fields, declaredBy: CustomField)
}
```

That is the whole of it. `Product` gains one column, the app writes no hook, no projector and no allocator, and `CustomField` takes derived CRUD like any model.

## Declaring is not a whitelist

An undeclared key in the blob is **accepted**. Declaring says what a form OFFERS, not what may be written — a dump is a dump, and making declaration a precondition of writing removes the only property that makes an untyped column worth having.

This is also why the column may not carry `@type`. A type is closed on write, so a key the tenant declares on Tuesday would be refused until the `.lite` changes and the app deploys, which is what `@@extensible` exists to avoid. The two are refused together, by name. Where an app wants both, they are two columns, because they answer to two different people:

```lite
model Client {
  address Json @type(Address)      // yours   — closed, typed, validated
  fields  Json @default("{}")      // theirs  — open, whatever they declared

  @@extensible(fields, declaredBy: CustomField)
}
```

## Reading the declarations

```js
const declared = await db.product.$declaredFields()
```

Scoped to this model, and a caller cannot widen it. That matters more than it looks: **one declaring table serves every extensible model**, so a plain `findMany({})` answers with another model's keys and the failure is total silence — a key declared on a product becomes an accepted term in a query over customers, matching nobody, request succeeding, count plausible. A model with no `@@extensible` refuses rather than answering an empty list.

## Making a declared key filterable — `max:`

A key in a blob cannot be indexed, so a query naming one is a scan. `max:` buys an index, and it is the half that costs:

```lite
model Customer {
  id     Int  @id
  fields Json @default("{}")

  @@extensible(fields, declaredBy: CustomField, max: { text: 8, number: 4 })
}
```

This expands to exactly what an app would write by hand — a `fieldsSlots` mirror the application fills, one `@generated` column per slot reading it, and **one composite index** over the pool:

```sql
"fieldsSlots" TEXT NOT NULL DEFAULT '{}',
"t1" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t1')) VIRTUAL,
"n1" REAL GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.n1')) VIRTUAL,
…
CREATE INDEX "idx_customer_t1_t2_n1_…" ON "customer" ("t1","t2","n1",…);
```

`max:` is keyed by the declaring model's own `type` enum, so the pool's shape is stated in the app's vocabulary rather than in slot names. A key that is not a member of that enum is refused: a pool nothing can be declared into is a cost with no reader.

### One composite, not one index per slot

Measured at 200,000 rows on a three-term query: **twelve single-column indexes, 139 ms. One composite over the pool, 2.7 ms.** SQLite picks one index and filters the rest, which is the same sentence that sinks the pivot-table designs this replaces.

### What a slot costs

A `VIRTUAL` generated column stores nothing and slows no read at any pool size. What costs is the **declared** count: SQLite parses the whole table definition per statement, roughly 0.25 µs per row per column, so ten slots is 12.6 µs an insert and two hundred is 62 µs — a 4.9× spread on write throughput.

So the cap is a write-rate decision and belongs in the seed beside its reason. **An unused slot is a tax on every write to that table, forever, paid by every tenant including the ones who declared nothing.** Forty is nearly free on a table written once at checkout; ten is generous on an event log.

### The order is a bet, and it is yours

A composite index is read left to right, so which slots sit at the front decides which queries reach it. Measured at 20,000 rows across three orderings and six field mixes, the total index columns reached was **13 for all three** — the trade is conserved. There is no ordering that is better, only orderings better for different mixes.

So the pool follows the ratio you declared: `{ text: 8, number: 4 }` is 2:1 and lays down two text per number. An app expecting mostly text says so and gets a run of text at the front.

### The thirteenth field

A key declared once the pool is full gets no slot, and that is an **answer** rather than a failure: it stores, displays and edits like any other, and only a query naming it falls back to a scan. Refusing the declaration would tell a tenant about an implementation detail they can neither see nor act on.

## The slot is chosen at the Data boundary

A declaration is an ordinary create and states no slot:

```js
await db.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text' } })
// → slot: 't1'
```

First free of the matching kind, in the composite's own order, out of the pool the **named model** declares — so a `Product` declaration gets `null` and a `Customer` one gets a column, from the same call on the same table. `slot` is `@system`, so a caller cannot send one; the column is filled the way the mirror is, in `writeData`.

Allocated by the framework rather than by the app, because the three things it takes — the pool, its order, and what is already spoken for — are all facts the schema states. An app writing the allocator has to read `max:` back out of the parsed seed and the order off the generated index, which is the same fact in a second place; and the way that goes wrong is silent, since a declaration with no slot stores, renders and edits exactly like one that has a slot. Every field then reads as *the pool is full*, every query still answers correctly, and only the plan is different.

**A slot the payload states is honored rather than recomputed.** An import restoring declarations has to be able to say which slot each one held — re-deriving them would repoint live fields onto slots whose values were written for other keys, which does not self-heal the way the mirror does. Absent means allocate, the same rule Invariant 9 states for a patch.

An `update` never re-allocates. Re-pointing a live field would leave every existing row's value in the old slot, so every query on it would match nothing — the failure the feature exists to prevent, reintroduced by an edit. Changing which slot a field uses is a delete and a re-declare, which is honest about what it costs: a rebuild.

## The declaring model is found by convention

`declaredBy:` names a model and nothing else. Four columns are looked for by name — `model`, `key`, `type`, and `slot` where `max:` is present — and whichever is missing is named at parse time. Convention rather than named arguments, because a second spelling for columns the app has already written is a second thing to keep in step; the refusal is what keeps it from being a silent guess.

`@@unique([model, key])` on the declaring model is required. Without it one model can declare a key twice, and the second declaration is a field whose value nothing can find.

## What it must not become

**Not a per-tenant schema.** The moment a tenant can declare a *model*, a relation or a `@@gate`, there are two schema languages and one of them is a database table. The extension point is one column shape on one model.

**Not a way around access.** A declared key inherits the model's rules and can state none of its own. A tenant-declared column carrying `@allow` would be an access rule written by a customer.
