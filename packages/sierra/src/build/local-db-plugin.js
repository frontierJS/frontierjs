/**
 * build/local-db-plugin.js — the bytes a local database needs, in the output.
 *
 * `offline: { db: true }` in sierra.config.js. Phase 4 of the Homestead work
 * (`IDEAS/homestead.md`, `FJS-D307`): the list cache answers the exact question
 * it was given and nothing else, and a real query engine on the device is what
 * erases that bound — any query on a `@@sync` model, reachable or not.
 *
 * ── What it puts where, and why the build owns it ──────────────────────────
 *
 * Two things a page cannot produce for itself:
 *
 *   fjs-sqlite/           SQLite's own wasm build, copied out of the APP's
 *                         `@sqlite.org/sqlite-wasm`. The module fetches its
 *                         `.wasm` sibling by a relative path, so the directory
 *                         travels whole — emitting the entry alone through
 *                         Vite's `?url` leaves a 404 nothing in the build can
 *                         see.
 *   fjs-device-schema.json  the `@@sync` models and what they reference, out of
 *                         litestone's `deviceSchema()` — never the app's `.lite`
 *                         source, which would undo `FJS-D204`'s prose stripping
 *                         and hand a device every model in the app.
 *
 * **The app owns the DEPENDENCY and the build owns the OUTPUT**, which is the
 * division `postbuild/offline-shell.js` already makes for the precache: the app
 * installs the wasm and pays for it, and only the build knows its own directory
 * layout. Resolved from the app root rather than from this package, the way
 * `schema-plugin.js` already resolves litestone — sierra depends on neither.
 *
 * ── Off unless asked, and refused by name when asked for wrongly ───────────
 *
 * An app that says nothing installs nothing, ships nothing and pays nothing.
 * An app that says `offline: { db: true }` with no wasm installed is refused
 * with the install line rather than built without a database, because a
 * database that silently is not there is discovered in a basement.
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'fs'
import { resolve, dirname, join, extname } from 'path'

/** Where the two artefacts live, relative to the app's own origin. */
export const WASM_DIR   = 'fjs-sqlite'
export const SCHEMA_URL = '/fjs-device-schema.json'
export const WASM_URL   = `/${WASM_DIR}/index.js`

/**
 * The two files a browser needs, and the three it does not.
 *
 * The package ships five: `node.mjs` is the server build, `sqlite3-worker1.mjs`
 * is a message API this does not use — `engines/sqlite-wasm.js` drives `oo1`
 * directly — and `sqlite3-opfs-async-proxy.js` belongs to the OTHER OPFS VFS,
 * not to `opfs-sahpool`. Between them that is 260 kB brotli, on a shell that
 * precaches every byte of this.
 *
 * Asserted rather than believed: litestone's own browser drive copies these two
 * and nothing else, and passes.
 *
 * **The entry is renamed `.mjs` → `.js` on the way, and that is not tidying.**
 * It is reached by a dynamic `import()`, which a browser refuses outright when
 * the response is not a JavaScript media type — and `.mjs` is the extension
 * static hosts most often have no row for. Measured: served as
 * `application/octet-stream` it failed with *Failed to fetch dynamically
 * imported module*, the page said nothing, and every offline read quietly fell
 * through to the list cache. `.js` is the one extension every host answers
 * correctly. The `.wasm` beside it is fetched by the module ITSELF, by its own
 * name, so it travels unrenamed.
 */
const WASM_FILES = [['index.mjs', 'index.js'], ['sqlite3.wasm', 'sqlite3.wasm']]

/** What `local-db-open.js` becomes when the database is off. */
const STUB = '\0sierra:local-db-off'

const TYPES = {
  '.mjs':  'text/javascript',
  '.js':   'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
}

/** Is the local database asked for? `offline: true` alone is the SHELL, not this. */
export const wantsLocalDb = (config) =>
  !!(config?.offline && config.offline !== true && config.offline.db)

/**
 * Find the app's own copy of SQLite's wasm build.
 *
 * Walked up from the Vite root rather than resolved from here: sierra does not
 * depend on it, and an app's dependency is reachable from the app.
 *
 * @returns {string|null} the package's `dist/` directory
 */
