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
import { resolve, extname, basename } from 'path'
import { execSync } from 'child_process'

// ─── JSON Schema parser ───────────────────────────────────────────────────────
// Reads db/.json/schema.json (output of litestone jsonschema) and extracts model names.
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
//
// A minimal service names no model at all — createBaseService() resolves it from
// the service name, which the autoloader takes from the FILENAME. So an absent
// `model:` is not "nothing to check", it is "check the filename instead".

function parseServiceModel(src) {
  const m = src.match(/model\s*:\s*['"](\w+)['"]/)
  return m ? m[1] : null
}

// ─── Service name → model name ────────────────────────────────────────────────
// The reverse of Sierra's registry: regular English plurals only.
//   leads → Lead · companies → Company · statuses → Status
// Irregulars (people/Person) are not guessable and are not guessed — a miss here
// is reported as a warning, never an error.

function modelNameFor(service) {
  const base = service.endsWith('ies') ? service.slice(0, -3) + 'y'
             : /(s|x|z|ch|sh)es$/.test(service) ? service.slice(0, -2)
             : service.endsWith('s') ? service.slice(0, -1)
             : service
  return base.charAt(0).toUpperCase() + base.slice(1)
}

// ─── Resource parser ──────────────────────────────────────────────────────────
// Extracts service and model from a createResource() call. The service name is
// the FIRST POSITIONAL ARGUMENT — it is not a `service:` key:
//
//   createResource('leads')                        → service 'leads'
//   createResource('people', { model: 'Person' })  → service 'people', model 'Person'
//
// A file may declare several. Every call is returned, because a resource module
// that also builds its relation pickers references more than one service.

function parseResourceRefs(src) {
  const refs = []
  const re = /createResource\s*\(\s*['"]([\w-]+)['"]\s*(?:,\s*\{([^}]*)\})?/g
  let m
  while ((m = re.exec(src)) !== null) {
    const modelM = m[2] ? m[2].match(/model\s*:\s*['"](\w+)['"]/) : null
    refs.push({ service: m[1], model: modelM ? modelM[1] : null })
  }
  return refs
}

// ─── Route parser ─────────────────────────────────────────────────────────────
// Finds resource imports in route files. Sierra resolves no `@/` alias, so the
// import is relative — what matters is the resources/ segment and the basename:
//
//   import { leads } from '../../resources/Lead.mesa'
//   import { leads } from '@/resources/Lead'           (legacy alias, still read)
//
// The basename is the MODEL and the binding is the SERVICE (invariant 19), so
// this reads the left side and never infers one from the other.

function parseRouteResourceImports(src) {
  const imports = []
  const re = /from\s+['"][^'"]*\bresources\/([\w.-]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) {
    imports.push(m[1].replace(/\.(mesa|js)$/, ''))
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
Reads `db/.json/schema.json` (regenerated fresh each run via `litestone jsonschema`)
so results always reflect the current schema, not a stale snapshot.

**Checks:**
- Every service resolves to a model in schema.lite — by its `model:` when it
  declares one, otherwise by the filename the autoloader registers it under
- Every resource names a model that exists and a service file that exists, and
  states its model rather than leaving an irregular plural to be guessed
- Every route's `resources/…` import resolves to an actual file
- `ENCRYPTION_KEY` is set in `.env` if schema.lite contains `@secret` fields
- Required env vars from `_module.md` `requires:` blocks are present in `.env`

Use `--layer` to scope: `schema` `services` `resources` `env`

```js
const root        = context.paths.root
const schemaLite  = resolve(context.paths.db, 'schema.lite')
// One owner for where the derived JSON Schema lives (`core/derived-paths.js`).
// This command both WRITES it and reads it back, so a literal here is the
// shape that regenerates one file and validates another — a clean pass over a
// schema nobody looked at.
const { jsonSchemaPath } = await import(resolve(global.fliRoot, 'core/derived-paths.js'))
const schemaJson  = jsonSchemaPath(context.paths.db)
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
  execSync(`cd ${root} && bunx litestone jsonschema --schema db/schema.lite --out ${schemaJson}`, {
    stdio: 'pipe',
  })
} catch (e) {
  log.error(`litestone jsonschema failed: ${e.stderr?.toString().trim() || e.message}`)
  return
}

if (!existsSync(schemaJson)) {
  log.error(`litestone jsonschema ran but ${schemaJson} was not written`)
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
    const declared = parseServiceModel(readFileSync(file, 'utf8'))

    if (declared) {
      // An explicit model: is checked against every spelling the accessor
      // resolver accepts — the declared name, the accessor, or the plural.
      const hit = [...models].some(m =>
        m === declared ||
        m.charAt(0).toLowerCase() + m.slice(1) === declared ||
        modelNameFor(declared) === m
      )
      if (!hit) {
        err('services', file, `References model '${declared}' which does not exist in schema.lite`)
      }
      continue
    }

    // No model: — the minimal form. The registered service name comes from the
    // filename, and that is what has to resolve to a model.
    const service = basename(file).replace(/\.service\.ts$/, '')
    const guess   = modelNameFor(service)

    if (!models.has(guess)) {
      warn('services', file, `Names no model, so '${service}' must resolve to one — '${guess}' is not in schema.lite. Add model: '<Name>' if the plural is irregular.`)
    }
  }
}

// ─── Layer: resources ─────────────────────────────────────────────────────────

if (!layer || layer === 'resources') {
  const files = scanDir(resourcesDir, '.js', '.mesa')

  log.info(`Resources  ·  checking ${files.length} file${files.length !== 1 ? 's' : ''}`)

  for (const file of files) {
    const refs = parseResourceRefs(readFileSync(file, 'utf8'))

    if (!refs.length) continue  // no createResource() call in this file

    for (const ref of refs) {
      // model: 'Lead' → schema model name is 'Lead' (PascalCase singular)
      if (ref.model && !models.has(ref.model)) {
        err('resources', file, `References model '${ref.model}' which does not exist in schema.lite`)
      }

      // createResource('leads') → api/src/services/leads.service.ts must exist.
      // The autoloader derives the registered name from the filename, so that
      // is the file to look for.
      const svcPath = resolve(servicesDir, `${ref.service}.service.ts`)
      if (!existsSync(svcPath)) {
        err('resources', file, `Calls service '${ref.service}' but ${ref.service}.service.ts does not exist`)
      }

      // A resource that names no model relies on the registry guessing one from
      // the service name — which works for regular plurals and silently degrades
      // to a bare make() for anything else.
      if (!ref.model) {
        warn('resources', file, `createResource('${ref.service}') names no model — add { model: '…' } so an irregular plural cannot resolve to nothing`)
      }
    }
  }

  // ── Routes: resources/<name> imports ────────────────────────────────────

  const routeFiles = scanDirRecursive(routesDir, '.mesa')
  let routesChecked = 0

  for (const file of routeFiles) {
    const imports = parseRouteResourceImports(readFileSync(file, 'utf8'))
    if (!imports.length) continue
    routesChecked++

    for (const name of imports) {
      const exists = ['.js', '.mesa', ''].some(ext =>
        existsSync(resolve(resourcesDir, name + ext))
      )
      if (!exists) {
        err('routes', file, `Imports 'resources/${name}' but no matching file found in ${resourcesDir}`)
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
