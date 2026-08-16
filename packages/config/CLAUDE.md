# config — package map

**Three files and the reasoning behind them.** No source, no binary, no runtime.
`@frontierjs/config` is what a scaffolded application extends in one line, so
that the framework's opinion about tooling is a **dependency rather than a copy**
— a rule improved here reaches every app that already exists.

`bun run test` (bun).

---

## Layout

```
tsconfig.json    how a FrontierJS app is type-checked
biome.json       linter only; the formatter is off and that is a decision
editorconfig     the original of the one file that HAS to be copied
test/            the claims above, asserted
```

---

## What bites here

- **There is no formatter, and it is not an oversight.** This house aligns
  columns where a run of lines is parallel, and Prettier, Biome and dprint all
  collapse that — none can express it, and it is not a setting any of them is
  missing. The framework's canonical files are written that way and so is the
  code `fli new` generates, so the first format run would rewrite the app it had
  just scaffolded. `assist` is off with it: Biome's import sorting reorders an
  aligned import block, which is a format change wearing a lint rule's clothes.
  `FJS-D32` is the ruling.
- **`biome.json` must stay plain JSON.** Biome reads `biome.jsonc` as jsonc and
  `biome.json` as JSON; a comment in this file is a parse error in every app that
  extends it. The reasoning goes in the README, which is why the README is long.
- **Biome treats any `biome.json` it discovers while scanning as a competing
  root config and refuses to run** — including this one, sitting in the app's
  own `node_modules`. `files.includes` excludes `node_modules` for that reason
  and not only for speed. A directory an app has not gitignored (a per-run bun
  cache, say) will reproduce it.
- **The rule set is curated, and the objective is not coverage.** Measured
  against this repo, Biome's `recommended` gives 7,249 findings; correctness +
  security + suspicious minus the taste rules gives ~600. `style`, `complexity`
  and `performance` are off because with the formatter refused, a linter that
  argues about style is a formatter that cannot fix anything.
- **`.editorconfig` is a hand copy** — EditorConfig has no extends mechanism, so
  the scaffold writes the text. `editorconfig` here is the original and
  `packages/cli/core/app-config.js` holds the copy; `test/config.test.js`
  asserts byte equality from this side and `packages/cli/tests/app-config.test.js`
  from the other. Change one, change both.
- **Adding a rule is a minor, not a patch.** It can fail an app's CI on code that
  has not changed. That is the price of the config being a dependency, and the
  reason it is worth paying only for rules that catch bugs.
- **What it cannot see is the interesting half.** Biome reads neither `.mesa` nor
  `.lite`, and neither can ESLint or dprint without a hand-written processor.
  `fli check` owns everything derived from the seed; neither reimplements the
  other. A scaffolded app's `bun run check` runs `fli check` first.

## Proving a change

`bun run test` here, then scaffold an app and run its gate:

```bash
node scripts/scaffold-build.mjs --keep
```

The `scaffold` CI phase runs `bun run check` inside the app it builds, which is
the only place a change to these files is proved against a real install.
