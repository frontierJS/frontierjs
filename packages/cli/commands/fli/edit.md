---
title: fli:edit
description: Open a command file in your editor
alias: edit
examples:
  - fli edit hello:greet
  - fli edit crypto:keygen
  - fli edit make:command
args:
  -
    name: command
    description: Command title or alias to edit
    required: true
flags:
  editor:
    char: e
    type: string
    description: Editor to use (overrides $EDITOR)
    defaultValue: ''
---

<script>
import { execSync } from 'child_process'
import { resolve } from 'path'
import { existsSync } from 'fs'
</script>

Open a command's `.md` source file in your editor.
Uses `$EDITOR`, falling back to `vi` if not set.
Pass `--editor` to override for a single run.

```js
// ─── Look up the command in the registry ──────────────────────────────────────
// We need direct registry access — import buildRegistry from core
const { buildRegistry } = await import(`${global.fliRoot}/core/registry.js`)
const registry = buildRegistry()
const entry = registry.get(arg.command)

if (!entry) {
  log.error(`Command "${arg.command}" not found — run \`fli list\` to see available commands`)
  return
}

const filePath = entry.filePath

// ─── Resolve editor ───────────────────────────────────────────────────────────
const { getConfig } = await import(resolve(global.fliRoot, 'core/config.js'))
const { editor: configEditor } = getConfig()
const editor = flag.editor || configEditor || process.env.EDITOR || process.env.VISUAL || 'vi'

log.info(`Opening ${filePath}`)
log.info(`Editor:  ${editor}`)

if (flag.dry) {
  log.dry(`Would run: ${editor} "${filePath}"`)
  return
}

// ─── Launch editor (blocks until closed) ─────────────────────────────────────
try {
  execSync(`${editor} "${filePath}"`, { stdio: 'inherit' })
  log.success('Editor closed')
} catch (err) {
  // Exit code 1 is normal for some editors (vi on :q!)
  if (err.status !== 1) {
    log.error(`Editor exited with code ${err.status}: ${err.message}`)
  }
}
```
