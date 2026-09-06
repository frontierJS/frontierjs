/*
 * run.mjs — the runtime drive.
 *
 *   node test/browser/runtime/run.mjs               every spec
 *   node test/browser/runtime/run.mjs each          specs whose filename matches
 *   node test/browser/runtime/run.mjs --verbose     print the passing rows too
 *   node test/browser/runtime/run.mjs --serve       serve and stay up
 *
 * Needs Chrome on PATH or `$FJS_CHROME`.
 *
 * ── What this exists to reach ─────────────────────────────────────────
 *
 * Every other suite in this package runs in happy-dom, so none of them can see
 * what this compiler and runtime exist to produce: an event that does not
 * bubble, an attachment on a connected element, a scoped rule that actually
 * wins, a keyed row that is the same node moved. `FJS-025` is the register
 * entry — nothing in mesa had ever been verified in a real browser, and the
 * cost was paid downstream in `@frontierjs/ui`, whose first browser drive
 * found five delegation defects in this package on its first day.
 *
 * The harness is `../drive.mjs`: Chrome, the CDP protocol, real input and the
 * spec runner, shared with every other drive in the repo.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMesaServer } from './server.mjs'
import { runSpecs, dim } from '../drive.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PKG  = fileURLToPath(new URL('../../..', import.meta.url))

const argv      = process.argv.slice(2)
const serveOnly = argv.includes('--serve')
const verbose   = argv.includes('--verbose')
const filters   = argv.filter((a) => !a.startsWith('--'))

const compileWarnings = []
const it = createMesaServer({ onWarning: (f, w) => compileWarnings.push([f, w]) })
const origin = await it.listen()

if (serveOnly) {
  console.log(`mesa served at ${origin}`)
  console.log(dim('fixtures are at /mesa/test/browser/runtime/fixtures/<name>.mesa'))
} else {
  const fixture = (name) => `/mesa/test/browser/runtime/fixtures/${name}.mesa`

  const { infra, failures } = await runSpecs({
    origin,
    specDir: join(HERE, 'specs'),
    filters,
    verbose,
    ready: 'window.__mesaReady',
    extend: ({ evaluate }) => ({
      /** Mount a fixture by name — `fixtures/<name>.mesa`. */
      mount: (name, props = {}) => evaluate(
        `return await window.mesaMount(${JSON.stringify(fixture(name))}, ${JSON.stringify(props)});`
      ),
      /** Render one by CALLING it, with no delegation root — see smoke.spec. */
      mountBare: (name, props = {}) => evaluate(
        `return await window.mesaMountBare(${JSON.stringify(fixture(name))}, ${JSON.stringify(props)});`
      ),
      /** Tear the current mount down WITHOUT clearing the stage, so a spec can
       *  read what `destroy()` left behind. `mesaUnmount` cannot answer that:
       *  it clears the stage itself. */
      destroy: () => evaluate('return window.mesaDestroy();'),
      /** Everything console.warn has been handed since the last mount. */
      warnings: () => evaluate('return { v: window.mesaWarnings.slice() };').then((r) => r.v),
    }),
    teardown: 'return window.mesaUnmount();',
    notes: () => compileWarnings.map(([file, w]) => `${file.replace(PKG, '')} — ${w}`),
  })

  await it.close()
  process.exit(failures || infra ? 1 : 0)
}
