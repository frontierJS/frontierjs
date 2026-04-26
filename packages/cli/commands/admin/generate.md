---
title: admin:generate
description: Generate a gate-aware CRUD admin UI from schema.lite — list, detail, create, and edit views for every model
alias: admin-gen
examples:
  - fli admin:generate
  - fli admin:generate --model users
  - fli admin:generate --model leads --force
  - fli admin:generate --dry
args:
  -
    name: model
    description: Generate for a single model only (lowercase, as in schema.lite). Omit to generate for all models.
    defaultValue: ''
flags:
  force:
    type: boolean
    description: Overwrite existing files
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { execSync } from 'child_process'

// ─── JSON Schema helpers ──────────────────────────────────────────────────────
// Reads db/schema.json and returns:
//   models  — Map<modelName, { properties, required, defs }>
//   defs    — raw $defs (for resolving $ref enums)

function loadSchema(schemaJsonPath) {
  const raw   = JSON.parse(readFileSync(schemaJsonPath, 'utf8'))
  const defs  = raw.$defs || raw.definitions || {}
  const models = new Map()

  for (const [key, val] of Object.entries(defs)) {
    if (val.type === 'object' && val.properties) {
      models.set(key, {
        properties: val.properties,
        required:   new Set(val.required || []),
      })
    }
  }

  return { models, defs }
}

// ─── Field type resolver ──────────────────────────────────────────────────────
// Resolves a JSON Schema field descriptor to an input type + optional enum options.
// Returns: { inputType, optional, options? }

function resolveField(fieldSchema, defs) {
  // Optional: anyOf [type, null]
  if (fieldSchema.anyOf) {
    const nonNull = fieldSchema.anyOf.find(s => s.type !== 'null')
    if (nonNull) return { ...resolveField(nonNull, defs), optional: true }
    return { inputType: 'text', optional: true }
  }

  // Enum $ref
  if (fieldSchema.$ref) {
    const defName = fieldSchema.$ref.replace(/^#\/\$defs\/|^#\/definitions\//, '')
    const def = defs[defName]
    if (def?.enum) return { inputType: 'select', options: def.enum, optional: false }
    return { inputType: 'text', optional: false }
  }

  // Format overrides
  if (fieldSchema.format === 'email')     return { inputType: 'email',          optional: false }
  if (fieldSchema.format === 'uri')       return { inputType: 'url',            optional: false }
  if (fieldSchema.format === 'date-time') return { inputType: 'datetime-local', optional: false }

  // Base types
  switch (fieldSchema.type) {
    case 'integer':
    case 'number':  return { inputType: 'number',   optional: false }
    case 'boolean': return { inputType: 'checkbox', optional: false }
    default:        return { inputType: 'text',     optional: false }
  }
}

// ─── Label helper ─────────────────────────────────────────────────────────────

function toLabel(name) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\s/, '')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// ─── Resource file (minimal, for service access) ──────────────────────────────

function makeResourceFile(modelName) {
  const lower  = modelName.charAt(0).toLowerCase() + modelName.slice(1)
  const plural  = lower + 's'
  const sc = '</' + 'script>'
  return `<script module>
  import { resource } from '@/core/frontier'

  const _res = resource.createResource({
    model:   '${modelName}',
    service: '${plural}',
  })

  export const { store, service, load, context } = _res

  export function make(spec) {
    return _res.make(Object.assign({}, spec))
  }
${sc}
`
}

// ─── Admin _layout.svelte — auth guard ───────────────────────────────────────
// Guards all /admin/* routes. Redirects if not authenticated or not admin.
// NOTE: $session is imported from @/core/auth — wire this to your project's
// actual session store if the path differs.

function makeAdminLayout(modelNames) {
  const sc  = '</' + 'script>'
  const nav = modelNames.map(m =>
    `    <a href="/admin/${m}">${toLabel(m)}</a>`
  ).join('\n')

  return `<script>
  import { session } from '@/core/auth'
  import { goto }    from '@/core/router'
  import { title }   from '@/core/app'

  // Redirect if not logged in or not admin.
  // "isAdmin" is a Boolean field on the users model — add it via fli scaffold or make:model.
  $: if ($session === null) $goto('/login?next=/admin')
  $: if ($session && !$session.user?.isAdmin) $goto('/')
${sc}

{#if $session?.user?.isAdmin}
  <nav class="admin-nav">
    <a href="/admin" class="admin-home">Admin</a>
${nav}
  </nav>

  <main class="admin-content">
    <slot />
  </main>
{/if}
`
}

