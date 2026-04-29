---
title: make:scaffold
description: Generate a full vertical slice — schema.lite stanza, service, resource, and CRUD routes
alias: scaffold
examples:
  - fli scaffold Lead
  - fli scaffold Invoice --fields "number:string total:float status:string due:date"
  - fli scaffold Product --fields "name:string price:float active:boolean" --no-routes
  - fli scaffold Note --fields "title:string body:text" --no-resource
  - fli scaffold Contact --fields "name:string email:email phone:string" --dry
args:
  -
    name: model
    description: Model name in PascalCase (e.g. Lead, Invoice, BlogPost)
    required: true
flags:
  fields:
    type: string
    description: "Space-separated field specs: name:type (string email text url secret integer float boolean date)"
    defaultValue: ''
  no-routes:
    type: boolean
    description: Skip route generation — schema + service + resource only
    defaultValue: false
  no-resource:
    type: boolean
    description: Skip resource and routes — schema + service only
    defaultValue: false
  soft-delete:
    type: boolean
    description: Add deletedAt and @@softDelete to the schema stanza
    defaultValue: false
  open:
    char: o
    type: boolean
    description: Open all created files in editor after scaffolding
    defaultValue: false
  force:
    type: boolean
    description: Overwrite existing files
    defaultValue: false
---

<script>
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'

// ─── Field parser ─────────────────────────────────────────────────────────────
// Parses "name:string email:email total:float" into structured field objects.

function parseFields(str) {
  if (!str || !str.trim()) return []
  return str.trim().split(/\s+/).map(token => {
    const [name, type = 'string'] = token.split(':')
    return { name, type: type.toLowerCase() }
  })
}

// ─── Type maps ────────────────────────────────────────────────────────────────

const SCHEMA_TYPE = {
  string:   'String',
  email:    'String    @email',
  text:     'String    @textarea',
  url:      'String    @url',
  secret:   'String    @secret',
  int:      'Integer',
  integer:  'Integer',
  float:    'Float',
  boolean:  'Boolean',
  bool:     'Boolean',
  date:     'DateTime',
  datetime: 'DateTime',
  enum:     'String',
}

const INPUT_TYPE = {
  string:   'text',
  email:    'email',
  text:     'textarea',
  url:      'url',
  secret:   'password',
  int:      'number',
  integer:  'number',
  float:    'number',
  boolean:  'checkbox',
  bool:     'checkbox',
  date:     'date',
  datetime: 'datetime-local',
  enum:     'text',
}

// ─── Label helper ─────────────────────────────────────────────────────────────

function toLabel(name) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\s/, '')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// ─── Template: schema.lite stanza ────────────────────────────────────────────

function makeSchemaStanza(name, fields, softDelete) {
  // Model names in schema.lite are PascalCase singular — e.g. Lead, not leads
  const pascal = name.charAt(0).toUpperCase() + name.slice(1)
  const col = 10  // column width for field names

  const lines = [
    '',
    `model ${pascal} {`,
    `  ${'id'.padEnd(col)}Integer   @id`,
  ]

  for (const f of fields) {
    const schType = SCHEMA_TYPE[f.type] || 'String'
    lines.push(`  ${f.name.padEnd(col)}${schType}`)
  }

  lines.push(`  ${'createdAt'.padEnd(col)}DateTime  @default(now())`)
  lines.push(`  ${'updatedAt'.padEnd(col)}DateTime  @default(now()) @updatedAt`)

  if (softDelete) {
    lines.push(`  ${'deletedAt'.padEnd(col)}DateTime?`)
    lines.push('')
    lines.push('  @@softDelete')
  }

  lines.push('  @@gate("0.4.4.6")')
  lines.push('}')
  lines.push('')

  return lines.join('\n')
}

// ─── Template: service ────────────────────────────────────────────────────────

