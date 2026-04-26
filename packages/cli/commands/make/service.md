---
title: make:service
description: Scaffold a Junction service file in api/src/services/
alias: mksvc
examples:
  - fli make:service Lead
  - fli mksvc Invoice
  - fli make:service Order --open
args:
  -
    name: model
    description: Model name (PascalCase) — service is scaffolded for the plural model
    required: true
flags:
  open:
    char: o
    type: boolean
    description: Open the created file in editor
    defaultValue: false
---

<script>
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const makeServiceFile = (name) => {
  const lower  = name.charAt(0).toLowerCase() + name.slice(1)
  const plural = `${lower}s`
  return `import { createLitestoneService } from '@frontierjs/junction'
import { authenticate, publish }   from '@frontierjs/junction'

export default createLitestoneService({
  name:   '${plural}',
  model:  '${plural}',
  schema: jsonSchema,
  hooks: {
    before: {
      create: [authenticate],
      patch:  [authenticate],
      remove: [authenticate],
    },
    after: {
      create: [publish((_r, ctx) => ctx.app.channel?.('${plural}') ?? null)],
      patch:  [publish((_r, ctx) => ctx.app.channel?.('${plural}') ?? null)],
      remove: [publish((_r, ctx) => ctx.app.channel?.('${plural}') ?? null)],
    }
  }
})
`
}
</script>

```js
const servicesDir = resolve(context.paths.api, 'src/services')
const serviceName = arg.model.charAt(0).toLowerCase() + arg.model.slice(1)
const servicePath = resolve(servicesDir, `${serviceName}.service.ts`)
const editor      = process.env.EDITOR || 'vi'

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
