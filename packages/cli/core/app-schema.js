// core/app-schema.js — what an app's schema and service layer ACTUALLY hold.
//
// Two questions, one owner each, because both used to be answered twice and the
// two answers disagreed:
//
//   appSchemaModels(root)  every model the app's seed declares
//   appServices(root)      every service the app answers on, and its model
//
// ─── Why db/schema.lite is not the answer ─────────────────────────────────
//
// An app assembles its seed from three places and only the first is that file:
//
//   1. `db/schema.lite`, plus any sibling `.lite` it imports — `db/auth.lite`
//      is the shape `fli auth:install` writes.
//   2. Fragments a PACKAGE ships and the app appends IN MEMORY:
//      `authSchemaFragments()`, `outboxSchemaFragment()`. Nothing reaches disk,
//      so a file scan cannot see them.
//   3. `extend model X` in a file of the app's own, naming a model from either.
//
// Reading (1) alone makes every reader wrong about a model that came from a
// package. Measured on `example`: `fli check`'s `service-model` reported a
// correct `users.service.ts` as naming a model that does not exist, and
// `fli admin:generate` silently generated an admin panel with no `User` screen
// in it — the one model an admin panel is most about. Both read the file.
//
// (2) is read off each dependency's own `exports` map and never a guessed path,
// the same rule the litestone parser's own resolver follows and the same one
// `package-model-drift` already applies.
//
// ─── Why a service name cannot be derived ─────────────────────────────────
//
// It is the FILENAME. `shipping-methods.service.ts` answers on
// `/shipping-methods`, and no rule applied to `ShippingMethod` produces that
// string: the plural of a camelCase model is `shippingMethods`, which is a
// different service and, in an app that never declared one, no service at all.
//
// A generator that guessed wrote pages calling a URL the app does not serve —
// five of `example`'s models, every one of them a 404 with the page rendering
// normally around it. So the services directory is READ, and a model with no
// service is reported by name rather than given an invented one.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename }                        from 'node:path'

const safeRead = (dir) => { try { return readdirSync(dir) } catch { return [] } }

// The level scale as the @@gate grammar spells it. Litestone owns the numbers;
// this is a reading of a declaration, not a second definition of the scale.
const GATE_LEVELS = {
  STRANGER: 0, VISITOR: 1, READER: 2, CREATOR: 3, USER: 4,
  ADMINISTRATOR: 5, OWNER: 6, SYSADMIN: 7, SYSTEM: 8, LOCKED: 9,
}

/**
 * The READ level a model's `@@gate` requires, or null where it declares none.
 *
 * Both spellings, because an app that writes its gate by name would otherwise
 * be graded as declaring none — which is the shape both apps in this repo use.
 * "R.C.U.D" inherits: a position not stated takes the one before it.
 */
function readGate(body) {
  const compact = body.match(/@@gate\s*\(\s*['"`]([\d.]+)['"`]\s*\)/)
  if (compact) return Number(compact[1].split('.')[0])

  const named = body.match(/@@gate\s*\(([^)]*[A-Za-z][^)]*)\)/)
  if (!named) return null
  const read = named[1].match(/read\s*:\s*([A-Za-z_]+)/)
  if (read) return GATE_LEVELS[read[1]] ?? null
  // `@@gate(SYSTEM)` — one level for every operation.
  const flat = named[1].trim().match(/^([A-Za-z_]+)$/)
  return flat ? GATE_LEVELS[flat[1]] ?? null : null
}

/** Models declared in one `.lite` text. A line scan — no parser, no database. */
export function declaredModels(text) {
  const out   = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) out.push({ name: m[1], line: i + 1 })
  }
  return out
}

/**
 * Every `.lite` a dependency ships, asked of its `exports` map and of nothing
 * else. A package that exports none ships none as far as this is concerned.
 */
export function shippedSchemas(root) {
  const out = []
  let pkg
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { return out }

  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const dir = join(root, 'node_modules', name)
    let manifest
    try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { continue }

    for (const target of Object.values(manifest.exports ?? {})) {
      // Only the plain-string form. A conditional export ({ import, require })
      // is how JavaScript is published and is not how a schema fragment is.
      if (typeof target !== 'string' || !target.endsWith('.lite')) continue
      const file = join(dir, target)
      if (!existsSync(file)) continue
      out.push({ pkg: name, file, text: readFileSync(file, 'utf8') })
    }
  }
  return out
}

