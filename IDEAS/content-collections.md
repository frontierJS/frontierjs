---
id: content-collections
status: proposed
dated: 2026-09-03
---

# Idea — Content collections: words that are not rows

**Status: IDEA. The page half is built and is described accurately below; the
collection half does not exist.** Dated 2026-09-03. Do not cite this file as
describing behaviour — see `VERIFYING.md`.

---

## The claim

Every application contains text that will never be a row: the pricing page's
paragraphs, help articles, terms, a changelog, an FAQ, the words in an email
template, a launch post. **This framework has a whole surface for publishing that
text and no model for the text itself.**

The register does not mention it. A search of `IDEAS/package-map.md`,
`IDEAS/overview.md` and `IDEAS/ecosystem-gaps.md` on 2026-09-03 returns zero hits
for `cms`, `content model`, `editorial`, `non-technical` and `non-developer`. The
thirty unbuilt packages in `package-map.md` cover charts, media, flags, bulk data,
demo data, i18n, compliance, agents, offline, observability — and nothing for
copy.

---

## What already exists, stated accurately

More than expected, and this changes the size of the proposal.

- **`.md` is a first-class route extension.** `packages/sierra/src/scanner/classify.js`
  declares `ROUTE_EXTENSIONS = new Set(['.mesa', '.md'])`.
- **There is a real markdown compiler.** `packages/mesa/src/compiler-md.js` —
  frontmatter, remark-parse, remark-gfm, remark-rehype, rehype-slug, syntax
  highlighting through `@frontierjs/toolbelt/glow`, Mesa components passing
  through the markup, and a reconstruction step that feeds the result to the
  ordinary `compile()`. It returns `ctx.frontmatter`, `ctx.layout` and
  `ctx.markdownHTML`.
- **It is wired end to end** — `mesa-vite` transforms `.md` by default,
  `auto-import-plugin` scans for PascalCase `.md`, and sierra's build handles it
  beside `.mesa`.
- **A `.md` page therefore gets everything a `.mesa` page gets**: `render: static`,
  a layout chain, `head()`, islands, `publishes:`, a row in `routes.snapshot.md`.

**No application in this repo has a single `.md` route.** The only two in the tree
are `packages/cli/cli/src/routes/hello/*.md`, which belong to fli's own
markdown-native command runtime and are a different system.

So the plumbing is built, tested by nothing, and used by nobody.

---

## What is missing is the collection, not the page

A page is one file. A collection is a **validated, queryable set**, and every one
of the five things that makes it one is absent:

1. **Frontmatter is validated by nothing.** `compiler-md.js` parses it with a
   hand-written *"YAML-ish"* reader — strings, numbers, booleans, null, inline and
   multi-line arrays — and hands back a plain object. A typo in `publishedAt` is a
   missing key at render time. Meanwhile the seed has `type T { … }`, a JSON Schema
   generator, `x-messages`, `@label`, and a validator that junction already reuses
   for a custom method's payload through `validateInput(type)`. **The validator
   exists and the content never meets it.**

2. **There is no set.** *Every post, newest first, tagged `release`, drafts
   excluded* cannot be asked. A content site is mostly that query, and the
   framework that owns `find`, `orderBy`, `$after` and a window has no way to
   point any of it at a directory.

3. **Content cannot reference a row.** A launch post about a product has no way to
   say which product. `@@external` exists for a table the app does not own; there
   is no equivalent for a document.

4. **It is invisible to search.** `@@fts` is over rows. `example`'s storefront
   search finds a word in a product description and cannot find one in a help
   article, because the article is markup inside a compiled component.

5. **There is no draft, no scheduled publish, no review.** Which is interesting,
   because that is a **state machine over a document** and this framework declares
   those — `@@transitions`, `@immutable`, `@seals`. The vocabulary is sitting
   there.

And underneath all five: **only a developer can change a word.** The copy lives in
`.mesa` markup inside a git repository behind a build. A colleague who writes
cannot fix a typo on the pricing page.

---

## Why it is shaped like this framework

The reason to build it here rather than reach for a CMS is that **a content
collection is a schema over files**, and this workspace already believes the
schema is the seed of everything else.

