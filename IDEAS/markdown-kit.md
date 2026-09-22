---
id: markdown-kit
status: proposed
dated: 2026-09-22
---

# Idea — `@frontierjs/toolbelt/markdown`: what markdown means here, written once

**Status: PROPOSED.** Dated 2026-09-22. Every number below was measured against this
tree and a real `bun-1.4.2`; nothing is read off a release note. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The question this answers is not *which markdown library* but *where does markdown
run*. Mesa's `.md` compiler must work in three places — node under vite, bun, and a
browser — and that set is what decides the design before any other argument starts.

---

## What it costs today

`packages/mesa/src/compiler-md.js` imports `unified`, `remark-parse`, `remark-gfm`,
`remark-rehype`, `rehype-slug` and `rehype-stringify`. Those six pull **82 packages
and 8.7 MB** into this workspace's store, of 559 packages total, and nothing else in
the tree imports one of them. `mesa-bench` lists the same six because it vendors the
compiler; it is not a second consumer.

The chain is also **six of the nineteen CDN entries** that keep the REPL's drive out
of CI ([`FJS-326`](../ISSUES.md#fjs-326)). That issue's whole blocker is the
importmap, and a third of it is this.

## What it serves today

**Zero `.md` routes exist in any app in this tree.** Searched every directory holding
a `.mesa` file and every app `src/`: the one `.md` under an app is
`example/cli/src/routes/shortcut/go-time.md`, which is an `fli` command file and
never reaches mesa. The live consumers of `compileMd` are mesa's own 19 assertions
and the REPL's three examples.

That cuts both ways and both are worth saying. It removes the urgency — nothing is
waiting on this — and it removes almost all of the risk, because there is no corpus
to break and no user to migrate. **It is a do-it-before-anyone-depends-on-it item**,
which is what Wave 5 is for.

## Why the Bun native is not the door

Probed and refused in `bun-natives.md` § The nine that do not, and not restated here.
The short of it: `Bun.markdown` is 102× faster and correct on everything mesa
actually uses, and it cannot run in a browser, where mesa's compiler runs.

---

## The proposal

One kit, `@frontierjs/toolbelt/markdown`, pure, zero-dependency, `string → string`,
sitting beside `/predicate`, `/glow` and `/cron` — which is the same charter:
**a fact with many possible answers that must have one.** Toolbelt is substrate
below the dependency graph, so mesa may import it (`FJS-D26`), and so may the cli.

It runs on node, on bun and in a browser, which is the entire argument. The 8.7 MB
and the six esm.sh entries go with it.

### What it absorbs

Markdown is already written three times in this tree and nobody decided that:

| Where | Lines | What it does |
| --- | --- | --- |
| `packages/mesa/src/compiler-md.js` | 438 | frontmatter by hand, then unified |
| `packages/cli/core/prose.js` | 97 | a second markdown renderer, to the terminal |
| `packages/sierra/src/scanner/parse-frontmatter.js` | 128 | frontmatter by hand, again |

The two frontmatter parsers are the clearest case: *what a frontmatter block means*
is one fact with two implementations, and `bun-natives.md` already names it as a
toolbelt question. `prose.js` is a renderer for a different target and stays a
renderer — but it should tokenize with the kit rather than with its own regexes, the
way `/glow` is already the one tokenizer two compilers share.

### What it must not do

**It does not highlight code.** `/glow` owns *code → highlighted HTML* and
`compiler-md.js` already calls it. The kit emits the fence and its language and
stops.

---

## Prior art — measured, not surveyed

**`@stacksjs/ts-md` was cloned and graded as a base, and refused.** MIT, 1,872 lines
of which the parser is 1,154 in one file, and portable in the way that matters:
`src/parser.ts` imports nothing at all — no `Bun.`, no `node:`, no dependency — so it
runs in a browser, which is the test every other candidate fails. It already carries
two of the seams this kit needs, in almost the right shape: a
`highlight: (code, lang) => string` option, which is the `/glow` hand-off, and
`headerIds` / `headerPrefix` over its own `slugify`, which is `rehype-slug`.
(`yaml.ts` wraps `Bun.YAML` and `config.ts` needs `bunfig`; neither travels.)

It scores **147 of 652 on CommonMark 0.31.2** — 22.5%, comparing on collapsed
whitespace, so the real figure is lower. The distribution is the finding rather than
the number:

| Section | Pass | Section | Pass |
| --- | --- | --- | --- |
| HTML blocks | 0/44 | Lists | 2/26 |
| Tabs | 0/11 | Setext headings | 2/27 |
| Fenced code blocks | 2/29 | ATX headings | 3/18 |
| Indented code blocks | 1/12 | List items | 6/48 |
| Images | 1/22 | Links | 17/90 |
| Backslash escapes | 1/13 | Emphasis and strong | 57/132 |

One row is unfair to it and is left in rather than quietly dropped: ATX headings
score 3/18 largely because it emits `id=` by default, which this kit WANTS. The rest
are not that.

**Three of mesa's hard requirements fail, and they are the same failure.** Raw HTML
is escaped rather than passed through, so `<Counter count={5} />` renders as
`<p>&lt;Counter…`, `<!--MESA:0-->` renders as text, and every `<div>` in a prose file
is shown to the reader. That is the whole of what `allowDangerousHtml` buys today and
the whole of what the placeholder dance depends on. It is not reachable by
configuration: `sanitize: false` is declared in the defaults and read nowhere, and
the escape on the text token is unconditional.

Nested lists also do not work, in any shape — `- a` / `  - b` yields one `<li>` and a
paragraph reading `- b`, and the ordered and in-blockquote forms fail identically.

**Why it is small is why it is broken, and that is the transferable part.** Its block
dispatcher is seven functions — heading, code, HR, blockquote, list, table,
paragraph — with no HTML-block case and a `parseList` that does not recurse. It is
line-oriented and flat, which is exactly the parser one writes when aiming at 1,200
lines. **The two things missing are the two things a container-block parser is**, so
adopting it means writing that layer anyway, and the block layer is the expensive
half. A base that has to be replaced below the waterline is a reference.

What it is worth reading for: its **inline scanners** — emphasis, code spans, links,
images, strikethrough, tables — which are the fiddliest code in any markdown parser
and the part it does best, and its **flat token stream carrying a `nesting` depth**,
which is markdown-it's shape and is the answer to the extension question below.

---

## The nine, answered before the first edit

1. **Another origin of truth?** It removes two. Markdown is written three times
   today (table above) and the kit is the one place. The risk is arriving as a
   fourth, which is why absorbing `prose.js`'s tokenizer is in scope and not a
   follow-up.
2. **Concept budget?** No new noun — a kit is toolbelt's existing shape, one per
   subpath. A dependency is charged to the same budget, and this returns 82.
3. **Problem's complexity or ours?** Markdown genuinely is a parser. Ours is the
   part we would add by writing all of CommonMark when the dialect mesa needs is
   smaller; scoping it is the first open question below.
4. **Predictability?** The hazard is real and it is the worst outcome available: a
   dialect that silently differs from what an author sees on GitHub. The answer is
   the refusal — an unrecognized construct is named, never re-parsed as something
   else — which makes it *more* predictable than today, where `[^1]` under
   `Bun.markdown` quietly became a link and nothing said so.
5. **Derived rather than restated?** The grammar cannot be derived. **The
   conformance can**: CommonMark ships a machine-readable `spec.json` and GFM ships
   its own, so the suite is generated from the spec rather than hand-written, and a
   pass count is a number nobody types.
6. **One owner, and does it exist?** Toolbelt, which exists and whose charter this
   fits. `bridge-index` names no markdown owner today, which is the finding.
7. **Boundary explicit?** `markdown(src, opts) → html`, pure, string in and string
   out, the same shape every other kit has.
8. **Failure proportional?** Markdown is prose. A mis-parse is cosmetic, never
   destructive, so the boundary warns and names at compile time and never throws at
   runtime.
9. **Can it be wrong silently — and what artefact?** Yes, trivially, and this is the
   question that decides whether the item is buildable at all. Three artefacts, and
   the third is the one that matters: **the spec conformance count as a ratcheting
   baseline** (Invariant 14's shape, one number, `--update` unable to lower it); **a
   committed snapshot** of mesa's `.md` corpus rendered, gated by the `snapshots`
   phase; and **the old implementation as the oracle** — a differ that renders every
   one of this repo's 763 tracked `.md` files through both unified and the kit and
   fails on divergence. That differ runs for the whole migration and is deleted with
   the last remark import. Nothing lands until it is clean.

**Adjudication in tension** (`PHILOSOPHY.md` § IV): *preservation vs. evolution*.
`remarkPlugins` / `rehypePlugins` is a documented `compileMd` option with three tests
and **zero callers** — sierra never passes it. Pre-alpha, a spelling with nobody
depending on it is not a reason to keep it. That is the settled row and it governs,
with one honest exception named in the open questions.

**Tier** (`PHILOSOPHY.md` § VII): Assessment. This is a proposal, not a ruling. If it
is taken, the extension-point answer is a `FJS-D##` and the kit's dialect is a map
sentence in `packages/toolbelt/CLAUDE.md`.

---

## Open questions

- **How much markdown?** Full CommonMark is ~6k lines (markdown-it's core is the
  reference point); the dialect mesa's `.md` actually uses is a fraction of it.
  **A** — implement CommonMark + GFM in full, grade against both spec files, accept
  the month. **B** — implement the subset the compiler needs, refuse the rest by
  name, and let the ratchet record the gap honestly as a partial conformance number.
  **Recommend B** — the spec suite still runs and still reports, so the gap is
  visible rather than claimed closed, and §V.3's *did we add this complexity* points
  at what nothing in this tree writes: link reference definitions, setext headings,
  indented code blocks. B is also what makes the refusal in §V.4 possible at all: a
  parser that implements everything has nothing to refuse.
  **The subset has a floor, and grading `ts-md` is where it was measured.** Whatever
  is cut, the parser must be CONTAINER-BLOCK — blocks that nest and reparse their
  own children — because HTML blocks and nested lists are precisely the two things a
  flat line-oriented parser cannot reach, and mesa needs both: the first is how
  `<Counter />` survives the markdown step at all, the second is how anybody writes a
  list. So the subset is a choice about which LEAF constructs to carry and never
  about the block layer's shape, and an earlier draft of this line had HTML blocks on
  the cuttable side, which is backwards.

- **Does the kit take extensions, and in what shape?** This is the only real argument
  against the whole item. `conversion-ksite.md` names a **custom markdown dialect** —
  `==text==`, `:icon-name:`, `Heading |> split`, `====` dividers, ALL-CAPS kicker
  detection, bare phone and email autolinking — and calls reusing ksite's existing
  remark plugin *the cheapest item on that page*. Dropping unified makes it the most
  expensive. A dialect needs to ADD syntax, which is exactly what the refusal in
  §V.4 forbids, so the two cannot both be unqualified.
  **A** — no extension point; ksite's dialect is rewritten inside the kit as named
  constructs, and the kit owns every dialect anyone gets. **B** — a hook on the TOKEN
  STREAM: the kit tokenizes to a flat list carrying a nesting depth, and a caller
  contributes inline and block matchers that run while it tokenizes. No AST is
  exposed, there is no visitor pass and no second traversal. **C** — keep
  `remarkPlugins` working by keeping unified as an optional peer, kit by default.
  **Recommend B**, and it is not close: A makes the framework the owner of every
  client's typography, which is not a business it can be in, and C keeps 82 packages
  alive to serve an option with zero callers today — the worst of both, since the
  install cost is paid by everyone and the benefit reaches one unstarted conversion.
  B is the same shape `registerControl` already has (`FJS-D17`): a name and a
  resolver, contributed from outside, with no framework internals crossing the seam.
  **The shape is measured rather than guessed, and it moved.** This file first
  proposed a vaguer *token-level hook*; reading `ts-md` named what the tokens ARE —
  a flat stream with a `nesting` depth, markdown-it's shape — which is the one part
  of that parser worth copying and the reason B is now a design instead of a wish.

- **Does `prose.js` move now or later?** Absorbing it is what keeps the kit from
  being a fourth origin, but it is also the only markdown in the tree with live
  users, and the cli is the one package that must stay reachable before install.
  **A** — same change. **B** — a follow-up, with the row naming it.
  **Recommend B**, stated as a named remainder rather than left implied: the kit has
  to exist and be graded by the oracle before anything moves onto it, and moving a
  working renderer onto an ungraded parser is the order that makes a cosmetic defect
  into a `fli` that prints wrong.

---

## See also

- `bun-natives.md` § The nine that do not — why the native is refused, probed
- [`FJS-326`](../ISSUES.md#fjs-326) — the REPL's nineteen CDN entries; six are this chain
- `conversion-ksite.md` § The markdown dialect — the one named future consumer
- `packages/toolbelt/CLAUDE.md` — the kit charter and why each existing kit exists
- [`stacksjs/ts-md`](https://github.com/stacksjs/ts-md) — MIT, graded above; its
  inline scanners and token shape are the parts worth reading
