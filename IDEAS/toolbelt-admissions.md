---
id: toolbelt-admissions
status: partial
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

## 4. `frontmatter` — two parsers that disagree, and §3 does not settle it

**Built 2026-10-05 as [`@frontierjs/toolbelt/frontmatter`](../packages/toolbelt/README.md#frontmatter--what-a----block-means)** on `FJS-D549`'s subset; sierra and mesa both read it and js-yaml is gone. What follows is the argument as it stood.

**Not the same question as §3**, which refuses a yaml WRAPPER because a
dependency under `src/` fails `hygiene`. This asks whether the framework commits
to a frontmatter subset of its own, which takes no dependency and is therefore
admissible on the license — the cost lands somewhere else.

Two implementations read the same block today and **they disagree on nesting**:

- `packages/sierra/src/scanner/parse-frontmatter.js` — **js-yaml**, full YAML,
  carrying a billion-laughs mitigation because of it (`FJS-821` (f)).
- `packages/mesa/src/compiler-md.js` — hand-rolled *YAML-ish*: flat keys,
  scalars, and one level of list. **No nested maps.**

Read mesa's loop against a nested block: the parent key has no inline value and
no `- ` items, so it is set to `null`, and the indented child line is then read
as a **top-level key**. Silent on both sides — sierra's route table and the
rendered page get two different objects out of one file, and nothing reports it.

**What makes it a ruling rather than a cleanup.** The kit can only be the
hand-rolled subset, so admitting it means **sierra loses full YAML** in
frontmatter. That is the framework's usual move — commit rather than wrap — but
it is a decision with a cost, not a de-duplication. The alternative is to say
frontmatter means full YAML, in which case the one answer lives in sierra, mesa
imports nothing, and the two stay split by the dependency direction.

The options are in § Open questions.

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

## Open questions

- ~~**What does a frontmatter block mean here?**~~ **Answered 2026-09-28 (`FJS-D533`): A — a toolbelt kit holding a declared subset; sierra drops js-yaml and both callers agree by construction.** § 4 is the measurement: two parsers,
  and a nested map silently becomes a null plus a stray top-level key on one side.
  - **A** — a toolbelt kit holding a declared subset; sierra drops js-yaml and both callers agree by construction.
  - **B** — full YAML is the meaning; the parser stays sierra's, and mesa's hand-rolled reader is the defect to close rather than the shape to standardize.
  - **Recommend A** — a frontmatter block is configuration written by hand into a route file, and anchors, aliases and merge keys are the part of YAML that produced `FJS-821` in the first place, so dropping them removes the mitigation along with the feature. **B is the honest answer if an app is found relying on nesting**, which nothing in this repo does — every `.md` and `.mesa` frontmatter here is flat.
- ~~**FJS-D549 — Does FJS-D533 stand now that an app relies on nesting?**~~ **Answered 2026-10-05 (`FJS-D549`): C — a declared subset that includes nesting: block maps and sequences at any depth, `|` and `>` scalars, and flow collections, with anchors, aliases, merge keys and tags refused by name. It's one toolbelt kit with no dependency, as A intended, and it holds everything ksite writes. - **Recommend C.** D533's reason was the part of YAML that caused `FJS-821`, and C still refuses that part. The nesting D533 gave up is something a real client site depends on. A leaves ksite's content split across two formats, which is a cost every client site cut from the template would pay.** The
  ksite stressor (Phase 3, 2026-09-28) is the app the recommendation above was
  waiting for, and it lives outside this repo. Its content writes a list of maps
  in every menu (`items: - name: … link: …`), a list of maps two deep for the
  services table, a `|` block scalar for a page hero's copy, and lists at
  column 0. Mesa's reader turns each into a stray top-level key, a `null`, or
  the string `"|"`, without an error (`FJS-1541`). Sierra's js-yaml reads them
  right, so the route's `page.meta` and the `.md` module's `frontmatter`
  disagree about one file. None of these files uses an anchor, an alias or a
  merge key.
  - **A** — D533 stands. The kit is the flat subset, it refuses what it does not read, and a site keeps nested content in a JS module. ksite's port already does this for five files, so `content/` stops being all Markdown.
  - **B** — full YAML (D533's option B). The parser stays sierra's, mesa reads what sierra reads, and the `FJS-821` mitigation stays with js-yaml.
  - **C** — a declared subset that includes nesting: block maps and sequences at any depth, `|` and `>` scalars, and flow collections, with anchors, aliases, merge keys and tags refused by name. It's one toolbelt kit with no dependency, as A intended, and it holds everything ksite writes.
  - **Recommend C.** D533's reason was the part of YAML that caused `FJS-821`, and C still refuses that part. The nesting D533 gave up is something a real client site depends on. A leaves ksite's content split across two formats, which is a cost every client site cut from the template would pay.
