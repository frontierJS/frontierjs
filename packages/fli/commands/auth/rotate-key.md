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
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve }                                  from 'path'

// Inline Bun script that calls db.$rotateKey(newKey)
const makeScript = (schemaPath, oldKey, newKey) => `
import { createClient } from '@frontierjs/litestone'

const db = await createClient('${schemaPath}', {
  encryption: { key: '${oldKey}' }
})

console.log('Rotating encryption key...')
const stats = await db.$rotateKey('${newKey}')
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
const schemaPath = resolve(context.paths.db, 'schema.lite')
const envPath    = resolve(context.paths.root, '.env')

// ─── Preflight ────────────────────────────────────────────────────────────────

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  return
}

if (!existsSync(envPath)) {
  log.error('.env not found')
  return
}

loadEnv({ path: envPath })

const oldKey = process.env.ENCRYPTION_KEY
const newKey = process.env.ENCRYPTION_KEY_NEW

if (!oldKey) {
  log.error('ENCRYPTION_KEY not set in .env')
  return
}

if (!newKey) {
  log.error('ENCRYPTION_KEY_NEW not set in .env')
  log.info('Generate one first:')
  log.info('  fli keygen aes --name ENCRYPTION_KEY_NEW --env --format hex')
  return
}

if (oldKey === newKey) {
  log.error('ENCRYPTION_KEY_NEW is the same as ENCRYPTION_KEY — nothing to rotate')
  return
}

// ─── Dry run ──────────────────────────────────────────────────────────────────

if (flag.dry) {
  log.dry('Would call db.$rotateKey(ENCRYPTION_KEY_NEW)')
  log.dry('Would update ENCRYPTION_KEY in .env to new value')
  log.dry('Would remove ENCRYPTION_KEY_NEW from .env')
  return
}

// ─── Confirm ──────────────────────────────────────────────────────────────────

echo('')
log.warn('This will re-encrypt all @secret fields in the database.')
log.warn('Make a backup first: fli db:backup')
echo('')

const confirmed = await question('Continue? (y/n) › ')
if (confirmed.toLowerCase() !== 'y' && confirmed.toLowerCase() !== 'yes') {
  log.info('Aborted')
  return
}

// ─── Write + run rotation script ─────────────────────────────────────────────

const { unlinkSync } = await import('fs')
const tmpPath = resolve(context.paths.root, `.fli-rotate-key-${Date.now()}.ts`)

try {
  writeFileSync(tmpPath, makeScript(
    schemaPath.replace(/\\/g, '/'),
    oldKey,
    newKey
  ), 'utf8')

  log.info('Rotating key — this may take a moment on large databases...')

  const result = context.exec({ command: `bun run "${tmpPath}"`, capture: true })
  const output = (result?.stdout ?? result ?? '').toString().trim()
  const last   = output.split('\n').find(l => l.startsWith('{'))

  if (last) {
    const stats = JSON.parse(last)
    const models = Object.entries(stats)
    echo('')
    log.success('Key rotation complete')
    for (const [model, count] of models) {
      echo(`  ${model.padEnd(20)} ${count} row${count !== 1 ? 's' : ''} re-encrypted`)
    }
  } else {
    log.success('Key rotation complete')
  }

  // ─── Update .env ────────────────────────────────────────────────────────────
  const envContent = readFileSync(envPath, 'utf8')
  writeFileSync(envPath, updateEnvKey(envContent, newKey), 'utf8')

  echo('')
  log.success('Updated ENCRYPTION_KEY in .env')
  log.success('Removed ENCRYPTION_KEY_NEW from .env')
  echo('')
  log.info('Restart your API server to pick up the new key')
  echo('')

} catch (err) {
  log.error(`Rotation failed: ${err.message}`)
  log.warn('Your database has not been modified — ENCRYPTION_KEY unchanged')
} finally {
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
}
```
