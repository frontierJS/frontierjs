/**
 * @frontierjs/mesa — renderComponent
 *
 * Unified pipeline: Mesa source → HTML / email / fragment / JS.
 *
 * Handles:
 *   - Recursive import resolution (other .mesa/.md files)
 *   - CSS extraction and collection across the component tree
 *   - CSS inlining (for email / fragment targets)
 *   - UnoCSS class scanning (optional)
 *   - Rendering to HTML via the Mesa runtime
 *   - Subject line extraction for email templates
 *   - Plain-text fallback generation (email target)
 *   - JS target: compiled module map ready for bundling or serving
 *
 * Usage:
 *   import { renderComponent } from '@frontierjs/mesa/render-component.js'
 *
 *   // Email
 *   const result = await renderComponent(source, {
 *     data:     { firstName: 'Alice', items: [...] },
 *     cwd:      '/path/to/templates',
 *     target:   'email',
 *     filename: 'WelcomeEmail.mesa',
 *   })
 *   // result.html    — inlined, email-ready HTML
 *   // result.text    — plain text fallback
 *   // result.subject — from `export const subject = ...` in the component
 *   // result.css     — collected CSS (before inlining)
 *
 *   // Fragment — pre-rendered HTML chunk, styles inline
 *   const result = await renderComponent(source, {
 *     data:   { title: 'Hello' },
 *     cwd:    '/path/to/templates',
 *     target: 'fragment',
 *   })
 *
 *   // Full HTML document
 *   const result = await renderComponent(source, {
 *     data:   { title: 'Hello' },
 *     cwd:    '/path/to/templates',
 *     target: 'html',
 *   })
 *
 *   // Compiled JS module map (for client-side use)
 *   const result = await renderComponent(source, {
 *     cwd:      '/path/to/templates',
 *     filename: 'Counter.mesa',
 *     target:   'js',
 *   })
 *   // result.modules  — Map<filename, compiledJS>
 *   // result.css      — collected CSS
 *   // result.entry    — filename of the root module
 */

