---
title: admin:generate
description: Generate a gate-aware CRUD admin UI from schema.lite — Mesa routes for Sierra, derived at runtime
alias: admin-gen
examples:
  - fli admin:generate
  - fli admin:generate --model Lead
  - fli admin:generate leads --force
  - fli admin:generate --dry
args:
  -
    name: model
    description: Generate routes for a single model only — model name or service name, any case. Omit for all models.
    defaultValue: ''
flags:
  force:
    type: boolean
    description: Overwrite existing files
    defaultValue: false
  external:
    type: boolean
    description: Include @@external models (they mirror foreign tables and usually have no service)
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

// A literal closing script tag ends this block — core/compiler.js extracts it
// with a non-greedy match, and does not care that the tag is inside a comment
// or a string. Every generated Mesa file needs one, so it is assembled from two
// halves here and interpolated into the templates below.
const SC = '<' + '/script>'

// ─── Model discovery ──────────────────────────────────────────────────────────
// Read model names straight out of schema.lite. The JSON Schema is not usable
// for this: $defs is the whole definition table — models, enums and `type T`
// blocks alike — with nothing marking which entries are models.
//
// Same regex make:service --auto uses, plus a body scan for @@external.

function scanModels(src) {
  const braces = (line) => (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length

  const out = []
  let current = null
  let depth = 0

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '')

    if (!current) {
      const m = line.match(/^\s*model\s+([A-Za-z_]\w*)\s*\{/)
      if (!m) continue
      // The opening line is scanned for @@external too — a one-line model body
      // closes on this same line and would otherwise never be looked at.
      current = { name: m[1], external: /@@external/.test(line) }
      depth = braces(line)
      if (depth <= 0) { out.push(current); current = null }
      continue
    }

    if (/@@external/.test(line)) current.external = true
    depth += braces(line)
    if (depth <= 0) { out.push(current); current = null }
  }

  return out
}

// ─── Naming ───────────────────────────────────────────────────────────────────
// Model → service name. Regular English plurals only — the same three rules
// Sierra's schema registry applies in the other direction (schema-registry.js).
// Irregulars are not guessed anywhere in this framework; the generated resource
// passes `model:` explicitly so a miss cannot break resolution either way.

function servicePlural(modelName) {
  const a = modelName.charAt(0).toLowerCase() + modelName.slice(1)
  if (/[^aeiou]y$/.test(a))     return a.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(a)) return a + 'es'
  return a + 's'
}

function toLabel(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim()
}

// ─── resources/<Model>.mesa ───────────────────────────────────────────────────
// The admin uses the app's OWN Resource for a model and writes one only where
// none exists (`FJS-364`). Declaring a second `createResource('users')` beside
// the app's is two stores over one service: a write through the admin leaves
// the app's list stale and the app's write leaves the admin's, with a live
// socket on both and nothing anywhere saying why.
//
// This is also what puts the generated file back inside invariant 19 — one
// Resource per file, named for its model — rather than the one `admin.mesa`
// holding every model that used to sit here. Nothing is ever overwritten, not
// even under `--force`: a hand-written Resource is the app's, and the admin is
// a consumer of it.
//
// The template is `fli make:resource`'s. Both are the same file for the same
// reason, so a divergence here is a bug rather than a variant.

