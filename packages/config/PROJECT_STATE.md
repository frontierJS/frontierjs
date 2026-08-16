# @frontierjs/config — state

**v0.1.0 · green · 12 tests.** Consumed by every app `fli new` scaffolds; not yet
consumed by this repo's own packages.

## What is decided

| | |
| --- | --- |
| Formatter | refused, and the reason is measured — `FJS-D32` |
| Linter | Biome, curated: correctness · security · suspicious · a11y |
| tsconfig | shared; the app keeps `paths` and `include` |
| `.editorconfig` | copied, byte-pinned by a test on both sides |

## Open

- **This repo does not extend its own config.** Measured on the tree at the time
  it was written: Biome's `recommended` gives 7,249 findings and the shipped rule
  set gives ~600, 123 of them unused imports. That is a countable cleanup rather
  than a taste argument, and it is the remaining half of
  `IDEAS/tooling-decisions.md` 1 — `FJS-266`. Until it is done, a framework that
  lints itself with nothing while telling its users to run Biome has two answers
  to one question.
- **Biome cannot parse `packages/mesa/test/runtime.test.js`.** Found by the same
  sweep and unexplained; it will matter when the item above is picked up.
- **The `$schema` pin is a version.** `biome.json` names the 2.5.8 schema; a
  Biome major will want it moved, and nothing fails if it is not.
