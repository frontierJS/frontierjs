---
title: dev:tui
description: Run the web surface's routes in this terminal
alias: tui-dev
examples:
  - fli dev:tui
  - fli dev:tui --list
  - fli dev:tui --frame /reports/
  - fli dev:tui --api http://localhost:8110
flags:
  list:
    char: l
    type: boolean
    description: Print each route and the first thing that stops it lowering, then exit
    defaultValue: false
  frame:
    char: f
    type: string
    description: Print one route's frame and exit — no TTY needed
    defaultValue: ''
  api:
    char: a
    type: string
    description: The API origin, when it is not the one config.junction.url names
    defaultValue: ''
---

The same `web/src/routes`, compiled for the terminal and mounted one at a time
(`FJS-D809`): a target of `web/`, not a surface of its own. A route that does
not lower is listed with the file and line that stops it. Start the API first
(`fli dev:api`); a route reading a resource with no API behind it paints what
it paints for an outage.

Sierra's shell is resolved from the app's own install, so the app runs the
Sierra it depends on. Bun, never node: the loader is a Bun plugin.

```js
const { resolve } = await import('node:path')
const { shippedFile } = await import(resolve(global.fliRoot, 'core/app-schema.js'))

const shell = shippedFile($.paths.root, '@frontierjs/sierra', './tui')?.file
if (!shell) {
  echo('\n  ✗ @frontierjs/sierra is not installed in this app, or is too old to have ./tui\n')
  process.exitCode = 1
  return
}

const extra = [
  flag.list  ? '--list' : '',
  flag.frame ? `--frame ${flag.frame}` : '',
  flag.api   ? `--api ${flag.api}` : '',
].filter(Boolean).join(' ')

$.exec({ command: `bun ${shell} ${extra}`.trim(), cwd: $.paths.web, dry: flag.dry })
```
