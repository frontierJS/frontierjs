---
title: cli:build
description: Compile the cli/ surface into a binary that needs no bun, node_modules or source tree
alias: cli-build
examples:
  - fli cli:build
  - fli cli:build --target bun-darwin-arm64,bun-linux-x64
flags:
  target:
    char: t
    type: string
    description: Comma-separated bun compile targets; none builds for this machine
    defaultValue: ''
---

<script>
import { resolve } from 'path'
</script>

The binary is named for `cli/config/cli.config.js`'s `name` and written to
`cli/dist/`, with the target appended when one is given. A plain
`bun build --compile cli/src/main.js` compiles, runs, and has none of the
routes under `cli/src/routes/` — they are read off the directory at run time —
so the binary it makes refuses to start rather than offer half a command set.

A target other than this machine's downloads that platform's bun runtime the
first time, so it needs the network once.

```js
const { shippedFile } = await import(resolve(global.fliRoot, 'core/app-schema.js'))
const build = shippedFile(context.paths.root, '@frontierjs/mcp', './client/build')

if (!build) {
  log.error(`@frontierjs/mcp is not installed in ${context.paths.root}, or ships no ./client/build`)
  log.info('Install it first: bun add @frontierjs/mcp')
  context.config.abort = true
  return
}

const target = flag.target ? ` --target ${JSON.stringify(flag.target)}` : ''
context.exec({
  command: `bun ${JSON.stringify(build.file)} --root ${JSON.stringify(context.paths.cli)}${target}`,
  dry:     flag.dry,
})
```
