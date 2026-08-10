# @frontierjs/utils

Pure functions, shared across every FrontierJS package and app, so the same string/date/object logic is not written a fourth time.

The whole package holds to one rule:

> **Every export is a pure function.** Same input, same output. No I/O, no clock, no filesystem, no network, no globals, no framework imports, no mutation of its arguments.

That rule is what makes the package cheap to depend on: any package in the tree may import it without a dependency-direction argument, and every export is testable with no mocks and no setup.

```
@frontierjs/utils      pure functions, no I/O, no framework knowledge   ← this package
@frontierjs/toolbelt   shared helpers that may touch runtime + framework
```

If a helper needs the current time, read an env var, or know what a Junction `ctx` is, it belongs in [`@frontierjs/toolbelt`](../toolbelt/) instead. A function that *takes* a `Date` is pure; one that *calls* `Date.now()` is not.

---

## Realm

Cross-cutting. Not a realm noun — utils introduces no Model, Service, or Resource.

---

## Dependency direction

**Zero workspace dependencies, ever** — the same standing that Mesa holds (Invariant 1). Utils sits below the whole tree, so importing it can never create a cycle or route a package around `Litestone ← Junction ← Sierra`. Any package may import it, including litestone.

Runtime deps are zero too, and should stay there. A pure function that needs a third-party package is usually a sign it is not the small thing it looks like.

---

## `glow` — source code to highlighted HTML

```js
import { glow } from '@frontierjs/utils/glow'

glow('.btn { color: red }', { language: 'css', prefix: false })
// → <code language="css">…</code>
```

| Option | Default | What it does |
| --- | --- | --- |
| `language` | inferred from the first character | `css`, `html`, `js`, `bash`, `md`, `json`, `yaml`, … |
| `prefix` | `true` | Treat a leading `+`, `-` or `>` as a line marker. **See the trap below.** |
| `mark` | `true` | Treat `•text•` as a highlight and `••text••` as an error |
| `numbered` | `false` | Wrap each line in a `<span>` so a CSS counter can number it |

**The output carries no CSS classes.** A token is marked with the HTML element that already means it, so the theme is element selectors and one attribute:

| Element | Marks |
| --- | --- |
| `<sup>` | comment |
| `<i>` | punctuation |
| `<b>` | identifier — property, function, key |
| `<em>` | value — string, number, CSS custom property |
| `<strong>` | keyword, tag name, hex colour |
| `<label>` | `@rule`, decorator, `!important` |
| `<ins>` `<del>` `<dfn>` | a whole line: added, removed, noted |
| `<mark>` `<u>` | an author's highlight, an author's error |

[`@frontierjs/css`](../css/) ships that theme in `components/code.css` and needs nothing from this package at runtime to do it.

### The line-prefix trap

With `prefix` on, a line beginning `+`, `-` or `>` is a marker and **the character is removed from the output**. In CSS all three are legal first characters — `--custom-prop`, `> .child`, `+ .sibling` — so highlighting a stylesheet with prefixes on silently eats one character per line.

`--` is handled for you: two dashes are never a diff marker. The combinators are not, and cannot be — `+ .sibling` and a diff-added line are the same three characters. **A caller highlighting CSS wants `prefix: false`.**

---

## Install

```bash
bun add @frontierjs/utils
```

---

## Testing

```bash
bun run test          # all specs
bun run test glow     # only specs whose filename matches
```

Zero dependencies — `test/run.js` is the whole harness, and it runs under node as well as bun.

The corpus in `test/fixtures/guide-samples.json` is 137 real code samples lifted from the `@frontierjs/css` guide — CSS, HTML, JS, shell. Every one is round-tripped through every language and must come back byte-identical, because the one way a highlighter can be catastrophically wrong is silently: it drops a character, the output still looks like code, and the reader copies a sample that does not work. Refresh it with `node test/fixtures/extract.mjs`.

---

## Candidate contents

Nothing here is committed to. Listed so the boundary is legible:

- string: case conversion, slugify, truncate, pluralize (note: the regular-English pluralizer behind `modelNameFor()` is a live seam — see `sierra/src/junction/schema-registry.js`)
- object: pick, omit, deep equal, deep clone, dot-path get/set
- array: groupBy, chunk, uniqueBy, partition
- date: format and diff helpers that take an explicit `now`
- type guards and small predicates
- result/option helpers, if the framework settles on a shape

---

## Open questions

- Is purity enforced, or only documented? A lint rule banning `Date`, `Math.random`, `process`, `fs` and `@frontierjs/*` imports inside `src/` would make the invariant real rather than aspirational.
- Tree-shaking: `glow` ships as a subpath export (`@frontierjs/utils/glow`) so an app that imports one helper does not pull in forty. Whether there is ever a root `.` entry is undecided.
- Does `utils` duplicate anything already living inside litestone or sierra? If so, the copy there moves here and the original re-exports — never two implementations.
- `glow` was written elsewhere and adopted; `docs/glow/` keeps the Svelte editor and SCSS theme it arrived with, as reference only. Neither is shipped, and neither is FrontierJS code — the repo has no Svelte, and the SCSS uses UnoCSS's `@apply`.
