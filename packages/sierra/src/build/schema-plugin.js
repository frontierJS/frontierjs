/**
 * build/schema-plugin.js — generate client-side model schemas from the .lite file.
 *
 * The browser needs a model's field shape for `make()` defaults. Hand-writing it
 * in each resource file duplicated `db/schema.lite`, and once Junction started
 * deriving server validation from the Litestone client's own `$schema`, that
 * hand-written copy became the only place the two halves of an app could drift.
 *
 * This reads the same `.lite` file the API does, runs Litestone's
 * `generateJsonSchema`, and hands the result to `virtual:sierra`, which calls
 * `registerSchemas()` before any route module is evaluated.
 *
 * @frontierjs/litestone is imported dynamically: a Sierra app with no database
 * has no reason to depend on it, and its absence is not an error.
 */

import { resolve, dirname, isAbsolute } from 'path'
import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { gzipSync } from 'zlib'
import { pathToFileURL } from 'url'
import { diffSchemaModes } from '../junction/schema-registry.js'

/** Default locations, tried in order when `config.schema` isn't set. */
const DEFAULT_PATHS = [
  'db/schema.lite',
  '../db/schema.lite',      // web/ inside a repo whose db/ is at the root
  'schema.lite',
]

/**
 * Resolve the .lite path from config, or find it in a conventional location.
 *
 * @param {object} config  sierra config
 * @param {string} root    vite root
 * @returns {string|null}  absolute path, or null when there is no schema
 */
export function resolveSchemaPath(config, root) {
  if (config?.schema === false) return null

  if (typeof config?.schema === 'string') {
    const p = isAbsolute(config.schema) ? config.schema : resolve(root, config.schema)
    return existsSync(p) ? p : null
  }

  for (const candidate of DEFAULT_PATHS) {
    const p = resolve(root, candidate)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Locate and import @frontierjs/litestone from the APP, not from Sierra.
 *
 * A bare `import('@frontierjs/litestone')` here resolves relative to this file,
 * which lives in the Sierra package wherever that has been linked. Sierra has no
 * reason to depend on Litestone, so that fails even when the app has it.
 *
 * `createRequire(...).resolve()` does not work either: Litestone's exports map
 * declares only `import` and `types`, and require-resolution needs a `require`
 * condition. That is the same trap that made a fallback in virtual-sierra.js
 * dead code — so this reads the package manifest and follows its exports map by
 * hand.
 */
async function loadLitestone(root, warn, schemaPath) {
  // Import the schema modules, NOT the package root.
  //
  // Litestone's main entry pulls in the query client, which imports bun:sqlite
  // — unloadable in Node, and this plugin runs wherever Vite runs. The parser
  // and JSON-schema generator have no driver dependency, so they are imported
  // by subpath. That is also why the failure used to look like a resolution
  // problem: the package resolved fine and then threw on `bun:`.
  const SUBPATHS = { parse: './parser', json: './jsonschema' }
  const tried = []

  // Walk up from the app root looking for the package.
  let dir = resolve(root)
  for (let i = 0; i < 6; i++) {
    const pkgDir = resolve(dir, 'node_modules', '@frontierjs', 'litestone')
    const manifestPath = resolve(pkgDir, 'package.json')
    tried.push(pkgDir)

    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const entry =
          manifest.exports?.['.']?.import ??
          manifest.exports?.['.']?.default ??
          (typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : null) ??
          manifest.module ??
          manifest.main

        const pick = (sub) =>
          manifest.exports?.[sub]?.import ??
          manifest.exports?.[sub]?.default ??
          (typeof manifest.exports?.[sub] === 'string' ? manifest.exports[sub] : null)

        const parserRel = pick(SUBPATHS.parse)
        const jsonRel   = pick(SUBPATHS.json)

        if (parserRel && jsonRel) {
          const parserAbs = resolve(pkgDir, parserRel)
          const jsonAbs   = resolve(pkgDir, jsonRel)
          if (existsSync(parserAbs) && existsSync(jsonAbs)) {
            const [{ parse, parseFile }, { generateJsonSchema }] = await Promise.all([
              import(pathToFileURL(parserAbs).href),
              import(pathToFileURL(jsonAbs).href),
            ])
            return { parse, parseFile, generateJsonSchema }
          }
        }

        // Older Litestone with no ./jsonschema subpath — fall back to the root
        // entry and hope it loads in this runtime.
        if (entry) {
          const abs = resolve(pkgDir, entry)
          if (existsSync(abs)) return await import(pathToFileURL(abs).href)
        }
      } catch {
        // fall through to the next candidate
      }
    }

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Hoisted / monorepo layouts where a bare specifier happens to work.
  try {
    return await import('@frontierjs/litestone')
  } catch {
    warn?.(
      `found ${schemaPath} but @frontierjs/litestone could not be loaded from ` +
      `${root} — client schemas will not be generated. Add it as a devDependency ` +
      `of this app, or have resources pass their own schema.`
    )
    return null
  }
}

// Maps whose keys are NAMES rather than JSON Schema keywords. `description` in
// one of these is a column somebody declared — `Product.description` is a real
// column of this repo's own example, and of four models in basecamp — so a walk
// that filtered by key name alone would delete it from every generated form and
// leave a build that says nothing. The annotation and the field are the same
// word at different depths, which is the whole trap.
const _NAME_KEYED = new Set([
  'properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas',
])

/**
 * Every `description` ANNOTATION out of a generated `$defs` table (`FJS-785`).
 *
 * A `///` comment is emitted at three depths — on a model, on a property, and
 * inside a `$ref` target — so the walk is recursive rather than two loops, and
 * a fourth depth arrives carried rather than missed. Nothing in the browser
 * reads it: `field-rules.js` carries it into a field rule and no control
 * renders it.
 *
 * A user-facing hint is a DECLARED attribute if it is ever wanted, not a doc
 * comment repurposed — a comment addresses whoever edits the schema, which is
 * what this repo's own comments show by quoting policy expressions.
 *
 * @param {object} defs  the `$defs` table (a name-keyed map)
 * @returns {object} a new table; the input is not mutated
 */
export function stripProse(defs) {
  return _stripNamed(defs)
}

/** A map from names to schema nodes: keys are untouched, values are schemas. */
function _stripNamed(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return map
  const out = {}
  for (const [name, node] of Object.entries(map)) out[name] = _stripNode(node)
  return out
}

/** A schema node: `description` is the annotation and comes out. */
function _stripNode(node) {
  if (Array.isArray(node)) return node.map(_stripNode)
  if (!node || typeof node !== 'object') return node

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') continue
    out[key] = _NAME_KEYED.has(key) ? _stripNamed(value) : _stripNode(value)
  }
  return out
}