import path          from 'path'
import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { existsSync, unlinkSync, readdirSync, statSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { compileSource } from './compiler.js'
import { initRenderer, renderToHTML, escapeHTML } from './render.js'
import { inlineCSS }     from './css-inliner.js'

// ── Module-level renderer init guard ─────────────────────────────────────────
let _rendererReady = false
async function ensureRenderer() {
  if (_rendererReady) return
  await initRenderer()
  _rendererReady = true
}

// ── Temp file management ──────────────────────────────────────────────────────
// All temp files must live within a directory that:
//   - Node can resolve @frontierjs/mesa from (the mesa package root)
//   - Vite/vitest allows serving (within the configured fs.allow roots)
//
// import.meta.url can be rewritten by Vite to a virtual path — detect this
// and fall back to finding the actual mesa package directory on disk.

function findMesaDir() {
  try {
    // Walk UP from this module to the nearest package.json rather than assuming
    // this file sits at the package root. It does not: it lives in `src/`, and
    // testing only `dirname(import.meta.url)` for a package.json therefore
    // failed for every caller — the resolution then fell through to the cwd
    // search below, which finds mesa only when the process was started from
    // inside it. From any other package the last resort applies, temp modules
    // land in the OS temp dir, and every `import '@frontierjs/mesa/runtime.js'`
    // inside them fails to resolve. That is exactly what the comment above this
    // function says must not happen; it stopped being true when the sources
    // moved into src/, and the only symptom was somebody else's test suite.
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      if (existsSync(path.join(dir, 'package.json'))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* import.meta.url was rewritten by Vite to a non-file URL */ }

  // Fallback: search up from cwd for a directory containing mesa's package.json
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(require('fs').readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (pkg.name === '@frontierjs/mesa') return dir
    } catch { /* continue */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Last resort — the OS temp dir. This LOSES `@frontierjs/mesa` resolution, so
  // every temp module written here will fail to import the runtime; it exists
  // only so that resolution failing is not itself a throw.
  //
  // It says so now. Landing here silently is how the src/ move went unnoticed:
  // this package's own tests kept passing (they run from the package root) while
  // every render from another package failed on a bare specifier, and the error
  // pointed at a file in /tmp rather than at the resolution that put it there.
  // Resolved once and cached, so this warns at most once per process.
  console.warn(
    '[Mesa renderComponent] could not locate the @frontierjs/mesa package directory; ' +
    'temp render modules will be written to the OS temp dir, where ' +
    "`import '@frontierjs/mesa/runtime.js'` cannot resolve. Pass options.tmpDir to " +
    'a directory inside your project to fix this.'
  )
  return import('os').then(os => os.tmpdir()).catch(() => '/tmp')
}

const _tmpPrefix = '__mesa_render_'

// Resolved once, then reused. This used to be a module-level `const` awaited at
// import time, which made the directory a property of the *package* rather than
// of the call — see `defaultTmpDir` callers and `options.tmpDir`.
let _defaultTmpDir = null

/**
 * Where temp modules go when the caller does not say.
 *
 * Mesa's own package root, so a compiled module's `import '@frontierjs/mesa/
 * runtime.js'` resolves. That default is right for rendering Mesa's own trees
 * and wrong for rendering an app's: Node resolves bare specifiers relative to
 * the importing file, so a layout containing
 * `import { page } from '@frontierjs/sierra/router'` fails with "Cannot find
 * package" — the app's node_modules is nowhere on the lookup path from inside
 * packages/mesa. `options.tmpDir` is how a meta-framework points the temp
 * modules at its own tree instead.
 */
async function defaultTmpDir() {
  if (_defaultTmpDir === null) _defaultTmpDir = await Promise.resolve(findMesaDir())
  return typeof _defaultTmpDir === 'string' ? _defaultTmpDir : '/tmp'
}

function makeTmpPath(filePath, tmpDir) {
  const base = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(
    typeof tmpDir === 'string' && tmpDir ? tmpDir : '/tmp',
    `${_tmpPrefix}${base}_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`
  )
}

async function cleanTempFiles(paths) {
  await Promise.all(paths.map(p => unlink(p).catch(() => {})))
  for (const p of paths) _liveTemp.delete(p)
}

// ── Temp-module lifetime ──────────────────────────────────────────────────────
// renderComponent's `finally` blocks clean up on every path this process gets
// to run. Two it does not. A caller may ABANDON the render: sierra's prerender
// races it against a timeout with Promise.race, so a component that hangs at
// import leaves a promise that never settles and a `finally` that never runs,
// while the build reports the route skipped and exits. And a process that dies
// takes the pending cleanup with it. Either way a .mjs is stranded in whatever
// tmpDir was in use — by default this package's own root, where `bun run ci`'s
// hygiene phase reports it as an ignored source file, for everyone, until
// somebody deletes it by hand.
const _liveTemp = new Set()
let _exitSweepInstalled = false

/** Synchronous — an 'exit' listener may not await. */
function sweepLiveTemp() {
  for (const p of _liveTemp) { try { unlinkSync(p) } catch { /* already gone */ } }
  _liveTemp.clear()
}

function signalSweep(sig) {
  return function handler() {
    sweepLiveTemp()
    // Node's default for a signal is to exit WITHOUT firing 'exit', and merely
    // having a listener suppresses that default — so Ctrl-C on a build would
    // stop working. Re-raise to restore it, but only when nothing else is
    // listening: an app with its own shutdown handler owns the decision, and
    // re-raising would run that handler a second time.
    if (process.listenerCount(sig) > 1) return
    process.removeListener(sig, handler)
    process.kill(process.pid, sig)
  }
}

function installExitSweep() {
  if (_exitSweepInstalled) return
  _exitSweepInstalled = true
  // Covers a normal end, an explicit process.exit(), and the exit Node takes
  // after an uncaught throw. Not SIGKILL — nothing covers SIGKILL, which is
  // what the stale sweep below is for.
  process.on('exit', sweepLiveTemp)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, signalSweep(sig))
}

const STALE_TEMP_MS = 60 * 60 * 1000
const _sweptDirs = new Set()

/**
 * Remove temp modules a previous process left behind.
 *
 * The exit sweep cannot run after SIGKILL or a hard crash, so leftovers
 * accumulate in the default tmpDir — this package's root — and are reported by
 * CI rather than by anything the person who produced them was looking at.
 * Age-gated so a concurrent render's file is never taken: nothing here holds a
 * temp module for an hour, and sierra bounds a render at seconds.
 */
function sweepStaleTemp(dir) {
  if (!dir || _sweptDirs.has(dir)) return
  _sweptDirs.add(dir)
  const cutoff = Date.now() - STALE_TEMP_MS
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (!name.startsWith(_tmpPrefix) || !name.endsWith('.mjs')) continue
    const full = path.join(dir, name)
    try { if (statSync(full).mtimeMs < cutoff) unlinkSync(full) } catch { /* raced */ }
  }
}

// ── Import specifier regex ────────────────────────────────────────────────────
// Matches: import X from './foo.mesa'
//          import { a } from "./bar.md"
//          import * as X from './baz.mesa'
const IMPORT_RE = /^(import\s[\s\S]*?from\s+['"])([^'"]+)(['"])/gm

function isMesaSpecifier(spec) {
  return spec.endsWith('.mesa') || spec.endsWith('.md')
}

// ── The runtime the temp module runs against ──────────────────────────────────
// A compiled module imports the runtime by BARE specifier, which Node resolves
// from wherever the temp file was written. `options.tmpDir` therefore chooses
// which COPY of `runtime.js` executes, and a caller pointing it into its own
// tree (Sierra does, on every build) gets a different module object from the one
// `render.js` called `setRenderEnvironment(true, false)` on. Nothing fails: the
// rendering copy computed `_isClient` from `typeof document`, and the happy-dom
// globals are installed BEFORE the import, so it believes it is in a browser and
// every RULE 19 guard is off — `{@attach}` runs, `$.onMount` runs, and `island()`
// emits no markers at all. The specifier is rewritten to this file's own sibling
// so the two halves cannot be two files.
const RUNTIME_SPECIFIERS = new Set([
  '@frontierjs/mesa/runtime.js',
  '@frontierjs/mesa/runtime',
])

let _runtimePath
function runtimePath() {
  if (_runtimePath === undefined) {
    try {
      // `path.dirname(fileURLToPath(...))` and not `new URL('./runtime.js', ...)`:
      // under a happy-dom test environment the global URL is the DOM's, and
      // node's fileURLToPath refuses an instance it did not make, so the whole
      // suite fell back to the bare specifier without a render failing.
      _runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime.js')
    } catch {
      // import.meta.url was rewritten by a bundler to a non-file URL. Leaving
      // the bare specifier is the old behavior and still works whenever the two
      // copies coincide, so this warns rather than failing a render that renders.
      _runtimePath = null
      console.warn(
        '[Mesa renderComponent] could not resolve this package\'s own runtime.js; ' +
        'temp modules keep the bare specifier and may execute a DIFFERENT copy of ' +
        'the runtime, where server-render guards are off ({@attach} runs, islands ' +
        'emit no markers).'
      )
    }
  }
  return _runtimePath
}

/**
 * Resolve an aliased specifier to an absolute path, or null if none matches.
 *
 * A build-time render imports the compiled module under Node, which knows
 * nothing about a bundler's aliases: `@/api.js` is a BARE specifier there, so
 * Node looks for a package called `@` and fails with "Cannot find package". The
 * caller that has an alias table — Sierra's prerender, which is running a Vite
 * build and holds the same one Vite does — passes it in.
 *
 * Longest prefix wins, so `@ui` cannot be swallowed by `@`. An entry matches on
 * a path BOUNDARY (`@` matches `@/x`, never `@foo/x`) or on the bare key itself.
 */
function applyAlias(spec, alias) {
  if (!alias) return null
  let best = null
  for (const key of Object.keys(alias)) {
    if (spec !== key && !spec.startsWith(key + '/')) continue
    if (!best || key.length > best.length) best = key
  }
  if (best === null) return null
  const rest = spec.slice(best.length).replace(/^\//, '')
  return rest ? path.resolve(alias[best], rest) : path.resolve(alias[best])
}

// ── Recursive compiler ────────────────────────────────────────────────────────
/**
 * Compile a .mesa/.md file and all its .mesa/.md dependencies recursively.
 * Returns:
 *   - tmpPath   — path to the temp .mjs file for this component
 *   - css       — all collected CSS (this file + all deps)
 *   - modules   — Map<originalPath, compiledJS> (JS target)
 *   - tempFiles — array of all temp file paths created (for cleanup)
 *   - exports   — named exports extracted from the module (e.g. subject)
 *   - islands   — every `client:*` call site in this file and its deps, each
 *                 tagged with the file it was written in
 */
/**
 * Resolve a `.mesa` import to a file on disk.
 *
 * Relative and absolute specifiers are ordinary paths. A BARE one is a package
 * specifier — `@frontierjs/email-kit/components/Email.mesa` — and is resolved
 * the way Node resolves any other subpath export, from the importing file.
 *
 * Without this, a bare specifier was `path.resolve`d against the importer's
 * directory and produced nonsense:
 *
 *   ENOENT: …/api/emails/@frontierjs/email-kit/components/Email.mesa
 *
 * which is the usage `@frontierjs/email-kit`'s own README documents. It worked
 * inside that package only because its templates import `../components/…`
 * relatively; the first consumer outside it hit the wall. Same shape as the
 * temp-dir bug next door: correct from within, broken from without.
 */
function resolveMesaImport(spec, importer) {
  if (spec.startsWith('.') || path.isAbsolute(spec))
    return path.resolve(path.dirname(importer), spec)

  try {
    return fileURLToPath(import.meta.resolve(spec, pathToFileURL(importer).href))
  } catch {
    // Fall through to the old behavior so the error names the file the author
    // wrote, not a resolution API they have never heard of.
    return path.resolve(path.dirname(importer), spec)
  }
}

/**
 * Refuse a tree in which any file collected compiler errors.
 *
 * One throw for the whole tree, naming every file and every error under it. A
 * prerender walks hundreds of components and each error is independent of the
 * others, so failing at the first one costs a full rebuild per error.
 *
 * It throws rather than answering an array because an array is a channel a
 * caller has to remember to read, which is the fail-open this closes: the Vite
 * plugin read `analysis.errors` and the prerender did not, and nothing said so.
 */
function refuseCompileErrors(problems) {
  if (!problems?.length) return
  const detail = problems
    .map((p) => `${p.file}\n${p.errors.map((e) => `  \u2022 ${e}`).join('\n')}`)
    .join('\n')
  const n = problems.reduce((a, p) => a + p.errors.length, 0)
  throw new Error(
    `[Mesa renderComponent] ${n} compile error(s) in ${problems.length} file(s):\n${detail}`
  )
}

async function compileTree(filePath, visited = new Map(), tempFiles = [], opts = {}, sourceOverride = null) {
  const canonical = path.resolve(filePath)

  // Cycle guard
  if (visited.has(canonical)) {
    return { tmpPath: visited.get(canonical).tmpPath, css: '', tempFiles, modules: new Map(), islands: [], styles: [] }
  }

  // Read source — use override at entry point to avoid writing a temp .mesa file
  let source
  if (sourceOverride !== null) {
    source = sourceOverride
  } else {
    try {
      source = await readFile(canonical, 'utf8')
    } catch (err) {
      throw new Error(`[Mesa renderComponent] Cannot read file: ${canonical}\n${err.message}`)
    }
  }

  // Compile
  let ctx
  try {
    ctx = await compileSource(source, {
      filename: canonical,
      css:      false,    // css:false → CSS extracted as ctx.css.result string, not runtime injection
      debug:    false,
      dev:      false,
      warning:  () => {},
      ...opts.compileOptions,
    })
  } catch (err) {
    throw new Error(`[Mesa renderComponent] Compile error in ${canonical}:\n${err.message}`)
  }

  // A compile that COLLECTED errors is a compile that failed. `compileSource`
  // only throws for the failures the parser cannot walk past; everything else
  // — `bind:this` on a non-`let`, `{@const}` with no assignment, an unknown
  // `<mesa:*>`, `export default` in an instance script — lands in
  // `analysis.errors`, which the Vite plugin reads and this path never did, so
  // a prerender emitted the broken component's markup and said nothing.
  //
  // Collected across the whole tree rather than thrown here: a prerender that
  // dies on file 300 of 400 naming one file makes the author run it 400 times.
  // `renderComponent` throws once, at the entry, naming every file.
  if (ctx.analysis?.errors?.length && opts.problems) {
    opts.problems.push({ file: canonical, errors: [...ctx.analysis.errors] })
  }

  let js  = ctx.result
  // De-scope CSS — but only for the targets that INLINE it.
  //
  // email and fragment push every declaration into a `style=""` attribute, so
  // the selectors are consumed by the inliner and never shipped; flattening
  // them to plain selectors keeps that simple.
  //
  // The html target is the opposite: the CSS is shipped as a `<style>` block
  // and the scope class is what keeps one component's rules off another's
  // markup. De-scoping it there made every component's styles GLOBAL to the
  // page — measured on a prerendered Sierra route, where one island's
  // `button { background }` restyled every other button on the page. It went
  // unnoticed because it cancelled out a second bug: scoped selectors were
  // emitted in an ancestor form that could not match the element carrying the
  // class, so de-scoping was the only reason component styles applied at all.
  // Both are fixed; this must not be re-generalized to every target.
  const cssRaw = ctx.css?.result ?? ''
  const cssId  = ctx.css?.id
  let css = cssRaw
  if (cssId && cssRaw && opts.descope) {
    css = cssRaw.replace(new RegExp(`\\.${cssId}\\b`, 'g'), '')
  }
  // Per-component styles, keyed by the scope hash. The concatenated `css` above
  // is what a caller drops into one <style> blob; this is the same content split
  // so a consumer can emit `<style id="mHASH">` per component. That id is what
  // lets the runtime's `addStyles` find a style already present in the document
  // and inject nothing — which is only possible because the hash is
  // content-addressed and therefore identical across compilations.
  //
  // Deduped by that id on the way up the tree, and `css` below is derived from
  // the deduped list rather than concatenated separately. The id is a hash of
  // the style content and nothing else, so two components with byte-identical
  // CSS share one — which is what makes the dedupe sound, and is the whole
  // reason the hash is content-addressed. Concatenating blindly shipped a
  // design system's one style block once per component that used it.
  const styles = cssRaw ? [{ id: cssId, css }] : []
  const seen   = new Set(cssId && cssRaw ? [cssId] : [])

  const modules = new Map([[canonical, js]])

  // `ctx.islands` is per-module and the caller only ever sees the tree, so tag
  // each entry with the file it came from. Without that, two components both
  // declaring `<Counter client:load />` are indistinguishable in the flattened
  // list, and a loader cannot resolve `Counter` to a module to import.
  const islands = (ctx.islands ?? []).map((i) => ({ ...i, file: canonical }))

  // Reserve the tmpPath before recursing so cycle guard works.
  // opts.tmpDir is threaded rather than read from a module const so that the
  // recursive path lands in the same directory as the entry — an import graph
  // split across two directories resolves bare specifiers inconsistently.
  const tmpPath = makeTmpPath(canonical, opts.tmpDir)
  visited.set(canonical, { tmpPath })

  // Find + rewrite .mesa/.md imports
  const rewrites = []
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(js)) !== null) {
    // An aliased specifier becomes an absolute path BEFORE anything else looks
    // at it, so both branches below — a Mesa dependency and a plain sibling
    // module — see a path rather than a bare name they would resolve as a
    // package. Applied here rather than in each branch because the two must not
    // be able to disagree about where `@/x` points.
    const spec = applyAlias(m[2], opts.alias) ?? m[2]

    if (RUNTIME_SPECIFIERS.has(spec)) {
      const abs = runtimePath()
      if (abs) rewrites.push({ match: m[0], prefix: m[1], tmpPath: abs, suffix: m[3] })
      continue
    }

    // A RELATIVE import of something that is not a Mesa file — a sibling store,
    // a formatter, a table of constants — is rewritten to an absolute path.
    //
    // The compiled module is written to a temp directory, so every relative
    // specifier in it is now relative to somewhere else: `'../../money.js'`
    // resolves against `node_modules/.sierra/render/` and is not there. A bare
    // specifier survives (Node walks up to a node_modules) and so does an
    // absolute one, which is why this only ever bit a component importing its
    // own neighbor — an ordinary thing for an island to do, and it failed the
    // render rather than the build.
    if (!isMesaSpecifier(spec)) {
      // `path.isAbsolute` also catches an aliased specifier, which is already a
      // path by now — and rewriting one that was written absolute costs nothing,
      // since it resolves to itself.
      if (spec.startsWith('.') || path.isAbsolute(spec)) {
        rewrites.push({
          match:  m[0],
          prefix: m[1],
          // An absolute PATH and not a file:// URL. Node takes either; Vite's
          // import-analysis refuses the URL form, and one of the two callers
          // here is a Vite SSR runner — the same rewrite the Mesa branch below
          // does with `child.tmpPath`.
          tmpPath: path.resolve(path.dirname(canonical), spec),
          suffix: m[3],
        })
      }
      continue
    }
    const depPath = resolveMesaImport(spec, canonical)
    const child = await compileTree(depPath, visited, tempFiles, opts)
    for (const [k, v] of child.modules) modules.set(k, v)
    islands.push(...child.islands)
    for (const s of child.styles) {
      // A style with no id cannot be compared, so it is always kept.
      if (s.id && seen.has(s.id)) continue
      if (s.id) seen.add(s.id)
      styles.push(s)
    }
    rewrites.push({ match: m[0], prefix: m[1], tmpPath: child.tmpPath, suffix: m[3] })
  }

  // A function replacement, because `$$` in a replacement STRING means one `$`
  // and the runtime is imported as `$$runtime` — the namespace would come out
  // `$runtime` and every call in the module would be a ReferenceError.
  for (const { match, prefix, tmpPath: childTmp, suffix } of rewrites) {
    js = js.replace(match, () => prefix + childTmp + suffix)
  }

  // Write temp file.
  //
  // The render targets import these paths, so the files have to exist. The `js`
  // target only wants the in-memory `modules` map — it never imports anything —
  // so it opts out rather than writing a file per module and deleting it again.
  // `modules` is captured above before import rewriting, so what it holds is the
  // original source either way.
  if (!opts.noEmit) {
    installExitSweep()
    await writeFile(tmpPath, js)
    tempFiles.push(tmpPath)
    _liveTemp.add(tmpPath)
  }

  return { tmpPath, css: styles.map((s) => s.css).join('\n'), tempFiles, modules, islands, styles }
}

