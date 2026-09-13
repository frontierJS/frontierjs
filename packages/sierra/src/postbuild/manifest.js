/**
 * manifest.js — can a browser INSTALL this build?
 *
 * A web app manifest is how a built SPA becomes an app somebody keeps in a dock
 * or on a home screen (`FJS-D263` calls it the floor under a desktop surface).
 * The app writes the file; Sierra writes nothing. What this step owns is the
 * verdict, because a manifest a browser will not install with says so to
 * nobody: the page loads, the link is there, and the install button never
 * appears.
 *
 * The rules are Chrome's, measured rather than remembered: neither a 512px
 * icon nor a service worker is required, which are the two most often assumed.
 * Each problem carries Chrome's own error id, so
 * `tests/browser/installable.mjs` can hold this grader against
 * `Page.getInstallabilityErrors` case for case:
 *
 *   • a manifest, linked                                      no-manifest
 *   • that exists and parses                                  manifest-parsing-or-network-error
 *   • `name` or `short_name`                                  manifest-missing-name-or-short-name
 *   • a `start_url`, on this origin                           start-url-not-valid
 *   • `display` of standalone, fullscreen or minimal-ui       manifest-display-not-supported
 *   • one icon, purpose `any`, whose file is here and whose
 *     declared AND real size are both at least 144px          no-acceptable-icon
 *
 * Chrome fetches the icon, so a 32px file declaring `512x512` is refused, and
 * so is a 192px file declaring `48x48`. Only a PNG's real size is read here;
 * an SVG counts with `sizes: any`, and any other format is graded on what it
 * declares.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIN_ICON = 144
const DISPLAYS = new Set(['standalone', 'fullscreen', 'minimal-ui'])
const ORIGIN   = 'http://sierra.invalid'

/**
 * @param {string} outDir — the build output, holding index.html
 * @param {string} root   — the Vite root, whose public/ may hold an unlinked manifest
 * @returns {{ file: string, problems: { code: string, message: string }[] } | null}
 *   null when the build neither links a manifest nor carries one
 */
export function gradeManifest(outDir, root) {
  const indexPath = join(outDir, 'index.html')
  const html      = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : ''
  const href      = manifestHref(html)

  if (!href) {
    // Only the unambiguous name: a public/manifest.json is as often some other
    // tool's file.
    if (!existsSync(join(root, 'public', 'manifest.webmanifest'))) return null
    return problem('public/manifest.webmanifest', 'no-manifest',
      'it is copied into the build and index.html links no manifest, so a browser never reads it. ' +
      'Add <link rel="manifest" href="/manifest.webmanifest"> to index.html.')
  }

  const url = new URL(href, `${ORIGIN}/`)
  if (url.origin !== ORIGIN) return null   // served from elsewhere; nothing here to read

  const file = url.pathname.replace(/^\//, '')
  const path = join(outDir, file)
  if (!existsSync(path)) return problem(file, 'manifest-parsing-or-network-error',
    `index.html links ${href} and the build has no such file, so the browser's request answers ` +
    `with the SPA fallback or a 404.`)

  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return problem(file, 'manifest-parsing-or-network-error', `${file} is not JSON (${e.message}).`)
  }

  const problems = []
  const add = (code, message) => problems.push({ code, message })

  if (!manifest.name && !manifest.short_name) add('manifest-missing-name-or-short-name',
    'it names no `name` or `short_name`, which is what the install prompt and the dock show.')

  if (!manifest.start_url) add('start-url-not-valid',
    'it has no `start_url`. Chrome does not default one for installing; `"/"` is the usual answer.')
  else if (new URL(manifest.start_url, url).origin !== ORIGIN) add('start-url-not-valid',
    `its start_url ${manifest.start_url} is on another origin, which a browser refuses to install.`)

  if (!DISPLAYS.has(manifest.display)) add('manifest-display-not-supported',
    `its display is ${manifest.display === undefined ? 'unset' : `"${manifest.display}"`}; an installed ` +
    'app needs standalone, fullscreen or minimal-ui — omitted is a tab, not an app.')

  if (!(manifest.icons ?? []).some(icon => acceptable(icon, url, outDir))) add('no-acceptable-icon',
    `no icon qualifies. One needs purpose "any" (the default; maskable alone is not enough), a file ` +
    `in the build, and a size of at least ${MIN_ICON}px both in \`sizes\` and in the image itself — ` +
    'or an SVG with `sizes: "any"`.')

  return { file, problems }
}

function manifestHref(html) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]
    if (rel?.toLowerCase() !== 'manifest') continue
    return /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? null
  }
  return null
}

function acceptable(icon, manifestUrl, outDir) {
  if (!icon?.src) return false
  const purposes = String(icon.purpose ?? 'any').split(/\s+/)
  if (!purposes.includes('any')) return false

  const sizes  = String(icon.sizes ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const isSvg  = icon.type === 'image/svg+xml' || /\.svg$/i.test(icon.src)
  const url    = new URL(icon.src, manifestUrl)
  const local  = url.origin === ORIGIN
  const path   = local ? join(outDir, decodeURIComponent(url.pathname.replace(/^\//, ''))) : null

  if (local && !existsSync(path)) return false
  if (isSvg && sizes.includes('any')) return true

  const declared = sizes.some(s => {
    const [w, h] = s.split('x').map(Number)
    return w >= MIN_ICON && h >= MIN_ICON
  })
  if (!declared) return false
  if (!local) return true

  const real = pngSize(path)
  return real === null || (real.width >= MIN_ICON && real.height >= MIN_ICON)
}

/** A PNG's real dimensions from its header, or null for anything that is not one. */
function pngSize(path) {
  const head = readFileSync(path).subarray(0, 24)
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

function problem(file, code, message) {
  return { file, problems: [{ code, message }] }
}
