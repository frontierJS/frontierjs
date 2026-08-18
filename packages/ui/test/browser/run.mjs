/*
 * run.mjs — the kit drive.
 *
 *   node test/browser/run.mjs                 every spec
 *   node test/browser/run.mjs datepicker      specs whose filename matches
 *   node test/browser/run.mjs --coverage      also list what no spec opens
 *   node test/browser/run.mjs --serve         serve the kit and stay up
 *
 * Needs Chrome on PATH or `$FJS_CHROME`.
 *
 * ── What this exists to reach ─────────────────────────────────────────
 *
 * `compile-all` proves a component emits parseable JS, `render` proves it
 * produces DOM, `attributes` proves the caller's attributes land. None of the
 * three runs a browser, so none of them can see the thing this kit exists to
 * add over `@frontierjs/css`: a roving tablist, a focus trap, a calendar that
 * changes month, a dropzone that accepts a file. `FJS-028` is the register
 * entry — 35 of 64 components had never been opened in a browser at all, and
 * what that cost was measured: `DatePicker` could not render AT ALL for as
 * long as it existed, and compiled cleanly the whole time.
 *
 * The drive that existed before this one lives in `example/`, and covering a
 * component there means first putting it on a real application screen. That
 * friction is why the long tail stayed dark. This one mounts the component
 * directly, so the cost of covering one is a fixture and a spec.
 *
 * ── What is here and what is in mesa ──────────────────────────────────
 *
 * Chrome, the CDP protocol, real input and the spec runner are
 * `mesa/test/browser/drive.mjs` — generic, and read by RELATIVE path for the
 * same reason the compiler is (a workspace dep resolves to a copy under
 * `node_modules/.bun/`, so a by-name import would drive an install-time
 * snapshot). What is left here is what makes it the KIT's drive: the server,
 * the fixture path, and coverage over the component tree.
 */
import { readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKitServer } from './server.mjs'
import { runSpecs, dim } from '../../../mesa/test/browser/drive.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PKG  = fileURLToPath(new URL('../..', import.meta.url))

const argv      = process.argv.slice(2)
const serveOnly = argv.includes('--serve')
const showGap   = argv.includes('--coverage')
const verbose   = argv.includes('--verbose')
const filters   = argv.filter((a) => !a.startsWith('--'))

/* ─── the kit, served ─────────────────────────────────────────────────── */

const compileWarnings = []
const kit = createKitServer({ onWarning: (f, w) => compileWarnings.push([f, w]) })
const origin = await kit.listen()

if (serveOnly) {
  console.log(`kit served at ${origin}`)
  console.log(dim('fixtures are at /kit/test/browser/fixtures/<name>.mesa'))
} else {
  const { infra, failures } = await runSpecs({
    origin,
    specDir: join(HERE, 'specs'),
    filters,
    verbose,
    // The page owns its own boot — an import map, the design system's
    // stylesheet and page.js — and sets this last.
    ready: 'window.__kitReady',
    extend: ({ evaluate }) => ({
      /** Mount a fixture by name — `fixtures/<name>.mesa`. */
      mount: (fixture, props = {}) => evaluate(
        `return await window.kitMount(${JSON.stringify(`/kit/test/browser/fixtures/${fixture}.mesa`)}, ${JSON.stringify(props)});`
      ),
    }),
    teardown: 'return window.kitUnmount();',
    coverage: { all: componentNames(), show: showGap, noun: 'components' },
    notes: () => compileWarnings.map(([file, w]) => `${file.replace(PKG, '')} — ${w}`),
  })

  await kit.close()
  process.exit(failures || infra ? 1 : 0)
}

/** Every component in the kit, as `<tier>/<Name>` — the same key a spec's
 *  `covers` list uses. Derived from the tree so a new component is uncovered
 *  the moment it is added, rather than when someone remembers to say so. */
function componentNames() {
  const out = []
  for (const tier of readdirSync(join(PKG, 'components'))) {
    for (const f of readdirSync(join(PKG, 'components', tier)))
      if (f.endsWith('.mesa')) out.push(`${tier}/${basename(f, '.mesa')}`)
  }
  return out.sort()
}
