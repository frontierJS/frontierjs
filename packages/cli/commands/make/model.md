---
title: make:model
description: Append a model block to schema.lite — optionally scaffold a service and resource
alias: mkmodel
examples:
  - fli mkmodel Lead
  - fli mkmodel Invoice --service
  - fli mkmodel Product --service --resource
  - fli mkmodel Order --service --resource --open
args:
  -
    name: model
    description: Model name (PascalCase)
    required: true
flags:
  service:
    char: s
    type: boolean
    description: Also scaffold api/src/services/<model>.service.ts
    defaultValue: false
  resource:
    char: r
    type: boolean
    description: Also scaffold web/src/resources/<Model>.mesa
    defaultValue: false
  soft-delete:
    type: boolean
    description: Include @@softDelete and deletedAt field
    defaultValue: false
  open:
    char: o
    type: boolean
    description: Open created files in editor after scaffolding
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const makeLiteModel = (name, softDelete) => {
  // Model names in schema.lite are PascalCase singular — e.g. Lead, not leads
  const pascal = name.charAt(0).toUpperCase() + name.slice(1)
  const lines = [
    '',
    `model ${pascal} {`,
    `  id        Integer   @id`,
    `  createdAt DateTime  @default(now())`,
    `  updatedAt DateTime  @default(now()) @updatedAt`,
  ]
  if (softDelete) {
    lines.push(`  deletedAt DateTime?`)
    lines.push('')
    lines.push(`  @@softDelete`)
  }
  lines.push(`  @@gate("0.4.4.6")`)
  lines.push(`}`)
  lines.push('')
  return lines.join('\n')
}

const makeServiceFile = (name) => {
  const lower = name.charAt(0).toLowerCase() + name.slice(1)
  const plural = `${lower}s`
  return `import { createService, authenticate } from '@frontierjs/junction'

export default createService({
  name:   '${plural}',
  model:  '${lower}',
  schema: jsonSchema,

  // Broadcast mutations to the '${plural}' channel.
  //
  // SCOPE THIS BEFORE YOU SHIP. Every connection in the channel receives every
  // row, and @@allow policies are enforced when a row is READ - a broadcast does
  // not re-evaluate them per subscriber. For per-tenant delivery:
  //
  //   channel: (rows, ctx) => ctx.app.channel(\`workspace:\${ctx.auth.user?.workspaceId}\`)
  //
  // Set channel:false to turn broadcasting off for this service.
  channel: '${plural}',

  hooks: {
    before: {
      create: [authenticate],
      patch:  [authenticate],
      remove: [authenticate],
    },
  }
})
`
}

const makeResourceFile = (name) => {
  const lower  = name.charAt(0).toLowerCase() + name.slice(1)
  const plural  = `${lower}s`
  const sc = '</' + 'script>'
  return `<script module>
  import { resource } from '@/core/frontier'

  export const query = {
    $orderBy: { createdAt: 'desc' },
    $limit: 100,
  }

  const _res = resource.createResource({
    model:   '${name}',
    service: '${plural}',
  })

  export const { store, service, load, context } = _res

  export function make(spec) {
    return _res.make(Object.assign({}, spec))
  }
${sc}
`
}
</script>

```js
const created = []
const editor  = process.env.EDITOR || 'vi'

// ─── 1. Append model block to schema.lite ────────────────────────────────────

const schemaPath = resolve(context.paths.db, 'schema.lite')

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  return
}

const modelBlock = makeLiteModel(arg.model, flag['soft-delete'])
const modelName  = arg.model.charAt(0).toLowerCase() + arg.model.slice(1) + 's'

// Check if model already exists
const existing = readFileSync(schemaPath, 'utf8')
if (existing.includes(`model ${modelName}`)) {
  log.warn(`model ${modelName} already exists in schema.lite — skipping`)
} else if (flag.dry) {
  log.dry(`Would append model ${modelName} to schema.lite`)
} else {
  writeFileSync(schemaPath, existing + modelBlock, 'utf8')
  log.success(`Appended model ${modelName} to schema.lite`)
  created.push(schemaPath)
  log.info('Run fli db:push to apply the schema change')
}

// ─── 2. Service scaffold ──────────────────────────────────────────────────────

if (flag.service) {
  const servicesDir = resolve(context.paths.api, 'src/services')
  const serviceName = arg.model.charAt(0).toLowerCase() + arg.model.slice(1)
  const servicePath = resolve(servicesDir, `${serviceName}.service.ts`)

  if (existsSync(servicePath)) {
    log.warn(`${servicePath} already exists — skipping`)
  } else if (flag.dry) {
    log.dry(`Would create ${servicePath}`)
  } else {
    mkdirSync(servicesDir, { recursive: true })
    writeFileSync(servicePath, makeServiceFile(arg.model), 'utf8')
    log.success(`Created ${servicePath}`)
    created.push(servicePath)
  }
}

// ─── 3. Resource scaffold ─────────────────────────────────────────────────────

if (flag.resource) {
  const resourcesDir = resolve(context.paths.web, 'src/resources')
  const resourcePath = resolve(resourcesDir, `${arg.model}.mesa`)

  if (existsSync(resourcePath)) {
    log.warn(`${resourcePath} already exists — skipping`)
  } else if (flag.dry) {
    log.dry(`Would create ${resourcePath}`)
  } else {
    mkdirSync(resourcesDir, { recursive: true })
    writeFileSync(resourcePath, makeResourceFile(arg.model), 'utf8')
    log.success(`Created ${resourcePath}`)
    created.push(resourcePath)
  }
}

// ─── Open created files ───────────────────────────────────────────────────────

if (flag.open && created.length && !flag.dry) {
  for (const f of created) context.exec({ command: `${editor} "${f}"` })
}
```
