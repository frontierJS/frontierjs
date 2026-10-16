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
    kind: model
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
import { kebab } from '@frontierjs/toolbelt/inflect'

// The service's name is `make:resource`'s (`servicePlural`), so the two
// generators cannot disagree about which service a model is served by.
const { servicePlural } =
  await import(resolve(global.fliRoot, 'core/resource-template.js'))

// The shape junction's autoloader documents: `<plural>.service.ts` default-
// exporting a `createService` definition (kebab file for a multi-word name), over a model
// stated by its PascalCase singular. Stating `model` keeps an irregular plural
// from being singularized back to a different word.
const serviceOf = (model, servicesDir) => {
  const serviceName = servicePlural(model)
  const file        = `${kebab(serviceName)}.service.ts`
  return { serviceName, file, servicePath: resolve(servicesDir, file) }
}

const makeServiceFile = (model, serviceName) => `import { createService } from '@frontierjs/junction'

export default createService({ model: '${model}', channel: '${serviceName}' })
`
</script>

```js
const servicesDir = resolve($.paths.api, 'src/services')
const editor      = process.env.EDITOR || 'vi'

// ─── --auto: read models from schema.lite, step through each with Y/n ──────────
if (flag.auto) {
  const schemaPath = resolve($.paths.db, 'schema.lite')
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

  // Minimal stdin line reader. We avoid readline / tty.line() here: readline
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
      const { serviceName, file, servicePath } = serviceOf(model, servicesDir)

      // Never clobber an existing service — report and move on.
      if (existsSync(servicePath)) {
        log.info(`  ${model.padEnd(16)} ${file} exists — skipping`)
        skipped++
        continue
      }

      let make = true
      if (!flag.yes) {
        const ans = await ask(`  ${model.padEnd(16)} create ${file}?  [Y/n] `)
        make = !(ans && ans.trim().toLowerCase().startsWith('n'))
      }
      if (!make) { skipped++; continue }

      if (flag.dry) {
        log.dry(`  Would create ${file}`)
        continue
      }
      mkdirSync(servicesDir, { recursive: true })
      writeFileSync(servicePath, makeServiceFile(model, serviceName), 'utf8')
      log.success(`  Created ${file}`)
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
    for (const p of created) $.exec({ command: `${editor} "${p}"` })
  }
  return
}

// ─── single model (default) ───────────────────────────────────────────────────
if (!arg.model) {
  log.error('A model name is required:  fli make:service <Model>')
  log.info('Or step through every model in schema.lite:  fli make:service --auto')
  return
}

const { serviceName, servicePath } = serviceOf(arg.model, servicesDir)

if (existsSync(servicePath)) {
  log.warn(`${servicePath} already exists`)
  log.info('Use --open to edit it: fli make:service ' + arg.model + ' --open')
  if (flag.open) $.exec({ command: `${editor} "${servicePath}"` })
  return
}

if (flag.dry) {
  log.dry(`Would create ${servicePath}`)
  return
}

mkdirSync(servicesDir, { recursive: true })
writeFileSync(servicePath, makeServiceFile(arg.model, serviceName), 'utf8')
log.success(`Created ${servicePath}`)
log.info(`Served as '${serviceName}' — autoloaded from api/src/services/, nothing to register.`)

if (flag.open) $.exec({ command: `${editor} "${servicePath}"` })
```