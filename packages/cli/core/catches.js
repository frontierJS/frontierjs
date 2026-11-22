// ─── catches.js — a catch on the request or Data path names what it caught ───
//
// `FJS-D2131`: in junction, litestone and auth, a catch tests what it caught
// (`instanceof`, `.name`, a code) or says in a comment why it is best-effort.
// Anything else swallows every error, a defect included, so a TypeError can come
// back as `null` or as a 404 before `toFrameworkError()` ever sees it — and
// nothing fails, which is why this is counted rather than left to review.
//
// The count is per package and only goes down: `scripts/catch-baselines.json`,
// graded by CI's `structure` phase, the shape of `typecheck-baselines.json`.
// The `fli check` rule `catch-names-its-error` lists the sites.
//
// Only the request and Data path is read. A CLI's, a studio's or the browser
// client's swallow costs a log line at most, and grading them was the whole-repo
// version the ruling turned down on cost.

import { join, relative } from 'path'
import { readdirSync, readFileSync, statSync } from 'fs'

export const CATCH_RULE = 'catch-names-its-error'

/** The request and Data path of each package, and what under it is not. */
export const CATCH_PATHS = {
  'packages/junction':  { roots: ['src'], skip: ['src/client', 'src/testing'] },
  'packages/litestone': { roots: ['src'], skip: ['src/tools', 'src/browser', 'src/testing.js', 'src/testdb.js', 'src/fake.js'] },
  'packages/auth':      { roots: ['.'],   skip: ['test', 'db', 'docs', 'node_modules', 'seed-login.ts'] },
}

const SOURCE = /\.(m?js|ts)$/
const NOT_SOURCE = /\.d\.ts$|\.snapshot\./

function* sourceFiles(dir, skip, base) {
  let names
  try { names = readdirSync(dir).sort() } catch { return }    // an absent root reads as empty
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const path = join(dir, name)
    if (skip.has(relative(base, path).split('\\').join('/'))) continue
    if (statSync(path).isDirectory()) yield* sourceFiles(path, skip, base)
    else if (SOURCE.test(name) && !NOT_SOURCE.test(name)) yield path
  }
}

// From an opening bracket to its partner. Brackets inside a string are counted
// too, which a source file this rule reads has not yet needed.
function enclosed(src, open) {
  const [o, c] = src[open] === '(' ? ['(', ')'] : ['{', '}']
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++
    else if (src[i] === c && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

const COMMENT = /\/\/|\/\*/

/** Does `body` look at the error `name` holds, or throw it back? */
function namesIt(body, name) {
  if (!name) return false
  const n = name.replace(/\$/g, '\\$')
  return new RegExp(`\\b${n}\\s+instanceof\\b|\\b${n}\\??\\.(name|code|errno|status)\\b|\\bthrow\\s+${n}\\b`).test(body)
}

/**
 * The catches in `src` that neither name what they caught nor say why they are
 * best-effort: a `catch` clause and a promise `.catch(handler)`. A comment
 * counts on the catch's own line or the first line of its body.
 */
export function looseCatches(src) {
  const lines = src.split('\n')
  const lineOf = (at) => src.slice(0, at).split('\n').length
  const out = []

  const consider = (at, binding, body) => {
    const line = lineOf(at)
    const text = lines[line - 1]
    if (/^\s*(\/\/|\/\*|\*)/.test(text)) return                  // a catch written in a comment
    const first = body.split('\n').find(l => l.trim()) ?? ''
    if (COMMENT.test(text.slice(text.indexOf('catch'))) || COMMENT.test(first)) return
    if (namesIt(body, binding)) return
    out.push({ line, text: text.trim() })
  }

  const clause = /\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)?[^)]*\))?\s*\{/g
  for (let m; (m = clause.exec(src));) {
    if (src[m.index - 1] === '.') continue
    consider(m.index, m[1], enclosed(src, m.index + m[0].length - 1))
  }

  const promise = /\.catch\s*\(/g
  for (let m; (m = promise.exec(src));) {
    const handler = enclosed(src, m.index + m[0].length - 1)
    const binding = /^\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(handler)?.[1]
    consider(m.index, binding, handler)
  }

  return out.sort((a, b) => a.line - b.line)
}

/** Every loose catch on the request and Data path under `root`, by package. */
export function catchFindings(root) {
  const findings = []
  for (const [pkg, { roots, skip }] of Object.entries(CATCH_PATHS)) {
    const base  = join(root, pkg)
    const skips = new Set(skip)
    for (const r of roots) {
      for (const file of sourceFiles(join(base, r), skips, base)) {
        for (const c of looseCatches(readFileSync(file, 'utf8'))) {
          findings.push({ pkg, file, line: c.line, text: c.text })
        }
      }
    }
  }
  return findings
}

/** `{ 'packages/junction': n, … }`, every package named even at 0. */
export function catchCounts(findings) {
  const counts = Object.fromEntries(Object.keys(CATCH_PATHS).map(p => [p, 0]))
  for (const f of findings) counts[f.pkg] = (counts[f.pkg] ?? 0) + 1
  return counts
}
