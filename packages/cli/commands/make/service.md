---
title: make:service
description: Scaffold a Junction service file in api/src/services/
alias: mksvc
examples:
  - fli make:service Lead
  - fli mksvc Invoice
  - fli make:service Order --open
  - fli make:service --auto
  - fli make:service --auto --yes
args:
  -
    name: model
    description: Model name (PascalCase). Omit when using --auto.
    required: false
flags:
  open:
    char: o
    type: boolean
    description: Open created file(s) in editor
    defaultValue: false
  auto:
    char: a
    type: boolean
    description: Read model names from db/schema.lite and step through each with a Y/n prompt
    defaultValue: false
  yes:
    char: y
    type: boolean
    description: With --auto, generate a service for every model without prompting
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const makeServiceFile = (name) => {
  const lower  = name.charAt(0).toLowerCase() + name.slice(1)
  const plural = `${lower}s`
  return `import { createBaseService } from '@frontierjs/junction'

export default createBaseService({
  name:   '${plural}',
  model:  '${plural}',
  hooks: { }
})
`
}
</script>

```js
const servicesDir = resolve(context.paths.api, 'src/services')
const editor      = process.env.EDITOR || 'vi'

// service filename + path for a model name (identical to manual behavior)
const serviceOf = (model) => {
  const serviceName = model.charAt(0).toLowerCase() + model.slice(1)
  return { serviceName, servicePath: resolve(servicesDir, `${serviceName}.service.ts`) }
}

// ─── --auto: read models from schema.lite, step through each with Y/n ──────────
if (flag.auto) {
  const schemaPath = resolve(context.paths.db, 'schema.lite')
  if (!existsSync(schemaPath)) {
    log.error(`schema.lite not found at ${schemaPath}`)
    log.info('Run this from a FJS project root (or add models with fli make:model).')
    return
  }

  const models = [...readFileSync(schemaPath, 'utf8')
    .matchAll(/^\s*model\s+([A-Za-z_]\w*)\s*\{/gm)].map(m => m[1])

  if (!models.length) {
    log.warn('No models found in schema.lite.')
    return
  }

  log.info(`${models.length} model(s) in schema.lite: ${models.join(', ')}`)
  echo('')

  const created = []
  let skipped = 0

  // Minimal stdin line reader. We avoid readline / zx question() here: readline
  // emits buffered lines eagerly, so with piped or scripted input every answer
  // after the first is dropped. Queuing lines ourselves and handing them out on
  // demand works for both an interactive TTY and pipes. EOF → '' (default Yes).
  let reader = null
  if (!flag.yes) {
    const stdin = process.stdin
    stdin.setEncoding('utf8')
    let buf = '', ended = false
    const lines = []
    let pending = null
    const deliver = (line) => { if (pending) { const p = pending; pending = null; p(line) } else lines.push(line) }
    const onData = (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) { deliver(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1) }
    }
    const onEnd = () => { ended = true; if (buf.length) { deliver(buf.replace(/\r$/, '')); buf = '' } if (pending) { const p = pending; pending = null; p('') } }
    stdin.on('data', onData); stdin.on('end', onEnd); stdin.resume()
    reader = {
      ask: (q) => {
        process.stdout.write(q)
        if (lines.length) return Promise.resolve(lines.shift())
        if (ended) return Promise.resolve('')
        return new Promise(res => { pending = res })
      },
      close: () => { stdin.pause(); stdin.off('data', onData); stdin.off('end', onEnd) },
    }
  }
  const ask = (q) => reader ? reader.ask(q) : Promise.resolve('')

  try {
    for (const model of models) {
      const { serviceName, servicePath } = serviceOf(model)

      // Never clobber an existing service — report and move on.
      if (existsSync(servicePath)) {
        log.info(`  ${model.padEnd(16)} ${serviceName}.service.ts exists — skipping`)
        skipped++
        continue
      }

      let make = true
      if (!flag.yes) {
        const ans = await ask(`  ${model.padEnd(16)} create ${serviceName}.service.ts?  [Y/n] `)
        make = !(ans && ans.trim().toLowerCase().startsWith('n'))
      }
      if (!make) { skipped++; continue }

      if (flag.dry) {
        log.dry(`  Would create ${serviceName}.service.ts`)
        continue
      }
      mkdirSync(servicesDir, { recursive: true })
      writeFileSync(servicePath, makeServiceFile(model), 'utf8')
      log.success(`  Created ${serviceName}.service.ts`)
      created.push(servicePath)
    }
  } finally {
    if (reader) reader.close()
  }

  echo('')
  log.success(`${created.length} service(s) created · ${skipped} skipped`)
  if (created.length) {
    log.info('Services autoload from api/src/services/ (see api/config/junction.config.js).')
  }
  if (flag.open && created.length) {
    for (const p of created) context.exec({ command: `${editor} "${p}"` })
  }
  return
}

// ─── single model (default) ───────────────────────────────────────────────────
if (!arg.model) {
  log.error('A model name is required:  fli make:service <Model>')
  log.info('Or step through every model in schema.lite:  fli make:service --auto')
  return
}

const { serviceName, servicePath } = serviceOf(arg.model)

if (existsSync(servicePath)) {
  log.warn(`${servicePath} already exists`)
  log.info('Use --open to edit it: fli make:service ' + arg.model + ' --open')
  if (flag.open) context.exec({ command: `${editor} "${servicePath}"` })
  return
}

if (flag.dry) {
  log.dry(`Would create ${servicePath}`)
  return
}

mkdirSync(servicesDir, { recursive: true })
writeFileSync(servicePath, makeServiceFile(arg.model), 'utf8')
log.success(`Created ${servicePath}`)
log.info('Register in api/src/server.ts:')
log.info(`  import ${serviceName}Service from './services/${serviceName}.service.ts'`)
log.info(`  app.services.register(${serviceName}Service)`)

if (flag.open) context.exec({ command: `${editor} "${servicePath}"` })
```