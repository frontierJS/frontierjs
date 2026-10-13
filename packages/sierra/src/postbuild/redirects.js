/**
 * redirects.js — the _redirects file, written by the build and read by serveSite
 *
 * Format (Netlify's, which Cloudflare reads):
 *   /old-path/  /new-path/  301
 *
 * Two sources, one file: the route table's `redirects` — [[from, to], ...]
 * pairs from route frontmatter `redirect: /new-path/` — and the app's own
 * hand-written rules, which reach the output before this runs (Vite's public
 * directory, or what site-kit emits from content/settings/_redirects).
 *
 * Both directions live here because a redirect route emits no page, so this
 * file is its only answer, and a reader that parses it differently from the
 * writer is a redirect that works on the host and 404s in every drive (FJS-2717).
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

/**
 * Merge the route table's redirects into the app's own `_redirects`.
 *
 * The routes' rules go first: a host takes the first match, and an app's
 * `/* /index.html 200` fallback would otherwise swallow every one of them. The
 * app's lines follow verbatim, splats included, because only the host has to
 * answer them; serveSite refuses what it cannot answer when it starts.
 *
 * @param {Array<[string, string]>} redirects — [[from, to], ...]
 * @param {string} outDir
 * @returns {Promise<string|null>}
 */
export async function generateRedirects(redirects, outDir) {
  const dest = join(outDir, '_redirects')
  const own = await readFile(dest, 'utf8').catch(() => null)
  if (redirects.length === 0) return own === null ? null : "_redirects ← the app's"

  // One path sent two places is two declarations that disagree, and which one
  // a visitor gets would turn on line order.
  const declared = exactRules(own ?? '')
  const fresh = redirects.filter(([from, to]) => {
    const theirs = declared.get(redirectKey(from))
    if (theirs === undefined) return true
    if (theirs === to) return false
    throw new Error(
      `[Sierra] ${from} redirects to ${to} by its route's \`redirect:\` and to ${theirs} ` +
      "by the app's own _redirects — remove one of them."
    )
  })

  const lines = [
    '# _redirects — the routes\' rules written by Sierra, then the app\'s own',
    '# Cloudflare Pages / Netlify format: FROM  TO  STATUS',
    '',
    ...fresh.map(([from, to]) => `${from}  ${to}  301`),
    '',
    ...(own === null ? [] : [own]),
  ]

  await writeFile(dest, lines.join('\n'), 'utf8')
  const n = fresh.length
  return `_redirects (${n} rule${n === 1 ? '' : 's'} from routes${own === null ? '' : ", then the app's"})`
}

/** The exact-path rules of a hand-written file, first one per path, as a host reads it. */
function exactRules(text) {
  const rules = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const [from, to] = raw.trim().split(/\s+/)
    if (!from?.startsWith('/') || !to || from.includes('*') || from.includes('/:')) continue
    const key = redirectKey(from)
    if (!rules.has(key)) rules.set(key, to)
  }
  return rules
}

const STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * The key a path matches under: `/old` and `/old/` are one rule, the same way
 * serveSite answers both with one page.
 */
export function redirectKey(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * Parse a _redirects file into `redirectKey(from)` → `{ to, status }`.
 *
 * Only the exact-path shape is answered. A splat, a placeholder, a query match,
 * a forced rule or a 200 rewrite is a rule the host answers and serveSite would
 * not, so it throws naming the line rather than serving a 404 where the host
 * redirects — the silence FJS-2717 was. The first rule for a path wins, as it
 * does on the host.
 *
 * @param {string} text
 * @returns {Map<string, { to: string, status: number }>}
 */
export function parseRedirects(text) {
  const rules = new Map()
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return

    const refuse = (why) => {
      throw new Error(
        `[Sierra] _redirects line ${i + 1}: '${line}' — ${why}. serveSite answers ` +
        `'FROM TO [STATUS]' with an exact FROM path and a ${[...STATUSES].join('/')} status, ` +
        'and refuses the rest rather than answer 404 where the host redirects.'
      )
    }

    const parts = line.split(/\s+/)
    if (parts.length > 3) refuse('a query match or extra field')
    if (parts.length < 2) refuse('no TO')
    const [from, to, statusText = '302'] = parts

    if (!from.startsWith('/')) refuse('FROM is not a path on this origin')
    if (from.includes('*'))    refuse('a splat')
    if (from.split('/').some(seg => seg.startsWith(':'))) refuse('a placeholder')
    const status = Number(statusText)
    if (!STATUSES.has(status)) refuse(`status ${statusText} is not a redirect`)

    const key = redirectKey(from)
    if (!rules.has(key)) rules.set(key, { to, status })
  })
  return rules
}
