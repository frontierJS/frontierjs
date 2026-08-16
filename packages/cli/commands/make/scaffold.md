---
title: make:scaffold
description: Generate a full vertical slice — schema.lite stanza, service, resource, and CRUD routes
alias: scaffold
examples:
  - fli scaffold Lead
  - fli scaffold Invoice --fields "number:string total:float status:string due:date"
  - fli scaffold Product --fields "name:string price:float active:boolean" --no-routes
  - fli scaffold Note --fields "title:string body:text" --no-resource
  - fli scaffold User --skip-schema
  - fli scaffold Contact --fields "name:string email:email phone:phone" --dry
args:
  -
    name: model
    description: Model name in PascalCase and singular (e.g. Lead, Invoice, BlogPost)
    required: true
flags:
  fields:
    type: string
    description: "Space-separated field specs: name:type (string text email url phone secret slug int float boolean date json)"
    defaultValue: ''
  no-routes:
    type: boolean
    description: Skip route generation — schema + service + resource only
    defaultValue: false
  no-resource:
    type: boolean
    description: Skip resource and routes — schema + service only
    defaultValue: false
  skip-schema:
    type: boolean
    description: Skip schema.lite stanza generation — useful when the model already exists (e.g. from auth:install)
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

// A literal closing script tag ends this block — core/compiler.js extracts it
// with a non-greedy match and does not care that the tag is inside a string.
// Every generated Mesa file needs one, so it is assembled from two halves.
const SC = '<' + '/script>'

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
// Litestone's scalars are String, Int, Float, Boolean, DateTime, Bytes, Json
// and File — and only those. `Integer`, `Text`, `Real` and `Blob` were renamed
// and are rejected outright ("no aliases are accepted"), so a stanza written
// with an old name does not parse and everything downstream of it fails.

const SCHEMA_TYPE = {
  string:   'String',
  text:     'String',
  email:    'String    @email',
  url:      'String    @url',
  phone:    'String    @phone',
  secret:   'String    @secret',
  slug:     'String    @unique',
  int:      'Int',
  integer:  'Int',
  float:    'Float',
  boolean:  'Boolean',
  bool:     'Boolean',
  date:     'DateTime',
  datetime: 'DateTime',
  json:     'Json',
}

// ─── Label helper ─────────────────────────────────────────────────────────────

function toLabel(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim()
}

// ─── Template: schema.lite stanza ────────────────────────────────────────────

function makeSchemaStanza(name, fields, softDelete) {
  const col = 10  // column width for field names

  const lines = [
    '',
    `model ${name} {`,
    `  ${'id'.padEnd(col)}Int       @id`,
  ]

  for (const f of fields) {
    lines.push(`  ${f.name.padEnd(col)}${SCHEMA_TYPE[f.type] || 'String'}`)
  }

  lines.push(`  ${'createdAt'.padEnd(col)}DateTime  @default(now())`)
  lines.push(`  ${'updatedAt'.padEnd(col)}DateTime  @default(now()) @updatedAt`)

  if (softDelete) {
    lines.push(`  ${'deletedAt'.padEnd(col)}DateTime?`)
    lines.push('')
    lines.push('  @@softDelete')
  }

  lines.push('')
  lines.push('  /// read.create.update.delete — reads are public, writes need a user.')
  lines.push('  /// The only place those four answers are written down: the service')
  lines.push('  /// derives its 401s from this, and the UI reads it back as')
  lines.push('  /// resource.gate to decide which buttons to offer.')
  lines.push('  @@gate("0.4.4.6")')
  lines.push('}')
  lines.push('')

  return lines.join('\n')
}

// ─── Template: service ────────────────────────────────────────────────────────
// The autoloader looks for a `create*Service` factory export and takes the
// registered name from the FILENAME — leads.service.ts becomes 'leads'. A file
// exporting something it cannot recognise is skipped with a warning rather than
// an error, so the app starts and the route 404s later.

