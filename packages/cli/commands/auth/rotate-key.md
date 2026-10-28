---
title: auth:rotate-key
description: Rotate the ENCRYPTION_KEY — re-encrypts all @secret fields in the database
alias: rotate-key
examples:
  - fli auth:rotate-key
  - fli auth:rotate-key --dry
flags:
  dry:
    type: boolean
    description: Show what would be done without writing anything
    defaultValue: false
---

<script>
// Both keys reach the script through its environment, never its source: the
// source is a file on disk for as long as the rotation runs.
const SCRIPT = `
import { createClient } from '@frontierjs/litestone'

const input = JSON.parse(process.env.FLI_INPUT)

const db = await createClient({
  path:          input.schemaPath,
  resolveFrom:   'schema',
  encryptionKey: process.env.ENCRYPTION_KEY,
})

const stats = await db.$rotateKey(process.env.ENCRYPTION_KEY_NEW)
console.log(JSON.stringify(stats))
await db.$close()
`

const updateEnvKey = (content, newKey) => {
  const lines   = content.split('\n')
  const updated = lines.map(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim()
    if (key === 'ENCRYPTION_KEY')     return `ENCRYPTION_KEY=${newKey}`
    if (key === 'ENCRYPTION_KEY_NEW') return null   // remove the new key line
    return line
  }).filter(l => l !== null)
  return updated.join('\n')
}
</script>

Rotates the `ENCRYPTION_KEY` — re-encrypts every `@secret` and `@encrypted`
field in the database under the new key.

**Before running:**
```
fli keygen aes --name ENCRYPTION_KEY_NEW --env --format hex
```

Then run `fli auth:rotate-key`. On success, `ENCRYPTION_KEY` is updated
to the new value and `ENCRYPTION_KEY_NEW` is removed from `.env`.

```js
const schemaPath = requireSchema($)
if (!schemaPath || !requireEncryptionKey($)) return

const envPath = path.resolve($.paths.root, '.env')
if (!fs.existsSync(envPath)) return refuse($, `.env not found at ${envPath}`)

const newKey = process.env.ENCRYPTION_KEY_NEW
if (!newKey) {
  return refuse($, 'ENCRYPTION_KEY_NEW not set in .env',
    'Generate one first: fli keygen aes --name ENCRYPTION_KEY_NEW --env --format hex')
}
if (newKey === process.env.ENCRYPTION_KEY) {
  return refuse($, 'ENCRYPTION_KEY_NEW is the same as ENCRYPTION_KEY — nothing to rotate')
}

if (flag.dry) {
  return log.dry('Would re-encrypt every @secret and @encrypted field under ENCRYPTION_KEY_NEW, then make it ENCRYPTION_KEY in .env')
}

log.warn('This re-encrypts every @secret and @encrypted field in the database.')
log.warn('Make a backup first: fli db:backup')
if (!await confirm($)) return log.info('Aborted')

log.info('Rotating — this may take a moment on a large database')
const stats = runAppScript($, 'rotate-key', SCRIPT, { schemaPath })
if (!stats) return refuse($, 'Rotation failed — the reason is above', 'ENCRYPTION_KEY in .env is unchanged')

fs.writeFileSync(envPath, updateEnvKey(fs.readFileSync(envPath, 'utf8'), newKey), 'utf8')

log.success('Key rotated')
echo.lines(Object.entries(stats).map(([model, { rows, fields }]) =>
  chalk`${model.padEnd(20)} {dim ${plural(rows, 'row')}, ${plural(fields, 'column')} re-encrypted}`), { indent: 2 })
log.success('.env: ENCRYPTION_KEY is the new key, ENCRYPTION_KEY_NEW removed')
log.info('Restart the API server to pick up the new key')
```