/**
 * Every model this app has, with where it came from.
 *
 * `origin` is `'app'` for a model the app's own db/ declares and the package
 * name for one a dependency ships. It is carried rather than flattened because
 * the two are not interchangeable to every caller: a generator writing screens
 * over a package's model is doing something an app author may not expect, and
 * saying so is cheaper than a surprise.
 *
 * `@@external` models are included and flagged — invariant 2 exempts them and
 * they usually have no service, so a caller filters rather than being filtered
 * for.
 */
export function appSchemaModels(root) {
  const out  = []
  const seen = new Set()

  const add = (text, origin) => {
    const lines = text.split('\n')
    for (const m of declaredModels(text)) {
      if (seen.has(m.name)) continue
      seen.add(m.name)
      // The body decides `@@external` and the gate, and a one-line model body
      // closes on the line the name is on — so that line is scanned too.
      let depth = 0
      const body = []
      for (let i = m.line - 1; i < lines.length; i++) {
        const line = lines[i].replace(/\/\/.*$/, '')
        body.push(line)
        depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
        if (depth <= 0) break
      }
      const text = body.join('\n')
      out.push({
        name: m.name, line: m.line, origin,
        external: /@@external/.test(text),
        gate:     readGate(text),
      })
    }
  }

  const schema = join(root, 'db', 'schema.lite')
  if (existsSync(schema)) add(readFileSync(schema, 'utf8'), 'app')

  // A sibling under db/ — what an `import` in schema.lite reaches, and where
  // `fli auth:install` puts the @@gate("8") machinery.
  const dbDir = join(root, 'db')
  for (const file of safeRead(dbDir)) {
    if (!file.endsWith('.lite') || file === 'schema.lite') continue
    try { add(readFileSync(join(dbDir, file), 'utf8'), 'app') } catch { /* unreadable declares nothing */ }
  }

  for (const dep of shippedSchemas(root)) add(dep.text, dep.pkg)

  return out
}

/**
 * Every service this app answers on.
 *
 * The name is the FILENAME with `.service.*` cut, because that is what junction
 * autoloads and therefore what the URL is. The model is the `model:` the file
 * states, or null — a service over no model is a whole kind of service and not
 * a miss.
 */
export function appServices(root) {
  const out = []
  for (const dir of [join(root, 'api', 'src', 'services'), join(root, 'api', 'services')]) {
    if (!existsSync(dir)) continue
    for (const file of safeRead(dir)) {
      if (!/\.service\.[cm]?[jt]s$/.test(file)) continue
      const path  = join(dir, file)
      let code = ''
      try { code = readFileSync(path, 'utf8') } catch { continue }
      const stated = code.replace(/\/\/.*$/gm, '').match(/\bmodel\s*:\s*['"`]([A-Za-z0-9_]+)['"`]/)
      out.push({
        name:  basename(file).replace(/\.service\.[cm]?[jt]s$/, ''),
        model: stated ? stated[1] : null,
        path,
      })
    }
    break   // the first directory that exists is the app's, as junction probes
  }
  return out
}

/**
 * model name → the service that answers for it, read rather than derived.
 *
 * A service stating `model:` is authoritative. One that does not is matched on
 * the name junction itself would derive, which is the singular of the accessor
 * — so `orders` reaches `Order` and `shipping-methods` reaches nothing, exactly
 * as it does at runtime.
 */
export function serviceForModel(root, services = appServices(root)) {
  const byModel = new Map()
  for (const svc of services) {
    if (svc.model) { if (!byModel.has(svc.model)) byModel.set(svc.model, svc.name); continue }
    const singular = svc.name.replace(/ies$/, 'y').replace(/(s|x|z|ch|sh)es$/, '$1').replace(/s$/, '')
    const pascal   = singular.charAt(0).toUpperCase() + singular.slice(1)
    if (!byModel.has(pascal)) byModel.set(pascal, svc.name)
  }
  return byModel
}
