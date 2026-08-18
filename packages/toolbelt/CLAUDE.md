# toolbelt — package map

**`@frontierjs/toolbelt`** — pure functions, zero dependencies, importable from
anywhere in the tree including litestone and mesa. One rule: **every export is a
pure function** — same input, same output, no I/O, no clock, no globals, no
framework import, no mutation of its arguments. The rule is the package's
licence, not its style: `FJS-D26` admits toolbelt as substrate *below* the
dependency graph on the strength of it, so breaking purity costs the standing.

**One kit per subpath.** `/glow`, `/inflect`, `/directives`, `/hooks` and
`/jsonschema` today; a caller importing one gets nothing else. There is no root
`.` entry.

`bun run test` — `test/run.js` is the whole harness, no dependencies, runs
under node too.

---

## Layout

```
src/glow/glow.js     source code → highlighted HTML. The first kit.
src/inflect/         English singular ⇄ plural. One definition, five callers
                     across litestone, junction and sierra
src/directives/      the `$` convention — which params are directives, and how
                     a bag of them splits into filters + directives. Two
                     boundaries read it: junction's bridge and sierra's router
src/hooks/           the four-phase resource pipeline — before · after · around
                     · error. Two callers: sierra's createResource and jetty's
src/jsonschema/      the CONSUMER half of what litestone emits — follow a
                     `$ref`, and what a blank record of this model looks like.
                     Same two callers
docs/glow/           the Svelte editor and SCSS theme glow arrived with.
                     Reference only — not shipped, not FrontierJS code
docs/datetime.md     the /datetime kit's intent — no code yet
mockup/datetime/     the prototype /datetime is being rebuilt from. Parked,
                     below the packages/* glob, allowance-named in CI
test/run.js          the harness
test/specs/          one .spec.js per export
test/fixtures/       guide-samples.json — 137 real samples from the css guide
                     extract.mjs — regenerates it
```

**`@frontierjs/utils` and `packages/datetime-kit/` are gone** — both folded in
here. An import of either name is stale, and the published `@frontierjs/utils`
0.1.x on npm no longer moves.

---

## What bites here

- **`mergeHooks` answers a NEW map.** It merged in place in both copies it came
  from; a pure function may not mutate its arguments, and that rule is this
  package's licence rather than its style (`FJS-D26`). A caller upgrading has to
  assign the result. The failure mode after the change is a map that never grew,
  which is louder than one silently rewritten.
- **`createStore` is NOT here and must not arrive.** `FJS-D16` named it to move
  and the ruling is amended: a store is state. Admitting one costs the standing
  that lets litestone and mesa import this package at all.
- **A spec body may be async, and the harness had to learn it.** `test(name,
  fn)` awaits a returned promise now; before that a rejection inside an async
  spec was an unhandled rejection reported as a PASS.
- **A highlighter fails silently or not at all.** It drops a character, the
  output still looks like code, and the reader copies a sample that does not
  work. The round-trip test over the whole corpus is the only one that matters;
  everything else in `glow.spec.js` is a detail.
- **`prefix: true` eats the first character of a CSS line.** `+`, `-` and `>`
  start a diff marker and are stripped. `--custom-prop` is disambiguated (two
  dashes are never a marker); `> .child` and `+ .sibling` cannot be, so a CSS
  caller passes `prefix: false`.
- **The corpus is a snapshot, not a mirror.** It is committed so this package
  has no cross-package dependency. A new *kind* of sample in the css guide is
  not covered until someone runs `extract.mjs`.
- **Everything `renderRow` pushes is a raw slice of the source, tokens and the
  gaps between them alike.** Both go through `encode()`. Two shapes have
  already leaked here: a rule matching more than one character, back when
  `elem()` encoded only a lone `<` or `>` (an HTML comment went to the page as
  live markup), and the gap text, which looked safe only because `<`, `>` and
  `&` are punctuation rules in most languages and so usually arrive as tokens.
  Do not move encoding back into a per-rule special case.
- **`encode()` escapes `&` FIRST.** Reverse the order and the ampersand of an
  escape the function just wrote gets escaped again, so a source line reading
  `&lt;` renders as a `<` the author never typed. Callers depend on this:
  mesa's `compiler-md.js` decodes a fence body precisely because glow re-encodes
  what it emits.
- **A comment that opens mid-line is a token, not a block.** `/*` anywhere on
  a line used to start a comment block and swallow the code before it, which
  reads as a disabled line. `isTrailingComment()` is the split; a comment
  that opens the line, or runs on, is still a block.
- **glow's output is elements, never classes** — `<em>` a value, `<sup>` a
  comment. `@frontierjs/css`'s `components/code.css` themes exactly that shape,
  so emitting a class here would silently break the theme rather than fail.
- **CI fails the build on an import that is not relative.** `scripts/ci.mjs`
  § hygiene checks the manifest for dependencies and every file under `src/`
  for a clock, a global, a network call and a non-relative specifier — the
  blunt rule catches a node builtin, a sibling and a registry package at once.
  A kit that genuinely needs one of those does not belong in this package.
- **`inflect` is load-bearing for Invariant 2, not a convenience.** litestone
  derives a table name with `pluralize` and reads it back with `singularize`,
  junction derives a model name from a service name, sierra indexes both
  directions — so a rule changed here renames tables. The irregular table is
  whole-word only for that reason: teaching it to reach inside `audit_index`
  would rename a table in every schema that already has one.
- **`directives` is load-bearing the same way `inflect` is.** A `$` key it does
  not name is not refused — it falls through as a FILTER, so the Data boundary
  reports a column nobody declared and the cause is three layers away. The kit
  holds the read direction only; junction's browser client writes `$` names from
  a typed `QueryDirectives` on two paths that share nothing, and junction's own suite
  asserts every name it emits is one this table strips. Adding a directive means
  both ends, and that test is what says so.
- **A new subpath is invisible to a vite that is already running.** The exports
  map is read at server start, so the error names the very file that plainly
  has the entry — *"./directives" is not exported ... (see exports field in
  .../toolbelt/package.json)* — and the app it was added for does not mount.
  Restart the dev server; nothing about the code is wrong.
- **A word the rules cannot reach is not a bug to fix here.** `lens` → `len` is
  structural: `pens` is a real plural with the same ending, so telling them
  apart needs a dictionary. `inflect.spec.js` asserts that limit rather than
  hiding it.

## Proving a change

`bun run test`, then the callers — a kit here is only correct in them:

| Changed | Run |
| --- | --- |
| `glow` | `packages/css`: `bun run test code` — 26 assertions that style *real glow output*, injected by the css harness. A change to the element glow picks for a token breaks there, not here. Then `packages/mesa`: `bun run test`, whose markdown fences run it |
| `inflect` | `packages/litestone`: `bun run test` (table names), `packages/junction` and `packages/sierra`: `bun run test` (model resolution). A rule changed here renames tables — read the DDL snapshot diff before believing a green run |
| `directives` | `packages/junction`: `bun run test` — the bridge strips by this table, and `live-order.test.ts` asserts both transports only emit names it holds. Then `packages/sierra`: `bun run test` (`page-query.test.js`), and `example`: `verify` for a real navigation |
