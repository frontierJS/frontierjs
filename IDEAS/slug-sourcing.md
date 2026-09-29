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

- Is `source:` an argument to `@slug`, or is a sourced slug `@generated` plus the
  transform — one sentence the language already has?
- Does the collision scope come from the column's `@@unique`, so nothing new is declared?