function makeServiceFile(name) {
  const lower  = name.charAt(0).toLowerCase() + name.slice(1)
  const plural = lower + 's'
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

// ─── Template: resource component ────────────────────────────────────────────

function makeResourceFile(name, fields) {
  const lower   = name.charAt(0).toLowerCase() + name.slice(1)
  const plural  = lower + 's'
  const idField = lower + 'Id'
  const sc      = '</' + 'script>'

  const inputs = fields.map(f => {
    const itype = INPUT_TYPE[f.type] || 'text'
    const label = toLabel(f.name)
    if (itype === 'textarea') {
      return `    <label>${label}<textarea bind:value={${lower}.${f.name}} name="${f.name}"></textarea></label>`
    }
    if (itype === 'checkbox') {
      return `    <label><input type="checkbox" bind:checked={${lower}.${f.name}} name="${f.name}" /> ${label}</label>`
    }
    return `    <Input bind:value={${lower}.${f.name}} name="${f.name}" type="${itype}" label="${label}" />`
  }).join('\n')

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

<script>
  import { setContext } from 'svelte'
  import Input from '@/components/Forms/Input.svelte'
  import { useForm } from '@/components/Forms/Form.svelte'
  import { back, goto } from '@/core/router'

  export let ${lower} = make()
  setContext('resource', ${lower})

  let { form, status, errors } = useForm({
    submit: async () => { await service.upsert(${lower}); $goto('/${plural}/[${idField}]', { ${idField}: ${lower}.id }) },
    reset:  () => $back(),
    afterChange: () => ($errors = {}),
  })
${sc}

<form id="${lower}-form" use:form={${lower}}>
  <fieldset class="space-y-4">
${inputs || `    <Input bind:value={${lower}.id} name="id" label="Id" />`}
  </fieldset>
  <footer>
    <button class="btn" type="submit">{$status || 'Save'}</button>
    <button type="reset" class="btn secondary">Back</button>
  </footer>
</form>
`
}

// ─── Template: route — index (list) ──────────────────────────────────────────

function makeIndexRoute(name, fields) {
  const lower  = name.charAt(0).toLowerCase() + name.slice(1)
  const plural = lower + 's'
  const sc     = '</' + 'script>'
  const displayFields = fields.length ? fields : [{ name: 'id' }]
  const ths    = displayFields.map(f => `      <th>${toLabel(f.name)}</th>`).join('\n')
  const tds    = displayFields.map(f => `        <td>{${lower}.${f.name}}</td>`).join('\n')

  return `<script>
  import { store, load } from '@/resources/${name}.svelte'
  import { goto } from '@/core/router'
  import { title } from '@/core/app'

  $title = '${name}s'
  export const preload = load
${sc}

<div class="page">
  <header>
    <h1>${name}s</h1>
    <a href="/${plural}/new" class="btn">New ${name}</a>
  </header>

  <table>
    <thead>
      <tr>
${ths}
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each $store as ${lower}}
        <tr>
${tds}
          <td>
            <a href="/${plural}/{${lower}.id}">View</a>
            <a href="/${plural}/{${lower}.id}/edit">Edit</a>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
`
}

// ─── Template: route — detail ────────────────────────────────────────────────

function makeDetailRoute(name, fields) {
  const lower  = name.charAt(0).toLowerCase() + name.slice(1)
  const plural = lower + 's'
  const sc     = '</' + 'script>'
  const displayFields = fields.length ? fields : [{ name: 'id' }]
  const rows   = displayFields.map(f =>
    `    <tr><th>${toLabel(f.name)}</th><td>{${lower}.${f.name}}</td></tr>`
  ).join('\n')

  return `<script>
  import { service } from '@/resources/${name}.svelte'
  import { goto } from '@/core/router'
  import { title } from '@/core/app'

  export let id
  let ${lower} = {}
  $title = '${name}'

  $: service.get(id).then(r => { ${lower} = r })
${sc}

<div class="page">
  <header>
    <h1>${name}</h1>
    <a href="/${plural}/{${lower}.id}/edit" class="btn">Edit</a>
  </header>

  <table class="detail">
    <tbody>
${rows}
    </tbody>
  </table>

  <footer>
    <a href="/${plural}">← Back to ${name}s</a>
  </footer>
</div>
`
}

// ─── Template: route — new ────────────────────────────────────────────────────

function makeNewRoute(name) {
  const lower  = name.charAt(0).toLowerCase() + name.slice(1)
  const plural = lower + 's'
  const sc     = '</' + 'script>'
  return `<script>
  import ${name}Resource from '@/resources/${name}.svelte'
  import { make } from '@/resources/${name}.svelte'
  import { title } from '@/core/app'

  $title = 'New ${name}'
  let ${lower} = make()
${sc}

<div class="page">
  <header><h1>New ${name}</h1></header>
  <${name}Resource bind:${lower} />
</div>
`
}

// ─── Template: route — edit ───────────────────────────────────────────────────

function makeEditRoute(name) {
  const lower  = name.charAt(0).toLowerCase() + name.slice(1)
  const sc     = '</' + 'script>'
  return `<script>
  import ${name}Resource from '@/resources/${name}.svelte'
  import { service, make } from '@/resources/${name}.svelte'
  import { title } from '@/core/app'

  export let id
  let ${lower} = make()
  $title = 'Edit ${name}'

  $: service.get(id).then(r => { ${lower} = r })
${sc}

<div class="page">
  <header><h1>Edit ${name}</h1></header>
  <${name}Resource bind:${lower} />
</div>
`
}
</script>

Generates a complete vertical slice from a single model name. Each layer is wired to
the others — schema feeds the service, the resource wraps the service, the routes use
the resource. Run `fli db:push` after to apply the schema change.

Use `--fields` to seed real fields across all layers from the start:

```
fli scaffold Lead --fields "name:string email:email status:string"
```

Supported field types: `string` `email` `text` `url` `secret` `integer` `float`
`boolean` `date` `datetime`. Defaults to `string` if type is omitted.

Without `--fields` a minimal stub is generated — id + timestamps only — ready to
extend in `schema.lite`.

```js
const modelName  = arg.model.charAt(0).toUpperCase() + arg.model.slice(1)
const lower      = modelName.charAt(0).toLowerCase() + modelName.slice(1)
const plural     = lower + 's'
const fields     = parseFields(flag.fields)
const skipRoutes = flag['no-routes'] || flag['no-resource']
const editor     = process.env.EDITOR || 'vi'
const created    = []

const write = (path, content, label) => {
  if (existsSync(path) && !flag.force) {
    log.warn(`${label} already exists — skipping (use --force to overwrite)`)
    return false
  }
  if (flag.dry) {
    log.dry(`Would create ${label}:  ${path}`)
    return false
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  log.success(`Created ${label.padEnd(10)}  ${path}`)
  created.push(path)
  return true
}

// ─── 1. schema.lite ───────────────────────────────────────────────────────────

const schemaPath = resolve(context.paths.db, 'schema.lite')

if (!existsSync(schemaPath)) {
  log.error('schema.lite not found — run fli db:push in an existing project first')
  return
}

const existing = readFileSync(schemaPath, 'utf8')
if (existing.includes(`model ${modelName}`) && !flag.force) {
  log.warn(`model ${modelName} already exists in schema.lite — skipping (use --force to overwrite)`)
} else if (flag.dry) {
  log.dry(`Would append model ${modelName} to schema.lite`)
} else {
  const stanza = makeSchemaStanza(modelName, fields, flag['soft-delete'])
  writeFileSync(schemaPath, existing + stanza, 'utf8')
  log.success(`Appended model        schema.lite`)
  created.push(schemaPath)
}

// ─── 2. Service ───────────────────────────────────────────────────────────────

const servicePath = resolve(context.paths.api, `src/services/${lower}.service.ts`)
write(servicePath, makeServiceFile(modelName), 'service')

// ─── 3. Resource ──────────────────────────────────────────────────────────────

if (!flag['no-resource']) {
  const resourcePath = resolve(context.paths.web, `src/resources/${modelName}.svelte`)
  write(resourcePath, makeResourceFile(modelName, fields), 'resource')
}

// ─── 4. Routes ────────────────────────────────────────────────────────────────

if (!skipRoutes) {
  const routesBase = resolve(context.paths.webPages, plural)

  write(resolve(routesBase, 'index.svelte'),      makeIndexRoute(modelName, fields),  'route/list')
  write(resolve(routesBase, '[id].svelte'),        makeDetailRoute(modelName, fields), 'route/detail')
  write(resolve(routesBase, 'new.svelte'),         makeNewRoute(modelName),            'route/new')
  write(resolve(routesBase, '[id]/edit.svelte'),   makeEditRoute(modelName),           'route/edit')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

if (!flag.dry && created.length) {
  echo('')
  echo(`  ${created.length} file${created.length === 1 ? '' : 's'} created for ${modelName}`)
  echo('')
  if (created.some(f => f.endsWith('schema.lite'))) {
    echo('  Next: fli db:push to apply the schema change')
  }
  if (!skipRoutes) {
    echo(`  Routes: /${plural}  /${plural}/[id]  /${plural}/new  /${plural}/[id]/edit`)
    echo(`  Add a nav link to your layout pointing to /${plural}`)
  }
  echo('')
}

if (flag.open && created.length && !flag.dry) {
  for (const f of created) context.exec({ command: `${editor} "${f}"` })
}
```
