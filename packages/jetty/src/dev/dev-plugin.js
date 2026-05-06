// dev-plugin.js — Vite plugins that inject the dev WS client into bundles.
//
// Two factories:
//   - devClientPlugin({ port, clientType, islandMatches }) — single entry,
//     fixed clientType (Harbor build).
//   - perEntryDevClientPlugin({ port, resolveClientType }) — multi-entry,
//     clientType resolved per-entry.
//
// Both implement the same injection strategy:
//   1. resolveId/load expose dev-client.js as a virtual module
//   2. transform prepends `import + invocation` into entry modules
//
// The virtual-module pattern is required because Rollup only resolves
// imports it sees during the transform phase. Imports added in renderChunk
// (the older approach) are emitted as literal strings and the browser tries
// to fetch them as URLs — which 404s for absolute filesystem paths.
//
// Detecting "entry module" is the tricky part. Two complementary strategies:
//   1. opts.input from buildStart — direct entries (Harbor uses this; the
//      input is the harbor.js path).
//   2. this.getModuleInfo(id).isEntry inside transform — Rollup-classified
//      entry modules (Pages build uses this; the entry is the auto-gen
//      main.js inside an HTML file's script tag, NOT the HTML itself).
//
// We use both: any module that's either explicitly listed in opts.input or
// has isEntry === true is considered an entry candidate. The resolver then
// decides whether and how to inject.

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const HERE             = dirname(fileURLToPath(import.meta.url))
const DEV_CLIENT_PATH  = resolve(HERE, './dev-client.js')
const VIRTUAL_ID       = '\0jetty:dev-client'

let _devClientSrc = null
function devClientSource() {
  if (_devClientSrc == null) _devClientSrc = readFileSync(DEV_CLIENT_PATH, 'utf8')
  return _devClientSrc
}

/**
 * Single-entry plugin (Harbor).
 *
 * @param {Object} opts
 * @param {number} opts.port
 * @param {string} opts.clientType
 * @param {Record<string,string[]>} [opts.islandMatches]
 */
export function devClientPlugin({ port, clientType, islandMatches = null }) {
  if (!port)        throw new Error('devClientPlugin: port required')
  if (!clientType)  throw new Error('devClientPlugin: clientType required')

  return perEntryDevClientPlugin({
    port,
    islandMatches,
    resolveClientType: () => clientType,
  })
}

/**
 * Multi-entry plugin. resolveClientType receives:
 *   { name: string|null, path: string }
 * where name is the input key (when available) and path is the absolute
 * resolved module path. Return a clientType string (e.g. 'dock', 'island:foo')
 * or null to skip injection for that entry.
 *
 * The resolver MAY be called multiple times for the same entry (once from
 * buildStart's opts.input, once from getModuleInfo isEntry detection). It
 * should be idempotent. The first call that returns a string wins.
 *
 * @param {Object} opts
 * @param {number} opts.port
 * @param {(entry: { name: string|null, path: string }) => string | null} opts.resolveClientType
 * @param {Record<string,string[]>} [opts.islandMatches]
 */
export function perEntryDevClientPlugin({ port, resolveClientType, islandMatches = null }) {
  if (!port)              throw new Error('perEntryDevClientPlugin: port required')
  if (!resolveClientType) throw new Error('perEntryDevClientPlugin: resolveClientType required')

  // entryId → clientType, populated lazily.
  const entryClientTypes = new Map()
  // Reverse lookup: input path → name (for the second strategy below).
  const inputNamesByPath = new Map()

  return {
    name: 'jetty:dev-client',
    enforce: 'pre',

    buildStart(opts) {
      entryClientTypes.clear()
      inputNamesByPath.clear()
      const input = opts.input

      const recordInput = (name, path) => {
        const absPath = resolve(path)
        inputNamesByPath.set(absPath, name)
        const ct = resolveClientType({ name: name || null, path: absPath })
        if (ct) entryClientTypes.set(absPath, ct)
      }

      if (typeof input === 'string') {
        recordInput('', input)
      } else if (Array.isArray(input)) {
        for (const i of input) recordInput('', i)
      } else if (input && typeof input === 'object') {
        for (const [name, path] of Object.entries(input)) recordInput(name, path)
      }
    },

    resolveId(source) {
      if (source === VIRTUAL_ID) return VIRTUAL_ID
      return null
    },

    load(id) {
      if (id === VIRTUAL_ID) return devClientSource()
      return null
    },

    transform(code, id) {
      // Skip the virtual module itself — Rollup processes it as a normal
      // module but we don't want to inject the dev client into the dev client.
      if (id === VIRTUAL_ID) return null

      let clientType = entryClientTypes.get(id)

      if (!clientType) {
        // Strategy 2: ask Rollup if this is an entry. For HTML-rooted builds,
        // the JS entry path is not in opts.input but IS marked isEntry.
        const info = this.getModuleInfo?.(id)
        if (info?.isEntry) {
          // Try to find a name from the input mapping by matching importers
          // up to the top — the entry itself is at the root of an import
          // chain that started from one of opts.input's HTML files.
          //
          // For our use case, the simpler heuristic is: just call resolveClientType
          // with no name and let it derive from the path.
          const ct = resolveClientType({ name: null, path: id })
          if (ct) {
            clientType = ct
            entryClientTypes.set(id, ct)
          }
        }
      }

      if (!clientType) return null

      const matchesGlobal = clientType === 'harbor' && islandMatches
        ? `globalThis.__JETTY_ISLAND_MATCHES__ = ${JSON.stringify(islandMatches)};\n`
        : ''

      const preamble =
`// --- jetty dev client (${clientType}) ---
${matchesGlobal}import { startDevClient as __jettyStartDev } from ${JSON.stringify(VIRTUAL_ID)};
__jettyStartDev({ port: ${port}, clientType: ${JSON.stringify(clientType)} });
// --- end jetty dev client ---
`

      return {
        code: preamble + code,
        map: null,
      }
    },
  }
}
