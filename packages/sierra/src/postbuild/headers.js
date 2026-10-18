/**
 * headers.js — the site's cache rule, and the _headers file written from it
 *
 * `cacheFor` is the one answer to how long a site's file may be cached, with
 * two readers: serveSite sends it per request, and a host that serves the files
 * itself reads `_headers`. Without the file Cloudflare revalidates every hashed
 * asset, a round trip per chunk on every page load that no drive shows.
 *
 * Format (Cloudflare's):
 *   /path-or-splat
 *     ! Header        detach what an earlier rule set
 *     Header: value
 *
 * Cloudflare applies EVERY matching rule in file order and joins two values for
 * one header with a comma, so a narrower rule that only stated its own value
 * would send `max-age=0, …, max-age=31536000, immutable`. Each rule after the
 * first detaches before it states. `headerUnder` reads the file that way, and
 * `wrangler dev` answered the same on every case it was asked.
 */

import { readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

import { isHashedAsset } from './hashed-asset.js'

export const IMMUTABLE  = 'public, max-age=31536000, immutable'
export const REVALIDATE = 'public, max-age=0, must-revalidate'
export const NOINDEX    = 'noindex'

/** @param {string} path  root-relative, as a request names it @returns {string} */
export function cacheFor(path) {
  if (isHashedAsset(path)) return IMMUTABLE
  // Everything else, HTML included: the URL is permanent and the bytes behind
  // it change on every build, so the only safe answer is revalidate.
  return REVALIDATE
}

// Cloudflare refuses a `_headers` past this, and the deploy fails, not the build.
const MAX_RULES = 100

/**
 * Write `_headers` from `cacheFor`, then the app's own file verbatim.
 *
 * `/assets/*` is `isHashedAsset`'s directory as a splat; a file in it the rule
 * calls unhashed (one the app put there by hand) gets its own rule after it.
 * A preview build's `/*` also says `noindex`, as Pages does for every preview:
 * a review link is public, and a crawler that finds it indexes a second copy
 * of the site. A header rather than `robots.txt`, because a crawler that
 * obeys a Disallow never fetches the page that would tell it noindex.
 *
 * @param {string} outDir
 * @param {{ preview?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function generateHeaders(outDir, { preview = false } = {}) {
  const dest = join(outDir, '_headers')
  const own  = await readFile(dest, 'utf8').catch(() => null)

  const rules  = [['/*', REVALIDATE]]
  const assets = await filesUnder(join(outDir, 'assets'), 'assets')
  if (assets.some(isHashedAsset)) {
    rules.push(['/assets/*', IMMUTABLE])
    for (const f of assets) if (cacheFor(f) !== IMMUTABLE) rules.push(['/' + f, cacheFor(f)])
  }
  if (rules.length > MAX_RULES) {
    const loose = rules.slice(2).map(([p]) => p.slice(1))
    throw new Error(
      `[Sierra] _headers: ${loose.length} unhashed files under assets/ make ${rules.length} rules, ` +
      `past Cloudflare's ${MAX_RULES}. assets/ is where the build puts hashed files; move these out ` +
      `of the public directory's assets/: ${loose.slice(0, 5).join(', ')}${loose.length > 5 ? ', …' : ''}`
    )
  }

  const lines = [
    "# _headers — the cache rule written by Sierra, then the app's own",
    '',
    ...rules.flatMap(([path, value], i) => [
      path,
      ...(i === 0 ? [] : ['  ! Cache-Control']),
      `  Cache-Control: ${value}`,
      ...(i === 0 && preview ? [`  X-Robots-Tag: ${NOINDEX}`] : []),
      '',
    ]),
    ...(own === null ? [] : [own]),
  ]
  await writeFile(dest, lines.join('\n'), 'utf8')
  return `_headers (${rules.length} rule${rules.length === 1 ? '' : 's'} from the cache rule${preview ? ', noindex' : ''}${own === null ? '' : ", then the app's"})`
}

async function filesUnder(dir, rel) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    const r = `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...await filesUnder(join(dir, e.name), r))
    else if (e.isFile()) out.push(r)
  }
  return out
}

/**
 * What a `_headers` file sends as `name` for `path`, read as Cloudflare reads
 * it: every matching rule in order, `!` detaching, a repeat joined with `, `.
 * A splat is any run of characters and `:placeholder` one segment.
 *
 * @param {string} text
 * @param {string} path  the request path, `/assets/app-AbCd1234.js`
 * @param {string} name
 * @returns {string | null}
 */
export function headerUnder(text, path, name) {
  const want = name.toLowerCase()
  let value = null
  let applies = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (!/^\s/.test(raw)) { applies = matches(line, path); continue }
    if (!applies) continue
    if (line.startsWith('!')) {
      if (line.slice(1).trim().toLowerCase() === want) value = null
      continue
    }
    const at = line.indexOf(':')
    if (at < 0 || line.slice(0, at).trim().toLowerCase() !== want) continue
    const v = line.slice(at + 1).trim()
    value = value === null ? v : `${value}, ${v}`
  }
  return value
}

function matches(pattern, path) {
  const source = pattern
    .split('*').map(part => part
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:[A-Za-z]\w*/g, '[^/]+'))
    .join('.*')
  return new RegExp(`^${source}$`).test(path)
}
