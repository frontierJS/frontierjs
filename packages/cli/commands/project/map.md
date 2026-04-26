---
title: project:map
description: Structural snapshot of the FJS project — schema, services, resources, migrations
alias: pmap
examples:
  - fli project:map
  - fli project:map --json
  - fli project:map --out project-map.json
  - fli project:map --layer schema
  - fli project:map --layer api
  - fli project:map --layer ui
  - fli project:map --layer migrations
flags:
  json:
    type: boolean
    description: Output raw JSON to stdout
    defaultValue: false
  out:
    type: string
    description: Write JSON to this file path (implies --json)
    defaultValue: ''
  layer:
    type: string
    description: "Scope to one layer: schema | api | ui | migrations"
    defaultValue: ''
---

Reads `schema.lite`, service files, resource files, and migration files to build
a structural snapshot of the project. No running server required.

Use `--json` to pipe output to tooling. Use `--out` to write `project-map.json`
for use with FJSChain or Basecamp.

```js
const root          = context.paths.root
const schemaLite    = resolve(context.paths.db, 'schema.lite')
const servicesDir   = existsSync(resolve(context.paths.api, 'src/services'))
  ? resolve(context.paths.api, 'src/services')
  : resolve(context.paths.api, 'services')
const resourcesDir  = context.paths.webResources
const migrationsDir = resolve(context.paths.db, 'migrations')

const layer  = (flag.layer || '').toLowerCase()
const toJson = flag.json || !!flag.out

// ── Guard ──────────────────────────────────────────────────────────────────────

if (!existsSync(schemaLite)) {
  log.error('schema.lite not found — run this from a FJS project root')
  return
}

// ── Schema ─────────────────────────────────────────────────────────────────────

let schema = null
if (!layer || layer === 'schema') {
  log.info('Reading schema...')
  try {
    schema = freshJsonSchema(context)
  } catch (e) {
    log.error(`litestone jsonschema failed: ${e.message}`)
    return
  }
}

// ── Server / packages ──────────────────────────────────────────────────────────

let packages = []
if (!layer || layer === 'api') {
  const serverMeta = extractServerMeta(root)
  packages = serverMeta.packages
  if (!toJson) {
    const installed = packages.filter(p => p.installed).map(p => p.short)
    const missing   = packages.filter(p => !p.installed).map(p => p.short)
    if (installed.length) log.info(`Plugins: ${installed.join(', ')}`)
    if (missing.length)   log.info(`Not detected: ${missing.join(', ')}`)
  }
}

// ── Services ───────────────────────────────────────────────────────────────────

let services = []
if (!layer || layer === 'api') {
  const files = scanFiles(servicesDir, '.service.ts')
  services = files.map(f => extractServiceMeta(readFileSync(f, 'utf8'), f))
  if (!toJson) log.info(`API:  ${services.length} service${services.length !== 1 ? 's' : ''} found`)
}

// ── Resources ──────────────────────────────────────────────────────────────────

let resources = []
if (!layer || layer === 'ui') {
  const files = scanFiles(resourcesDir, '.mesa', '.svelte')
  resources = files.map(f => extractResourceMeta(readFileSync(f, 'utf8'), f))
  if (!toJson) log.info(`UI:   ${resources.length} resource${resources.length !== 1 ? 's' : ''} found`)
}

// ── Migrations ─────────────────────────────────────────────────────────────────

let migrations = []
if (!layer || layer === 'migrations') {
  migrations = parseMigrationFiles(migrationsDir)
  if (!toJson) log.info(`DB:   ${migrations.length} migration file${migrations.length !== 1 ? 's' : ''} found`)
}

// ── Assemble ───────────────────────────────────────────────────────────────────

const map = {
  meta: {
    generatedAt: new Date().toISOString(),
    root,
  },
}
if (schema)              map.schema     = schema
if (services.length)     map.services   = services
if (resources.length)    map.resources  = resources
if (migrations.length)   map.migrations = migrations
if (packages.length)     map.packages   = packages

// ── JSON output ────────────────────────────────────────────────────────────────

if (flag.out) {
  const outPath = resolve(root, flag.out)
  writeFileSync(outPath, JSON.stringify(map, null, 2))
  log.success(`Written to ${flag.out}`)
  return
}

if (toJson) {
  echo(JSON.stringify(map, null, 2))
  return
}

// ── Terminal view ──────────────────────────────────────────────────────────────

echo('')

if (schema) {
  const defs   = schema.$defs || {}
  const models = Object.entries(defs).filter(([, d]) => d.type === 'object' && !d['x-litestone-file'])
  const enums  = Object.entries(defs).filter(([, d]) => d.type === 'string'  && d.enum)

  echo(`  ${chalk.bold.cyan('Schema')}  ·  ${models.length} model${models.length !== 1 ? 's' : ''}  ·  ${enums.length} enum${enums.length !== 1 ? 's' : ''}`)
  echo('')

  for (const [name, def] of models) {
    const gate  = def['x-gate']
    const rels  = def['x-relations'] ?? []
    const fCnt  = Object.keys(def.properties ?? {}).length

    const gateStr = gate
      ? chalk.dim(`  @@gate(${gate.read}.${gate.create}.${gate.update}.${gate.delete})`)
      : ''
    const relStr  = rels.length
      ? chalk.dim(`  → ${rels.map(r => r.model).join(', ')}`)
      : ''

    echo(`    ${chalk.yellow(name.padEnd(22))} ${chalk.dim(String(fCnt).padStart(2) + ' fields')}${gateStr}${relStr}`)
  }

  if (enums.length) {
    echo('')
    for (const [name, def] of enums) {
      echo(`    ${chalk.dim('enum')} ${chalk.yellow(name)}  ${chalk.dim(def.enum.join(' | '))}`)
    }
  }

  echo('')
}

if (services.length) {
  echo(`  ${chalk.bold.blue('Services')}  ·  ${services.length} registered`)
  echo('')

  for (const svc of services) {
    const before  = [...new Set(Object.values(svc.hooks.before).flat())]
    const after   = [...new Set(Object.values(svc.hooks.after).flat())]
    const custom  = svc.customMethods.length
      ? chalk.dim(`  +${svc.customMethods.join(', ')}`)
      : ''

    const hookParts = [
      before.length ? chalk.dim(`before:[${before.join(', ')}]`) : '',
      after.length  ? chalk.dim(`after:[${after.join(', ')}]`)   : '',
    ].filter(Boolean).join('  ')

    echo(`    ${chalk.blue(svc.name.padEnd(22))} ${chalk.dim('→ ' + svc.model.padEnd(20))} ${hookParts}${custom}`)
  }

  echo('')
}

if (resources.length) {
  echo(`  ${chalk.bold.hex('#c26a1a')('Resources')}  ·  ${resources.length} registered`)
  echo('')

  for (const res of resources) {
    const svcStr   = res.service ? chalk.dim(` → ${res.service}`) : chalk.red(' → (no service)')
    const hookStr  = res.hooks.length ? chalk.dim(`  [${res.hooks.join(', ')}]`) : ''
    echo(`    ${chalk.hex('#f08030')(res.name.padEnd(22))}${svcStr}${hookStr}`)
  }

  echo('')
}

if (migrations.length) {
  echo(`  ${chalk.bold.magenta('Migrations')}  ·  ${migrations.length} file${migrations.length !== 1 ? 's' : ''}`)
  echo('')

  for (const m of migrations) {
    const lineCount = m.sql.split('\n').filter(l => l.trim() && !l.trim().startsWith('--')).length
    echo(`    ${chalk.dim(m.name)}  ${chalk.dim(lineCount + ' statements')}`)
  }

  echo('')
}

log.success('Map complete')
```
