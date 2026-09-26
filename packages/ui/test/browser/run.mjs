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
    extend: (browser) => ({
      /** Mount a fixture by name — `fixtures/<name>.mesa`. */
      mount: (fixture, props = {}) => browser.evaluate(
        `return await window.kitMount(${JSON.stringify(`/kit/test/browser/fixtures/${fixture}.mesa`)}, ${JSON.stringify(props)});`
      ),
      /** Put the page in a named IANA zone, for a spec about local time.
       *
       *  Every runner here is UTC — `bun test` forces it and CI is UTC anyway
       *  — which is the one zone where a local-midnight bug and a correct
       *  component render identical bytes. Call it BEFORE `mount`: a `Date`
       *  fixes its local fields when it is built, so a component already on
       *  screen goes on answering in the zone it was mounted in. The teardown
       *  clears it, so a spec cannot leak a zone into the next one. */
      timezone: (id) => browser.cmd('Emulation.setTimezoneOverride', { timezoneId: id ?? '' }),
      /** Press at `from`, move in `steps` to `to`, and release unless
       *  `release: false` — both a selector (its center) or `{x, y}`.
       *
       *  Through the input pipeline, because a dispatched PointerEvent is not
       *  trusted and takes no pointer capture. Each step waits a frame in the
       *  page: a drag that reads the pointer once per frame, stepped faster
       *  than frames arrive, sees only the last position and never crosses
       *  the slots in between. */
      drag: async (from, to, { steps = 12, release = true } = {}) => {
        const at = async (p) => typeof p !== 'string' ? p : browser.evaluate(`
          const r = document.querySelector(${JSON.stringify(p)})?.getBoundingClientRect();
          if (!r) throw new Error('drag: no element for ' + ${JSON.stringify(p)});
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        `)
        const a = await at(from), b = await at(to)
        const mouse = (type, { x, y }, buttons) => browser.cmd('Input.dispatchMouseEvent', {
          type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
        })
        const frame = () => browser.evaluate('await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;')
        await mouse('mousePressed', a, 1)
        for (let i = 1; i <= steps; i++) {
          await mouse('mouseMoved', { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, 1)
          await frame()
        }
        if (release) {
          await mouse('mouseReleased', b, 0)
          await frame()
        }
      },
    }),
    teardown: async (browser) => {
      await browser.cmd('Emulation.setTimezoneOverride', { timezoneId: '' })
      await browser.evaluate('return window.kitUnmount();')
    },
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
