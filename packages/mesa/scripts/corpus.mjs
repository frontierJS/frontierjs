/*
 * corpus.mjs — compile every .mesa file in the workspace and compare the output
 * against a saved run, byte for byte.
 *
 *   bun run corpus -- --save before      compile all, write the outputs under .cache/mesa-corpus/before
 *   bun run corpus -- --diff before      compile all, name every file whose output differs from that save,
 *                                        and write this run beside it as before.now to diff against
 *   bun run corpus                       compile all, report refusals and invalid JS only
 *   bun run corpus -- --portability terminal
 *                                        also say how much of the corpus a target lowers today,
 *                                        and what stops the rest (`IDEAS/mesa-ir.md` § 3, § 6 step 2)
 *   bun run corpus -- --portability server
 *                                        the same tally, and then every file that lowers is RENDERED
 *                                        on both paths and the HTML compared byte for byte
 *
 * This is the grade for a compiler change meant to change NOTHING — the IR
 * extraction (`IDEAS/mesa-ir.md` § 6 step 1) above all. Invariant 12 makes the
 * output reproducible, so a byte that moves is either a bug or a change to be
 * named; there is no third kind and no tolerance.
 *
 * Each file compiles twice: once as a production build compiles it and once as
 * a dev server does, because `data-fjs-loc`, the debug labels and the HMR-facing
 * shape exist only in the second and a refactor can break either alone.
 *
 * A refusal is an output too. A file that threw before must throw the same
 * message after, so the error text is saved and compared like the JS is.
 *
 * Every output is parsed with acorn (Invariant 15): a compile that returns is
 * not a compile that produced JavaScript.
 *
 * The portability report reads `ctx.ir` off the production compile and asks
 * the target's own `hostOffenses` what it would refuse — every offender,
 * not the first the emitter throws. A file lowers when nothing in its own
 * template is refused AND every component it calls lowers, so a component
 * tag is followed through its import to the child's file. A tag whose import
 * does not resolve to a corpus file is an offender of its own: the report
 * cannot say whether it lowers. A shape's *unlocks* is how many more files
 * would lower if that shape alone lowered next, children included.
 *
 * ── The parity pass ──────────────────────────────────────────────────
 *
 * A target with a string mode (`server`) is admissible only while it writes
 * the HTML the DOM path serializes (`IDEAS/server-render-without-dom.md` § 3),
 * so for that target every file the tally says lowers is compiled twice more
 * (`css: false`, unscoped), rendered once through `renderToHTML` and once as
 * `Comp(out, props)` with no props, and the two strings compared raw. The
 * modules are imported for real, so the script's imports have to resolve: a
 * `.mesa` the script imports compiles on the fly, for the path of the module
 * importing it (a tree is one mode throughout), a stylesheet or an asset is
 * an empty module, and a specifier the workspace cannot resolve from the
 * file's own directory (`$lib/…`, a vite alias, `?raw`) binds to a stub
 * value that answers every property and call with itself. Both paths see the
 * same stub, so the comparison still means something; what it cannot grade
 * is a page whose markup depends on what the alias would have returned. A
 * file that throws on both paths — a page that reads a prop it was not
 * given — is counted and set aside, as is one importing a component the mode
 * refuses; one that throws on ONE path is a finding and fails the run, as a
 * byte that differs does.
 *
 * ── What it does not see ─────────────────────────────────────────────
 *
 * The files are compiled raw. Sierra rewrites a page before handing it over
 * (injected imports and props), so a defect that lives only in that rewritten
 * shape is invisible here; `example`'s drives are where that shape runs.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'
import { hostOffenses } from '../src/host/emit.js'
import { TARGETS } from '../src/host/targets.js'
import { callsOf, follow, lowering, plan } from './portability.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const CACHE = join(ROOT, '.cache/mesa-corpus')
const PARITY = join(CACHE, 'parity')
const STUB = join(PARITY, 'stub.mjs')
const REFUSAL = /has no \w+ lowering/

const ASSET = /\.(css|scss|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|mp4|webm|md|txt)$/
const LOADERS = { ts: 'ts', mts: 'ts', tsx: 'tsx', jsx: 'jsx' }

const RUNTIME = {
  '@frontierjs/mesa/runtime':        join(HERE, '../src/runtime.js'),
  '@frontierjs/mesa/runtime/server': join(HERE, '../src/runtime-server.js'),
}

// A value that answers every property and every call with itself, and
// serializes as an empty string: what an unresolvable import binds to.
const STUB_SOURCE = `const handler = {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k === 'toString' || k === 'toJSON' ? () => '' : stub),
  apply: () => stub,
  construct: () => stub,
}
export const stub = new Proxy(function stub() {}, handler)
export default stub
`


const MODES = {
  prod: (filename) => ({ filename, dev: false }),
  dev:  (filename) => ({ filename, dev: true, loc: true, locRoot: '' })
}

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
const saveAs = flag('--save')
const diffAgainst = flag('--diff')
const portability = flag('--portability')
if (portability && !TARGETS[portability]) {
  console.error(`no portability report for target ${portability} — one of: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(2)
}

// What an `@frontierjs/<name>/…` import resolves to, for the report's walk to a child's file.
const PACKAGES = new Set(readdirSync(join(ROOT, 'packages')))

// rg skips node_modules and gitignored build output, which is the corpus: a
// built copy of a component under dist/ is not a second source file.
const files = execFileSync('rg', ['--files', '-g', '*.mesa'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .sort()

const results = []
const portable = []
const warningsOff = () => {}

for (const file of files) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  for (const [mode, configFor] of Object.entries(MODES)) {
    let out
    let refused = null
    try {
      const ctx = await compile(source, { ...configFor(file), warning: warningsOff })
      out = ctx.result
      if (portability && mode === 'prod') portable.push({ file, offenses: hostOffenses(ctx.ir, TARGETS[portability]), calls: callsOf(file, source, ctx.ir, PACKAGES) })
    } catch (err) {
      refused = String(err?.message ?? err)
      out = `/* refused */\n${refused}\n`
    }
    let invalid = null
    if (!refused) {
      try {
        acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' })
      } catch (err) {
        invalid = err.message
      }
    }
    results.push({ file, mode, out, refused, invalid, hash: sha(out) })
  }
}

const refusedCount = results.filter((r) => r.refused).length
const invalid = results.filter((r) => r.invalid)
console.log(`${files.length} files · ${results.length} compiles · ${refusedCount} refused · ${invalid.length} invalid JS`)
for (const r of invalid) console.log(`  invalid  ${r.file} [${r.mode}]  ${r.invalid}`)

if (portability) await reportPortability(portability)

if (saveAs) console.log(`saved ${relative(ROOT, save(saveAs))}`)

if (diffAgainst) {
  const dir = join(CACHE, diffAgainst)
  const manifest = join(dir, 'manifest.json')
  if (!existsSync(manifest)) {
    console.error(`no save named ${diffAgainst} — run with --save ${diffAgainst} first`)
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(manifest, 'utf8'))
  const now = manifestOf(results)
  const changed = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(now)])) {
    if (before[key] !== now[key]) changed.push(key)
  }
  if (changed.length === 0) {
    console.log(`identical to ${diffAgainst}: ${results.length} outputs`)
  } else {
    const nowDir = save(`${diffAgainst}.now`)
    for (const key of changed.sort()) {
      const why = !(key in before) ? 'new' : !(key in now) ? 'gone' : 'differs'
      console.log(`  ${why.padEnd(7)}  ${key}`)
    }
    const [mode, file] = changed[0].split(/:(.*)/)
    console.log(`${changed.length} of ${results.length} outputs moved — the first, compared:`)
    console.log(`  git diff --no-color --no-index ${relative(ROOT, join(dir, mode, `${file}.js`))} ${relative(ROOT, join(nowDir, mode, `${file}.js`))}`)
    process.exitCode = 1
  }
}

if (invalid.length) process.exitCode = 1
// An app module the parity pass imported leaves timers behind — a client that
// reconnects, a poll — and the process would never return on its own.
if (portability && TARGETS[portability].mode === 'string') process.exit()

function save(name) {
  const dir = join(CACHE, name)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
  for (const r of results) {
    const path = join(dir, r.mode, `${r.file}.js`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, r.out)
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestOf(results), null, 1))
  return dir
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function manifestOf(rs) {
  return Object.fromEntries(rs.map((r) => [`${r.mode}:${r.file}`, r.hash]))
}

async function reportPortability(target) {
  const files = follow(portable)
  const pct = (n, of) => `${of ? Math.round((n / of) * 100) : 0}%`
  const now = lowering(files)
  const held = files.filter((f) => f.offenses.length === 0 && !now.has(f.file)).length
  console.log(`\n${target}: ${now.size} of ${files.length} files lower today (${pct(now.size, files.length)}); ` +
    `${held} more pass on their own and are held by a component they call`)

  // An area is the first two path segments: packages/ui, example/web.
  const areas = new Map()
  for (const f of files) {
    const area = f.file.split('/').slice(0, 2).join('/')
    const a = areas.get(area) ?? { files: 0, lower: 0 }
    a.files++
    if (now.has(f.file)) a.lower++
    areas.set(area, a)
  }
  console.log('\n  area                          lower / files')
  for (const [area, a] of [...areas].sort((x, y) => y[1].files - x[1].files)) {
    console.log(`  ${area.padEnd(30)}${String(a.lower).padStart(5)} / ${String(a.files).padEnd(5)} ${pct(a.lower, a.files)}`)
  }

  const { rows, order } = plan(files)
  console.log('\n  shape                                files  unlocks   uses')
  for (const r of rows) {
    console.log(`  ${r.shape.padEnd(35)}${String(r.files).padStart(7)}${String(r.unlocks).padStart(9)}${String(r.uses).padStart(7)}`)
  }
  console.log(`\n  lower next: ${order.map((o) => `${o.shape} +${o.gain} (${pct(o.lower, files.length)})`).join(' → ')}`)

  const path = join(CACHE, `portability-${target}.json`)
  mkdirSync(CACHE, { recursive: true })
  writeFileSync(path, JSON.stringify(files, null, 1))
  console.log(`\n  every offender, by file: ${relative(ROOT, path)}`)

  if (TARGETS[target].mode === 'string') await reportParity(target, [...now].sort())
}

// ── Parity ──────────────────────────────────────────────────────────────────

async function reportParity(target, lowering) {
  const { initRenderer, renderToHTML } = await import('../src/render.js')
  const { createRoot, setRenderEnvironment } = await import('../src/runtime.js')
  installLoaders()
  initRenderer()
  mkdirSync(PARITY, { recursive: true })
  writeFileSync(STUB, STUB_SOURCE)

  const buckets = { same: [], styleText: [], unstable: [], boundNode: [], differs: [], threwBoth: [], threwDom: [], threwStr: [], childRefused: [], unimportable: [] }
  for (const file of lowering) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    let Dom, Str
    try {
      Dom = await importCompiled(file, source, undefined)
    } catch (err) {
      buckets.unimportable.push({ file, why: firstLine(err) })
      continue
    }
    try {
      Str = await importCompiled(file, source, target)
    } catch (err) {
      // A file lowers while a component it imports does not: the render
      // path falls the whole tree back, so there is no string render to
      // compare. Set aside and named, since the tally counts the file.
      if (REFUSAL.test(err.message)) { buckets.childRefused.push({ file, why: firstLine(err) }); continue }
      buckets.unimportable.push({ file, why: firstLine(err) })
      continue
    }
    // A terminal or native fixture's runtime flips the environment as it
    // loads, and an imported module graph can reach one.
    setRenderEnvironment(true, false)
    const dom = attempt(() => renderToHTML(Dom, {}))
    const str = attempt(() => { let html = ''; createRoot((dispose) => { const out = []; Str(out, {}); html = out.join(''); dispose() }); return html })
    const [a, b] = await Promise.all([dom, str])
    if (a.error && b.error) { buckets.threwBoth.push({ file, why: firstLine(a.error) }); continue }
    if (a.error) { buckets.threwDom.push({ file, why: firstLine(a.error) }); continue }
    if (b.error) { buckets.threwStr.push({ file, why: firstLine(b.error) }); continue }
    // `renderToHTML` trims the page it returns; the string path is the raw join.
    const html = b.value.trim()
    if (a.value === html) { buckets.same.push({ file }); continue }
    // Beside the module that wrote it, so the diff and its source are one `ls` apart.
    writeFileSync(join(PARITY, 'dom', `${file}.html`), a.value)
    writeFileSync(join(PARITY, 'str', `${file}.html`), html)
    const why = firstDifference(a.value, html)
    // A component that mints an id renders differently every time, on either
    // path; a second DOM render says so.
    const again = await attempt(() => renderToHTML(Dom, {}))
    if (again.value !== a.value) { buckets.unstable.push({ file, why }); continue }
    // happy-dom's CSSOM re-serializes a style a directive touched — `0` as
    // `0px`, a shorthand as its longhands — which the string path does not
    // imitate (plan 1.2's known non-parity); the markup around it is graded.
    if (sansStyle(a.value) === sansStyle(html)) { buckets.styleText.push({ file, why }); continue }
    // A script handed a node by `bind:this` writes on it under happy-dom —
    // an `aria-expanded` from a `$:` — and the string mode has no node to
    // hand (plan 2.5: `bind:this` is null), so the write has nowhere to land.
    if (bindsThis(file)) { buckets.boundNode.push({ file, why }); continue }
    buckets.differs.push({ file, why })
  }

  const n = (k) => String(buckets[k].length).padStart(5)
  console.log(`\n  parity on ${target}: ${lowering.length} lowering files rendered on both paths`)
  console.log(`  ${n('same')} same`)
  console.log(`  ${n('differs')} differ`)
  console.log(`  ${n('styleText')} differ only in a style attribute's CSS text (set aside — happy-dom's CSSOM re-serialization)`)
  console.log(`  ${n('unstable')} render differently each time on the DOM path too (set aside — a minted id)`)
  console.log(`  ${n('boundNode')} differ with a bind:this in the tree (set aside — a script wrote on a node the string mode cannot hand it)`)
  console.log(`  ${n('threwBoth')} threw on both paths (set aside — a page that reads a prop it was not given)`)
  console.log(`  ${n('threwDom')} threw on the DOM path only`)
  console.log(`  ${n('threwStr')} threw on the string path only`)
  console.log(`  ${n('childRefused')} import a component the mode refuses (set aside — the tree falls back)`)
  console.log(`  ${n('unimportable')} could not be imported (a transitive import the workspace cannot resolve)`)
  for (const [k, label] of [['differs', 'differs'], ['threwDom', 'dom threw'], ['threwStr', 'str threw'], ['styleText', 'style'], ['unstable', 'unstable'], ['boundNode', 'bound'], ['childRefused', 'child'], ['unimportable', 'import']]) {
    for (const r of buckets[k]) console.log(`  ${label.padEnd(10)} ${r.file}  ${r.why}`)
  }
  if (buckets.differs.length) {
    const { file } = buckets.differs[0]
    console.log(`  the first difference, compared:`)
    console.log(`    git diff --no-color --no-index ${relative(ROOT, join(PARITY, 'dom', `${file}.html`))} ${relative(ROOT, join(PARITY, 'str', `${file}.html`))}`)
  }
  if (buckets.differs.length || buckets.threwDom.length || buckets.threwStr.length) process.exitCode = 1
}

async function attempt(fn) {
  try { return { value: await fn() } } catch (error) { return { error } }
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0].slice(0, 160)
}

// The attribute stays, so a style missing on one path is still a difference;
// only its text is set aside. A property-name set would be stricter, but
// the CSSOM expands a shorthand into longhands and the names would differ.
function sansStyle(html) {
  return html.replace(/ style="[^"]*"/g, ' style="…"')
}

function firstDifference(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const show = (s) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 40))
  return `at ${i}: dom ${show(a)} · str ${show(b)}`
}

/**
 * Compile the file for one path, write the module under the parity cache and
 * import it. Every import specifier is rebound before the write: the runtimes
 * to this package's own source (so the script and the module share one
 * reactive core), a specifier the workspace resolves from the file's own
 * directory to its absolute path, and anything else to the stub.
 */
async function importCompiled(file, source, target) {
  const mode = target ? 'str' : 'dom'
  const { result } = await compile(source, { target, filename: file, dev: false, css: false, warning: warningsOff })
  const js = rebindImports(result, dirname(join(ROOT, file)))
  const path = join(PARITY, mode, `${file}.mjs`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, js)
  const mod = await import(`file://${path}`)
  if (typeof mod.default !== 'function') throw new Error('no default export')
  return mod.default
}