function makeResourceFile(model, service) {
  return `<script module>
// src/resources/${model}.mesa — the Resource layer.
//
// A Resource is a UI-realm noun, so it is a .mesa file (repo invariant 18):
// the data half in <script module>, and markup below it — optional — is the
// model's default form.
//
// Written by \`fli admin:generate\` because no Resource for this model existed.
// It is yours now — edit it freely, and no later run will touch it.
//
// Read this next to db/schema.lite. Nothing here restates it: no field list, no
// types, no enum values, no required list, no relations. The admin pages read
// resource.fields, resource.relations and resource.gate at runtime, so a column
// added later shows up on the next reload.

import { createResource } from '@frontierjs/sierra/junction'

// coerce      — every DOM control hands back a string, \`<input type="number">\`
//               and \`<select>\` included. The schema is the only thing that
//               knows the column is an Int, so it does the casting. Without it
//               a form sends "42" for a Float and is told it is not a number.
// blankToNull — an empty text box submits '', which SQLite does not agree is
//               NULL: \`slug String? @unique\` takes any number of NULLs and
//               rejects the second ''.
// validate    — apply the schema's own rules before the request so the first
//               "no" is local. The server validates regardless; this only moves
//               the answer closer to the user.
//
// The first argument is the SERVICE name and \`model\` is the MODEL. Only the
// regular English plurals were guessed — an irregular (Person -> people) comes
// out wrong. Fix the string if one did; nothing else changes, because the model
// is stated rather than inferred.
export const ${service} = createResource('${service}', {
  model: '${model}',
  coerce: true,
  blankToNull: true,
  validate: true,
})
</script>
`
}

// ─── admin/_session.js ────────────────────────────────────────────────────────
// Only written when the project has no src/session.js of its own.

function makeSession() {
  return `// web/src/routes/admin/_session.js — generated by \`fli admin:generate\`.
//
// The caller's Litestone gate level (0–9) as judged by the SERVER. The admin UI
// reads it only to decide what to offer — \`resource.can('delete', level)\` is a
// UI affordance and never a boundary. Every request is graded again on arrival,
// so a wrong number here changes what a page shows and nothing else.
//
// It starts permissive on purpose: an unknown answer that hides a button the
// user could have pressed is a worse and much quieter failure than one that
// shows a button which comes back 403. Call setLevel() with whatever your login
// response reports and it stops guessing.
//
// Plain object, not a signal — Mesa RULE 8 puts shared state in plain
// JavaScript. Readers declare \`$: session.level\`; this module is the writer, so
// it mutates through its own watchProxy handle, because assigning
// \`session.level\` directly updates the object and notifies nobody (RULE 45).

import { watchProxy } from '@frontierjs/mesa/runtime'

export const session = { level: 7 }

const _w = watchProxy(session)

export function setLevel(level) {
  _w.level = Number(level) || 0
}
`
}

// ─── admin/_module.mesa — the layout ──────────────────────────────────────────
// Layouts nest: this one composes inside the app's root _module.mesa rather
// than replacing it (router/internals.js walks _layoutParents).

function makeLayout(paths, resources) {
  const imports = resources.map(r =>
    `import { ${r.name} } from '${paths.up}resources/${r.model}.mesa'`
  ).join('\n')

  const index = resources.map(r =>
    `  { key: '${r.key}', label: '${r.label}', model: '${r.model}', resource: ${r.name} },`
  ).join('\n')

  return `---
title: Admin
---
<script module>
// Every model this admin covers, and the one place the list exists — the nav
// below and the dashboard both read it rather than a second hand-written copy.
//
// It lives here rather than in a generated src/resources/admin.mesa because
// that file was N Resources under a name no model has, which invariant 19
// refuses twice over (\`FJS-364\`). A layout is already this surface's own
// module; <script module> runs once at import and its named exports are
// importable by any other module (Mesa VISION §11, rule 30), which is all the
// pages below ever needed from it.
//
// Each import is the app's OWN Resource. The admin declares none of its own,
// so a write here and a write from the app's screens move the same store.
${imports}

export const models = [
${index}
]
</script>

<script>
  // models comes from <script module> above — same file, module scope.
  import { isActive } from '@frontierjs/sierra/router'
  import { status } from '@frontierjs/sierra/junction'
  import { session } from '${paths.session}'

  // Both are plain objects that other modules write through a proxy — naming
  // the paths here is what subscribes this component to them.
  $: (status.connected, session.level)
${SC}

<header class="admin-bar">
  <a href="/admin/" class="admin-brand">Admin</a>

  <nav class="admin-nav">
    {#each models as m}
      <a href={'/admin/' + m.key + '/'} class:on={isActive('/admin/' + m.key + '/')}>{m.label}</a>
    {/each}
  </nav>

  <span class="admin-meta">
    <span class="dot" class:live={status.connected}></span>
    gate level {session.level}
  </span>
</header>

<main class="admin-main"><slot /></main>

<style>
  .admin-bar { display: flex; gap: 20px; align-items: center; padding: 12px 20px; border-bottom: 1px solid #e5e7eb; font-family: system-ui, sans-serif }
  .admin-brand { font-weight: 600; color: #111; text-decoration: none }
  .admin-nav { display: flex; gap: 14px; flex-wrap: wrap }
  .admin-nav a { text-decoration: none; color: #6b7280; font-size: 14px }
  .admin-nav a.on { color: #111; font-weight: 600 }
  .admin-meta { margin-left: auto; display: flex; gap: 8px; align-items: center; font-size: 13px; color: #6b7280 }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #d1d5db }
  .dot.live { background: #22c55e }
  .admin-main { padding: 20px; max-width: 980px; font-family: system-ui, sans-serif; color: #111 }
</style>
`
}