// ── HTML rendering ────────────────────────────────────────────────────────────

/**
 * Point a render failure's stack back at the `.mesa` files it came from.
 *
 * Every module in the tree executes from a temp `.mjs` in a scratch directory,
 * so the one frame that names the failing component names a path nobody wrote
 * and nobody can open. The frame itself carries the component function's name,
 * which is why rewriting the path is enough to identify it — and the innermost
 * rewritten frame is named in the message, because a prerender of hundreds of
 * pages reports one line and the reader may never see the stack.
 */
function attributeToSource(err, sources) {
  if (!sources?.size || typeof err?.stack !== 'string') return err
  let culprit = null
  err.stack = err.stack.replace(/(?:file:\/\/)?(\/\S*?\.mjs)/g, (m, p) => {
    const src = sources.get(p)
    if (!src) return m
    culprit ??= src
    return src
  })
  if (culprit) {
    const line = `[Mesa renderComponent] ${path.basename(culprit)} threw during render — ${culprit}`
    err.stack   = line + '\n' + err.stack
    err.message = line + '\n' + err.message
  }
  return err
}

/**
 * Execute a compiled component in the Mesa runtime and return its HTML.
 * Also extracts named module exports (e.g. `export const subject`).
 */
async function executeComponent(tmpPath, props, { label, sources } = {}) {
  const mod = await import(tmpPath)
  const fn  = mod.default

  if (typeof fn !== 'function') {
    throw new Error('[Mesa renderComponent] Compiled module has no default function export.')
  }

  // One renderer, two entry points. This used to be a second copy of the same
  // container/anchor/serialize/strip sequence, which is how render.js drifted
  // onto a calling convention the compiler had stopped emitting without anyone
  // noticing — nothing exercised it. Delegating also picks up root disposal,
  // which this copy never had: rendering N pages left N live effect sets
  // subscribed to any module-scope signal they read.
  let html
  try {
    html = await renderToHTML(fn, props, { label })
  } catch (err) {
    throw attributeToSource(err, sources)
  }

  // Named exports: <script module> exports are real ES module-level exports.
  // export const/let inside the component function are props, not module exports.
  const namedExports = {}
  for (const key of Object.keys(mod)) {
    if (key !== 'default') namedExports[key] = mod[key]
  }

  return { html, namedExports }
}