function rebindImports(js, from) {
  const ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
  const edits = []
  for (const node of ast.body) {
    if (!node.source) continue
    const spec = node.source.value
    const resolved = resolveFrom(spec, from)
    if (resolved) { edits.push([node.source.start, node.source.end, JSON.stringify(resolved)]); continue }
    if (node.type !== 'ImportDeclaration') { edits.push([node.source.start, node.source.end, JSON.stringify(STUB)]); continue }
    // An unresolvable import becomes a binding to the stub value, named as
    // the import named it: an ESM import of a stub module could not supply
    // the names statically.
    const names = node.specifiers.map((s) => {
      if (s.type === 'ImportDefaultSpecifier') return `${s.local.name} = $$stub`
      if (s.type === 'ImportNamespaceSpecifier') return `${s.local.name} = $$stub`
      return `${s.local.name} = $$stub`
    })
    edits.push([node.start, node.end, names.length ? `const ${names.join(', ')};` : ''])
  }
  let out = js
  for (const [start, end, text] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, start) + text + out.slice(end)
  return `import { stub as $$stub } from ${JSON.stringify(STUB)};\n${out}`
}

/**
 * Whether `file` or any `.mesa` its imports reach writes `bind:this`. Read
 * off the sources, since Bun keeps a loaded module's graph to itself; an
 * import the workspace cannot resolve is the stub and reaches nothing. Not
 * memoized across files: a cycle is cut with `false`, which is only true of
 * that walk.
 */
