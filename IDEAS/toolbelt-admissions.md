---
id: toolbelt-admissions
status: proposed
dated: 2026-09-07
---

# Idea — What else earns a toolbelt kit

**Status: PROPOSED. None of this is built and none of it is a defect.** It is the
residue of one measurement: `@frontierjs/toolbelt/inflect` grew a shape half
(`FJS-975`) because six hand copies of `pascal` were answering Invariant 2 with
four different splitters, and the same sweep turned up three groups that look
like the same argument and are not yet decided.

The admission test is not *is this useful*. It is toolbelt's own license
(`FJS-D26`): **pure, zero-dependency, and a fact with many possible answers that
must have one.** That license is what lets litestone and mesa import it against
Invariant 1, and CI's `hygiene` phase enforces the dependency half by failing a
non-relative import under `src/`.

## 1. `debounce` / `throttle` — dependency-free, but stateful

Four sites: sierra's presence layer, mesa's runtime, and the vscode extension's
Mesa client twice.

**The open question is purity, not usefulness.** `FJS-D111` refused `createStore`
a place here on the grounds that a store is state and purity is the whole
argument for the import license. A debounce is a factory that returns a closure
holding a timer, which is not the same thing as shared state and is not a pure
function either. Nobody has ruled which side of that line it falls on.

Against admitting them: the four sites are each tuned to what they debounce —
mesa's is inside a flush, sierra's is a socket. Four call sites with four
intervals is weak evidence of one fact. The legacy package had them, and it had
them from lodash, where **`throttle` was imported from `lodash/debounce`** and
had therefore never throttled anything.

## 2. `deepMerge` — seven sites, and possibly not one question

Sierra's build, jetty's config loader, junction's app, config and testing
modules, and two test files. Every one of them merges CONFIG, which is
suggestive, but nobody has compared them: array concatenation versus
replacement is the axis they would differ on, and it is invisible until an app
sets a list in two places.

**It is also not a name question**, so it is not a candidate for `/inflect` — it
would be its own kit, and a kit for one function that seven callers might not
agree about is the shape this test exists to refuse. Measure first.

## 3. The parsers — structurally excluded, and the exclusion is the answer

Legacy toolbelt shipped yaml, frontmatter and postcss wrappers with four
dependencies in its `package.json`. **They can never live in this toolbelt**, and
that is a build failure rather than a preference: a non-relative import under
`src/` fails `hygiene`, which is the check standing behind the import license.

If a shipped parser surface is wanted it is a separate package beside toolbelt,
with the dependency direction argued on its own terms. Nothing in the repo is
currently asking for one.

## What is deliberately NOT admitted, and who already owns it

Both were in the legacy package and both have an owner here. Adding either would
be a second origin for one translation (Invariant 4).

- **`tryParse` / `MAP_STRING_TO_PRIMITIVES`** → `@frontierjs/toolbelt/query`'s
  `parseValue`. Same rule, already the one owner for three readers (Invariant 10).
- **`statusCodeToReasonPhrase`** → junction's `core/errors.ts`, where `NotFound`
  carries `'Not Found'` and `code = 404`. A 117-line table beside it is a second
  place to look.

## One site that cannot be fixed by any of this

`packages/css/guide/search.js` has its own `slugify` and will keep it. The file
is a **classic script**, loaded by `<script src>` so the guide's suite can inline
it, so it cannot import anything at all. That is a structural exclusion of the
same kind as the parsers, and it is written here so the next sweep does not read
it as an oversight.