function makeServiceFile(model, plural, pascalPlural) {
  const accessor = model.charAt(0).toLowerCase() + model.slice(1)
  return `// The whole service. The name comes from this file's name ('${plural}' →
// /api/${plural} → db.${accessor}), CRUD from the model, 401s from @@gate, and 400s
// from the field rules. Nothing below restates the schema.
import { createBaseService } from '@frontierjs/junction'

export function create${pascalPlural}Service() {
  return createBaseService({
    // Announce every mutation on the '${plural}' channel so a subscribed browser
    // updates without polling.
    //
    // SCOPE THIS BEFORE YOU SHIP. Every connection in the channel receives every
    // row, and @@allow policies are evaluated when a row is READ — a broadcast
    // does not re-check them per subscriber. For per-tenant delivery make
    // \`channel\` a function of the context; set it to false to turn it off.
    channel: '${plural}',

    // Adding an action? Declare it, and the CRUD you keep, in one list:
    //
    //   methods: ['find', 'get', 'create', 'patch', 'remove', 'approve'],
    //   async approve(ctx) { … },
    //
    // The list is the surface — anything absent answers 405 naming what is
    // offered, which is also how a verb is removed. Left out entirely, every
    // CRUD verb is answered and custom methods are found by scanning.
  })
}
`
}

// ─── Template: the Resource ───────────────────────────────────────────────────
// A plain module, not a component. The Resource is the UI's half of the API
// boundary; forms are built FROM it and are not it.

function makeResourceFile(model, plural) {
  return `<script module>
// src/resources/${model}.mesa — the Resource layer.
//
// A Resource is a UI-realm noun, so it is a .mesa file (repo invariant 18):
// no markup, everything in <script module>.
//
// Read this next to db/schema.lite. Nothing here restates anything there: no
// field list, no types, no enum values, no required list, no relations. A
// resource names a service and turns three flags on.

import { createResource } from '@frontierjs/sierra/junction'

export const ${plural} = createResource('${plural}', {
  // Stated rather than inferred, so an irregular plural cannot quietly resolve
  // to nothing.
  model: '${model}',

  // Every DOM control hands back a string — \`<input type="number">\` and
  // \`<select>\` included. The schema is the only thing that knows the column is
  // an Int, so it does the casting.
  coerce: true,

  // An empty text box submits '', which SQLite does not agree is NULL: a
  // \`String? @unique\` column takes any number of NULLs and rejects the second
  // ''. Rewrite blanks on nullable fields on the way out.
  blankToNull: true,

  // Check the record against the schema before the request rather than
  // round-tripping to be told the same thing. The server validates regardless.
  validate: true,
})
</script>
`
}

// ─── Template: route — index (list) ──────────────────────────────────────────
// Columns are named here rather than derived: which five of twenty fields
// belong in a table is a judgement, and this is the file to make it in.

function makeIndexRoute(model, plural, fields) {
  const cols = fields.length ? fields.map(f => f.name) : ['id']
  const ths  = cols.map(c => `      <th>${toLabel(c)}</th>`).join('\n')
  const tds  = cols.map(c => `        <td>{row.${c}}</td>`).join('\n')

  return `---
title: ${toLabel(plural)}
---
<script>
  import { ${plural} } from '../../resources/${model}.mesa'
  import { useStore } from '@frontierjs/sierra/junction'
  import { $onDestroy } from '@frontierjs/mesa/runtime'

  const { get: rows, unsubscribe } = useStore(${plural}.store)
  $onDestroy(unsubscribe)

  let error = null

  ${plural}.load().catch(e => { error = e.message })
${SC}

<header class="head">
  <h1>${toLabel(plural)}</h1>
  <a class="btn" href="/${plural}/create/">New ${toLabel(model)}</a>
</header>

{#if error}<p class="err">{error}</p>{/if}

<table>
  <thead>
    <tr>
${ths}
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each rows() as row}
      <tr>
${tds}
        <td><a href={'/${plural}/' + row.id + '/'}>Open</a></td>
      </tr>
    {/each}
  </tbody>
</table>

{#if !rows().length && !error}
  <p class="muted">Nothing here yet.</p>
{/if}

<style>
  .head { display: flex; align-items: center; gap: 16px }
  .head h1 { margin: 0; font-size: 22px }
  .btn { margin-left: auto; border: 1px solid #d1d5db; border-radius: 6px; padding: 5px 12px; text-decoration: none; color: #111; font-size: 14px }
  table { border-collapse: collapse; width: 100%; margin-top: 16px }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eee; font-size: 14px }
  th { color: #6b7280; font-weight: 500 }
  .muted { color: #6b7280; font-size: 13px }
  .err { color: #b91c1c }
</style>
`
}

