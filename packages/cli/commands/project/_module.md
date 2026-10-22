---
namespace: project
description: FJS project introspection — structural map of services, schema, migrations, and resources
---

<script>
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { resolve, basename } from 'path'
import { execSync } from 'child_process'
import { randomBytes } from 'crypto'

// ─── freshJsonSchema ──────────────────────────────────────────────────────────
// Regenerates schema.json from schema.lite and returns the parsed object.
// Same approach as fli:validate — shells out to litestone jsonschema silently.

const freshJsonSchema = ($) => {
  const root = $.paths.root
  execSync(`${$.bin('litestone')} jsonschema --schema db/schema.lite`, {
    cwd: root, stdio: 'pipe',
  })
  const schemaJson = resolve($.paths.db, 'schema.json')
  return JSON.parse(readFileSync(schemaJson, 'utf8'))
}

// ─── freshAccess ──────────────────────────────────────────────────────────────
// The Warden's own reading of the schema — the same object `access.snapshot.md`
// renders. The JSON Schema says only THAT a model has row policies
// (`x-litestone-policies: true`), never what they admit, and field protection
// is not in it at all, so a page asking *what can a level-4 caller do* has to
// read it here. Shelled out for the reason the schema is: this package imports
// no litestone.

const freshAccess = ($) => JSON.parse(execSync(
  `${$.bin('litestone')} access --schema db/schema.lite --json --stdout`,
  { cwd: $.paths.root, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 },
).toString())

// ─── scanFiles ────────────────────────────────────────────────────────────────
// Returns all files under a directory matching one or more extensions.
// Recursive: an app may group a service in its own folder
// (api/src/services/apps/apps.service.ts) rather than keeping them flat.

const scanFiles = (dir, ...exts) => {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = resolve(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        walk(full)
      } else if (e.isFile() && exts.some(x => e.name.endsWith(x))) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out.sort()
}

// ─── the committed app snapshot ───────────────────────────────────────────────
//
// `core/app-entry.js` owns it — where the snapshot is, what wrote it, what it
// says, and the sentence to print when there is none. It lived here AND there
// until `FJS-D240`, in five pieces, and the missing-file sentence had already
// drifted between the two copies.
//
// Imported rather than required at module scope, because a `<script>` block
// compiles above `run()` and `global.fliRoot` is not resolved yet up there.
const appEntryModule = () =>
  import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))

