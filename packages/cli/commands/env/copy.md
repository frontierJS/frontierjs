---
title: env:copy
description: Copy .env to .env.example with values stripped (safe to commit)
alias: ecopy
examples:
  - fli ecopy
  - fli ecopy --from .env.production --to .env.production.example
  - fli ecopy --dry
flags:
  from:
    type: string
    description: Source env file
    defaultValue: '.env'
  to:
    type: string
    description: Destination file
    defaultValue: '.env.example'
  keep-values:
    type: boolean
    description: Keep values (for non-secret env files)
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const stripValues = (content) =>
  content.split('\n').map(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) return line
    return trimmed.slice(0, eqIdx + 1)  // key= with no value
  }).join('\n')
</script>

Generates a `.env.example` from your real `.env` — keys preserved,
values stripped. Safe to commit to git.

```js
const srcPath  = resolve(context.paths.root, flag.from)
const destPath = resolve(context.paths.root, flag.to)

if (!existsSync(srcPath)) {
  log.error(`${srcPath} not found`)
  return
}

const content  = readFileSync(srcPath, 'utf8')
const output   = flag['keep-values'] ? content : stripValues(content)
const varCount = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('=')).length

if (flag.dry) {
  log.dry(`Would copy ${flag.from} → ${flag.to} (${varCount} vars, values ${flag['keep-values'] ? 'kept' : 'stripped'})`)
  return
}

writeFileSync(destPath, output, 'utf8')
log.success(`Created ${flag.to} with ${varCount} variable${varCount === 1 ? '' : 's'} (values ${flag['keep-values'] ? 'kept' : 'stripped'})`)
```
