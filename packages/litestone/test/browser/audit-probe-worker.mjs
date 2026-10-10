// browser/audit-probe-worker.mjs — the audit scenarios, inside a module worker
// over the wasm engine. Bundled by `audit-browser-seams.mjs` with
// `--conditions=browser`, which is what resolves `#host` to the browser half.
//
// The page sends one message, `{ wasmUrl }`; the worker answers once with every
// scenario's result. Nothing here is the shipped worker: that one exposes model
// methods over postMessage and cannot take an `onEvent` function or reach
// `$backup`, which is exactly why those two are probed from in here.

import { setEngine }              from '../../src/core/engine.js'
import { createSqliteWasmEngine } from '../../src/engines/sqlite-wasm.js'
import { scenarios, runAll }      from '../fixtures/audit-browser-scenarios.mjs'

self.onmessage = async ({ data: { wasmUrl } }) => {
  try {
    const engine = await createSqliteWasmEngine({ load: () => import(/* @vite-ignore */ wasmUrl), vfs: 'audit' })
    setEngine(engine)
    const [{ createClient }, { parse }, { deviceSchema }] = await Promise.all([
      import('../../src/core/client.js'), import('../../src/core/parser.js'), import('../../src/device-schema.js'),
    ])
    const list = scenarios({ createClient, parse, deviceSchema, rawOpen: (p) => engine.open(p) })

    // Engine facts the client cannot be asked for: the journal the engine
    // declared, foreign keys, and the compile options the schema features rest on.
    list.unshift(['engine-facts', async () => {
      const db = await createClient({ parsed: parse('model Item { id Int @id @default(autoincrement())  name String }'), db: '/audit-facts.db' })
      const raw = db.$db
      const opts = raw.query('PRAGMA compile_options').all().map(r => r.compile_options)
      return {
        engine:      engine.name,
        journal:     raw.query('PRAGMA journal_mode').get()?.journal_mode,
        synchronous: raw.query('PRAGMA synchronous').get()?.synchronous,
        foreignKeys: raw.query('PRAGMA foreign_keys').get()?.foreign_keys,
        fts5:        opts.includes('ENABLE_FTS5'),
        math:        opts.includes('ENABLE_MATH_FUNCTIONS'),
        json:        !!raw.query(`SELECT json_extract('{"a":1}', '$.a') AS v`).get()?.v,
        loadExt:     opts.includes('OMIT_LOAD_EXTENSION') ? 'omitted' : 'present',
      }
    }])

    const results = await runAll(list)
    self.postMessage({ ok: results })
  } catch (e) {
    self.postMessage({ err: { name: e?.name, message: String(e?.message ?? e) } })
  }
}
