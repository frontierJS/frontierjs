---
id: slug-sourcing
status: proposed
dated: 2026-09-29
---

# Idea — `@slug` sourced from a sibling, with collisions

**Status: PROPOSED, unargued.** Moved from `packages/litestone/docs/roadmap.md`
when that file was retired. `@slug` SHIPS and slugifies the column's own value on
write; the parenthesized form calls a `function slug` the schema declares
(`packages/litestone/docs/reference.snapshot.md#slug-field`). Nothing below is
behavior.

```lite
model Post {
  title String
  slug  String @slug(source: title)   // unbuilt
}
```

What is unbuilt is everything AROUND the transform:

- **sourcing from a sibling column**, rather than slugifying this column's own value
- **collision handling** — appending a suffix (`my-post-2`, `my-post-3`), which
  needs a read inside the write and therefore a rule about what it collides against
  (the table? the tenant? the `@@unique` the column sits in?)
- **re-slugging when the source changes**, which is a decision about URLs that
  already exist and not a default anyone can pick for an app

## Open questions

- ~~**Is `source:` an argument to `@slug`, or is a sourced slug `@generated` plus the transform — one sentence the language already has?**~~ **Answered 2026-10-09 (`FJS-D788`): A — Neither: sourcing already ships twice. `slug String @default(title) @slug` stamps the slug once on create and leaves it alone when `title` changes; `slug String @slug(title)` is a STORED generated column that re-slugs on every change. The choice of spelling is the re-slug decision.**
  - **A** — Neither: sourcing already ships twice. `slug String @default(title) @slug` stamps the slug once on create and leaves it alone when `title` changes; `slug String @slug(title)` is a STORED generated column that re-slugs on every change. The choice of spelling is the re-slug decision.
  - **B** — Add `@slug(source: title)` as a write-time stamp, a third spelling that carries the collision suffix and a re-slug option.
  - **C** — Retire the stamp form and make every sourced slug `@generated` plus the transform, so the slug always follows its source.
  - **Recommend A** — A is what ships: a probe of `@default(title) @slug` and `@slug(title)` in `packages/litestone` shows the first keeps `hello-world` after a retitle and the second becomes `other-thing`. B adds a third spelling of a sentence the language already says. C cannot carry collisions, because a generated column cannot read other rows. The paper's open work is collision handling on the stamp form, not sourcing.
- ~~**Does the collision scope come from the column's `@@unique`, so nothing new is declared?**~~ **Answered 2026-10-09 (`FJS-D789`): A — Yes: the suffix probe reads against exactly the columns of the unique the slug sits in. A bare `@unique` means the table, and `@@unique([tenantId, slug])` means per tenant.**
  - **A** — Yes: the suffix probe reads against exactly the columns of the unique the slug sits in. A bare `@unique` means the table, and `@@unique([tenantId, slug])` means per tenant.
  - **B** — An explicit scope argument, `@slug(scopeBy: [tenantId])`, declared beside the unique.
  - **C** — No suffixing: a collision stays the refusal that ships (`Post: slug "hello-world" is already taken.`), and the app picks the next value.
  - **Recommend A** — The scope is derivable, and the parser already refuses a scoped model's `@unique` that does not carry the tenant column, so tenancy is in the unique before the slug looks at it. B restates the unique and can disagree with it. The probe must count soft-deleted rows, since the unique index does.
