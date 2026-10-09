# @frontierjs/config — changes

## 0.1.0 — first release

The tooling opinion a FrontierJS application extends in one line, extracted so it
can be corrected after an app has been scaffolded. Answers `IDEAS/overview.md`
5.13, *what a scaffolded app is given*.

- **`tsconfig`** — how an app is type-checked. The app keeps only `paths` and
  `include`, which are the parts about its own layout.
- **`biome`** — linter only. `formatter.enabled: false` and
  `assist.enabled: false` are the ruling in `FJS-D32`: this house aligns
  columns, no formatter can express that, and the framework's own generated code
  is written that way. The rule set is correctness + security + suspicious +
  a11y, with the taste groups off.
- **`editorconfig`** — the original of the file the scaffold copies, since
  EditorConfig has no extends mechanism. Byte equality with
  `packages/cli/core/app-config.js` is asserted from both sides.