// ─── The derived form ─────────────────────────────────────────────────────────
// Shared by create.mesa and [id].mesa. Which fields exist, their types, their
// enum members, which are required and which are references are all read off
// `resource.fields` at runtime — which is why a column added to schema.lite
// later shows up on these pages without regenerating them.

function formScript(plural, indent) {
  const i = indent
  return [
    `${i}// The registered document is the CREATE-mode schema, so @id and the`,
    `${i}// columns the server assigns (@default(now()), @updatedAt) are not in it`,
    `${i}// and cannot be rendered as inputs.`,
    `${i}const entries = Object.entries(${plural}.fields).filter(([n]) => n !== 'id')`,
    ``,
    `${i}// A foreign key is emitted as a plain integer; x-relations is the only`,
    `${i}// place it is knowable as a reference, and that is what makes it a picker`,
    `${i}// instead of a number spinner. Regular English plurals only — for an`,
    `${i}// irregular, import that resource and use it here instead.`,
    `${i}const pickers = entries`,
    `${i}  .filter(([, rule]) => rule.references)`,
    `${i}  .map(([name, rule]) => {`,
    `${i}    const target = rule.references.model`,
    `${i}    const res    = createResource(`,
    `${i}      target.charAt(0).toLowerCase() + target.slice(1) + 's',`,
    `${i}      { model: target },`,
    `${i}    )`,
    `${i}    const label = Object.keys(res.fields).find(f => res.fields[f].type === 'string')`,
    `${i}    return { name, res, label: label ?? 'id' }`,
    `${i}  })`,
    ``,
    `${i}// Replaced wholesale rather than mutated: replacement is the reactive`,
    `${i}// operation (Mesa RULE 43).`,
    `${i}let options = {}`,
    ``,
    `${i}Promise.all(pickers.map(p =>`,
    `${i}  p.res.service.getOptions({}, { limit: 200, orderBy: p.label })`,
    `${i}    .then(r => [p.name, (r.data ?? r ?? []).map(row => ({`,
    `${i}      value: row.id, label: String(row[p.label] ?? row.id),`,
    `${i}    }))])`,
    `${i}    .catch(() => [p.name, []])`,
    `${i})).then(pairs => { options = Object.fromEntries(pairs) })`,
    ``,
    `${i}const problem = (name) => errors.find(e => e.field === name)?.message`,
  ].join('\n')
}

function formMarkup() {
  return `  {#each entries as [name, rule]}
    <label>
      <span class="lbl">
        <b>{name}</b>
        {#if rule.required}<i class="req">*</i>{/if}
      </span>

      {#if rule.references}
        <select bind:value={draft[name]}>
          <option value="">—</option>
          {#each (options[name] ?? []) as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      {:else if rule.enum}
        <select bind:value={draft[name]}>
          <option value="">—</option>
          {#each rule.enum as choice}
            <option value={choice}>{choice}</option>
          {/each}
        </select>
      {:else if rule.type === 'boolean'}
        <input type="checkbox" bind:checked={draft[name]} />
      {:else if rule.type === 'integer' || rule.type === 'number'}
        <input type="number" bind:value={draft[name]} min={rule.minimum} max={rule.maximum} />
      {:else if rule.format === 'date-time'}
        <input type="datetime-local" bind:value={draft[name]} />
      {:else}
        <input
          type={rule.format === 'email' ? 'email' : rule.format === 'uri' ? 'url' : 'text'}
          bind:value={draft[name]}
          maxlength={rule.maxLength}
        />
      {/if}

      {#if problem(name)}<span class="err">{problem(name)}</span>{/if}
    </label>
  {/each}`
}

const FORM_STYLE = `<style>
  form { display: grid; gap: 14px; max-width: 520px; margin-top: 16px }
  label { display: grid; gap: 4px }
  .lbl { font-size: 13px; color: #374151 }
  .req { color: #b91c1c; font-style: normal }
  input, select { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit }
  .row { display: flex; gap: 10px; align-items: center }
  button { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit }
  button[disabled] { opacity: .45; cursor: not-allowed }
  button.danger { color: #b91c1c; border-color: #fca5a5 }
  a.cancel { color: #6b7280; text-decoration: none; font-size: 14px }
  .err { color: #b91c1c; font-size: 12px }
  .muted { color: #6b7280; font-size: 13px }
</style>`