// ── Email document wrapper ────────────────────────────────────────────────────
/**
 * Wraps rendered body content in a full <!DOCTYPE html> email document.
 * Includes MSO/Outlook conditional comments and preserved @media styles.
 */
function wrapEmailDoc(bodyHTML, { subject = '', preservedCSS = '', bgcolor = '#f4f4f4' } = {}) {
  const styleBlock = preservedCSS.trim()
    ? `\n  <style>\n${preservedCSS}\n  </style>`
    : ''
  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
  <!--[if mso]>
  <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml>
  <![endif]-->${styleBlock}
  <title>${subject ? escapeHTML(subject) : ''}</title>
</head>
<body style="margin:0;padding:0;word-spacing:normal;background-color:${escapeHTML(bgcolor)};">
  <div role="article" aria-roledescription="email" lang="en" style="text-size-adjust:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
${bodyHTML}
  </div>
</body>
</html>`
}

/**
 * Walk an HTML string and produce a plain-text equivalent.
 * Preserves semantic whitespace — headings get blank lines,
 * paragraphs get double newlines, links show their URL.
 */
function htmlToText(html) {
  if (!html) return ''

  return html
    /*
     * ── Drop what is not readable content, BEFORE tags are stripped ──────
     *
     * Stripping tags first turns each of these into visible garbage in the
     * plain-text part of a multipart email, which is the half nobody looks
     * at until a client renders it. All four were live in the kit's own
     * WelcomeEmail:
     *
     *   <style>/<script>/<head>  — rule text read as prose.
     *   <!--[if mso]>…<![endif]--> — the Outlook fallback of a bulletproof
     *     button sits beside the real anchor, so every CTA appeared twice.
     *   display:none elements    — the preheader, whose whole job is to be
     *     invisible. Its &#847; padding is meaningless outside an inbox
     *     preview pane, and its sentence already repeats the opening line.
     */
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')

    /*
     * Conditional comments come in two shapes and they must be treated
     * OPPOSITELY. A bulletproof button is built from both:
     *
     *   <!--[if mso]>      …VML…        <![endif]-->     downlevel-HIDDEN
     *   <!--[if !mso]><!--> …<a>…   <!--<![endif]-->     downlevel-REVEALED
     *
     * The hidden branch is the Outlook fallback and must go, or every CTA
     * appears twice in the text part. The revealed branch is the real anchor
     * — only its markers go, never its content. Dropping anything that looks
     * like `<!--[if … <![endif]-->` deletes the anchor and the text loses
     * every link it had.
     *
     * Markers first, so what is left is unambiguously a hidden block.
     */
    .replace(/<!--\[if[^\]]*\]><!-->/gi, '')
    .replace(/<!--<!\[endif\]-->/gi, '')
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<(\w+)\b[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

    // Block elements → newlines before text
    .replace(/<(h[1-6])[^>]*>/gi, '\n\n')
    .replace(/<\/(h[1-6])>/gi,    '\n\n')
    /*
     * A CLOSING tag emits a newline as well as the opening one. The opening
     * alone is enough only while every block is followed by another block;
     * content after a `</p>` that opens no block of its own joins the
     * paragraph. Doubling is collapsed by the `\n{3,}` rule below.
     *
     * Table parts are the same question one step out: an email kit builds
     * everything from tables, so a document whose only structure is
     * `<tr><td>` had no boundaries at all and adjacent cells ran their words
     * together — a `<p>` of body text followed by a button came out as
     * `Body wordsGo (…)`.
     */
    .replace(/<(p|div|section|article|header|footer|li)[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li)>/gi,    '\n')
    // Closing tag only. Source indentation already puts a newline before the
    // opening one, so matching both buys nothing a cell can see.
    .replace(/<\/(table|tbody|thead|tfoot|tr|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n' + '─'.repeat(40) + '\n')
    // Links: preserve URL
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const t = stripTags(text).trim()
      return href && href !== t ? `${t} (${href})` : t
    })
    // Images: alt text
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => alt ? `[${alt}]` : '')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode entities. The named list is short on purpose, but numeric refs
    // have to be general: a fixed list left `&#847;` (the zero-width spacer
    // email preheaders are padded with) sitting in the text as literal
    // "&#847;". Anything a template author writes as &#NNN; or &#xHH; is
    // meant to be a character, not that text.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g,         (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    // &amp; last, so "&amp;lt;" decodes to "&lt;" and not to "<".
    .replace(/&amp;/g,  '&')
    // Normalize whitespace
    .replace(/\t/g,      ' ')
    .replace(/ {2,}/g,   ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g,  '\n\n')
    .trim()
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '')
}

