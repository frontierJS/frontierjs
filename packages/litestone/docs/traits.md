# Traits

A `trait` is a reusable model fragment — a chunk of fields and model-level attributes that get spliced into a model via `@@trait(T)`. Traits are erased at parse time; nothing in the rest of the codebase needs to know they existed.

```
trait Dates {
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([createdAt])
}

trait SoftDelete {
  deletedAt DateTime?
  @@softDelete
}

model Post {
  id    Integer @id
  title Text

  @@trait(Dates)
  @@trait(SoftDelete)
}
```

The `Post` model ends up with `createdAt`, `updatedAt`, `deletedAt` fields, the `@@index([createdAt])`, and `@@softDelete` — exactly as if you'd written them inline.

## Why traits

Most apps end up with the same field clusters on every model: timestamps, soft-delete, audit, tenant-scoping, ownership. Without traits, you copy-paste them. Adding a fourth field to your audit cluster means editing 30 model declarations. With traits, you change one place.

```
trait Audited {
  createdAt   DateTime @default(now())
  createdById Integer?
  createdBy   User?    @relation("created", fields: [createdById], references: [id])
  updatedAt   DateTime @updatedAt
  updatedById Integer?
  updatedBy   User?    @relation("updated", fields: [updatedById], references: [id])
  @@log(audit)
}

model Order   { id Integer @id; ...; @@trait(Audited) }
model Invoice { id Integer @id; ...; @@trait(Audited) }
model Payment { id Integer @id; ...; @@trait(Audited) }
```

Add a `deletedById` field to `Audited` and all three models pick it up on the next migration.

## Syntax

```
trait <Name> {
  <field declarations>
  <model-level attributes>
}
```

Inside a trait you can put almost anything you'd put in a model: scalar fields with attributes, optional fields, arrays, relations, validators, transforms, encrypted fields, computed fields, `@from` derived fields, model-level policies (`@@allow` / `@@deny`), `@@gate`, `@@softDelete`, `@@log`, `@@index`, `@@unique`, `@@strict` / `@@noStrict`, even other traits.

What you **can't** put in a trait:

- `@id` on a field — the host model owns its primary key
- `@@id([...])` — same reason
- `@@map("table")` — the host model owns its table name
- `@@db(name)` — the host model owns its database routing
- `@@fts([...])` — only one FTS index per model; the host owns it

These are caught at parse time; an attempted use produces a clear error.

## Use site — `@@trait(T)`

A model includes a trait by adding `@@trait(T)` to its model-level attributes. One per line, repeatable.

```
model Post {
  @@trait(Dates)
  @@trait(SoftDelete)
  @@trait(Authored)
}
```

The order of `@@trait` declarations matters for one specific case: model-level attributes that are list-evaluated (like `@@allow` and `@@deny`). Trait attributes are spliced in declaration order, then the host's own attributes follow last. So a host's `@@deny` always evaluates after any trait's `@@allow`.

For all other purposes, order doesn't matter.

## Conflict resolution

Three rules, in order:

**1. Host wins.** If both a trait and the host model declare a field with the same name, the host's version wins and the trait's is dropped silently. Useful for tightening defaults:

```
trait Dates {
  createdAt DateTime @default(now())
}

model Post {
  id        Integer  @id
  createdAt DateTime @default(now()) @map("created_at")  // host wins, gets a custom column name
  @@trait(Dates)
}
```

**2. Two traits → same field name → parse error.** No silent ordering-based winner.

```
trait X { foo Text }
trait Y { foo Text }

model M { id Integer @id; @@trait(X); @@trait(Y) }
//        Error: field 'foo' provided by both @@trait(X) and @@trait(Y)
```

If you really need both, override on the host:

```
model M {
  id  Integer @id
  foo Text                // host wins, both trait foos dropped
  @@trait(X)
  @@trait(Y)
}
```

**3. Model-level attributes are additive.** If `Dates` adds `@@index([createdAt])` and `Audited` adds `@@log(audit)`, the host gets both. If two traits both add `@@allow('read', X)`, the host gets both rows in its policy list — same effect as if you'd written them inline.

## Nested traits

A trait can itself include other traits:

```
trait Identifiable {
  id Integer @id     // ❌ Error — @id not allowed in a trait
}

trait Dates {
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

trait Audited {
  createdById Integer?
  createdBy   User?    @relation("created", fields: [createdById], references: [id])
  @@log(audit)
  @@trait(Dates)        // includes Dates' fields and attributes
}

model Order {
  id Integer @id
  @@trait(Audited)      // gets createdById, createdBy, createdAt, updatedAt, @@log(audit)
}
```

Cycles are detected at parse time:

```
trait A { @@trait(B) }
trait B { @@trait(A) }
//        Error: Trait cycle detected: A → B → A
```

## What gets spliced where

Inside a trait, fields and model-level attributes coexist. When the trait is spliced:

- **Fields** are added to the host model's field list, before the host's own fields. (So `createdAt` from `@@trait(Dates)` appears before the host's `id` in field-iteration order, but field-position has no semantic meaning at runtime.)
- **Model-level attributes** are added to the host's attribute list, before the host's own attributes. So host attributes "have the final say" in any list-evaluation pass (`@@allow` / `@@deny` are evaluated in order).

The `@@trait(T)` reference itself is removed from the final model — it's not exposed to the migration system, the client, or any tooling. After parsing, the model looks identical to one written without traits.

## TypeScript output

Trait-spliced fields appear directly in the model's TypeScript interface — there's no separate `Dates` interface. From a type perspective, traits are pure code reuse, not a runtime concept:

```ts
// generated types
interface Post {
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  id:        number
  title:     string
}
```

If you want a separate type for `Dates`, declare it in your application code.

## Migrations

Trait splicing is a parser-stage transformation. The migration system never sees traits — it sees a fully-resolved model with all the spliced fields. So:

- Adding a `@@trait(T)` adds the trait's fields as new columns. Standard column-add migration.
- Removing a `@@trait(T)` removes those columns. Standard column-drop migration.
- Changing a field within a trait propagates to every model using that trait — generates an `ALTER COLUMN` per host.

`migrate verify` and `litestone doctor` work normally; they see the post-splice schema.

## When to use traits vs separate models

Use a trait when the cluster of fields is **conceptually part of every model that has them** — timestamps belong to a Post, not somewhere else. Use a separate model + relation when the data has its own identity — addresses belong in their own table because addresses can exist without a Post.

A useful test: would you ever query the cluster on its own? "Find all addresses in Boston" makes sense — Address is a model. "Find all timestamps from yesterday" doesn't — Dates is a trait.

## Comparison to ZenStack `type` / `with`

ZenStack v3 has a similar feature called `type X / model M with X`. Litestone's `trait` is the same concept with two differences:

1. **Naming.** `trait` and `@@trait(T)` consistent with the cross-cutting-concern terminology familiar from Rust, Scala, Ruby (concerns), Sass (mixins). ZenStack reused the word `type` for both this case and JSON shape validation.
2. **Use site.** Litestone uses `@@trait(T)` as a model-level attribute — consistent with `@@index`, `@@allow`, etc. ZenStack uses `with` as a model-declaration-line keyword. Both work; the attribute form composes more cleanly with the rest of Litestone's schema language.

Litestone reserves the `type` keyword for typed JSON columns (`Json @type(Address)`) — a different feature, shipped separately. See [json-types.md](./json-types.md).

## See also

- [schema.md](./schema.md) — full schema language reference
- [access-control.md](./access-control.md) — `@@allow` / `@@deny` policies
- [audit-logging.md](./audit-logging.md) — `@@log` for audit trails
