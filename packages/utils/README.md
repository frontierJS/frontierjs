# @frontierjs/utils

> **Status: stub.** Folder claimed, nothing implemented. This file is the intent, not a description of behaviour.

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

Runtime deps should stay at zero too. A pure function that needs a third-party package is usually a sign it is not the small thing it looks like.

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

## Install

```bash
bun add @frontierjs/utils
```

## Usage

Not yet. When the first export lands, it gets an example here and an entry in `CHANGES.md`.

---

## Open questions

- Is purity enforced, or only documented? A lint rule banning `Date`, `Math.random`, `process`, `fs` and `@frontierjs/*` imports inside `src/` would make the invariant real rather than aspirational.
- Tree-shaking: named exports from a single entry, or one file per function with subpath exports? Prefer whichever keeps an app that imports one helper from shipping forty.
- Does `utils` duplicate anything already living inside litestone or sierra? If so, the copy there moves here and the original re-exports — never two implementations.