// ─── Admin index — dashboard ──────────────────────────────────────────────────

function makeAdminIndex(modelNames) {
  const sc    = '</' + 'script>'
  const cards = modelNames.map(m => `
  <a href="/admin/${m}" class="admin-card">
    <h2>${toLabel(m)}</h2>
    <span>Manage ${m}</span>
  </a>`).join('')

  return `<script>
  import { title } from '@/core/app'
  $title = 'Admin'
${sc}

<div class="admin-page">
  <h1>Admin</h1>
  <div class="admin-cards">${cards}
  </div>
</div>
`
}

// ─── Model: list view ─────────────────────────────────────────────────────────

function makeModelList(modelName, properties, required, defs) {
  const lower   = modelName.charAt(0).toLowerCase() + modelName.slice(1)
  const plural  = lower + 's'
  const sc      = '</' + 'script>'

  // Show first 5 non-id fields in the table (id always shown)
  const displayFields = [
    'id',
    ...Object.keys(properties).filter(f => f !== 'id').slice(0, 4)
  ]

  const ths = displayFields.map(f => `      <th>${toLabel(f)}</th>`).join('\n')
  const tds = displayFields.map(f => `        <td>{item.${f} ?? ''}</td>`).join('\n')

  return `<script>
  import { service } from '@/resources/${modelName}.svelte'
  import { goto }    from '@/core/router'
  import { title }   from '@/core/app'

  $title = '${toLabel(modelName)}s — Admin'

  let items = []
  let loading = true
  let error = null

  async function load() {
    try {
      const res = await service.find({ $limit: 500, $sort: { id: -1 } })
      items   = res.data ?? res
      loading = false
    } catch (e) {
      error   = e.message
      loading = false
    }
  }

  load()

  async function remove(id) {
    if (!confirm('Delete this record?')) return
    await service.remove(id)
    items = items.filter(i => i.id !== id)
  }
${sc}

<div class="admin-page">
  <header class="admin-header">
    <h1>${toLabel(modelName)}s</h1>
    <a href="/admin/${plural}/new" class="btn">New ${toLabel(modelName)}</a>
  </header>

  {#if loading}
    <p>Loading…</p>
  {:else if error}
    <p class="admin-error">{error}</p>
  {:else if !items.length}
    <p class="admin-empty">No ${lower}s yet. <a href="/admin/${plural}/new">Create one</a>.</p>
  {:else}
    <table class="admin-table">
      <thead>
        <tr>
${ths}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          <tr>
${tds}
            <td class="admin-actions">
              <a href="/admin/${plural}/{item.id}">View</a>
              <a href="/admin/${plural}/{item.id}/edit">Edit</a>
              <button on:click={() => remove(item.id)}>Delete</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
`
}

// ─── Model: detail view ───────────────────────────────────────────────────────

function makeModelDetail(modelName, properties, defs) {
  const lower  = modelName.charAt(0).toLowerCase() + modelName.slice(1)
  const plural = lower + 's'
  const sc     = '</' + 'script>'
  const allFields = ['id', ...Object.keys(properties).filter(f => f !== 'id')]
  const rows = allFields.map(f =>
    `    <tr><th>${toLabel(f)}</th><td>{${lower}?.${f} ?? '—'}</td></tr>`
  ).join('\n')

  return `<script>
  import { service } from '@/resources/${modelName}.svelte'
  import { goto }    from '@/core/router'
  import { title }   from '@/core/app'

  export let id
  let ${lower} = null
  let error = null
  $title = '${toLabel(modelName)} — Admin'

  async function load() {
    try { ${lower} = await service.get(id) }
    catch (e) { error = e.message }
  }

  load()

  async function remove() {
    if (!confirm('Delete this record?')) return
    await service.remove(id)
    $goto('/admin/${plural}')
  }
${sc}

<div class="admin-page">
  <header class="admin-header">
    <h1>${toLabel(modelName)} #{id}</h1>
    <div>
      <a href="/admin/${plural}/{id}/edit" class="btn">Edit</a>
      <button class="btn danger" on:click={remove}>Delete</button>
    </div>
  </header>

  {#if error}
    <p class="admin-error">{error}</p>
  {:else if !${lower}}
    <p>Loading…</p>
  {:else}
    <table class="admin-detail">
      <tbody>
${rows}
      </tbody>
    </table>
  {/if}

  <footer class="admin-footer">
    <a href="/admin/${plural}">← Back to ${toLabel(modelName)}s</a>
  </footer>
</div>
`
}

