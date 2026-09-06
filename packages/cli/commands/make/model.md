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
    description: Model name (PascalCase and singular)
    required: true
flags:
  service:
    char: s
    type: boolean
    description: Also scaffold api/src/services/<plural>.service.ts
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

// Regular English plurals only, matching Sierra's registry in reverse.
// Irregulars are not guessed: `fli make:resource Person --service people`.
const servicePlural = (model) => {
  const a = model.charAt(0).toLowerCase() + model.slice(1)
  if (/[^aeiou]y$/.test(a))     return a.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(a)) return a + 'es'
  return a + 's'
}

// ─── The stanza ───────────────────────────────────────────────────────────────
// Litestone's scalars are String, Int, Float, Boolean, DateTime, Bytes, Json and
// File. `Integer`, `Text`, `Real` and `Blob` were renamed and are rejected
// outright — a stanza using one does not parse, and nothing downstream runs.

const makeLiteModel = (name, softDelete) => {
  const lines = [
    '',
    `model ${name} {`,
    `  id        Int       @id`,
    `  createdAt DateTime  @default(now())`,
    `  updatedAt DateTime  @default(now()) @updatedAt`,
  ]
  if (softDelete) {
    lines.push(`  deletedAt DateTime?`)
    lines.push('')
    lines.push(`  @@softDelete`)
  }
  lines.push('')
  lines.push('  /// read.create.update.delete — reads are public, writes need a user.')
  lines.push('  @@gate("0.4.4.6")')
  lines.push(`}`)
  lines.push('')
  return lines.join('\n')
}

// ─── The service ──────────────────────────────────────────────────────────────
// The autoloader looks for a `create*Service` factory export and takes the
// registered name from the FILENAME. A file exporting something it cannot
// recognize is skipped with a warning rather than an error.

const makeServiceFile = (model, plural) => {
  const pascalPlural = plural.charAt(0).toUpperCase() + plural.slice(1)
  const accessor     = model.charAt(0).toLowerCase() + model.slice(1)
  return `// The whole service. The name comes from this file's name ('${plural}' →
// /api/${plural} → db.${accessor}), CRUD from the model, 401s from @@gate, and 400s
// from the field rules. Nothing below restates the schema.
import { createBaseService } from '@frontierjs/junction'

export function create${pascalPlural}Service() {
  return createBaseService({
    // Announce every mutation on the '${plural}' channel. Every write through
    // this service is published there under its own name — the five CRUD
    // methods and any action you add.
    //
    // NOTHING IS DELIVERED UNTIL A CONNECTION JOINS, and membership is the
    // app's decision — Junction never makes it. api/src/core/channels.ts is
    // where this app makes it, and it joins every channel a service declares,
    // so this line is enough. Narrow it there, not here: a publish to a
    // channel nobody joined succeeds and reaches nobody, with no error.
    //
    // Joining is a subscription and not a permission: each frame is graded
    // per recipient against this model's own @@gate and @@allow, so a
    // subscriber receives what they could have read and nothing else. Set
    // channel to false to announce nothing.
    channel: '${plural}',
  })
}
`
}

// ─── The Resource ─────────────────────────────────────────────────────────────
// A plain module, not a component. Same template make:resource writes.

const makeResourceFile = (model, plural) => `<script module>
// src/resources/${model}.mesa — the Resource layer.
//
// A Resource is a UI-realm noun, so it is a .mesa file (repo invariant 18):
// the data half in <script module>, and markup below it — optional — is the
// model's default form.
//
// Read this next to db/schema.lite. Nothing here restates anything there: no
// field list, no types, no enum values, no required list, no relations.

import { createResource } from '@frontierjs/sierra/junction'

export const ${plural} = createResource('${plural}', {
  // Stated rather than inferred, so an irregular plural cannot quietly resolve
  // to nothing.
  model: '${model}',

  // Every DOM control hands back a string; the schema is what knows the column
  // is an Int, so it does the casting.
  coerce: true,

  // '' is not NULL to SQLite — a \`String? @unique\` column takes any number of
  // NULLs and rejects the second ''.
  blankToNull: true,

  // Apply the schema's own rules before the request. The server validates
  // regardless; this only moves the first "no" closer to the user.
  validate: true,
})
</script>
`
</script>

Appends one model to `db/schema.lite`. `--service` and `--resource` also write
the two files that hang off it — the Junction service that exposes it and the
Sierra Resource the UI binds to.

For the whole vertical slice, including CRUD routes, use `fli scaffold` instead.

```js
const created  = []
const editor   = process.env.EDITOR || 'vi'
const model    = arg.model.charAt(0).toUpperCase() + arg.model.slice(1)
const plural   = servicePlural(model)

// ─── 1. Append the model to schema.lite ──────────────────────────────────────

const schemaPath = resolve(context.paths.db, 'schema.lite')

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  return
}

const existing = readFileSync(schemaPath, 'utf8')

// Anchored to a declaration. The old check looked for the lowercase plural
// ('model leads') which the generator never writes, so it never matched and a
// second run silently appended a duplicate model.
const declared = new RegExp(`^\\s*model\\s+${model}\\s*\\{`, 'm').test(existing)

if (declared) {
  log.warn(`model ${model} already exists in schema.lite — skipping`)
} else if (flag.dry) {
  log.dry(`Would append model ${model} to schema.lite`)
} else {
  writeFileSync(schemaPath, existing + makeLiteModel(model, flag['soft-delete']), 'utf8')
  log.success(`Appended model ${model} to schema.lite`)
  created.push(schemaPath)
  log.info('Run fli db:push to apply the schema change')
}

// ─── 2. Service ───────────────────────────────────────────────────────────────

if (flag.service) {
  const servicesDir = resolve(context.paths.api, 'src/services')
  const servicePath = resolve(servicesDir, `${plural}.service.ts`)

  if (existsSync(servicePath)) {
    log.warn(`${servicePath} already exists — skipping`)
  } else if (flag.dry) {
    log.dry(`Would create ${servicePath}`)
  } else {
    mkdirSync(servicesDir, { recursive: true })
    writeFileSync(servicePath, makeServiceFile(model, plural), 'utf8')
    log.success(`Created ${servicePath}`)
    created.push(servicePath)
  }
}

// ─── 3. Resource ──────────────────────────────────────────────────────────────

if (flag.resource) {
  const resourcesDir = resolve(context.paths.web, 'src/resources')
  // Named for the MODEL, exported as the SERVICE — repo invariant 19, and the
  // rule `fli check` enforces on the file this command writes.
  const resourcePath = resolve(resourcesDir, `${model}.mesa`)

  if (existsSync(resourcePath)) {
    log.warn(`${resourcePath} already exists — skipping`)
  } else if (flag.dry) {
    log.dry(`Would create ${resourcePath}`)
  } else {
    mkdirSync(resourcesDir, { recursive: true })
    writeFileSync(resourcePath, makeResourceFile(model, plural), 'utf8')
    log.success(`Created ${resourcePath}`)
    created.push(resourcePath)
  }
}

// ─── Open created files ───────────────────────────────────────────────────────

if (flag.open && created.length && !flag.dry) {
  for (const f of created) context.exec({ command: `${editor} "${f}"` })
}
```