/**
 * Read the .lite file and produce `$defs`.
 *
 * Returns null rather than throwing: a schema that doesn't parse should warn
 * and leave the app running on explicitly-passed schemas, not fail the build.
 *
 * @returns {Promise<{ defs: object, models: string[], updatePatch: object } | null>}
 */
export async function generateSchemas(schemaPath, warn, root = process.cwd()) {
  const litestone = await loadLitestone(root, warn, schemaPath)
  if (!litestone) return null

  const { parse, parseFile, generateJsonSchema } = litestone
  if (typeof parse !== 'function' || typeof generateJsonSchema !== 'function') {
    warn?.('@frontierjs/litestone does not export parse / generateJsonSchema')
    return null
  }

  let source
  try {
    source = readFileSync(schemaPath, 'utf8')
  } catch (err) {
    warn?.(`could not read ${schemaPath}: ${err.message}`)
    return null
  }

  // parseFile, because a schema may `import "./other.lite"` and only it resolves
  // one. Parsing the root file alone reaches the browser as a $defs table with
  // the imported models missing — `modelNameFor` misses, `createResource`
  // degrades to a bare make(), and a generated <Form> renders no fields. Every
  // step of that is a warning at most, so the app builds and the form is empty.
  //
  // An older Litestone with no parseFile still works for the schemas it could
  // always handle, and says so BY NAME for the one case it cannot — a silent
  // fallback here is the same bug wearing a version number.
  const usable = typeof parseFile === 'function'
  if (!usable && /^[ \t]*import\s+["']/m.test(source)) {
    warn?.(
      `${schemaPath} imports another .lite file, and this @frontierjs/litestone ` +
      `does not export parseFile — the imported models will be missing from the ` +
      `client schemas. Upgrade @frontierjs/litestone.`
    )
  }

  const result = usable ? parseFile(schemaPath) : parse(source)
  if (!result?.valid) {
    for (const e of result?.errors ?? []) warn?.(`${schemaPath}: ${e}`)
    return null
  }

  // Both write modes, because a form does both jobs and the two schemas are
  // different documents. Asking for one and getting the default — `create` —
  // is what left `@immutable` writable on every edit form and `x-litestone-seal`
  // absent from every model in every real app (`FJS-807`).
  //
  // What crosses is the create table plus the DELTA to the update one: the
  // second copy costs +26 KB gzipped on `example` and the delta costs +2 KB,
  // and `diffSchemaModes` computes it from the two generated documents rather
  // than restating litestone's mode rules here.
  // Prose is dropped before either table is measured or diffed (`FJS-785`).
  // A `///` comment is written for whoever edits the .lite file, and litestone
  // emits it as `description` — so `example`'s notes, which quote policy
  // expressions and explain the cart bearer-token scheme, were reaching an
  // anonymous visitor's login page. `audience: 'client'` is the one owner of
  // which FIELDS cross and it is doing its job; it was never asked about a doc
  // comment, because a comment is not a field.
  //
  // The strip is here rather than there because this bundle is not the client
  // audience: that describes what an API may answer an authenticated caller,
  // and this is a static file anyone can fetch before signing in — the same
  // question `static-safety.js` already owns for a prerendered page.
  //
  // It is also the large cut, not the cheap one: over `example` the whole
  // payload is 120 429 bytes / 30 380 gzipped, and without `description`
  // 53 841 / 6 820. The prose is 78% of what crosses compressed.
  const defs        = stripProse(generateJsonSchema(result.schema)?.$defs ?? {})
  const updateDefs  = stripProse(generateJsonSchema(result.schema, { mode: 'update' })?.$defs ?? {})
  const updatePatch = diffSchemaModes(defs, updateDefs)

  // $defs holds models, enums, `type` declarations and FileRef side by side —
  // it is the whole document's definition table, not a list of models. Taking
  // the model names from the parse result instead of from Object.keys(defs) is
  // what stops an enum being addressable as a resource: `enum Plan` was indexed
  // under 'Plan'/'plan'/'plans', so createResource('plans') resolved to the enum
  // and make() then iterated a string. It also fixes the build log, which
  // reported "2 model(s) — Lead, Plan" for one model and one enum.
  //
  // The full defs table is still returned and still registered: $ref targets
  // live in it, and resolving `{$ref:'#/$defs/Plan'}` is the only way the
  // browser can learn a field's enum values.
  const models = (result.schema?.models ?? []).map(m => m.name).filter(Boolean)

  return { defs, models, updatePatch }
}

/**
 * What `registerSchemas()` will cost in the bundle, raw and gzipped.
 *
 * The three arguments as `virtual-sierra.js` will serialize them, so the number
 * moves when the emit does. gzip because that is what a browser downloads and
 * the two differ by an order of magnitude on a table this repetitive.
 *
 * @param {{defs: object, models: string[], updatePatch: object}} generated
 * @returns {string}
 */
function emittedSize({ defs, models, updatePatch }) {
  const raw = JSON.stringify(defs).length
            + JSON.stringify(models ?? null).length
            + JSON.stringify(updatePatch ?? null).length
  const gz = gzipSync(Buffer.from(
    JSON.stringify(defs) + JSON.stringify(models ?? null) + JSON.stringify(updatePatch ?? null)
  )).length
  const kb = (n) => (n / 1024).toFixed(1) + ' KB'
  return `${kb(raw)} (${kb(gz)} gzipped)`
}

/**
 * Vite plugin. Watches the .lite file and invalidates virtual:sierra on change,
 * so editing the schema updates `make()` defaults without a restart.
 *
 * @param {object} config         sierra config
 * @param {object} sierraContext  shared context — the generated defs are stashed
 *                                here for virtual-sierra.js to emit
 */
export function schemaPlugin(config, sierraContext) {
  let root = process.cwd()
  let schemaPath = null

  const warn = (msg) => console.warn(`[Sierra] schema: ${msg}`)

  return {
    name: 'sierra:schema',
    enforce: 'pre',

    async configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
      schemaPath = resolveSchemaPath(config, root)

      if (!schemaPath) {
        sierraContext.schemaDefs = null
        return
      }

      const generated = await generateSchemas(schemaPath, warn, root)
      sierraContext.schemaDefs   = generated?.defs   ?? null
      sierraContext.schemaModels = generated?.models ?? null
      sierraContext.schemaUpdate = generated?.updatePatch ?? null
      sierraContext.schemaPath   = schemaPath

      if (generated) {
        // The SIZE, beside the model count. What crosses here is the largest
        // single thing in the bundle and it took an audit to notice (`FJS-785`);
        // a number in the build log is what makes the next person's complaint a
        // measurement rather than a discovery. Refusing to project the table is
        // a ruling (`FJS-D204`), and a ruling that hides its own cost is the
        // shape that gets quietly reversed.
        console.log(
          `  [Sierra] schema: ${generated.models.length} model(s) from ` +
          `${schemaPath.replace(root + '/', '')} — ${generated.models.join(', ')}`
        )
        console.log(`  [Sierra] schema: ${emittedSize(generated)} to the client`)
      }
    },

    configureServer(server) {
      if (!schemaPath) return
      server.watcher.add(schemaPath)

      server.watcher.on('change', async (file) => {
        if (resolve(file) !== resolve(schemaPath)) return

        const generated = await generateSchemas(schemaPath, warn, root)
        sierraContext.schemaDefs   = generated?.defs   ?? null
        sierraContext.schemaModels = generated?.models ?? null
        sierraContext.schemaUpdate = generated?.updatePatch ?? null

        // virtual:sierra embeds the schemas, so it has to be rebuilt. A full
        // reload rather than an HMR update: make() defaults are read when a
        // resource module is first evaluated, and those modules are already
        // instantiated by now.
        const mod = server.moduleGraph.getModuleById('\0virtual:sierra')
        if (mod) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      })
    },
  }
}
