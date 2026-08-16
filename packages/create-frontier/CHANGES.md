# create-frontier — changes

## 0.1.0 — first release

`npm create frontier@latest my-app`. Answers `IDEAS/overview.md` 1.2: there was
no path from the website to a running app that did not involve cloning a
monorepo.

An entry point and nothing else — the scaffold stays in `@frontierjs/cli`. Three
behaviours it adds, all about being invoked through `npm create`:

- **`--project <cwd>`**, because fli walks up for a project root and would
  otherwise write the new app into an enclosing repository's root. Measured, not
  assumed.
- **A prompt for the name**, since `npm create frontier@latest` with no arguments
  is what people type. Non-interactive with no name is an error naming the fix,
  not a hang.
- **A Bun check before anything is written**, since Junction is Bun-only.