// ─── Model: create / edit form (shared template) ──────────────────────────────

function makeModelForm(modelName, properties, required, defs, isEdit) {
  const lower  = modelName.charAt(0).toLowerCase() + modelName.slice(1)
  const plural = lower + 's'
  const sc     = '</' + 'script>'

  // Skip id in forms — auto-assigned
  const formFields = Object.entries(properties).filter(([f]) => f !== 'id')

  const inputs = formFields.map(([fieldName, fieldSchema]) => {
    const { inputType, optional, options } = resolveField(fieldSchema, defs)
    const label    = toLabel(fieldName)
    const req      = required.has(fieldName) ? ' required' : ''
    const optLabel = optional ? ' <span class="optional">(optional)</span>' : ''

    if (inputType === 'select' && options) {
      const opts = options.map(o => `          <option value="${o}">${o}</option>`).join('\n')
      return `  <label>
    ${label}${optLabel}
    <select name="${fieldName}" bind:value={data.${fieldName}}${req}>
          <option value="">— select —</option>
${opts}
    </select>
  </label>`
    }

    if (inputType === 'checkbox') {
      return `  <label class="checkbox">
    <input type="checkbox" name="${fieldName}" bind:checked={data.${fieldName}} />
    ${label}
  </label>`
    }

    if (inputType === 'number') {
      return `  <label>
    ${label}${optLabel}
    <input type="number" name="${fieldName}" bind:value={data.${fieldName}}${req} />
  </label>`
    }

    return `  <label>
    ${label}${optLabel}
    <input type="${inputType}" name="${fieldName}" bind:value={data.${fieldName}}${req} />
  </label>`
  }).join('\n\n')

  if (isEdit) {
    return `<script>
  import { service, make } from '@/resources/${modelName}.svelte'
  import { goto }          from '@/core/router'
  import { title }         from '@/core/app'

  export let id
  let data = make()
  let error = null
  let saving = false
  $title = 'Edit ${toLabel(modelName)} — Admin'

  async function load() {
    try { data = await service.get(id) }
    catch (e) { error = e.message }
  }

  load()

  async function save() {
    saving = true
    try {
      await service.patch(id, data)
      $goto('/admin/${plural}/{id}')
    } catch (e) {
      error  = e.message
      saving = false
    }
  }
${sc}

<div class="admin-page">
  <header class="admin-header">
    <h1>Edit ${toLabel(modelName)} #{id}</h1>
  </header>

  {#if error}<p class="admin-error">{error}</p>{/if}

  <form on:submit|preventDefault={save} class="admin-form">
${inputs}

    <footer class="admin-form-footer">
      <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      <a href="/admin/${plural}/{id}">Cancel</a>
    </footer>
  </form>
</div>
`
  }

  // Create form
  return `<script>
  import { service, make } from '@/resources/${modelName}.svelte'
  import { goto }          from '@/core/router'
  import { title }         from '@/core/app'

  let data = make()
  let error = null
  let saving = false
  $title = 'New ${toLabel(modelName)} — Admin'

  async function save() {
    saving = true
    try {
      const created = await service.create(data)
      $goto('/admin/${plural}/{created.id}')
    } catch (e) {
      error  = e.message
      saving = false
    }
  }
${sc}

<div class="admin-page">
  <header class="admin-header">
    <h1>New ${toLabel(modelName)}</h1>
  </header>

  {#if error}<p class="admin-error">{error}</p>{/if}

  <form on:submit|preventDefault={save} class="admin-form">
${inputs}

    <footer class="admin-form-footer">
      <button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
      <a href="/admin/${plural}">Cancel</a>
    </footer>
  </form>
</div>
`
}
</script>

Generates a complete admin UI directly from `schema.lite` — one list, detail,
create, and edit view per model, plus an index dashboard and an auth-guarded
layout. All files are plain Svelte components dropped into `web/src/routes/admin/`
— editable after generation, not a black-box runtime.

**Auth guard:** checks `$session.user.isAdmin` in `_layout.svelte`.
`isAdmin` must be a Boolean field on your `users` model. Add it with:

```
fli scaffold IsAdmin --fields "isAdmin:boolean"
```

or add manually to `schema.lite` and run `fli db:push`.

