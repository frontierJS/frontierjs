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
import { readFile, writeFile, unlink } from 'fs/promises'
import { existsSync }  from 'fs'
import { fileURLToPath } from 'url'
import { compileSource } from './compiler.js'
import { initRenderer }  from './render.js'
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
    const candidate = path.dirname(fileURLToPath(import.meta.url))
    // Valid if it exists on disk and contains package.json
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
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
  // Last resort — use OS temp dir (loses @frontierjs/mesa resolution but won't throw)
  return import('os').then(os => os.tmpdir()).catch(() => '/tmp')
}

const _tmpDir    = await Promise.resolve(findMesaDir())
const _tmpPrefix = '__mesa_render_'

function makeTmpPath(filePath) {
  const base = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(
    typeof _tmpDir === 'string' ? _tmpDir : '/tmp',
    `${_tmpPrefix}${base}_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`
  )
}

async function cleanTempFiles(paths) {
  await Promise.all(paths.map(p => unlink(p).catch(() => {})))
}

// ── Import specifier regex ────────────────────────────────────────────────────
// Matches: import X from './foo.mesa'
//          import { a } from "./bar.md"
//          import * as X from './baz.mesa'
const IMPORT_RE = /^(import\s[\s\S]*?from\s+['"])([^'"]+)(['"])/gm

function isMesaSpecifier(spec) {
  return spec.endsWith('.mesa') || spec.endsWith('.md')
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
 */
async function compileTree(filePath, visited = new Map(), tempFiles = [], opts = {}, sourceOverride = null) {
  const canonical = path.resolve(filePath)

  // Cycle guard
  if (visited.has(canonical)) {
    return { tmpPath: visited.get(canonical).tmpPath, css: '', tempFiles, modules: new Map() }
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

  let js  = ctx.result
  // De-scope CSS: Mesa scopes selectors as `.scopeId .selector` (ancestor selector).
  // For server-rendered HTML (email/fragment) we inline all styles, so scoping is
  // unnecessary and the ancestor selector format would prevent the inliner from
  // matching. Strip `.scopeId ` prefixes to restore plain selectors.
  const cssRaw = ctx.css?.result ?? ''
  const cssId  = ctx.css?.id
  let css = cssRaw
  if (cssId && cssRaw) {
    // Replace `.scopeId selector` → `selector` throughout
    css = cssRaw.replace(new RegExp(`\\.${cssId}\\s+`, 'g'), '')
  }
  const modules = new Map([[canonical, js]])

  // Reserve the tmpPath before recursing so cycle guard works
  const tmpPath = makeTmpPath(canonical)
  visited.set(canonical, { tmpPath })

  // Find + rewrite .mesa/.md imports
  const rewrites = []
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(js)) !== null) {
    const spec = m[2]
    if (!isMesaSpecifier(spec)) continue
    const depPath = path.resolve(path.dirname(canonical), spec)
    const child = await compileTree(depPath, visited, tempFiles, opts)
    css += '\n' + child.css
    for (const [k, v] of child.modules) modules.set(k, v)
    rewrites.push({ match: m[0], prefix: m[1], tmpPath: child.tmpPath, suffix: m[3] })
  }

  for (const { match, prefix, tmpPath: childTmp, suffix } of rewrites) {
    js = js.replace(match, prefix + childTmp + suffix)
  }

  // Write temp file
  await writeFile(tmpPath, js)
  tempFiles.push(tmpPath)

  return { tmpPath, css, tempFiles, modules }
}

// ── HTML rendering ────────────────────────────────────────────────────────────
/**
 * Execute a compiled component in the Mesa runtime and return its HTML.
 * Also extracts named module exports (e.g. `export const subject`).
 */
async function executeComponent(tmpPath, props) {
  const mod = await import(tmpPath)
  const fn  = mod.default

  if (typeof fn !== 'function') {
    throw new Error('[Mesa renderComponent] Compiled module has no default function export.')
  }

  const doc       = global.document
  const container = doc.createElement('div')
  const anchor    = doc.createComment('mesa-root')
  container.appendChild(anchor)
  doc.body.appendChild(container)

  try {
    fn(anchor, props ?? {}, null)
  } catch (err) {
    throw new Error(`[Mesa renderComponent] Component threw during render: ${err.message}`)
  }

  // Collect rendered HTML — strip the root anchor comment and all internal
  // Mesa anchor comments (<!---->  and <!-- mesa:... --> left by block directives).
  const raw  = container.innerHTML
  const html = raw
    .replace(/<!--mesa-root-->/g, '')   // root anchor
    .replace(/<!---->/g, '')            // empty block anchors
    .replace(/<!-- [^>]* -->/g, '')     // named anchor comments
    .trim()

  // Named exports: <script module> exports are real ES module-level exports.
  // export const/let inside the component function are props, not module exports.
  const namedExports = {}
  for (const key of Object.keys(mod)) {
    if (key !== 'default') namedExports[key] = mod[key]
  }

  try { doc.body.removeChild(container) } catch {}

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
  <title>${subject ? subject.replace(/</g,'&lt;') : ''}</title>
</head>
<body style="margin:0;padding:0;word-spacing:normal;background-color:${bgcolor};">
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
    // Block elements → newlines before text
    .replace(/<(h[1-6])[^>]*>/gi, '\n\n')
    .replace(/<\/(h[1-6])>/gi,    '\n\n')
    .replace(/<(p|div|section|article|header|footer|li)[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li)>/gi,    '')
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
    // Decode common entities
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    // Normalise whitespace
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
    preserveMediaQueries = true,
  } = options

  // ── JS target — compile only, no rendering ────────────────────────────────
  if (target === 'js') {
    const filePath = path.isAbsolute(filename) ? filename : path.join(cwd, filename)

    const srcPath = filePath.endsWith('.mesa') || filePath.endsWith('.md')
      ? filePath
      : filePath + '.mesa'

    let modules, css
    // Pass source directly — no temp .mesa file needed at entry point
    const result = await compileTree(srcPath, new Map(), [], { compileOptions }, source)
    modules = result.modules
    css     = result.css

    const cleanModules = new Map()
    const entryKey     = path.basename(srcPath)
    for (const [k, v] of modules) {
      const key = k === srcPath ? entryKey : path.basename(k)
      cleanModules.set(key, v)
    }

    return { modules: cleanModules, entry: entryKey, css: css.trim() }
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
  let html, namedExports, css, unocss_css, preWrapHTML

  try {
    // 1. Compile recursively — sourceOverride means rootPath doesn't need to exist on disk
    const tree = await compileTree(rootPath, new Map(), tempFiles, { compileOptions }, source)
    css = tree.css.trim()

    // 2. Execute the component
    const rendered = await executeComponent(tree.tmpPath, data)
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
        subject:      namedExports.subject ?? '',
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
      if (allCSS.trim()) {
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
