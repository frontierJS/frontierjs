/*
 * run.mjs — the browser kit drive, `@frontierjs/mesa/browser` in a real tab.
 *
 *   node test/browser/kit/run.mjs               every spec
 *   node test/browser/kit/run.mjs persisted     specs whose filename matches
 *   node test/browser/kit/run.mjs --verbose     print the passing rows too
 *   node test/browser/kit/run.mjs --serve       serve and stay up
 *
 * Needs Chrome on PATH or `$FJS_CHROME`.
 *
 * ── Why a drive of its own ────────────────────────────────────────────
 *
 * A wrapper's value is a condition of the browser — the viewport, the color
 * scheme, the network, a second tab, the tab hidden — and happy-dom can set
 * none of them, so a wrapper proved there is proved against its own default.
 * Each spec here flips the real condition over CDP and reads the wrapper's
 * answer through a mounted fixture. One spec per wrapper; a wrapper with no
 * spec is `none` in the plan's table (`IDEAS/browser-kit.md` § The drive).
 *
 * The server and page are the runtime drive's: the same compile-on-demand
 * server, the same `#stage` delegation root, so a kit fixture is mounted the
 * way an app mounts a component. Only the fixtures and specs are this
 * directory's.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMesaServer } from '../runtime/server.mjs'
import { runSpecs, dim } from '../drive.mjs'
import { createNetwork } from '../../../src/drive.js'

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
  console.log(dim('kit fixtures are at /mesa/test/browser/kit/fixtures/<name>.mesa'))
} else {
  const fixture = (name) => `/mesa/test/browser/kit/fixtures/${name}.mesa`

  const { infra, failures } = await runSpecs({
    origin,
    specDir: join(HERE, 'specs'),
    filters,
    verbose,
    ready: 'window.__mesaReady',
    extend: (browser) => ({
      /** Mount a fixture by name — `fixtures/<name>.mesa`. */
      mount: (name, props = {}) => browser.evaluate(
        `return await window.mesaMount(${JSON.stringify(fixture(name))}, ${JSON.stringify(props)});`
      ),
      /** Everything console.warn has been handed since the last mount — a
       *  blocked localStorage warns once per key, and that warning is the
       *  behavior under test. */
      warnings: () => browser.evaluate('return { v: window.mesaWarnings.slice() };').then((r) => r.v),
      /** A second tab on the drive page — what another window writing
       *  localStorage or posting a BroadcastChannel needs. Close it. */
      tab: () => browser.newPage(`${origin}/`, 'window.__mesaReady'),
      /** Run `fn` with the network down — `navigator.onLine` false and the
       *  `offline` event fired — and put it back whatever happens. */
      offline: async (fn) => (await createNetwork(browser)).withOffline(fn, { sever: false }),
      /** Run `fn` with the media features set — `{ 'prefers-color-scheme':
       *  'dark' }` — and the emulation cleared whatever happens. */
      media: async (features, fn) => {
        await browser.cmd('Emulation.setEmulatedMedia', {
          features: Object.entries(features).map(([name, value]) => ({ name, value })),
        })
        try { return await fn() }
        finally { await browser.cmd('Emulation.setEmulatedMedia', { features: [] }) }
      },
      /** Run `fn` at a viewport `width` px wide, and put the window's own back
       *  whatever happens. */
      viewport: async (width, fn) => {
        await browser.cmd('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
        try { return await fn() }
        finally { await browser.cmd('Emulation.clearDeviceMetricsOverride') }
      },
      /** Run `fn` with this tab in the background: another tab in front, so
       *  this one is `hidden` and blurred, the way a person switching away
       *  leaves it. The drive's focus emulation keeps a page focused whatever
       *  the window does (`FJS-1084`), so it is off for the duration — and
       *  back on, with this tab in front, whatever happens. */
      hidden: async (fn) => {
        const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
        try {
          await browser.cmd('Emulation.setFocusEmulationEnabled', { enabled: false })
          await browser.send('Target.activateTarget', { targetId })
          return await fn()
        } finally {
          await browser.send('Target.closeTarget', { targetId }).catch(() => {})
          await browser.cmd('Page.bringToFront')
          await browser.cmd('Emulation.setFocusEmulationEnabled', { enabled: true })
        }
      },
    }),
    // A fresh document per spec: a wrapper holds its listeners and pools for
    // the life of the tab, so a spec counting what the first read adds would
    // count nothing after an earlier spec had armed the same wrapper.
    teardown: (browser) => browser.navigate(`${origin}/`, 'window.__mesaReady'),
    notes: () => compileWarnings.map(([file, w]) => `${file.replace(PKG, '')} — ${w}`),
  })

  await it.close()
  process.exit(failures || infra ? 1 : 0)
}
