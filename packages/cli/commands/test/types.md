---
title: test:types
description: tsc --noEmit, reporting only the diagnostics that belong to your code
alias: typecheck
examples:
  - fli typecheck
  - fli typecheck --foreign
  - fli typecheck --quiet
flags:
  foreign:
    char: f
    type: boolean
    description: Also print the diagnostics from inside node_modules
    defaultValue: false
  quiet:
    char: q
    type: boolean
    description: Say nothing about the suppressed diagnostics
    defaultValue: false
---

Runs your project's own `tsc --noEmit` and reports the errors in **your** files.

This is not a bare `tsc` because it cannot be. Every `@frontierjs` package ships
TypeScript source rather than declarations — each `exports` map points at a
`.ts` — so tsc follows those imports and type-checks the framework as part of
your program. A freshly scaffolded app gets several hundred diagnostics from
inside `node_modules` and none of its own, and `skipLibCheck` does not help
because these are not declaration files.

Foreign diagnostics are counted and summarized rather than hidden. `--foreign`
prints them.

```js
const { resolve } = await import('node:path')

const { runTypecheck, formatTypecheck } =
  await import(resolve(global.fliRoot, 'core/typecheck.js'))

const result = runTypecheck({ dir: context.paths.root })

if (result.status !== 'ok') {
  log.error(result.message)
  process.exitCode = 2
  return
}

const report = formatTypecheck(result, { quiet: flag.quiet, showForeign: flag.foreign })
if (report) echo(report)

if (result.ownCount > 0) {
  log.error(`${result.ownCount} type error(s) in this project`)
  process.exitCode = 1
} else {
  log.success('typecheck clean')
}
```