// ─── Template: route — create ─────────────────────────────────────────────────

function makeCreateRoute(model, plural) {
  return `---
title: New ${toLabel(model)}
---
<script>
  import { ${plural} } from '../../resources/${model}.mesa'
  import { createResource, ResourceValidationError } from '@frontierjs/sierra/junction'
  import { goto } from '@frontierjs/sierra/router'

  let draft  = ${plural}.make()
  let errors = []
  let failed = null
  let saving = false

${formScript(plural, '  ')}

  async function save() {
    failed = null

    // Validate what will actually be SENT, not what the DOM holds: the inputs
    // give back strings and coerce() casts them using the schema's types.
    // Checking the raw draft reports "must be a number" for a good "42".
    const payload = ${plural}.coerce(draft)
    errors = ${plural}.validate(payload, 'create')
    if (errors.length) return

    saving = true
    try {
      const created = await ${plural}.service.create(payload)
      goto('/${plural}/' + created.id + '/')
    } catch (e) {
      // A ResourceValidationError never left the browser. Anything else is the
      // server's answer — including @@gate's 401.
      errors = e instanceof ResourceValidationError ? e.errors : []
      failed = e.message
    } finally {
      saving = false
    }
  }
${SC}

<h1>New ${toLabel(model)}</h1>

<form on:submit|preventDefault={save}>
${formMarkup()}

  <div class="row">
    <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Create'}</button>
    <a class="cancel" href="/${plural}/">Cancel</a>
  </div>
</form>

{#if failed}<p class="err">{failed}</p>{/if}

${FORM_STYLE}
`
}

// ─── Template: route — detail and edit, one page ─────────────────────────────

function makeEditRoute(model, plural) {
  return `---
title: ${toLabel(model)}
---
<script>
  import { ${plural} } from '../../resources/${model}.mesa'
  import { createResource, ResourceValidationError } from '@frontierjs/sierra/junction'
  import { page, goto } from '@frontierjs/sierra/router'

  // Read once at setup: navigating to a different id remounts the component.
  const id = page.params.id

  let draft    = ${plural}.make()
  let loaded   = false
  let errors   = []
  let failed   = null
  let saving   = false
  let deleting = false

${formScript(plural, '  ')}

  ${plural}.service.get(id)
    .then(record => { draft = record; loaded = true })
    .catch(e => { failed = e.message })

  async function save() {
    failed = null
    const payload = ${plural}.coerce(draft)
    // 'patch' mode: an absent field means "leave it alone", so required is not
    // re-asserted on fields this form did not touch.
    errors = ${plural}.validate(payload, 'patch')
    if (errors.length) return

    saving = true
    try { draft = await ${plural}.service.patch(id, payload) }
    catch (e) {
      errors = e instanceof ResourceValidationError ? e.errors : []
      failed = e.message
    } finally { saving = false }
  }

  async function remove() {
    if (!confirm('Delete ${model} ' + id + '?')) return
    failed = null
    deleting = true
    try {
      await ${plural}.service.remove(id)
      goto('/${plural}/')
    } catch (e) {
      failed = e.message
      deleting = false
    }
  }
${SC}

<header class="row">
  <h1>${toLabel(model)} {id}</h1>
  <a class="cancel" href="/${plural}/">← All ${toLabel(plural).toLowerCase()}</a>
</header>

{#if !loaded && !failed}<p class="muted">Loading…</p>{/if}

{#if loaded}
  <form on:submit|preventDefault={save}>
${formMarkup()}

    <div class="row">
      <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      <button type="button" class="danger" on:click={remove} disabled={deleting}>Delete</button>
    </div>
  </form>
{/if}

{#if failed}<p class="err">{failed}</p>{/if}

${FORM_STYLE}
`
}
</script>

Generates a complete vertical slice from a single model name — one stanza in
`db/schema.lite`, one Junction service, one Sierra Resource, and three Mesa
routes. Each layer is wired to the next, and every one of them traces back to
the schema. Run `fli db:push` afterwards to apply the schema change.

Use `--fields` to seed real fields across all layers from the start:

```
fli scaffold Lead --fields "name:string email:email status:string"
```

Supported field types: `string` `text` `email` `url` `phone` `secret` `slug`
`int` `float` `boolean` `date` `datetime` `json`. Defaults to `string` when the
type is omitted.

