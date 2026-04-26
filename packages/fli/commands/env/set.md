---
title: env:set
description: Set or update an environment variable in .env
alias: eset
examples:
  - fli eset DATABASE_URL postgres://localhost/mydb
  - fli eset NODE_ENV production
  - fli eset API_KEY sk-abc123 --file .env.production
  - fli eset DEBUG true --dry
  - fli eset GITHUB_TOKEN ghp_xxx --global
args:
  -
    name: key
    description: Environment variable name
    required: true
  -
    name: value
    description: Value to set
    required: true
flags:
  file:
    char: f
    type: string
    description: Target env file (default is .env in project root)
    defaultValue: '.env'
  create:
    char: c
    type: boolean
    description: Create the file if it does not exist
    defaultValue: true
  global:
    char: g
    type: boolean
    description: Write to the global FLI env (~/.config/fli/.env) instead of project .env
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'

const setEnvVar = (content, key, value) => {
  const lines    = content.split('\n')
  const quoted   = value.includes(' ') || value.includes('#') ? `"${value}"` : value
  const newLine  = `${key}=${quoted}`
  let   found    = false

  const updated = lines.map(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line
    const lineKey = trimmed.slice(0, trimmed.indexOf('=')).trim()
    if (lineKey === key) { found = true; return newLine }
    return line
  })

  if (!found) {
    // Append — add a blank line before if the file doesn't end with one
    if (updated[updated.length - 1] !== '') updated.push('')
    updated.push(newLine)
  }

  return updated.join('\n')
}
</script>

```js
const configDir = resolve(homedir(), '.config', 'fli')
const envPath   = flag.global
  ? resolve(configDir, '.env')
  : resolve(context.paths.root, flag.file)

// Ensure global config dir exists
if (flag.global && !existsSync(configDir)) {
  mkdirSync(configDir, { recursive: true })
}

if (!existsSync(envPath)) {
  if (!flag.create) {
    log.error(`${envPath} does not exist — use --create to create it`)
    return
  }
  if (flag.dry) {
    log.dry(`Would create ${envPath} and set ${arg.key}`)
    return
  }
  writeFileSync(envPath, `${arg.key}=${arg.value}\n`, 'utf8')
  log.success(`Created ${envPath}`)
  log.success(`Set ${arg.key}`)
  return
}

const current = readFileSync(envPath, 'utf8')
const updated = setEnvVar(current, arg.key, arg.value)

if (flag.dry) {
  log.dry(`Would set ${arg.key}=${arg.value} in ${flag.global ? '~/.config/fli/.env' : flag.file}`)
  return
}

writeFileSync(envPath, updated, 'utf8')
log.success(`Set ${arg.key} in ${flag.file}`)
```