```
# db/schema.lite
type Post {
  title       String  @label("Title") @length(1, 120)
  publishedAt DateTime
  tags        String[]
  product     String? @values(ActiveProducts)
}
```

```
content/posts/
  the-new-pricing.md      ← frontmatter validated against `type Post`
  variants-are-live.md
```

Everything downstream is a mechanism that already exists:

| Need | Existing owner |
| --- | --- |
| validate frontmatter | `generateJsonSchema` → `createSchema`, the same pair `validateInput(type)` uses |
| a queryable set | `find` semantics over a build-time index |
| identify a document | `@@label`, `labelFieldInfo` |
| relate to a row | `@values` / a declared set, which already crosses as a name |
| draft → review → published | `@@transitions` |
| freeze a published post | `@immutable`, `@seals` |
| commit the surface | `content.snapshot.md` — the same move as `routes.snapshot.md` |
| a page per document | `getStaticPaths` + `render: static`, both shipped |
| per-locale variants | `lexicon`'s reserved per-locale prerender, which today has nothing to vary |

**The honest tension**, stated rather than hidden: the seed is meant to be the one
source of truth, and content in files is a second one. The resolution is that the
**shape** stays in the seed and only the **instances** live in files — which is
exactly the split `valueset` makes for values and `@@external` makes for tables.
If that is not accepted, the alternative is content as ordinary rows with a
markdown column, which gets a CMS for free and loses git review, pull requests,
and the ability to prerender without a database. That choice is the first open
question below and it should be settled before anything is built.

---

## The direction that is built points outward

`packages/sierra/src/postbuild/markdown-pages.js` converts rendered HTML back to
markdown, per route, *"designed for LLM consumption — clean prose, structured
headings, no noise"*, behind `markdownPages: true`.

So the framework already moves between markdown and pages — **outward, for
machines**. The inward direction, for people writing words, was never built. That
is worth noticing because it says the instinct was present and pointed at the
other audience.

---

## What would have to be built

- A **collection declaration** — where the files are, which `type` validates them,
  and what the route is. Probably `content:` in `sierra.config.js`, since it is a
  build concern.
- **Frontmatter through the real validator**, with the error reported at build
  time naming the file, the field and the rule — the same 400 a `<Form>` renders,
  in a terminal.
- A **build-time index** so a page can ask for a set, with the loader running in
  Node exactly as a `render: static` companion already does.
- **`content.snapshot.md`**, committed and gated by the `snapshots` phase, or the
  collection silently shrinks the way a route table would.
- A decision about **search** — whether an index is emitted for the client, or the
  documents are written into a table so `@@fts` covers them, which is the
  rows-not-files answer arriving through the back door.

The first three are a weekend against machinery that all exists. The fourth is the
usual snapshot pattern. The fifth is a design question.

---

## Open questions

- **Files or rows?** Stated above and genuinely open. Files buy git review and a
  database-free prerender; rows buy a CMS, a draft state, and search for free. A
  third answer — files as the source, synced into a table at build — gets both and
  owes an answer about which one wins on conflict.
- **Is this a package or sierra's?** The routing, the compiler and the prerender
  are already sierra's and mesa's. What is new is a declaration and an index,
  which argues for sierra rather than a new name.
- **Does the non-developer audience actually get served by this?** Honestly, no.
  Files in git do not help somebody who does not have a checkout. That audience
  needs an editing surface, which is `foundry` territory and a much larger
  project. This proposal serves the developer who is tired of pasting paragraphs
  into markup, and should say so rather than claim the bigger prize.
- **What does it do about `@@fts`?** The storefront search finding a product and
  not a help article is the concrete symptom, and it is the strongest argument for
  content-as-rows.

---

## See also

- `packages/mesa/src/compiler-md.js` — the compiler, built
- `packages/sierra/src/scanner/classify.js` — `.md` as a route extension
- `packages/sierra/src/postbuild/markdown-pages.js` — the outward direction
- `example/site/` — the surface with no content model
- `IDEAS/package-map.md` § `lexicon` — the reserved per-locale prerender
- `IDEAS/package-map.md` § `foundry` — where an editing surface would live
