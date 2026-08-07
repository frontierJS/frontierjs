/**
 * @frontierjs/email-kit/render
 *
 * Convenience wrappers around @frontierjs/mesa renderComponent / renderFile
 * pre-configured for email output.
 *
 * Usage:
 *   import { renderEmail, renderEmailFile } from '@frontierjs/email-kit/render'
 *
 *   // From a source string
 *   const result = await renderEmail(source, {
 *     data:     { firstName: 'Alice', planName: 'Pro' },
 *     cwd:      '/path/to/templates',
 *     filename: 'WelcomeEmail.mesa',
 *   })
 *
 *   // From a file path
 *   const result = await renderEmailFile('./templates/WelcomeEmail.mesa', {
 *     data: { firstName: 'Alice' }
 *   })
 *
 *   result.html     — complete <!DOCTYPE html> email document with inlined CSS
 *   result.text     — plain-text fallback (auto-derived from HTML)
 *   result.subject  — from `export const subject = ...` in <script module>.
 *                     May be a FUNCTION of the same data the body renders from,
 *                     for the common case of a subject that names the record:
 *                     `export const subject = (d) => \`Order \${d.reference}\``.
 *                     It comes back exactly as exported — apply it yourself. The
 *                     document's <title> uses it only when it is a string.
 *   result.css      — collected CSS before inlining (for debugging)
 *
 * Auto-import:
 *   Pass `autoImport: true` to resolve component imports relative to
 *   @frontierjs/email-kit/components automatically — no import statements needed
 *   in templates that only use kit components.
 */

import path               from 'path'
import { fileURLToPath }  from 'url'
import { readFile }       from 'fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COMPONENTS_DIR = path.join(__dirname, 'components')

// Lazy-load renderComponent from @frontierjs/mesa to keep this package
// usable without mesa being a direct dependency in package.json.
let _renderComponent = null
let _renderFile      = null

async function getMesaRender() {
  if (_renderComponent) return { renderComponent: _renderComponent, renderFile: _renderFile }

  const candidates = [
    // Sibling in the monorepo layout (dev) — try first, so an edit to
    // packages/mesa is picked up rather than a stale install. `bun install`
    // resolves workspace:* to a COPY, so this is a real defence and not a
    // micro-optimisation.
    //
    // The path is `mesa/src/…`: mesa keeps its sources under src/ and maps them
    // through `exports`. These candidates used to name `mesa/render-component.js`
    // — the pre-src layout — so BOTH sibling probes missed, and under Vite the
    // miss was fatal rather than a fall-through (see the notFound test below).
    // Every one of this package's 34 tests failed on it.
    new URL('../mesa/src/render-component.js', import.meta.url).pathname,
    new URL('../../mesa/src/render-component.js', import.meta.url).pathname,
    // The installed peer dep. This is the only candidate that works when the
    // package is consumed from npm, where there is no sibling `../mesa/` — its
    // absence meant an installed consumer always hit the error below, however
    // correctly they had installed @frontierjs/mesa.
    '@frontierjs/mesa/render-component.js',
  ]

  // Collected rather than swallowed. `catch { continue }` reported "install
  // the peer dependency" for *any* failure — including a syntax error inside
  // render-component.js, which is a very confusing way to learn that a module
  // you just edited does not parse.
  const failures = []

  for (const c of candidates) {
    try {
      const mod = await import(c)
      if (mod.renderComponent) {
        _renderComponent = mod.renderComponent
        _renderFile      = mod.renderFile
        return { renderComponent: _renderComponent, renderFile: _renderFile }
      }
      failures.push(`${c}: loaded but exports no renderComponent`)
    } catch (err) {
      // Node says ERR_MODULE_NOT_FOUND / "Cannot find module". A bundler says
      // it differently — Vite and vitest report a missing file as
      // `Failed to load url … Does the file exist?` with no code — and reading
      // only Node's phrasing turned a missing candidate into a rethrow, so the
      // loop never reached the candidate that works.
      const notFound = err?.code === 'ERR_MODULE_NOT_FOUND' ||
                       /Cannot find (module|package)/.test(err?.message ?? '') ||
                       /Failed to load url/.test(err?.message ?? '')
      // A module that exists but throws is a real error, not a missing dep.
      if (!notFound) throw err
      failures.push(`${c}: not found`)
    }
  }

  throw new Error(
    '[@frontierjs/email-kit] @frontierjs/mesa is required as a peer dependency. ' +
    'Install it: npm install @frontierjs/mesa\n  Tried:\n    ' +
    failures.join('\n    ')
  )
}

