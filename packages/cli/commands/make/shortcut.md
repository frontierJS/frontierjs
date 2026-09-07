---
title: make:shortcut
description: Name a command line you type often — writes an ordinary project command
alias: mkshortcut
examples:
  - fli make:shortcut go-time "fli ws:atlas --open --live"
  - fli make:shortcut up "docker compose up -d"
  - fli make:shortcut go-time "fli ws:atlas --live" --description "Atlas, with git and registry state"
args:
  -
    name: name
    description: What you want to type after `fli` — e.g. go-time
    required: true
  -
    name: command
    description: The command line it runs, quoted
    required: true
flags:
  description:
    char: D
    type: string
    description: What the shortcut is for — defaults to the command line itself
    defaultValue: ''
---

<script>
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'

const { getConfig } = await import(new URL('file://' + global.fliRoot + '/core/config.js'))
const { buildRegistry } = await import(new URL('file://' + global.fliRoot + '/core/registry.js'))
const shortcuts = await import(new URL('file://' + global.fliRoot + '/core/shortcuts.js'))
</script>

Give a command line you type often a name of its own.

The file it writes is an ordinary project command under `cli/src/routes/shortcut/`,
so `fli --help`, completion and `fli edit` find it with no further wiring — and a
shortcut that grows into a real command is an edit to that file rather than a
migration out of a table.

```js
const { name, command } = arg

// Every refusal before anything is written, and each one names the next move.
// The taken-name check is the one that has to be here: the registry lets a
// project command override a core one in SILENCE, because that override is the
// authoring model — and it is the wrong default for a name typed from memory,
// where `fli make:shortcut new "…"` would eat `fli new` and say nothing.
const refusal =
  shortcuts.refuseName(name) ??
  shortcuts.refuseCommand(command) ??
  shortcuts.refuseTaken(name, buildRegistry())

if (refusal) {
  log.error(refusal)
  return
}

const { routesDir } = getConfig()
const outputPath = shortcuts.shortcutPath({ root: context.paths.root, routesDir, name })

if (existsSync(outputPath)) {
  log.error(`${shortcuts.shortcutTitle(name)} already exists at ${outputPath}`)
  log.info(`Use \`fli edit ${shortcuts.shortcutTitle(name)}\` to change it, or delete the file first`)
  return
}

const content = shortcuts.renderShortcut({ name, command, description: flag.description })

if (flag.dry) {
  log.dry(`Would write: ${outputPath}`)
  echo('')
  echo(content)
  return
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, content, 'utf8')

log.success(`Created ${outputPath}`)
echo(`\nRun it with:  fli ${name}`)
echo(`Edit it with: fli edit ${shortcuts.shortcutTitle(name)}`)
```