// ─── admin/index.mesa — the dashboard ─────────────────────────────────────────

function makeDashboard(paths) {
  return `---
title: Admin
---
<script>
  import { models } from '${paths.models}'
${SC}

<h1>Admin</h1>

<div class="cards">
  {#each models as m}
    <a class="card" href={'/admin/' + m.key + '/'}>
      <b>{m.label}</b>
      <span>model {m.model} · service {m.key}</span>
    </a>
  {/each}
</div>

<style>
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-top: 16px }
  .card { display: grid; gap: 4px; padding: 14px 16px; border: 1px solid #e5e7eb; border-radius: 8px; text-decoration: none; color: #111 }
  .card:hover { border-color: #9ca3af }
  .card span { color: #6b7280; font-size: 12px }
</style>
`
}

// ─── admin/<service>/ — list, create, detail ──────────────────────────────────
// The pages are `core/crud-templates.js`, shared with `fli make:scaffold`.
// Both commands emitted the same form and had drifted: one filtered `id` by
// name, the other asked the resource for its idField, and only one of them
// rendered a picker for a relation the schema declared. Neither page holds a
// form any more — `<ResourceForm />` is the Resource's own markup half, so the
// create page and the detail page render one definition (`FJS-559`).
//
// What is admin-specific is passed in rather than written out: the columns come
// off the schema at runtime (an admin covers every model and cannot name them),
// every page grades its buttons against `session.level`, and a row carries a
// delete. A gate answer is an affordance in all three — the button is disabled
// or annotated, never trusted.

const { listPage, createPage, editPage } =
  await import(resolve(global.fliRoot, 'core/crud-templates.js'))

const adminPages = (m, paths, res) => {
  // The FILE is named for the model and the EXPORT for the service (invariant
  // 19), and the export name is read off the file rather than pluralised again
  // here — `fli make:resource Person --service people` writes `people` into
  // `Person.mesa`, which no plural rule applied to `Person` would have found.
  // Two imports off one file: the default export is the model's DEFAULT FORM —
  // the resource's markup half, which is what a create or an edit page renders
  // — and the named one is the accessor, aliased because these pages cover
  // every model and cannot name each export.
  const imports  = [
    `import ResourceForm from '${paths.up}resources/${m.name}.mesa'`,
    `import { ${res.name} as resource } from '${paths.up}resources/${m.name}.mesa'`,
  ]
  const shared   = {
    imports,
    res:           'resource',
    form:          'ResourceForm',
    basePath:      `/admin/${m.key}/`,
    sessionImport: `import { session } from '${paths.session}'`,
    gate:          true,
  }

  return {
    list: listPage({
      ...shared,
      title: m.label, heading: m.label, newLabel: `New ${m.singularLabel}`,
      deriveColumns: true,
      rowDelete:     true,
    }),
    create: createPage({
      ...shared,
      title: `New ${m.singularLabel}`, heading: `New ${m.singularLabel}`,
      submitLabel: `Create ${m.singularLabel}`, backLabel: `All ${m.pluralLabel.toLowerCase()}`,
    }),
    detail: editPage({
      ...shared,
      title: m.singularLabel, heading: m.singularLabel,
      submitLabel: 'Save', backLabel: `All ${m.pluralLabel.toLowerCase()}`,
      deleteLabel: 'Delete',
    }),
  }
}

