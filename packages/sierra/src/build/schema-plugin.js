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
import { pathToFileURL } from 'url'

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

/**
 * Read the .lite file and produce `$defs`.
 *
 * Returns null rather than throwing: a schema that doesn't parse should warn
 * and leave the app running on explicitly-passed schemas, not fail the build.
 *
 * @returns {Promise<{ defs: object, models: string[] } | null>}
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

  const json = generateJsonSchema(result.schema)
  const defs = json?.$defs ?? {}

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

  return { defs, models }
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
      sierraContext.schemaPath   = schemaPath

      if (generated) {
        console.log(
          `  [Sierra] schema: ${generated.models.length} model(s) from ` +
          `${schemaPath.replace(root + '/', '')} — ${generated.models.join(', ')}`
        )
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
