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
// The model's whole client-side surface (`FJS-D114`) — the data half in
// <script module>, and the model's default form below it.
//
// What a generated Resource IS lives in `core/resource-template.js`, shared with
// `fli make:resource` and `fli web:resource` — three commands wrote the same
// file three times and had already drifted (Invariant 4).
const { resourceFile } =
  await import(resolve(global.fliRoot, 'core/resource-template.js'))

// ─── Templates: routes ────────────────────────────────────────────────────────
// The pages themselves are `core/crud-templates.js`, shared with
// `fli admin:generate` — two commands wrote the same form twice and had already
// drifted apart on which field is the id. They are built on `@frontierjs/ui`:
// `<${model} />` IS the form — the markup half of the Resource, written by
// `core/resource-template.js` — so nothing about the model is written into
// either page and a column added to schema.lite later still shows up without
// regenerating. The create page and the edit page render the same tag.
//
// The list is the exception, and deliberately: which of twenty columns belong in
// a table is a judgement, so it is named here and that file is where to change
// it.

const { listPage, createPage, editPage } =
  await import(resolve(global.fliRoot, 'core/crud-templates.js'))

const routePages = (model, plural, fields) => {
  const singularLabel = toLabel(model)
  const pluralLabel   = toLabel(plural)
  // Two imports off one file, and they are two different things: the default
  // export is the model's DEFAULT FORM (the resource's markup half), the named
  // one is the accessor. A page needs the form; it needs the accessor for the
  // id field and the gate.
  const imports       = [
    `import ${model} from '../../resources/${model}.mesa'`,
    `import { ${plural} } from '../../resources/${model}.mesa'`,
  ]
  const basePath      = `/${plural}/`
  const columns       = (fields.length ? fields.map(f => f.name) : ['id'])
    .map(name => ({ key: name, label: toLabel(name) }))

  return {
    list: listPage({
      title: pluralLabel, heading: pluralLabel, newLabel: `New ${singularLabel}`,
      basePath, imports, res: plural, columns,
    }),
    create: createPage({
      title: `New ${singularLabel}`, heading: `New ${singularLabel}`,
      submitLabel: `Create ${singularLabel}`, backLabel: 'Back to list',
      basePath, imports, res: plural, form: model,
    }),
    edit: editPage({
      title: singularLabel, heading: singularLabel,
      submitLabel: 'Save', backLabel: `All ${pluralLabel.toLowerCase()}`,
      deleteLabel: 'Delete',
      basePath, imports, res: plural, form: model,
    }),
  }
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

The routes are built on `@frontierjs/ui`, and **neither the create route nor the
edit route contains a form**. The form is the Resource's own markup half, so both
render `<Model />` and differ only in the wording on the button, where Cancel
goes and what happens after a save. Under it, `<Form {resource} />` with no
children IS the form — every writable column in schema order, each with the
control its type implies, the picker rows for a foreign key fetched from the
related service, and a rejection mapped back under the field that caused it — so
neither route names a field, a type or an enum member, and a column added to
`schema.lite` later appears on the next reload without regenerating. The **list** route is the exception and names its columns, because
which fields belong in a table is a judgement call and that file is where to
make it.

The pages themselves live in `core/crud-templates.js`, shared with
`fli admin:generate`: two commands emitting one form is how the two drifted
apart on which column is the id.

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
    resourceFile(modelName, plural),
    'resource'
  )
}

// ─── 4. Routes ────────────────────────────────────────────────────────────────

if (!skipRoutes) {
  const routesBase = resolve(context.paths.webPages, plural)

  const pages = routePages(modelName, plural, fields)

  write(resolve(routesBase, 'index.mesa'),  pages.list,   'route/list')
  write(resolve(routesBase, 'create.mesa'), pages.create, 'route/create')
  write(resolve(routesBase, '[id].mesa'),   pages.edit,   'route/edit')
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