export function findWasmDist(root) {
  let dir = resolve(root)
  for (let i = 0; i < 6; i++) {
    const dist = resolve(dir, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist')
    if (existsSync(join(dist, 'index.mjs'))) return dist
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const MISSING = (root) =>
  `[Sierra] offline: { db: true } needs SQLite's wasm build, and it is not installed.\n` +
  `  The app owns this dependency because the app pays for it — about 868 kB, which only\n` +
  `  an app that reads with no server should ship (FJS-D305).\n` +
  `    cd ${root} && bun add @sqlite.org/sqlite-wasm\n` +
  `  Or drop \`db\` from \`offline\` in sierra.config.js to keep the shell without a database.`

/**
 * @param {object} config         sierra config
 * @param {object} sierraContext  where `schema-plugin.js` leaves the device schema
 */
export function localDbPlugin(config, sierraContext) {
  let root = process.cwd()
  let dist = null

  return {
    name: 'sierra:local-db',
    // `pre`, or Vite's own resolver answers the specifier first and the stub
    // below never runs — which is silent, because the build then simply
    // contains the worker it was meant to leave out.
    enforce: 'pre',

    // **The worker is stubbed out for an app that did not ask for one**, and
    // this is the only thing that can do it. `new Worker(new URL(…))` is a
    // static signal — a bundler emits the chunk wherever it sees the pattern,
    // reachable or not — and the service worker precaches every `.js` the build
    // emits, so an app with no database was shipping the whole litestone
    // browser client AND precaching it: 277 kB → 401 kB on `example`, measured,
    // for a feature it had not turned on.
    resolveId(id) {
      if (wantsLocalDb(config)) return null
      if (id.endsWith('/local-db-open.js') || id === './local-db-open.js') return STUB
      return null
    },

    load(id) {
      if (id !== STUB) return null
      return 'export function openWorker() { return null }\n'
    },

    configResolved(viteConfig) {
      if (!wantsLocalDb(config)) return
      root = viteConfig.root ?? process.cwd()
      dist = findWasmDist(root)
      if (!dist) throw new Error(MISSING(root))
    },

    // Dev has no output directory, so both artefacts are answered off disk and
    // out of memory. The URLs are the build's, character for character, or the
    // page that works in dev fetches a 404 from the built one.
    configureServer(server) {
      if (!wantsLocalDb(config)) return
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]

        if (path === SCHEMA_URL) {
          const body = JSON.stringify(sierraContext?.deviceSchema ?? null)
          res.setHeader('Content-Type', 'application/json')
          return res.end(body)
        }

        if (path.startsWith(`/${WASM_DIR}/`) && dist) {
          // The name only — a path from the URL would reach out of the package.
          const name = path.slice(WASM_DIR.length + 2)
          const onDisk = WASM_FILES.find(([, served]) => served === name)?.[0] ?? name
          const file = join(dist, onDisk)
          if (!name.includes('/') && existsSync(file)) {
            res.setHeader('Content-Type', TYPES[extname(name)] ?? 'application/octet-stream')
            return res.end(readFileSync(file))
          }
        }

        next()
      })
    },

    // `writeBundle` rather than `generateBundle`: the wasm is copied as FILES
    // rather than emitted as assets, because `emitFile` content-addresses a
    // name and the module fetches its `.wasm` sibling by the name it was
    // published under.
    writeBundle(options) {
      if (!wantsLocalDb(config) || !dist) return
      const outDir = options.dir ?? resolve(root, 'dist')

      const target = join(outDir, WASM_DIR)
      mkdirSync(target, { recursive: true })
      for (const [from, to] of WASM_FILES)
        copyFileSync(join(dist, from), join(target, to))
    },

    // The schema goes in as an ASSET, because it is one file under a name the
    // page fetches — where the wasm above is a directory whose entry reaches
    // its siblings by their published names and so cannot be content-addressed.
    generateBundle() {
      if (!wantsLocalDb(config)) return
      this.emitFile({
        type: 'asset',
        fileName: SCHEMA_URL.slice(1),
        source: JSON.stringify(sierraContext?.deviceSchema ?? null),
      })
    },
  }
}
