---
title: fli:validate
description: Cross-realm integrity check — verify services, resources, and routes are consistent with schema.lite
alias: validate
examples:
  - fli validate
  - fli validate --layer schema
  - fli validate --layer services
  - fli validate --layer resources
  - fli validate --layer env
flags:
  layer:
    type: string
    description: "Scope check to one layer: schema | services | resources | env"
    defaultValue: ''
---

<script>
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve, extname } from 'path'
import { execSync } from 'child_process'

// ─── JSON Schema parser ───────────────────────────────────────────────────────
// Reads db/schema.json (output of litestone jsonschema) and extracts model names.
// Models are $defs entries with type "object". Enums are type "string" — excluded.

function parseJsonSchema(src) {
  const schema = JSON.parse(src)
  const defs   = schema.$defs || schema.definitions || {}
  const models = new Set()
  for (const [key, val] of Object.entries(defs)) {
    if (val.type === 'object') models.add(key)
  }
  return models
}

// ─── Service parser ───────────────────────────────────────────────────────────
// Extracts the model name from a Junction service file.
// Matches:  model: 'leads'  or  model: "leads"

function parseServiceModel(src) {
  const m = src.match(/model\s*:\s*['"](\w+)['"]/)
  return m ? m[1] : null
}

// ─── Resource parser ──────────────────────────────────────────────────────────
// Extracts model and service from a createResource() call.
// Matches:  createResource({ model: 'Lead', service: 'leads' })

function parseResourceRefs(src) {
  const modelM   = src.match(/model\s*:\s*['"](\w+)['"]/)
  const serviceM = src.match(/service\s*:\s*['"](\w+)['"]/)
  return {
    model:   modelM   ? modelM[1]   : null,
    service: serviceM ? serviceM[1] : null,
  }
}

// ─── Route parser ─────────────────────────────────────────────────────────────
// Finds resource imports in route .svelte files.
// Matches:  import Foo from '@/resources/Foo.svelte'
//           import { store } from '@/resources/Foo'

function parseRouteResourceImports(src) {
  const imports = []
  const re = /from\s+['"]@\/resources\/([\w.]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) {
    imports.push(m[1].replace(/\.svelte$/, '').replace(/\.mesa$/, ''))
  }
  return imports
}

// ─── _module.md env requirements ─────────────────────────────────────────────
// Extracts vars listed under requires: in _module.md frontmatter.

function parseModuleRequires(src) {
  const fm = src.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return []
  const req = fm[1].match(/requires:\s*\n((?:[ \t]+-[ \t]+\S+\n?)+)/)
  if (!req) return []
  return (req[1].match(/- (\S+)/g) || []).map(l => l.slice(2))
}

// ─── File scanners ────────────────────────────────────────────────────────────

function scanDir(dir, ...exts) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && exts.some(x => e.name.endsWith(x)))
    .map(e => resolve(dir, e.name))
}

function scanDirRecursive(dir, ext, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name)
    if (e.isDirectory()) scanDirRecursive(p, ext, out)
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p)
  }
  return out
}

// ─── Result printer ───────────────────────────────────────────────────────────

function printResults(errors, warns) {
  if (warns.length) {
    echo('')
    for (const w of warns) {
      const rel = w.file.replace(process.cwd() + '/', '')
      echo(`  ⚠  ${rel}`)
      echo(`     ${w.msg}`)
    }
  }

  if (errors.length) {
    echo('')
    for (const e of errors) {
      const rel = e.file.replace(process.cwd() + '/', '')
      echo(`  ✗  [${e.layer}]  ${rel}`)
      echo(`     ${e.msg}`)
    }
    echo('')
  }
}
</script>

Validates referential integrity across schema, services, resources, and routes.
Reads `db/schema.json` (regenerated fresh each run via `litestone jsonschema`)
so results always reflect the current schema, not a stale snapshot.

**Checks:**
- Every service references a model that exists in schema.lite
- Every resource references a model and a service that both exist
- Every route's `@/resources/` imports resolve to an actual file
- `ENCRYPTION_KEY` is set in `.env` if schema.lite contains `@secret` fields
- Required env vars from `_module.md` `requires:` blocks are present in `.env`

Use `--layer` to scope: `schema` `services` `resources` `env`

```js
const root        = context.paths.root
const schemaLite  = resolve(context.paths.db, 'schema.lite')
const schemaJson  = resolve(context.paths.db, 'schema.json')
const servicesDir = existsSync(resolve(context.paths.api, 'src/services'))
  ? resolve(context.paths.api, 'src/services')
  : resolve(context.paths.api, 'services')
const resourcesDir = resolve(context.paths.web, 'src/resources')
const routesDir   = resolve(context.paths.web, 'src/routes')
const envPath     = resolve(root, '.env')
const layer       = (flag.layer || '').toLowerCase()

const errors = []
const warns  = []
const err = (l, file, msg) => errors.push({ layer: l, file, msg })
const warn = (l, file, msg) => warns.push({ layer:  l, file, msg })

// ─── Guard: schema.lite must exist ───────────────────────────────────────────

if (!existsSync(schemaLite)) {
  log.error('schema.lite not found — run fli db:push to initialise')
  return
}

// ─── Generate fresh schema.json ───────────────────────────────────────────────
// Run silently — we only want the file, not the CLI output.

log.info('Generating schema.json...')
try {
  execSync(`cd ${root} && bunx litestone jsonschema --schema db/schema.lite`, {
    stdio: 'pipe',
  })
} catch (e) {
  log.error(`litestone jsonschema failed: ${e.stderr?.toString().trim() || e.message}`)
  return
}

if (!existsSync(schemaJson)) {
  log.error('litestone jsonschema ran but db/schema.json was not written')
  return
}

const models = parseJsonSchema(readFileSync(schemaJson, 'utf8'))
log.info(`Schema loaded  ·  ${models.size} model${models.size !== 1 ? 's' : ''}: ${[...models].join(', ')}`)
echo('')

// ─── Layer: services ──────────────────────────────────────────────────────────

if (!layer || layer === 'services') {
  const files = scanDir(servicesDir, '.service.ts')

  log.info(`Services  ·  checking ${files.length} file${files.length !== 1 ? 's' : ''}`)

  for (const file of files) {
    const model = parseServiceModel(readFileSync(file, 'utf8'))

    if (!model) {
      warn('services', file, 'No model: \'...\' found in service — skipping reference check')
      continue
    }

    if (!models.has(model)) {
      err('services', file, `References model '${model}' which does not exist in schema.lite`)
    }
  }
}

// ─── Layer: resources ─────────────────────────────────────────────────────────

if (!layer || layer === 'resources') {
  const files = scanDir(resourcesDir, '.svelte', '.mesa')

  log.info(`Resources  ·  checking ${files.length} file${files.length !== 1 ? 's' : ''}`)

  for (const file of files) {
    const src  = readFileSync(file, 'utf8')
    const refs = parseResourceRefs(src)

    if (!refs.model && !refs.service) continue  // not a createResource component

    // model: 'Lead' → schema model name is 'leads' (lowercase + s)
    if (refs.model) {
      const schemaName = refs.model.charAt(0).toLowerCase() + refs.model.slice(1) + 's'
      if (!models.has(schemaName) && !models.has(refs.model)) {
        err('resources', file, `References model '${refs.model}' (schema: '${schemaName}') which does not exist in schema.lite`)
      }
    }

    // service: 'leads' → api/src/services/leads.service.ts must exist
    if (refs.service) {
      const svcPath = resolve(servicesDir, `${refs.service}.service.ts`)
      if (!existsSync(svcPath)) {
        err('resources', file, `References service '${refs.service}' but ${refs.service}.service.ts does not exist`)
      }
    }
  }

  // ── Routes: @/resources/Name imports ────────────────────────────────────

  const routeFiles = scanDirRecursive(routesDir, '.svelte')
  let routesChecked = 0

  for (const file of routeFiles) {
    const imports = parseRouteResourceImports(readFileSync(file, 'utf8'))
    if (!imports.length) continue
    routesChecked++

    for (const name of imports) {
      const exists = ['.svelte', '.mesa', ''].some(ext =>
        existsSync(resolve(resourcesDir, name + ext))
      )
      if (!exists) {
        err('routes', file, `Imports '@/resources/${name}' but no matching file found in ${resourcesDir}`)
      }
    }
  }

  if (routesChecked) {
    log.info(`Routes     ·  ${routesChecked} route${routesChecked !== 1 ? 's' : ''} with resource imports checked`)
  }
}

// ─── Layer: env ───────────────────────────────────────────────────────────────

if (!layer || layer === 'env') {
  log.info('Env        ·  checking required vars')

  const envSrc = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const hasVar = (name) => new RegExp(`^${name}=.+`, 'm').test(envSrc)

  // @secret check — grep schema.lite directly since litestone strips these from JSON output
  const schemaSrc = readFileSync(schemaLite, 'utf8')
  if (/@secret|@guarded/.test(schemaSrc)) {
    if (!hasVar('ENCRYPTION_KEY')) {
      err('env', envPath, 'Schema has @secret or @guarded fields but ENCRYPTION_KEY is not set in .env')
    } else {
      // Validate it's 64 hex chars (32 bytes as hex = AES-256)
      const keyMatch = envSrc.match(/^ENCRYPTION_KEY=(.+)$/m)
      const key = keyMatch?.[1]?.trim()
      if (key && !/^[0-9a-fA-F]{64}$/.test(key)) {
        err('env', envPath, `ENCRYPTION_KEY must be 64 hex characters (32 bytes). Got ${key.length} chars — run: fli keygen --format hex --length 32 --name ENCRYPTION_KEY --env`)
      }
    }
  }

  // _module.md requires: blocks — scan both command roots
  const roots = [
    resolve(global.fliRoot, 'commands'),
    resolve(global.projectRoot, 'cli/src/routes'),
  ].filter(existsSync)

  const moduleFiles = roots.flatMap(dir => scanDirRecursive(dir, '_module.md'))

  for (const file of moduleFiles) {
    const required = parseModuleRequires(readFileSync(file, 'utf8'))
    for (const varName of required) {
      if (!hasVar(varName)) {
        warn('env', file, `_module.md declares requires: ${varName} but it is not set in .env`)
      }
    }
  }
}

// ─── Results ──────────────────────────────────────────────────────────────────

echo('')
printResults(errors, warns)

if (errors.length) {
  log.error(`${errors.length} error${errors.length !== 1 ? 's' : ''} found`)
  process.exitCode = 1
} else if (warns.length) {
  log.warn(`${warns.length} warning${warns.length !== 1 ? 's' : ''} — no errors`)
} else {
  log.success('All checks passed')
}
```
