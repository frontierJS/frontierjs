/*
 * run.mjs — the native drive (`FJS-D1074`).
 *
 *   node test/native/run.mjs               every spec
 *   node test/native/run.mjs counter       specs whose filename matches
 *   node test/native/run.mjs --verbose     print the passing rows too
 *   node test/native/run.mjs --device [--shots DIR] [names]
 *                                          the emulator sweep: every fixture
 *                                          opened in Lynx Explorer on the one
 *                                          adb device, its report read back
 *                                          from logcat
 *
 * ── What this exists to reach ─────────────────────────────────────────
 *
 * A `.mesa` component compiled with `target: 'native'`, bundled by Lynx's own
 * toolchain and run by Lynx's own engine — Lynx for Web, in `<lynx-view>`
 * in headless Chrome — then tapped and typed into through Chrome's input
 * pipeline. The fixtures are the terminal drive's (`test/terminal/fixtures`)
 * plus `fixtures/` here, so one corpus answers for both hosts. Every
 * `specs/*.spec.mjs` exports `run(t)` and runs through `test/browser/drive.mjs`.
 *
 * A phone is not this. The engine is Lynx's, but Chrome still does the
 * cascade, inheritance and layout, and the three device-only bugs in
 * `IDEAS/mesa-ir.md` § 10 all passed here. `--device` is the drive a
 * release owes (`DRIVES.md`): the same fixtures built for the engine's
 * native target and opened on an emulator or phone with Lynx Explorer
 * installed. It needs `adb` (`$ADB`, else `~/Android/Sdk/platform-tools`,
 * else PATH) and one device attached; the bundles are served over
 * `adb reverse`, so the device needs no network.
 *
 * Traps:
 * - The main thread has no async chunk loader, so a chunk shared between
 *   entries never loads and its fixture never renders: `all-in-one`.
 * - A fixture's report is a console line, `MESA_NATIVE {...}`, because a
 *   phone has no page to evaluate in and the emulator sweep reads the same
 *   line from logcat.
 * - The `@lynx-js/*` devDependencies are pinned exact. The Element PAPI
 *   carries no stability promise (`FJS-D1069`).
 * - Explorer under ARM translation can take over 4 s to report a bundle,
 *   so the sweep waits on the report rather than a fixed sleep.
 */
import { mkdtempSync, writeFileSync, readdirSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, basename, dirname, extname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRsbuild } from '@rsbuild/core'
import { pluginLynx } from '@lynx-js/rsbuild-plugin'
import { pluginVanillaLynx } from '@lynx-js/vanilla-rsbuild-plugin'
import { compileTree } from '../../scripts/host-tree.js'
import { runSpecs, green, red } from '../browser/drive.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PKG  = fileURLToPath(new URL('../..', import.meta.url))
const RUNTIME = join(PKG, 'src/runtime-native.js')
const WEB_CORE = join(dirname(createRequire(import.meta.url).resolve('@lynx-js/web-core/package.json')), 'dist/client_prod')

const argv    = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const device  = argv.includes('--device')
const shots   = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
const filters = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--shots')

const SOURCES = [join(PKG, 'test/terminal/fixtures'), join(HERE, 'fixtures')]
// What a fixture is mounted with, where it reads a prop to render at all.
const PROPS = { Provide: { on: true, items: ['a'] } }

// ─── compile and bundle ───────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'mesa-native-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

/** name → { entry } or { refusal }: every fixture, compiled or refused by name. */
const fixtures = {}
for (const dir of SOURCES) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.mesa')).sort()) {
    const name = basename(f, '.mesa')
    // A second fixture of one name would replace the first in silence.
    if (fixtures[name]) throw new Error(`two fixtures are named ${name}: ${join(dir, f)}`)
    try {
      const styles = []
      const url = await compileTree(join(dir, f), tmp, { target: 'native', styles })
      const entry = join(tmp, `entry-${name}.mjs`)
      writeFileSync(entry, entrySource(name, url, PROPS[name] ?? {}))
      let css = false
      if (styles.length) writeFileSync(css = join(tmp, `entry-${name}.css`), styles.join('\n'))
      fixtures[name] = { entry, css }
    } catch (e) {
      fixtures[name] = { refusal: String(e.message).split('\n')[0] }
    }
  }
}

function entrySource(name, url, props) {
  return `import { mount } from ${JSON.stringify(RUNTIME)}
import Component from ${JSON.stringify(url)}
globalThis.processData = (d) => d
lynx.getEngine().addEventListener('__RenderPage', () => {
  let report
  try { mount(Component, { props: ${JSON.stringify(props)} }); report = { name: ${JSON.stringify(name)}, phase: 'mounted' } }
  catch (e) { report = { name: ${JSON.stringify(name)}, phase: 'threw', error: String(e && e.message) } }
  console.log('MESA_NATIVE ' + JSON.stringify(report))
})
`
}

const entries = Object.fromEntries(Object.entries(fixtures)
  .filter(([, f]) => f.entry)
  .map(([name, f]) => [name, { mainThread: f.entry, background: false, css: f.css }]))
const dist = join(tmp, 'dist')
const rsbuild = await createRsbuild({
  cwd: PKG,
  rsbuildConfig: {
    plugins: [pluginLynx(), pluginVanillaLynx({ entries })],
    performance: { chunkSplit: { strategy: 'all-in-one' } },
    environments: device ? { lynx: {} } : { web: {} },
    output: { distPath: { root: dist }, cleanDistPath: false },
    logLevel: 'warn',
  },
})
await rsbuild.build()

// ─── serve ────────────────────────────────────────────────────────────

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/web-core/static/css/client.css">
<script type="module" src="/web-core/static/js/client.js"></script>
</head><body style="margin:0">
<script>
  const name = new URLSearchParams(location.search).get('bundle')
  if (name) document.write('<lynx-view style="width:400px;height:600px;display:block" url="/dist/' + name + '.web.bundle"></lynx-view>')