function bindsThis(file, seen = new Set()) {
  const abs = isAbsolute(file) ? file : join(ROOT, file)
  if (seen.has(abs)) return false
  seen.add(abs)
  let source = ''
  try { source = readFileSync(abs, 'utf8') } catch { return false }
  if (/\bbind:this\b/.test(source)) return true
  for (const m of source.matchAll(/\bfrom\s+['"]([^'"]+\.mesa)['"]/g)) {
    const resolved = resolveFrom(m[1], dirname(abs))
    if (resolved && resolved.endsWith('.mesa') && bindsThis(resolved, seen)) return true
  }
  return false
}

function resolveFrom(spec, from) {
  if (RUNTIME[spec]) return RUNTIME[spec]
  try { return Bun.resolveSync(spec, from) } catch { return null }
}

function installLoaders() {
  if (installLoaders.done) return
  installLoaders.done = true
  Bun.plugin({
    name: 'mesa-corpus-parity',
    setup(build) {
      // A tree is one mode throughout: everything a string-path module
      // reaches loads under the `str` namespace, so a .mesa on that path
      // compiles for the string path and is a different module from the
      // same file on the DOM path. A workspace .js is loaded there too, since
      // a kit's index re-exports its .mesa files. What stays ONE copy: a
      // third-party package, which reaches no .mesa, and this package's own
      // runtime, whose reactive core is process-global. Paths are not
      // realpath'd: an installed workspace package resolves its own
      // dependencies from its installed directory, not from the source tree.
      const str = join(PARITY, 'str')
      const mesaSrc = join(HERE, '../src')
      // Bun names a namespaced importer `str:/path` and leaves `namespace`
      // unset; the `?str` suffix keeps a string-path copy apart from the
      // same file loaded on the DOM path.
      const pathOf = (args) => args.path.replace(/\?str$/, '')
      const fromStr = (args) => (args.importer ?? '').startsWith('str:') || (args.importer ?? '').startsWith(str)
      const shared = (p) => p.startsWith(mesaSrc) || p.includes('/@frontierjs/mesa/') || (p.includes('/node_modules/') && !p.includes('/@frontierjs/'))
      // Every specifier on the string path is already absolute (rebound at
      // load), and `Bun.resolveSync` from inside a resolve hook re-enters
      // the resolver, which then retries from each parent directory and
      // discards the answer.
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!fromStr(args) || !args.path.startsWith('/')) return undefined
        return shared(args.path) ? undefined : { path: args.path + '?str', namespace: 'str' }
      })
      // A namespaced module's `import.meta.url` is `str:/path`, so a module
      // that locates a file from its own is pointed at the real one.
      const meta = (js, file) => js
        .replace(/import\.meta\.url\b/g, JSON.stringify(`file://${file}`))
        .replace(/import\.meta\.(?:dirname|dir)\b/g, JSON.stringify(dirname(file)))
        .replace(/import\.meta\.(?:filename|path)\b/g, JSON.stringify(file))
      build.onLoad({ filter: /.*/, namespace: 'str' }, async (args) => {
        const file = pathOf(args)
        if (file.endsWith('.mesa')) {
          const { result } = await compile(readFileSync(file, 'utf8'), { target: 'server', filename: relative(ROOT, file), dev: false, css: false, warning: warningsOff })
          return { contents: meta(rebindImports(result, dirname(file)), file), loader: 'js' }
        }
        if (ASSET.test(file)) return { contents: "export default ''", loader: 'js' }
        // Bun resolves a bare specifier in a namespaced module from the cwd,
        // not from the file, so every specifier is made absolute here as a
        // compiled .mesa's are; TypeScript is transpiled first so acorn can
        // read it.
        const ext = extname(file).slice(1)
        const code = readFileSync(file, 'utf8')
        const js = LOADERS[ext] ? new Bun.Transpiler({ loader: LOADERS[ext] }).transformSync(code) : code
        return { contents: meta(rebindImports(js, dirname(file)), file), loader: 'js' }
      })
      build.onLoad({ filter: /\.mesa$/ }, async (args) => {
        const { result } = await compile(readFileSync(args.path, 'utf8'), { filename: relative(ROOT, args.path), dev: false, css: false, warning: warningsOff })
        return { contents: rebindImports(result, dirname(args.path)), loader: 'js' }
      })
      build.onLoad({ filter: ASSET }, () => ({ contents: "export default ''", loader: 'js' }))
    }
  })
}
