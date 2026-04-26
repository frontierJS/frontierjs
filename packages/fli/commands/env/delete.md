---
title: env:delete
description: Remove an environment variable from .env
alias: edel
examples:
  - fli edel OLD_API_KEY
  - fli edel TEMP_SECRET --file .env.production
  - fli edel DEBUG --dry
args:
  -
    name: key
    description: Variable name to remove
    required: true
flags:
  file:
    char: f
    type: string
    description: Target env file
    defaultValue: '.env'
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const envPath = resolve(context.paths.root, flag.file)

if (!existsSync(envPath)) {
  log.error(`${envPath} not found`)
  return
}

const lines   = readFileSync(envPath, 'utf8').split('\n')
let   found   = false
const updated = lines.filter(line => {
  const trimmed = line.trim()
  if (trimmed.startsWith('#') || !trimmed.includes('=')) return true
  const lineKey = trimmed.slice(0, trimmed.indexOf('=')).trim()
  if (lineKey === arg.key) { found = true; return false }
  return true
})

if (!found) {
  log.warn(`${arg.key} not found in ${flag.file}`)
  return
}

if (flag.dry) {
  log.dry(`Would remove ${arg.key} from ${envPath}`)
  return
}

writeFileSync(envPath, updated.join('\n'), 'utf8')
log.success(`Removed ${arg.key} from ${flag.file}`)
```