/**
 * Decode one numeric character reference, leaving anything out of range
 * alone rather than throwing. Zero-width characters become a space so they
 * do not silently glue words together.
 */
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  // Surrogate halves are not valid on their own.
  if (code >= 0xd800 && code <= 0xdfff) return ''

  /*
   * Zero-width and formatting characters carry no meaning in plain text.
   * U+034F is the one that matters here: it is `&#847;`, the combining
   * grapheme joiner every email preheader is padded with.
   *
   * Written with \u escapes rather than the literal characters, because
   * U+2028 and U+2029 are line separators — pasting them into a regex
   * literal terminates the literal and the module stops parsing.
   */
  if (/[\u00ad\u034f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/.test(
        String.fromCodePoint(code))) return ''

  return String.fromCodePoint(code)
}


// ── UnoCSS integration ────────────────────────────────────────────────────────
/**
 * If a UnoCSS config is provided, scan the rendered HTML for class names
 * and generate CSS. Returns an empty string if @unocss/core is not installed.
 */
async function generateUnoCSS(html, unoConfig) {
  if (!unoConfig) return ''
  try {
    // Use indirect import to prevent Vite/vitest's static import analysis from
    // resolving @unocss/core at build time — it's an optional peer dependency.
    const pkg = '@unocss/core'
    const { createGenerator } = await import(/* @vite-ignore */ pkg)
    const uno = createGenerator(unoConfig)
    const { css } = await uno.generate(html)
    return css
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('Cannot find')) {
      console.warn('[Mesa renderComponent] @unocss/core not installed — UnoCSS skipped.')
      return ''
    }
    throw err
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render a Mesa component to HTML, email, fragment, or compiled JS.
 *
 * @param {string} source        — Mesa source string
 * @param {object} options
 * @param {object}  [options.data={}]       — Props to pass to the component
 * @param {string}  [options.cwd]           — Working directory for resolving imports
 * @param {string}  [options.filename]      — Source filename (used in error messages + import resolution)
 * @param {'html'|'email'|'fragment'|'js'} [options.target='html']
 * @param {object}  [options.unocss]        — UnoCSS config object (@unocss/core createGenerator options)
 * @param {object}  [options.compileOptions] — Extra options forwarded to compileSource()
 * @param {boolean} [options.islands=false]  — Wrap `client:*` components in island
 *                                             markers so a client loader can find them
 *                                             in the output. Off by default: RULE 26
 *                                             strips `client:*` unless a meta-framework
 *                                             asks for markers. See runtime.js `island()`.
 * @param {string}  [options.tmpDir]        — Directory for the temp modules the
 *                                             renderer compiles to. Defaults to
 *                                             Mesa's own package root, which is
 *                                             where Node resolves each compiled
 *                                             module's bare imports FROM — so a
 *                                             rendered tree containing
 *                                             `import … from '@frontierjs/sierra/router'`
 *                                             needs this pointed at a directory
 *                                             the app is resolvable from.
 *                                             Created if missing.
 * @param {object}  [options.alias]         — Bundler-style import aliases,
 *                                             `{ '@': '/abs/app/web/src' }`. A
 *                                             compiled module is imported under
 *                                             NODE, which resolves `@/api.js` as
 *                                             a package and fails; a caller that
 *                                             is itself a bundler (Sierra's
 *                                             prerender) passes the table it is
 *                                             already using so both resolvers
 *                                             agree. Longest prefix wins.
 * @param {boolean} [options.styleTag=true]   — html target only: prepend the
 *                                             collected CSS as one <style> block.
 *                                             Set false when assembling the
 *                                             document yourself from `.styles`.
 * @param {boolean} [options.preserveMediaQueries=true] — Keep @media in a <style> block (email/fragment)
 *
 * @returns {Promise<RenderResult>}
 *
 * RenderResult shape:
 *   target html/email/fragment:
 *     .html     {string}  — rendered HTML
 *     .css      {string}  — collected CSS (pre-inlining for email; scoped for html/fragment)
 *     .subject  {string|undefined} — from `export const subject` in the component
 *     .text     {string|undefined} — plain text fallback (email target only)
 *     .exports  {object}  — all named exports from the component
 *     .styles   {Array}   — `{ id, css }` per component in the tree, in order.
 *                           The same content as `.css`, split so a caller can
 *                           emit `<style id="mHASH">` per component; that id is
 *                           the scope hash, so the runtime's `addStyles` treats
 *                           an already-present block as done and injects nothing.
 *     .islands  {Array}   — every `client:*` call site in the rendered tree, in
 *                           compile order, each `{ component, directive, media?,
 *                           props?, file }`. This is `ctx.islands` per module,
 *                           flattened — the build-time view of what the markers
 *                           in `.html` refer to, which is what a loader needs to
 *                           map a component name onto a module to import.
 *
 *   target js:
 *     .modules  {Map<string,string>} — Map<originalPath, compiledJS>
 *     .entry    {string}             — key of the root module in .modules
 *     .css      {string}             — collected CSS
 */
export async function renderComponent(source, options = {}) {
  const {
    data                 = {},
    cwd                  = process.cwd(),
    filename             = 'Component.mesa',
    target               = 'html',
    unocss               = null,
    compileOptions       = {},
    islands              = false,
    tmpDir               = null,
    alias                = null,
    styleTag             = true,
    preserveMediaQueries = true,
  } = options

  // `islands` is sugar over compileOptions — the compiler flag is what actually
  // switches emission, and it has to reach every module in the tree, not just
  // the entry, because an island call site can be anywhere in it. An explicit
  // compileOptions.islands still wins, so a caller can force it either way.
  const _compileOptions = { islands, ...compileOptions }

  // Resolve once per call and create it if the caller named a directory that
  // does not exist yet — a build pointing at `outDir/.mesa-tmp` should not have
  // to mkdir it first, and the failure otherwise surfaces as a write error deep
  // in compileTree rather than as "your tmpDir is wrong".
  // Only the inlining targets flatten scoped selectors — see compileTree.
  const _descope = target === 'email' || target === 'fragment'
  const _tmpDir = tmpDir ?? await defaultTmpDir()
  if (tmpDir) await mkdir(tmpDir, { recursive: true }).catch(() => {})
  sweepStaleTemp(_tmpDir)

  // ── JS target — compile only, no rendering ────────────────────────────────
  if (target === 'js') {
    const filePath = path.isAbsolute(filename) ? filename : path.join(cwd, filename)

    const srcPath = filePath.endsWith('.mesa') || filePath.endsWith('.md')
      ? filePath
      : filePath + '.mesa'

    let modules, css, treeIslands
    const problems = []
    // Pass source directly — no temp .mesa file needed at entry point.
    // tempFiles is tracked and cleaned even though noEmit should leave it empty:
    // this call used to pass a throwaway [] and drop it, so every js-target
    // compile stranded one .mjs per module in the package directory.
    const tempFiles = []
    try {
      const result = await compileTree(
        srcPath, new Map(), tempFiles, { compileOptions: _compileOptions, tmpDir: _tmpDir, descope: _descope, alias, noEmit: true, problems }, source
      )
      modules     = result.modules
      css         = result.css
      treeIslands = result.islands
    } finally {
      await cleanTempFiles(tempFiles)
    }
    refuseCompileErrors(problems)

    const cleanModules = new Map()
    const entryKey     = path.basename(srcPath)
    for (const [k, v] of modules) {
      const key = k === srcPath ? entryKey : path.basename(k)
      cleanModules.set(key, v)
    }

    return { modules: cleanModules, entry: entryKey, css: css.trim(), islands: treeIslands ?? [] }
  }

  // ── Render targets — html / email / fragment ──────────────────────────────
  await ensureRenderer()

  // Determine the root file path — used for resolving relative imports
  const rootPath = path.isAbsolute(filename)
    ? filename
    : path.join(cwd, filename)
  const rootDir  = path.dirname(rootPath)

  // Pass source directly to compileTree — no temp .mesa file at entry point.
  // compileTree will still create temp .mjs files for compiled output,
  // but only for the compiled JS, never a duplicate .mesa temp file.
  const tempFiles = []
  const problems  = []
  let html, namedExports, css, unocss_css, preWrapHTML, treeIslands, treeStyles

  try {
    // 1. Compile recursively — sourceOverride means rootPath doesn't need to exist on disk
    const visited = new Map()
    const tree = await compileTree(rootPath, visited, tempFiles, { compileOptions: _compileOptions, tmpDir: _tmpDir, descope: _descope, alias, problems }, source)
    refuseCompileErrors(problems)

    // Temp path back to the file it was compiled from, so a stack can name a
    // component rather than a scratch file.
    const sources = new Map()
    for (const [canonical, { tmpPath }] of visited) sources.set(tmpPath, canonical)
    css = tree.css.trim()
    treeIslands = tree.islands
    treeStyles  = tree.styles

    // 2. Execute the component
    const rendered = await executeComponent(tree.tmpPath, data, { label: path.basename(rootPath), sources })
    html         = rendered.html
    preWrapHTML  = rendered.html   // saved for plain-text generation after try block
    namedExports = rendered.namedExports

    // 3. UnoCSS — scan rendered HTML for class names
    unocss_css = await generateUnoCSS(html, unocss)
    const allCSS = [css, unocss_css].filter(Boolean).join('\n')

    // 4. Apply CSS strategy per target
    if (target === 'email') {
      const inlined = inlineCSS(html, allCSS, {
        preserveMediaQueries,
        removeStyleTags: true,
        inlineStyleTags: true,
      })
      // The inliner prepends a <style>@media...</style> block when preserveMediaQueries:true
      // Extract it so we can move it to <head>
      let preservedCSS = ''
      let bodyHTML = inlined
      const styleMatch = inlined.match(/^<style>([\s\S]*?)<\/style>\n?/)
      if (styleMatch) {
        preservedCSS = styleMatch[1]
        bodyHTML = inlined.slice(styleMatch[0].length)
      }
      html = wrapEmailDoc(bodyHTML, {
        // A `subject` export may be a FUNCTION of the render data — a receipt's
        // subject names the order, and `<script module>` runs before props
        // exist, so a template literal cannot say it. The caller applies it
        // (`result.subject` hands back whatever was exported); the document's
        // <title> is a string or nothing. Passing the function through here
        // threw `subject.replace is not a function` out of the renderer, which
        // is a confusing way to learn that a document title cannot be a
        // callback.
        subject:      typeof namedExports.subject === 'string' ? namedExports.subject : '',
        preservedCSS,
        bgcolor:      namedExports.bgcolor  ?? '#f4f4f4',
      })
    } else if (target === 'fragment') {
      html = inlineCSS(html, allCSS, {
        preserveMediaQueries,
        removeStyleTags:  true,
        inlineStyleTags:  true,
      })
    } else {
      // html target — keep CSS in a <style> block, don't inline
      // (caller can use wrapPage() from render.js to assemble a full document)
      //
      // `styleTag: false` opts out, for a caller that assembles the document
      // itself and wants the styles per component rather than as one blob —
      // see `result.styles`. Sierra's prerenderer does exactly that, so that
      // each block can carry its component's scope hash as an `id` and the
      // runtime's `addStyles` recognizes it as already present. Without the
      // opt-out the caller has no way to suppress this copy, and the page ends
      // up carrying the same rules twice.
      if (allCSS.trim() && styleTag !== false) {
        html = `<style>\n${allCSS}\n</style>\n` + html
      }
    }

  } finally {
    await cleanTempFiles(tempFiles)
  }

  const result = {
    html,
    css,
    exports: namedExports,
    subject: namedExports.subject,
    islands: treeIslands ?? [],
    styles:  treeStyles ?? [],
  }

  if (target === 'email') {
    result.text = htmlToText(preWrapHTML ?? html)
  }

  return result
}

/**
 * Convenience wrapper — render from a file path directly.
 *
 * @param {string} filePath  — absolute or project-relative path to a .mesa or .md file
 * @param {object} options   — same as renderComponent(), minus `source` and `filename`
 */
export async function renderFile(filePath, options = {}) {
  const abs    = path.isAbsolute(filePath) ? filePath : path.join(options.cwd ?? process.cwd(), filePath)
  const source = await readFile(abs, 'utf8')
  return renderComponent(source, { ...options, filename: abs, cwd: path.dirname(abs) })
}