/**
 * Inject @frontierjs/email-kit/components as the default cwd so templates
 * can import kit components with relative paths without specifying an absolute path.
 *
 * If the caller provides a cwd, we use that — it's likely where their
 * custom templates live. The kit components resolve correctly because
 * the .mesa files themselves use relative imports (e.g. import Card from './Card.mesa').
 */
function resolveOptions(options) {
  return {
    target:              'email',
    preserveMediaQueries: true,
    ...options,
    cwd: options.cwd ?? COMPONENTS_DIR,
  }
}

/*
 * ── MSO placeholder expansion ────────────────────────────────────────────
 *
 * Outlook conditional comments cannot survive a DOM round-trip: happy-dom,
 * which the static renderer runs in, ends the comment early for several
 * shapes of tag inside it (a namespaced attribute like `xmlns:v` is enough),
 * after which `<!--[if mso]>` serialises as `<!--[if mso]-->` and the VML
 * that follows becomes live markup on every client.
 *
 * So components emit the block escaped in a `data-mso` attribute — text, as
 * far as the DOM is concerned — and it is spliced back in here, once the
 * HTML is a string again and nothing will re-parse it.
 */
const MSO_PLACEHOLDER = /<span\s+data-mso(?:-close)?="([^"]*)"\s*><\/span>/gi

/**
 * Decode the payload. It is percent-encoded rather than HTML-escaped because
 * happy-dom does not escape `"` when serialising an attribute value, so raw
 * markup in there would close the attribute and spill across the tag.
 */
function decodePayload(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    // A malformed payload should not take the whole email down with it.
    return ''
  }
}

/**
 * Replace `<span data-mso="…">` placeholders with the conditional-comment
 * markup they carry. Exported because anyone rendering kit components through
 * `renderComponent` directly needs it — without it the Outlook fallback is
 * silently dropped.
 *
 * @param {string} html
 * @returns {string}
 */
export function expandMsoPlaceholders(html) {
  if (!html || !html.includes('data-mso')) return html
  return html.replace(MSO_PLACEHOLDER, (_, encoded) => decodePayload(encoded))
}

/** Apply the expansion to a render result, leaving the other fields alone. */
function expand(result) {
  if (!result || typeof result.html !== 'string') return result
  return { ...result, html: expandMsoPlaceholders(result.html) }
}

/**
 * Render a Mesa email template from a source string.
 *
 * @param {string} source     — Mesa source (.mesa format)
 * @param {object} options
 * @param {object}  [options.data={}]     — Props to pass to the component
 * @param {string}  [options.cwd]         — Working directory for import resolution
 *                                          Defaults to email-kit/components so kit
 *                                          component imports resolve automatically.
 * @param {string}  [options.filename]    — Source filename for error messages
 * @param {boolean} [options.preserveMediaQueries=true]
 * @param {object}  [options.compileOptions] — Extra options forwarded to compiler
 *
 * @returns {Promise<{ html, text, subject, css, exports }>}
 */
export async function renderEmail(source, options = {}) {
  const { renderComponent } = await getMesaRender()
  return expand(await renderComponent(source, resolveOptions(options)))
}

/**
 * Render a Mesa email template from a file path.
 *
 * @param {string} filePath  — Path to a .mesa or .md file
 * @param {object} options   — Same as renderEmail(), minus source and filename
 *
 * @returns {Promise<{ html, text, subject, css, exports }>}
 */
export async function renderEmailFile(filePath, options = {}) {
  const { renderFile } = await getMesaRender()
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(options.cwd ?? process.cwd(), filePath)
  return expand(await renderFile(abs, resolveOptions({ ...options, cwd: path.dirname(abs) })))
}

/**
 * Resolve a component name to its absolute path in the kit.
 * Useful for building dynamic import paths.
 *
 * @param {string} name  — Component name without extension, e.g. 'Button'
 * @returns {string}     — Absolute path to the .mesa file
 */
export function resolveComponent(name) {
  const n = name.endsWith('.mesa') ? name : name + '.mesa'
  return path.join(COMPONENTS_DIR, n)
}

export { COMPONENTS_DIR }