**Relation fields** (Integer foreign keys) render as plain number inputs.

Run `fli db:push` and `fli db:jsonschema` before this command if schema has
changed recently — or just run `fli validate` first.

```js
const root         = context.paths.root
const schemaLite   = resolve(context.paths.db, 'schema.lite')
const schemaJson   = resolve(context.paths.db, 'schema.json')
const resourcesDir = resolve(context.paths.web, 'src/resources')
const routesDir    = resolve(context.paths.web, 'src/routes')
const adminDir     = resolve(routesDir, 'admin')
const onlyModel    = arg.model?.toLowerCase() || null
const created      = []

// ─── Guard ────────────────────────────────────────────────────────────────────

if (!existsSync(schemaLite)) {
  log.error('schema.lite not found — run fli db:push first')
  return
}

// ─── Generate fresh schema.json ───────────────────────────────────────────────

log.info('Generating schema.json...')
try {
  execSync(`cd ${root} && bunx litestone jsonschema --schema db/schema.lite`, { stdio: 'pipe' })
} catch (e) {
  log.error(`litestone jsonschema failed: ${e.stderr?.toString().trim() || e.message}`)
  return
}

const { models, defs } = loadSchema(schemaJson)

const targetModels = onlyModel
  ? (models.has(onlyModel) ? [[onlyModel, models.get(onlyModel)]] : [])
  : [...models.entries()]

if (!targetModels.length) {
  log.error(onlyModel
    ? `Model '${onlyModel}' not found in schema.lite`
    : 'No models found in schema.lite')
  return
}

log.info(`Generating admin for: ${targetModels.map(([m]) => m).join(', ')}`)

// ─── Write helper ─────────────────────────────────────────────────────────────

const write = (filePath, content, label) => {
  if (existsSync(filePath) && !flag.force) {
    log.warn(`${label} exists — skipping (--force to overwrite)`)
    return
  }
  if (flag.dry) {
    log.dry(`Would create ${label}:  ${filePath}`)
    return
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  log.success(`Created ${label.padEnd(16)}  ${filePath.replace(root + '/', '')}`)
  created.push(filePath)
}

// ─── _layout.svelte ───────────────────────────────────────────────────────────

const allModelNames = [...models.keys()]
write(
  resolve(adminDir, '_layout.svelte'),
  makeAdminLayout(allModelNames),
  'admin layout'
)

// ─── Admin index ──────────────────────────────────────────────────────────────

write(
  resolve(adminDir, 'index.svelte'),
  makeAdminIndex(targetModels.map(([m]) => m)),
  'admin index'
)

// ─── Per-model files ──────────────────────────────────────────────────────────

for (const [modelName, { properties, required }] of targetModels) {
  const modelDir = resolve(adminDir, modelName)

  // Resource file — create if missing, never overwrite (user may have customised it)
  const resourcePath = resolve(resourcesDir, `${modelName}.svelte`)
  const meshPath     = resolve(resourcesDir, `${modelName}.mesa`)
  if (!existsSync(resourcePath) && !existsSync(meshPath)) {
    write(resourcePath, makeResourceFile(modelName), `${modelName} resource`)
  }

  // PascalCase for resource imports
  const pascal = modelName.charAt(0).toUpperCase() + modelName.slice(1)

  write(resolve(modelDir, 'index.svelte'),        makeModelList(pascal, properties, required, defs),           `${modelName}/list`)
  write(resolve(modelDir, '[id].svelte'),          makeModelDetail(pascal, properties, defs),                   `${modelName}/detail`)
  write(resolve(modelDir, 'new.svelte'),           makeModelForm(pascal, properties, required, defs, false),    `${modelName}/new`)
  write(resolve(modelDir, '[id]/edit.svelte'),     makeModelForm(pascal, properties, required, defs, true),     `${modelName}/edit`)
}

// ─── Summary ──────────────────────────────────────────────────────────────────

if (!flag.dry && created.length) {
  echo('')
  echo(`  ${created.length} file${created.length !== 1 ? 's' : ''} created`)
  echo(`  Admin dashboard:  /admin`)
  if (targetModels.length) {
    echo('')
    for (const [m] of targetModels) {
      echo(`  /${m.padEnd(16)}  /admin/${m}  ·  /admin/${m}/new`)
    }
  }
  echo('')
  echo('  Auth guard checks $session.user.isAdmin')
  echo('  Ensure isAdmin: Boolean is present on your users model')
  echo('')
}
```