// ─── extractResourceMeta ──────────────────────────────────────────────────────
// Reads a resource module and extracts service, model and hook names.
//
// **Unlike a service, a Resource has no committed artefact to read.** It is
// constructed in the browser at runtime, so the only thing available is the
// `createResource(...)` call — and that call's arguments are literals, which is
// what makes reading them sound where scanning a service was not. What is read
// here is the call, not the file: everything below is matched INSIDE the
// argument list, and comments are stripped first, because a resource file is
// mostly prose and `model:` in a sentence is not a declaration (the same shape
// as the body tag written inside a comment, which this repo already has a rule
// for).
//
// The service name is the FIRST POSITIONAL ARGUMENT — it is not a `service:`
// key: `createResource('children', { model: 'Child' })`. The file name is the
// model where a model exists (Invariant 19), so a stated `model:` means the two
// disagree and is worth showing.

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// The balanced argument list of the first createResource( … ) call, or null.
// Counted rather than matched: a nested `{ hooks: { before: { … } } }` ends three
// braces deep and `[^)]*` stops at the first one that closes an inner call.
const createResourceArgs = (src) => {
  const at = src.search(/createResource\s*\(/)
  if (at === -1) return null
  const open = src.indexOf('(', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  return null   // unbalanced — an unparseable file says nothing rather than half
}

const extractResourceMeta = (src, filename) => {
  const name = basename(filename).replace(/\.(mesa|js)$/, '')
  const args = createResourceArgs(stripComments(src))
  if (!args) return { name, model: null, service: null, hooks: [] }

  const serviceM = args.match(/^\s*['"]([\w-]+)['"]/)
  const modelM   = args.match(/\bmodel\s*:\s*['"](\w+)['"]/)

  // hooks: { before: { create: [stampWorkspace] } } — read structurally, one
  // phase and one method at a time. The previous version swept the block for any
  // lowercase identifier minus a skip list, which counts words rather than
  // reading hooks: an argument, a property name and a hook all matched.
  const hookFns  = []
  const hooksAt  = args.match(/\bhooks\s*:\s*\{([\s\S]*)$/)
  if (hooksAt) {
    const phaseRe = /\b(before|after|around|error)\s*:\s*\{([^}]*)\}/g
    let pm
    while ((pm = phaseRe.exec(hooksAt[1])) !== null) {
      const methodRe = /\b\w+\s*:\s*\[([^\]]*)\]/g
      let mm
      while ((mm = methodRe.exec(pm[2])) !== null) {
        // A NAME, or nothing. An inline `ctx => stamp(ctx)` is anonymous, and
        // showing the text of it in a list of hook names is the same mistake at
        // one remove — the viewer's line reads as a name whatever is put there.
        for (const raw of mm[1].split(',')) {
          const fn = raw.trim()
          if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(fn)) hookFns.push(fn)
        }
      }
    }
  }

  return {
    name,
    model:   modelM   ? modelM[1]   : null,
    service: serviceM ? serviceM[1] : null,
    hooks:   [...new Set(hookFns)],
  }
}

// ─── extractServerMeta ────────────────────────────────────────────────────────
// Reads server.ts (or server.js) and detects which tier-1 FJS packages are
// configured. Returns a structured packages array — one entry per known package,
// installed: true/false.
//
// Detection strategy: import presence + app.configure() call.
// Tier-1 packages: auth, conduit, caravan, notifications
// Tier-2 packages: litestream (config file), mailer (the junction/mail import)

const TIER1_PACKAGES = [
  {
    id:    'auth',
    label: '@frontierjs/auth',
    short: 'auth',
    realm: 'junction',
    signals: ['createLitestoneAuth', 'frontierjs/auth'],
  },
  {
    id:    'conduit',
    label: '@frontierjs/conduit',
    short: 'conduit',
    realm: 'junction',
    signals: ['conduit(', 'frontierjs/conduit', 'app.conduit'],
  },
  {
    id:    'caravan',
    label: '@frontierjs/caravan',
    short: 'caravan',
    realm: 'junction',
    signals: ['caravan(', 'frontierjs/caravan', 'app.caravan'],
  },
  {
    id:    'notifications',
    label: '@frontierjs/notifications',
    short: 'notifications',
    realm: 'junction',
    signals: ['notifications(', 'frontierjs/notifications', 'app.notify('],
  },
  {
    id:    'litestream',
    label: 'litestream',
    short: 'litestream',
    realm: 'litestone',
    signals: ['litestream', 'LITESTREAM'],
  },
]

const extractServerMeta = (root) => {
  // Candidate server entry files — check most specific first.
  // server.* is the scaffolded name; app.* and index.* are what hand-written
  // apps actually use (example/api/app.ts, basecamp/api/src/index.ts), and
  // missing them reported "no packages installed" for both.
  const names = ['server', 'app', 'index']
  const dirs  = ['api/src', 'api', '.']
  const candidates = dirs.flatMap(d =>
    names.flatMap(n => ['ts', 'js'].map(e => resolve(root, d, `${n}.${e}`)))
  )

  const serverFile = candidates.find(f => existsSync(f)) ?? null

  // Signals live wherever the app is COMPOSED, which is not always the entry:
  // basecamp's api/src/index.ts only calls buildBasecampApp(), and every
  // app.configure() sits in api/src/core/app.ts. Reading the entry alone
  // reported "no packages installed" for an app that configures four of them,
  // so scan the API tree.
  const apiDir  = resolve(root, 'api')
  const sources = existsSync(apiDir)
    ? scanFiles(apiDir, '.ts', '.js').filter(f => !/[\\/](test|tests|dist)[\\/]/.test(f))
    : []
  if (!serverFile && !sources.length) return { serverFile: null, packages: [] }

  const src = [
    serverFile ? readFileSync(serverFile, 'utf8') : '',
    ...sources.map(f => readFileSync(f, 'utf8')),
  ].join('\n')

  const packages = TIER1_PACKAGES.map(pkg => ({
    id:        pkg.id,
    label:     pkg.label,
    short:     pkg.short,
    realm:     pkg.realm,
    installed: pkg.signals.some(s => src.includes(s)),
  }))

  // Detect mailer separately (not in COR chips but useful metadata)
  const mailer =
    src.includes('createResendMailer') ? 'resend' :
    src.includes('createSmtpMailer')   ? 'smtp'   :
    src.includes('junction/mail')      ? 'unknown' :
    null

  return { serverFile, packages, mailer }
}
// Reads migration .sql files from db/migrations/ and returns structured rows.
// Does not query the database — file system only.

const parseMigrationFiles = (migrationsDir) => {
  if (!existsSync(migrationsDir)) return []
  return readdirSync(migrationsDir)
    // Both naming schemes in the wild: litestone's 14-digit timestamp
    // (20260804120000_add_orders.sql) and a hand-numbered 001_initial.sql
    .filter(f => /^\d+[_-][\w.-]*\.sql$/.test(f))
    .sort()
    .map(f => ({
      name: f,
      sql:  readFileSync(resolve(migrationsDir, f), 'utf8'),
    }))
}
// ─── buildProjectMap ──────────────────────────────────────────────────────────
//
// ONE reader of the project, for every presentation of it.
//
// There were two. `project:map` assembled its model inline and `project:view`
// had a `buildMap()` of its own, and the two answered differently about the same
// tree: 54 models against 42, because one counted by SHAPE and the fix for that
// landed only in the other (`FJS-1016`). They also collected different fields —
// env health and the app atlas existed in the page's model and in no other — so
// *what does this project contain* had two answers depending on which command
// you asked, which is `FJS-D223` one scope down: the split was a rendering
// choice wearing a command's clothes.
//
// `layer` narrows what is COLLECTED rather than what is shown, so a narrowed run
// is cheaper and its JSON says only what it looked at. `atlas` boots the app
// once for the three registers no file can answer; it degrades rather than
// fails, because a terminal map that needs bun would be a worse command than one
// that says why three sections are missing.

const buildProjectMap = async ($, { layer = '', atlas = true, log } = {}) => {
  const root          = $.paths.root
  const resourcesDir  = $.paths.webResources
  const migrationsDir = resolve($.paths.db, 'migrations')
  const want          = (name) => !layer || layer === name
  const note          = (fn, msg) => { if (log) log[fn](msg) }

  let schema = null
  if (want('schema')) {
    try { schema = freshJsonSchema($) }
    catch (e) { return { error: `litestone jsonschema failed: ${e.message}` } }
  }

  // Degraded rather than fatal, like the atlas: the warden panel says why, and
  // every other section stands.
  let access = null
  if (want('schema')) {
    try { access = freshAccess($) }
    catch (e) { access = { error: `litestone access failed: ${String(e.stderr || e.message).split('\n')[0]}` } }
  }

  let packages = []
  if (want('api')) packages = extractServerMeta(root).packages

  // Read off the committed app snapshot, never scanned from service source —
  // what a service ANSWERS is decided at construction and is not a fact about
  // how a file reads (FJS-254).
  let services = []
  let snapshot = null
  if (want('api')) {
    const { readAppSnapshot, appSnapshotMissingHint } = await appEntryModule()
    snapshot = readAppSnapshot(root)
    if (snapshot) services = snapshot.services
    else note('warn', appSnapshotMissingHint(root))
  }

  let resources = []
  if (want('ui')) {
    resources = scanFiles(resourcesDir, '.js', '.mesa')
      .map(f => extractResourceMeta(readFileSync(f, 'utf8'), f))
  }

  let migrations = []
  if (want('migrations')) migrations = parseMigrationFiles(migrationsDir)

  // Three registers no file can answer — a job registers itself by being
  // autoloaded, a notification takes its type from its own file name, and a
  // principal resolver is installed in code. Read off a BUILT app, and DEGRADED
  // rather than fatal: this is one section of a report whose others are files, so
  // a missing bun costs three sections and never the command.
  let atlasPart = { skipped: true }
  if (atlas && want('api')) {
    const { readAppAtlas } = await appEntryModule()
    const { model, error } = readAppAtlas(root)
    if (error) {
      note('warn', `Atlas unavailable, three sections will say why: ${error.split('\n')[0]}`)
      atlasPart = { error }
    } else {
      atlasPart = { jobs: model.jobs, notifications: model.notifications, principal: model.principal }
    }
  }

  const map = { meta: { generatedAt: new Date().toISOString(), root } }
  if (schema)            map.schema     = schema
  if (access)            map.access     = access
  if (services.length)   map.services   = services
  if (resources.length)  map.resources  = resources
  if (migrations.length) map.migrations = migrations
  if (packages.length)   map.packages   = packages
  map.atlas = atlasPart
  map.env   = (await import(resolve(global.fliRoot, 'core/env-health.js'))).envHealth(root)

  // The rest of what the app snapshot knows and nothing else here does: the hooks
  // that run around EVERY call, the paths the router actually mounted, and the
  // plugins in configure order. `packages` above is a signal scan over the API
  // tree and answers a different question — is this dependency present — so the
  // two are both carried rather than merged.
  if (snapshot) map.app = {
    file:        snapshot.file,
    generatedBy: snapshot.generatedBy,
    appHooks:    snapshot.appHooks,
    routes:      snapshot.routes,
    plugins:     snapshot.plugins,
  }
  return { map }
}

// A model is the kind that SAYS model. `type === 'object'` is true of a `type`
// declaration and a view as well, which is how one presentation counted 54 and
// the other 42 over one tree (`FJS-1016`).
const countModels = (map) => Object.values(map.schema?.$defs ?? {})
  .filter(d => d['x-litestone-kind'] === 'model').length


</script>

## Project commands

```
fli project:map            — the terminal report
fli project:map --json     — the model, for tooling and the console's :map
```
