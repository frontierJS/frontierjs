/*
 * run.mjs — what Sierra costs a visitor, per surface, in bytes.
 *
 *   node bench/run.mjs              build each floor, fail on a rise
 *   node bench/run.mjs --update     write the numbers that went DOWN into bench.baseline.json
 *   node bench/run.mjs --adopt      write every number, raises included
 *
 * One floor per build target — the smallest interactive thing an app on it
 * ships, with no stylesheet (`@frontierjs/css` is its own row):
 *
 *   floor-spa     the scaffold's entry, RouterView and one route
 *   floor-static  a page with no island and a page with one; `index.html` is
 *                 the plain one, so `static.firstLoadJsBrotli` is the claim
 *                 that a page with no island ships no script
 *   floor-widget  one widget, its runtime and CSS inside its own IIFE
 *
 * The counting is `packages/cli/core/bench.js`, the measurer `fli test:bench`
 * and the vanilla floor use, so every byte gate on a built surface is brotli
 * from one function. A rise fails; `--update` cannot raise a number and
 * `--adopt` is the verb that can (root Invariant 14's shape). A Vite upgrade
 * can move these with nothing wrong, and `--adopt` is the answer then.
 *
 * Each fixture is copied into `bench/dist/` and built there, because the
 * scanner writes `config/routes.js` into the Vite root.
 */
import { cp, rm, mkdir }                                   from 'node:fs/promises'
import { join }                                            from 'node:path'
import { fileURLToPath }                                   from 'node:url'
import { build }                                           from 'vite'
import { createSierraViteConfig }                          from '../src/build/index.js'
import { buildWidgets }                                    from '../src/build/widget-build.js'
import { measureSurface, gatedMetrics, ratchet, readBaseline, writeBaseline, kb }
                                                           from '../../cli/core/bench.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORK = join(HERE, 'dist')

const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)

// ─── build ───────────────────────────────────────────────────────────────────

async function stage(name) {
  const root = join(WORK, name)
  await rm(root, { recursive: true, force: true })
  await cp(join(HERE, 'fixtures', name), root, { recursive: true })
  return root
}

async function buildPage(name, target) {
  const root = await stage(name)
  await build({ ...createSierraViteConfig({ target, routesDir: 'src/routes' }), root, logLevel: 'warn' })
  return join(root, 'dist/client')
}

async function buildWidget(name) {
  const root   = await stage(name)
  const config = createSierraViteConfig({ target: 'widget', widgets: { dir: 'src/Embeds', prefix: 'fjs-' } })
  await buildWidgets({ root, dir: 'src/Embeds', outDir: 'dist/embeds', prefix: 'fjs-', plugins: config.plugins ?? [], viteBuild: build })
  return join(root, 'dist/embeds')
}

// ─── main ────────────────────────────────────────────────────────────────────

await mkdir(WORK, { recursive: true })

const surfaces = {
  spa:    measureSurface(await buildPage('floor-spa', 'spa')),
  static: measureSurface(await buildPage('floor-static', 'static')),
  widget: measureSurface(await buildWidget('floor-widget')),
}

const failures = []
// A floor that built nothing reads as a clean run unless it is refused.
for (const [name, s] of Object.entries(surfaces)) {
  if (!s?.files) failures.push(`${name}: the build wrote no files`)
  if (s?.firstLoad?.missing.length) failures.push(`${name}: index.html names files the build did not write — ${s.firstLoad.missing.join(', ')}`)
}

const pad  = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
console.log(`\n${pad('brotli', 10)}${lpad('files', 7)}${lpad('total', 11)}${lpad('js', 11)}${lpad('css', 11)}${lpad('first js', 11)}`)
for (const [name, s] of Object.entries(surfaces)) {
  if (!s) { console.log(`  ${pad(name, 8)}not built`); continue }
  console.log(`  ${pad(name, 8)}${lpad(s.files, 7)}${lpad(kb(s.brotliBytes), 11)}${lpad(kb(s.js.brotli), 11)}${lpad(kb(s.css.brotli), 11)}${lpad(s.firstLoad ? kb(s.firstLoad.jsBrotli) : '—', 11)}`)
}

const baseline = readBaseline(HERE)
const verdict  = ratchet(gatedMetrics(surfaces), baseline)
const first    = !Object.keys(baseline).length

console.log('')
for (const r of verdict.regressions)  console.log(`  raised    ${r.key} ${r.was} → ${r.now}`)
for (const r of verdict.improvements) console.log(`  lowered   ${r.key} ${r.was} → ${r.now}`)
if (!first) for (const r of verdict.unbaselined) console.log(`  new       ${r.key} ${r.value}`)
for (const k of verdict.unmeasured)   console.log(`  unmeasured ${k} — kept at ${baseline[k]}`)

if (failures.length) {
  console.log('baseline not written: the run failed its checks')
} else if (first || flag('--adopt')) {
  writeBaseline(HERE, verdict.adopted)
  console.log(`baseline ${first ? 'written' : 'adopted'} — bench/bench.baseline.json`)
} else if (flag('--update') && (verdict.improvements.length || verdict.unbaselined.length)) {
  writeBaseline(HERE, verdict.next)
  console.log('baseline updated with the improvements')
} else if (verdict.improvements.length || verdict.unbaselined.length) {
  console.log('  `--update` writes the improvements back')
}
if (verdict.regressions.length && !flag('--adopt'))
  failures.push(`${verdict.regressions.length} number(s) rose — fix it, or \`--adopt\` with the reason in the commit message`)

for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(failures.length ? 1 : 0)
