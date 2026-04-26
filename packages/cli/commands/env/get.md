---
title: env:get
description: Get the value of an environment variable from .env
alias: eget
examples:
  - fli eget DATABASE_URL
  - fli eget API_KEY
  - fli env:get NODE_ENV
args:
  -
    name: key
    description: Environment variable name
    required: true
flags:
  file:
    char: f
    type: string
    description: Env file to read from (default .env in project root)
    defaultValue: '.env'
---

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const parseEnv = (content) => {
  const result = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val    = trimmed.slice(eqIdx + 1).trim()
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    result[key] = val
  }
  return result
}

const findEnvFile = (root, file) => {
  const p = resolve(root, file)
  return existsSync(p) ? p : null
}
</script>

```js
const envFile = findEnvFile(context.paths.root, flag.file)
if (!envFile) {
  // Fall back to process.env
  const val = process.env[arg.key]
  if (val !== undefined) {
    echo(val)
  } else {
    log.error(`${arg.key} not found (no .env file and not in process.env)`)
  }
  return
}

const vars = parseEnv(readFileSync(envFile, 'utf8'))
const val  = vars[arg.key] ?? process.env[arg.key]

if (val === undefined) {
  log.error(`${arg.key} is not set`)
  return
}

echo(val)
```
