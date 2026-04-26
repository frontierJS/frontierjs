---
title: env:list
description: List all variables in .env (keys only by default, use --values to show values)
alias: elist
examples:
  - fli elist
  - fli elist --values
  - fli elist --file .env.production
  - fli elist --json
flags:
  values:
    char: v
    type: boolean
    description: Show values alongside keys (careful with secrets)
    defaultValue: false
  file:
    char: f
    type: string
    description: Which env file to read
    defaultValue: '.env'
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const parseEnvFull = (content) => {
  const result = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    // Preserve comments as metadata
    if (!trimmed) { result.push({ type: 'blank' }); continue }
    if (trimmed.startsWith('#')) { result.push({ type: 'comment', text: trimmed }); continue }
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val    = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    result.push({ type: 'var', key, val })
  }
  return result
}

const mask = (val) => {
  if (!val) return ''
  if (val.length <= 4) return '****'
  return val.slice(0, 2) + '****' + val.slice(-2)
}
</script>

```js
const envPath = resolve(context.paths.root, flag.file)

if (!existsSync(envPath)) {
  log.error(`${envPath} not found`)
  return
}

const entries = parseEnvFull(readFileSync(envPath, 'utf8'))
const vars    = entries.filter(e => e.type === 'var')

if (!vars.length) {
  log.warn(`No variables found in ${flag.file}`)
  return
}

if (flag.json) {
  const obj = {}
  for (const { key, val } of vars) obj[key] = flag.values ? val : mask(val)
  echo(JSON.stringify(obj, null, 2))
  return
}

echo(`\n${flag.file}  (${vars.length} variable${vars.length === 1 ? '' : 's'})\n`)

// Print with comments preserved for context
for (const entry of entries) {
  if (entry.type === 'blank') continue
  if (entry.type === 'comment') {
    echo(`  ${entry.text}`)
    continue
  }
  const display = flag.values ? entry.val : mask(entry.val)
  const pad     = Math.max(0, 28 - entry.key.length)
  echo(`  ${entry.key}${' '.repeat(pad)}${display}`)
}
echo('')
```