The **list** route names its columns, because which fields belong in a table is
a judgement call and that file is where to make it. The **create and edit**
routes name nothing: they read `resource.fields` at runtime, so a column added
to `schema.lite` later appears on the next reload without regenerating.

Without `--fields` a minimal stub is generated — id + timestamps only — ready to
extend in `schema.lite`.

```js
const modelName  = arg.model.charAt(0).toUpperCase() + arg.model.slice(1)
const lower      = modelName.charAt(0).toLowerCase() + modelName.slice(1)
const fields     = parseFields(flag.fields)
const skipRoutes = flag['no-routes'] || flag['no-resource']
const editor     = process.env.EDITOR || 'vi'
const created    = []

// Model → service name. Regular English plurals only — the same three rules
// Sierra's schema registry applies in the other direction. Irregulars are not
// guessed anywhere in this framework; the resource states `model` explicitly so
// a miss cannot break resolution.
const plural = /[^aeiou]y$/.test(lower)     ? lower.slice(0, -1) + 'ies'
             : /(s|x|z|ch|sh)$/.test(lower) ? lower + 'es'
             : lower + 's'

const pascalPlural = plural.charAt(0).toUpperCase() + plural.slice(1)

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
  log.success(`Created ${label.padEnd(12)}  ${path}`)
  created.push(path)
  return true
}

// ─── 1. schema.lite ───────────────────────────────────────────────────────────

const schemaPath = resolve(context.paths.db, 'schema.lite')

if (flag['skip-schema']) {
  log.info('Skipping schema.lite — assumed to already contain model ' + modelName)
} else {
  if (!existsSync(schemaPath)) {
    log.error('schema.lite not found — run fli db:push in an existing project first')
    return
  }

  const existing = readFileSync(schemaPath, 'utf8')

  // Anchored to a model declaration: a plain includes() also matched the name
  // where it appears as a relation type in some other model.
  const declared = new RegExp(`^\\s*model\\s+${modelName}\\s*\\{`, 'm').test(existing)

  if (declared && !flag.force) {
    log.warn(`model ${modelName} already exists in schema.lite — skipping (use --force to overwrite, or --skip-schema to silence)`)
  } else if (flag.dry) {
    log.dry(`Would append model ${modelName} to schema.lite`)
  } else {
    writeFileSync(schemaPath, existing + makeSchemaStanza(modelName, fields, flag['soft-delete']), 'utf8')
    log.success(`Appended model        schema.lite`)
    created.push(schemaPath)
  }
}

// ─── 2. Service ───────────────────────────────────────────────────────────────
// Named for the service, not the model: the autoloader derives the registered
// name from the filename, so leads.service.ts is what makes /api/leads exist.

write(
  resolve(context.paths.api, `src/services/${plural}.service.ts`),
  makeServiceFile(modelName, plural, pascalPlural),
  'service'
)

// ─── 3. Resource ──────────────────────────────────────────────────────────────

if (!flag['no-resource']) {
  // Invariant 19: a resource file is named for its noun — PascalCase, singular —
  // exactly the split the Data realm already makes between `model Note` and
  // `db.note`. The filename is the MODEL; the export inside stays the lowercase
  // accessor. Where the plural is irregular that puts the irregularity in the
  // filename, where it is visible.
  write(
    resolve(context.paths.webResources, `${modelName}.mesa`),
    makeResourceFile(modelName, plural),
    'resource'
  )
}

// ─── 4. Routes ────────────────────────────────────────────────────────────────

if (!skipRoutes) {
  const routesBase = resolve(context.paths.webPages, plural)

  write(resolve(routesBase, 'index.mesa'),  makeIndexRoute(modelName, plural, fields), 'route/list')
  write(resolve(routesBase, 'create.mesa'), makeCreateRoute(modelName, plural),        'route/create')
  write(resolve(routesBase, '[id].mesa'),   makeEditRoute(modelName, plural),          'route/edit')
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
    echo(`  Routes: /${plural}/  ·  /${plural}/create/  ·  /${plural}/[id]/`)
    echo(`  Add a nav link to your layout pointing at /${plural}/`)
  }
  echo('')
}

if (flag.open && created.length && !flag.dry) {
  for (const f of created) context.exec({ command: `${editor} "${f}"` })
}
```
