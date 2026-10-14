---
title: haven:scenes
description: Edit Haven's scenes in a browser — place, move and remove pieces and doors, the spawn, the cat's row and the palette
effects: serves a page on this machine that writes Haven's scene files
examples:
  - fli haven:scenes
---

Haven's scene editor (`IDEAS/haven.md` 5.7, `FJS-D997`), served beside
Haven the way `fli studio` is served beside an app: a page on this machine and
never a Haven route, so no stranger is served it and the terminal never has to
draw it.

Its document is a scene file, `web/src/scenes/<Name>.mesa`, and the preview
is that scene's own component. A click selects the piece, door or pacer on
that cell, arrows move it and Delete removes it; a move onto another piece is
refused naming the cell. A click places the chosen piece or a door, or moves
the spawn; a door's target and a palette color are typed. A block of art
pasted in is recognized as the pieces at hand and placed. Save splices the
edits into the file's own text, so a scene saved untouched is the same bytes.

It edits Haven beside this `fli` in a checkout. An installed Haven under
`~/.fli/haven/` is the server's client, and an edit there would be overwritten
by nothing and read by no one.

```js
const { join, resolve, sep } = await import('node:path')
const { existsSync } = await import('node:fs')
const { GLOBAL } = await import(resolve(global.fliRoot, 'core/ports.js'))

const haven   = resolve(global.fliRoot, '..', 'haven')
const config = join(haven, 'editor', 'vite.config.js')
if (haven.split(sep).includes('node_modules') || !existsSync(config)) {
  log.error('The scene editor edits the haven in a FrontierJS checkout, and there is none beside this fli.')
  process.exitCode = 1
  return
}

const port = GLOBAL.havenScenes
log.info(`The haven's scene editor on http://localhost:${port}`)
await $.stream({
  command: `${JSON.stringify(join(haven, 'node_modules', '.bin', 'vite'))} -c editor/vite.config.js`,
  cwd:     haven,
  env:     { ...process.env, PORT: String(port) },
})
```