</script>
</body></html>`

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.bundle': 'application/octet-stream', '.wasm': 'application/wasm', '.json': 'application/json' }
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const file = path === '/' ? null
    : path.startsWith('/web-core/') ? join(WEB_CORE, path.slice('/web-core/'.length))
    : path.startsWith('/dist/') ? join(dist, path.slice('/dist/'.length))
    : undefined
  if (file === null) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return }
  if (!file || !existsSync(file)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

if (device) {
  const bad = await sweepDevice(server.address().port)
  server.close()
  process.exit(bad ? 1 : 0)
}

// ─── the spec API ─────────────────────────────────────────────────────

const view = `document.querySelector('lynx-view')?.shadowRoot`

const { infra, failures } = await runSpecs({
  origin,
  specDir: join(HERE, 'specs'),
  filters,
  verbose,
  extend: (browser) => {
    const reports = new Map()
    browser.on('Runtime.consoleAPICalled', (p) => {
      const line = p.args?.[0]?.value
      if (typeof line === 'string' && line.startsWith('MESA_NATIVE ')) {
        const r = JSON.parse(line.slice('MESA_NATIVE '.length))
        reports.set(r.name, r)
      }
    })
    const clickAtPoint = async ({ x, y }) => {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await browser.cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
      }
    }
    return {
      /** name → { entry } or { refusal }, every fixture this run compiled. */
      fixtures,
      /** Load `name`'s bundle and answer its main thread's own report. */
      open: async (name, ms = 15000) => {
        reports.delete(name)
        await browser.navigate(`${origin}/?bundle=${name}`)
        const t0 = Date.now()
        while (!reports.has(name) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25))
        return reports.get(name) ?? { name, phase: 'never-reported' }
      },
      /** The view's text, white space collapsed. */
      text: () => browser.evaluate(`return ${view}?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`),
      /** An expression for `t.eventually`: whether the view's text holds every part. */
      shows: (...parts) => `(${view}?.textContent?.replace(/\\s+/g, ' ') ?? '').includes(${JSON.stringify(parts[0])})` +
        parts.slice(1).map((p) => ` && (${view}?.textContent?.replace(/\\s+/g, ' ') ?? '').includes(${JSON.stringify(p)})`).join(''),
      /** A real click on the innermost element whose text is `label`. */
      tap: async (label) => {
        const at = await browser.evaluate(`
          const all = [...${view}.querySelectorAll('x-view, x-text')].filter((e) => e.textContent.trim() === ${JSON.stringify(label)});
          const el = all.at(-1);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        `)
        if (!at) throw new Error(`no element reads "${label}"`)
        await clickAtPoint(at)
      },
      /** Focus the `index`th field by a click and type `chars` into it. */
      typeInto: async (index, chars) => {
        const at = await browser.evaluate(`
          // The element lays out nothing itself; the box is its own input's.
          const x = ${view}.querySelectorAll('x-input')[${index}]?.shadowRoot?.querySelector('input');
          if (!x) return null;
          const r = x.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        `)
        if (!at) throw new Error(`no field #${index}`)
        await clickAtPoint(at)
        await browser.type(chars)
      },
    }
  },
})

server.close()
process.exit(infra ? 2 : failures ? 1 : 0)

// ─── the device sweep ─────────────────────────────────────────────────

async function sweepDevice(port) {
  const sdk = join(homedir(), 'Android/Sdk/platform-tools/adb')
  const adb = process.env.ADB ?? (existsSync(sdk) ? sdk : 'adb')
  const sh = (...args) => execFileSync(adb, args, { encoding: 'utf8', maxBuffer: 64 << 20 })
  const { REFUSED } = await import('./specs/mount.spec.mjs')
  if (shots) mkdirSync(shots, { recursive: true })
  sh('reverse', `tcp:${port}`, `tcp:${port}`)
  let bad = 0
  const row = (ok, name, detail) => { if (!ok) bad++; console.log(`${ok ? green('✓') : red('✗')} ${name.padEnd(10)} ${detail}`) }
  try {
    for (const [name, f] of Object.entries(fixtures)) {
      if (filters.length && !filters.some((x) => name.includes(x))) continue
      if (f.refusal) { row(!!REFUSED[name], name, f.refusal); continue }
      sh('shell', 'am', 'force-stop', 'com.lynx.explorer')
      sh('logcat', '-c')
      const url = encodeURIComponent(`http://localhost:${port}/dist/${name}.lynx.bundle`)
      sh('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'lynx://open?url=${url}'`)
      let report = null
      for (const t0 = Date.now(); !report && Date.now() - t0 < 60000;) {
        await new Promise((r) => setTimeout(r, 500))
        report = reportIn(sh('logcat', '-d'), name)
      }
      // The report is written before the first frame is painted.
      if (shots) { await new Promise((r) => setTimeout(r, 1500)); writeFileSync(join(shots, `${name}.png`), execFileSync(adb, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 })) }
      row(report?.phase === 'mounted', name, report ? report.phase + (report.error ? ` — ${report.error}` : '') : 'never reported')
    }
  } finally {
    sh('reverse', '--remove', `tcp:${port}`)
  }
  return bad
}

/** The fixture's `MESA_NATIVE` line in a logcat dump, which may quote it. */
function reportIn(log, name) {
  for (const m of log.matchAll(/MESA_NATIVE (\{[^}]*\})/g)) {
    let r = null
    try { r = JSON.parse(m[1]) } catch { try { r = JSON.parse(m[1].replace(/\\"/g, '"')) } catch {} }
    if (r?.name === name) return r
  }
  return null
}