</script>

Generates a CRUD admin from `db/schema.lite` — a list, a create form and a
detail/edit page per model, plus a dashboard and a nested layout. The output is
plain Mesa routes for Sierra, dropped into `web/src/routes/admin/`, editable
after generation.

**Nothing about a model is written into the generated pages.** The create page
and the detail page both render `<ResourceForm />` — the Resource's own markup
half — so the form exists once rather than once per page. Under it,
`<Form {resource} />` with no children IS the form: field names, types, enum
members, required flags, foreign keys and gate levels are all read off
`resource.fields` / `.relations` / `.gate` at runtime. Adding a column to
`schema.lite` shows up on the next reload; regenerate only when you add a
**model**.

The pages themselves are `core/crud-templates.js`, shared with
`fli make:scaffold`: two commands emitting one form is how the two drifted
apart on which column is the id.

**Gate levels are UI affordances, never boundaries.** `resource.can(op, level)`
decides whether a button is disabled; Litestone enforces `@@gate` at the data
layer and Junction turns the refusal into a status code no matter what the page
believed. The level comes from `session.level` — the project's own
`web/src/session.js` when it exists, otherwise a generated
`admin/_session.js` stub that starts permissive and wants `setLevel()` wired to
your login response.

**The admin uses the app's own Resources and declares none of its own.** A model
with a `web/src/resources/<Model>.mesa` is imported from it — export name and
service string both read out of the file, never pluralised again — and a model
without one gets that file written, once, from the same template
`fli make:resource` uses. Nothing already there is overwritten, `--force`
included: `--force` is about the generated pages, which are disposable, and a
Resource is not one of those. A second `createResource('users')` beside the
app's would be two stores over one service, where a write on either side leaves
the other stale with a live socket on both (`FJS-364`).

The model index lives in the layout's `<script module>` — `admin/_module.mesa`
exports `models`, and the dashboard imports it from there. It used to be a
generated `resources/admin.mesa` holding every model, which is N Resources in a
file named for no model, and `fli check` refused it twice.

Each model also needs a Junction service on the API side. Missing ones are
reported at the end — create them with `fli make:service <Model>`.

