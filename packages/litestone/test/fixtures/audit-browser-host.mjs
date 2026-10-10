// fixtures/audit-browser-host.mjs — the audit scenarios on a host shaped like a
// browser worker, on a runtime a `bun test` can spawn.
//
//   node --conditions=browser --no-warnings test/fixtures/audit-browser-host.mjs
//
// `--conditions=browser` resolves `#host` to `host/browser.js` and `#sql-engine`
// to nothing, the way `test/fixtures/second-engine.mjs` does. What this adds is
// the four globals a browser worker lacks and a server has — `process`, `Bun`,
// `Buffer`, `setImmediate` — removed before a scenario runs, because the walk
// in `engine-seam.test.ts` grades imports and nothing grades a global, and a
// server global is what the Chrome drive (`test/browser/audit-browser-seams.mjs`)
// found behind every ReferenceError. `node:sqlite` stands in for the wasm
// engine; a row here that depends on the engine rather than the host is marked
// in the test that reads this.
//
// Prints one JSON array of `{ name, value }` and nothing else on stdout.

import { DatabaseSync }   from 'node:sqlite'
import { tmpdir }         from 'node:os'
import { mkdtempSync }    from 'node:fs'
import { join }           from 'node:path'
import { setEngine }      from '../../src/core/engine.js'

const wrap = (raw) => {
  const stmt = (sql) => {
    const s = raw.prepare(sql)
    return {
      get: (...a) => s.get(...a), all: (...a) => s.all(...a), run: (...a) => s.run(...a),
      values:       (...a) => { s.setReturnArrays(true); try { return s.all(...a) } finally { s.setReturnArrays(false) } },
      safeIntegers(on = true) { s.setReadBigInts(!!on); return this },
    }
  }
  return {
    prepare: stmt,
    query:   stmt,
    run:     (sql, ...params) => raw.prepare(sql).run(...params),
    close:   () => raw.close(),
  }
}

setEngine({
  name: 'node:sqlite',
  sync: true,
  open: (path, { readonly = false } = {}) => wrap(new DatabaseSync(path, { readOnly: readonly })),
})

const [{ createClient }, { parse }, { deviceSchema }, { scenarios, runAll }] = await Promise.all([
  import('../../src/core/client.js'),
  import('../../src/core/parser.js'),
  import('../../src/device-schema.js'),
  import('./audit-browser-scenarios.mjs'),
])

const fileDir = mkdtempSync(join(tmpdir(), 'litestone-audit-host-'))
const out     = (s) => console.log(s)
const exit    = process.exit.bind(process)

// The host, from here on, is a browser worker's. Deleted rather than replaced
// with a throwing getter: `typeof process` on an undeclared name is 'undefined',
// which is what a guard in the client relies on, and a getter would throw there.
delete globalThis.process
delete globalThis.Bun
delete globalThis.Buffer
delete globalThis.setImmediate

const results = await runAll(scenarios({ createClient, parse, deviceSchema, fileDir }))
out(JSON.stringify(results, (k, v) => typeof v === 'bigint' ? `${v}n` : v))
exit(0)
