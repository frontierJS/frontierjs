---
id: content-collections
status: proposed
dated: 2026-09-03
---

# Idea — Content collections: words that are not rows

**Status: IDEA. The page half is built and is described accurately below; the
collection half does not exist.** Dated 2026-09-03. Do not cite this file as
describing behavior — see `VERIFYING.md`.

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

## Evidence from a CMS that has been running for years

Added 2026-09-08 from `conversion-maid-tech.md`. Numbers are counted in that
application's production database; the shapes are read off its source. It is one
application and it is not a survey — but it is a content system with **100 sites
and 9,355 documents**, and it answers two of the open questions below with
something better than argument.

**It is the third answer, and the conflict question does not arise.** GitHub is
the source of truth: a `Site` carries a `repoUrl`, a write goes through a `git`
service as a **commit**, and only then is the row updated. `Page.sha` is the git
blob sha and `Page.git` holds the raw API item, so a sync fetches content only
when the sha moved. Rows are never authoritative and are never written first —
which is why *which one wins on conflict* has no answer there rather than a hard
one. The row is an INDEX, and treating it as one is the whole design.

**A directory IS the collection declaration.** The document's `type` is derived
from its path — `site/content/pages/`, `.../collections/`, `.../blocks/`,
`.../menus/`, `.../settings/`, `.../media/` — plus two filename conventions:
`_module.md` is a directory's own metadata and `__template.md` is the default for
new documents in that directory. Neither convention has an equivalent in this
record, and the second is what makes a non-developer editor possible at all.

**The dominant noun is not the collection.** Counted across all 100 sites:

| type | count | what it is |
| --- | --- | --- |
| page | 3,381 | a document at a path |
| image | 3,165 | binary, stored apart |
| block | 1,802 | a reusable fragment a page composes |
| setting | 502 | a structured document — **`.json`, not markdown** |
| folder | 164 | `_module.md`, a directory's own metadata |
| menu | 80 | an ordered list of links |
| template | 67 | `__template.md`, the default for new documents here |
| collection | 46 | a named set |

**Blocks, settings, menus and templates outnumber the named collections 50 to
one.** A design that ships *a collection of posts* and nothing else covers 46 of
9,355 documents. Two of those rows are the interesting ones: a **block** is
content that is not a page and is composed into one, and a **setting** is a
content document that is not markdown at all — so *frontmatter validated against a
`type`* is the wrong shape for 502 of them and the right shape for the rest.

**Binary is a separate store, and this record says nothing about it.** Images go
to a second SQLite file as BLOBs keyed `(siteId, path)` with the row's `content`
nulled. 3,165 of 9,355 documents are that. `File` columns and `FileStorage` are
the obvious owner here, and an asset that is addressed by PATH rather than by id
is the part that does not fall out of them.

**It is multi-tenant, which this record does not consider.** `@@unique([siteId,
path])` — the path is the identity, WITHIN a site, and one deployment serves a
hundred of them. A content collection scoped by tenant is a different problem from
a content directory beside the app's source, and the difference lands on
everything: where the files are, who may edit one, and whether a build exists at
all.

**Point 1 of § *What is missing* is understated.** Frontmatter there is parsed
three ways in one file — a YAML library for the document, a hoist of `title` and
`image` into indexed columns, and a hand-written line scanner for `tags` that
stops at the first line not beginning with `-`. Three readers, one of them wrong,
and nothing compares them. That is the same shape as `@@allow`'s two halves
before they had an oracle.

**No full-text search exists over any of it**, so the fourth open question gets no
evidence either way — which is worth saying, because a system this size not having
solved it is weak evidence that it is not the first thing anyone reaches for.

---

## Open questions

- **Files or rows?** Stated above and **the third answer has now been seen
  running** (§ *Evidence from a CMS…*): files as the source, synced into a table,
  where the sync is one-directional and sha-gated so the conflict this question
  worried about cannot occur — a write is a commit first and a row second. What
  that shape costs is a round trip to a git host on every save, and a document
  that exists in the index and not in the repository if the second half fails.
  What remains open is not *which wins* but **whether the sync is at BUILD time or
  continuous**: at build time it is a loader, continuously it is a service and a
  webhook, and only the second serves an editor.
- **Is this a package or sierra's?** The routing, the compiler and the prerender
  are already sierra's and mesa's. What is new is a declaration and an index,
  which argues for sierra rather than a new name.
- **Does the non-developer audience actually get served by this?** The answer
  here was *no, that is `foundry` territory and a much larger project*, and the
  second half of that is **measured wrong**: the CMS in § *Evidence from a CMS…*
  serves 100 sites and 9,355 documents from **14 files and 2,460 lines** of editing
  UI. It is small because the index and the git service do the work and the screen
  is a list, an editor and a save. The first half stands — files in git do not
  help somebody with no checkout — but *therefore the editor is a big project* does
  not follow from it, and this record should stop claiming it does. What the editor
  actually needs from this proposal is the two conventions named above: a
  directory's own metadata, and a per-directory template for new documents.
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