```js
const root         = context.paths.root
const schemaLite   = resolve(context.paths.db, 'schema.lite')
const resourcesDir = resolve(context.paths.web, 'src/resources')
const adminDir     = resolve(context.paths.web, 'src/routes/admin')
const created      = []

// ─── Guard ────────────────────────────────────────────────────────────────────

if (!existsSync(schemaLite)) {
  log.error(`schema.lite not found at ${schemaLite}`)
  log.info('Run this from a FJS project root, or add models with fli make:model.')
  return
}

// ─── Models ───────────────────────────────────────────────────────────────────

const scanned = scanModels(readFileSync(schemaLite, 'utf8'))

if (!scanned.length) {
  log.error('No models found in schema.lite')
  return
}

const external = scanned.filter(m => m.external).map(m => m.name)
const usable   = flag.external ? scanned : scanned.filter(m => !m.external)

if (external.length && !flag.external) {
  log.info(`Skipping @@external model(s): ${external.join(', ')}  (--external to include)`)
}

if (!usable.length) {
  log.error('Every model in schema.lite is @@external — nothing to generate')
  return
}

// Model names are PascalCase and singular; the service is the regular plural.
// `model` is passed to createResource explicitly so an irregular can never
// silently resolve to nothing.
const allModels = usable.map(({ name }) => ({
  name,
  key:           servicePlural(name),
  label:         toLabel(servicePlural(name)),
  singularLabel: toLabel(name),
  pluralLabel:   toLabel(servicePlural(name)).toLowerCase(),
}))

// ─── Target selection ─────────────────────────────────────────────────────────
// --model accepts either spelling, any case: `Lead`, `lead` or `leads`.

const want = (arg.model || '').trim().toLowerCase()

const targets = want
  ? allModels.filter(m => m.name.toLowerCase() === want || m.key.toLowerCase() === want)
  : allModels

if (!targets.length) {
  log.error(`Model '${arg.model}' not found in schema.lite`)
  log.info(`Known: ${allModels.map(m => m.name).join(', ')}`)
  return
}

log.info(`Generating admin routes for: ${targets.map(m => m.name).join(', ')}`)

// ─── Session module ───────────────────────────────────────────────────────────
// Prefer the project's own session over a second copy of the same idea.

const projectSession = resolve(context.paths.web, 'src/session.js')
const ownSession     = existsSync(projectSession)

if (ownSession) log.info('Using the existing web/src/session.js for gate levels')

// Import specifiers, per generated file's depth under src/routes/.
//   admin/_module.mesa, admin/index.mesa      → src is two levels up
//   admin/<service>/*.mesa                    → three
// `up` reaches web/src/, so a Resource is `${up}resources/<Model>.mesa`.
// `models` reaches the layout, which is where the model index now lives.
const pathsAt = (depth) => ({
  up:        '../'.repeat(depth),
  models:    depth === 2 ? './_module.mesa' : '../'.repeat(depth - 2) + '_module.mesa',
  session:   ownSession
    ? '../'.repeat(depth) + 'session.js'
    : (depth === 2 ? './_session.js' : '../'.repeat(depth - 2) + '_session.js'),
})

// ─── Write helper ─────────────────────────────────────────────────────────────

const write = (filePath, content, label) => {
  const shown = filePath.replace(root + '/', '')

  if (existsSync(filePath) && !flag.force) {
    log.warn(`${label.padEnd(22)} exists — skipping (--force to overwrite)`)
    return
  }
  if (flag.dry) {
    log.dry(`Would write ${label.padEnd(22)} ${shown}`)
    return
  }

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  log.success(`${label.padEnd(22)} ${shown}`)
  created.push(shown)
}

// ─── Resources ────────────────────────────────────────────────────────────────
// One per model, and the app's own wherever it already has one. The export name
// is READ off an existing file rather than guessed: a resource over an irregular
// plural exports a name no rule applied to the model would produce.
//
// A file that exists is never rewritten, `--force` included — it is the app's,
// and this command is a consumer of it. `--force` is about the admin's own
// pages, which are disposable, and a Resource is not one of those.

// Both halves of an existing Resource are read rather than guessed: the EXPORT
// name, which is what the generated pages import, and the SERVICE string, which
// is what the admin actually calls. Guessing the second is what made an
// irregular come out as /admin/persons/ over a service named 'people' — the
// data worked and the URL, the route folder and the make:service hint were all
// wrong together.
const EXPORTS_RESOURCE = /export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*createResource\(\s*['"]([^'"]+)['"]/

const unreadable = []

const resources = allModels.map((m) => {
  const file = resolve(resourcesDir, `${m.name}.mesa`)
  const row  = { key: m.key, label: m.label, model: m.name, file }

  if (!existsSync(file)) {
    if (flag.dry) {
      log.dry(`Would write ${`resources/${m.name}.mesa`.padEnd(22)} ${file.replace(root + '/', '')}`)
    } else {
      mkdirSync(resourcesDir, { recursive: true })
      writeFileSync(file, makeResourceFile(m.name, m.key), 'utf8')
      log.success(`${`resources/${m.name}.mesa`.padEnd(22)} ${file.replace(root + '/', '')}`)
      created.push(file.replace(root + '/', ''))
    }
    return { ...row, name: m.key, existed: false }
  }

  // A Resource file with no createResource export is not one this can import
  // from. Naming it beats generating a page whose import resolves to undefined
  // and fails at the first render with no mention of this file.
  const [, name, service] = readFileSync(file, 'utf8').match(EXPORTS_RESOURCE) || []
  if (!name) { unreadable.push(m); return null }

  // The service the app states wins over the plural this command guessed, and
  // it carries: the route folder, the nav link and the missing-service hint all
  // read `key`.
  if (service && service !== m.key) {
    log.info(`${m.name}: using service '${service}' from resources/${m.name}.mesa (guessed '${m.key}')`)
    m.key = service
    row.key = service
  }

  return { ...row, name, existed: true }
}).filter(Boolean)

const resourceFor = (m) => resources.find(r => r.model === m.name)

// ─── Shared files ─────────────────────────────────────────────────────────────
// The layout and the dashboard cover every model regardless of --model: the
// layout carries the index, and generating a partial one would drop the models
// a previous run added.

if (!ownSession) {
  write(resolve(adminDir, '_session.js'), makeSession(), 'admin/_session.js')
}

write(resolve(adminDir, '_module.mesa'), makeLayout(pathsAt(2), resources), 'admin/_module.mesa')
write(resolve(adminDir, 'index.mesa'),   makeDashboard(pathsAt(2)), 'admin/index.mesa')

// ─── Per-model routes ─────────────────────────────────────────────────────────

const routePaths = pathsAt(3)

for (const m of targets) {
  const res = resourceFor(m)
  if (!res) continue

  const dir = resolve(adminDir, m.key)
  const pages = adminPages(m, routePaths, res)

  write(resolve(dir, 'index.mesa'),  pages.list,   `${m.key}/index.mesa`)
  write(resolve(dir, 'create.mesa'), pages.create, `${m.key}/create.mesa`)
  write(resolve(dir, '[id].mesa'),   pages.detail, `${m.key}/[id].mesa`)
}

// ─── Missing services ─────────────────────────────────────────────────────────
// A route with no service behind it renders and then fails on load, which reads
// as a broken page rather than a missing file. Say so here instead.

const serviceDirs = [
  resolve(context.paths.api, 'src/services'),
  resolve(context.paths.api, 'services'),
]

const missing = targets.filter((m) => {
  const accessor = m.name.charAt(0).toLowerCase() + m.name.slice(1)
  return !serviceDirs.some(d =>
    existsSync(resolve(d, `${accessor}.service.ts`)) ||
    existsSync(resolve(d, `${m.key}.service.ts`))
  )
})

// ─── Summary ──────────────────────────────────────────────────────────────────

echo('')

if (flag.dry) {
  echo('  Dry run — nothing written')
} else if (created.length) {
  echo(`  ${created.length} file${created.length !== 1 ? 's' : ''} written`)
} else {
  echo('  Nothing written — every file already exists (--force to overwrite)')
}

echo('')
echo('  /admin/')
// Only the models that got pages. A model whose Resource could not be read is
// reported below, and listing its URL here would say it was generated.
for (const m of targets.filter(resourceFor)) {
  echo(`  /admin/${m.key}/`.padEnd(30) + `list · create · [id]`)
}

if (unreadable.length) {
  echo('')
  log.warn(`Skipped — a Resource file exists but exports no createResource():`)
  for (const m of unreadable) echo(`    web/src/resources/${m.name}.mesa`.padEnd(40) + `→ /admin/${m.key}/ not generated`)
  echo('')
  echo('  The admin imports the app\'s own Resource rather than declaring a second')
  echo('  one, so it needs a name to import. Add the export, or move the file.')
}

if (missing.length) {
  echo('')
  log.warn(`No Junction service found for: ${missing.map(m => m.name).join(', ')}`)
  for (const m of missing) echo(`    fli make:service ${m.name}`.padEnd(34) + `→ the admin calls '${m.key}'`)
  echo('')
  echo('  If the service exists under another name — an irregular plural, say —')
  echo('  correct the createResource() call in that model\'s web/src/resources/<Model>.mesa.')
}

echo('')
echo('  Sierra rescans src/routes on the next build — restart fli web:dev if it is running.')
echo('')
```
