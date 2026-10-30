// test/doc-examples.test.js — every runnable fence in README.md and AGENTS.md runs (FJS-D860, FJS-3670).
//
// Invariant 16: a runnable example is verified. The fence contract is toolbelt's
// `docfences`: a block runs as a module in its own `bun` process unless its info
// string says `fragment`; `throws` passes only when the block throws, `failing`
// pins it to a filed defect and passes while it fails.
//
// This is bun and `test` runs it after vitest: the prelude is a real Litestone
// client behind a real Junction app (doc-prelude.mjs), and Litestone imports
// `bun:sqlite`. Vitest is told to leave it alone in vitest.config.js.
//
// The prelude is what a block may assume without declaring it:
//   leads      `createResource('leads')`, over the page client and a live app
//   userLevel  4
// Anything else a sliver names and does not declare is a `fragment`: it runs
// nothing, and the count may only fall.
//
// DOC_EXAMPLES_REPORT=1 prints every failure as `file:line  reason` and skips
// the expect, which is how a backlog is triaged. DOC_EXAMPLES_ONLY=<substring
// of file:line> runs one block.

import { describe, test, expect, beforeAll } from 'bun:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join }          from 'node:path'
import { fileURLToPath } from 'node:url'
import { docFences, isRunnable } from '@frontierjs/toolbelt/docfences'

const PKG     = fileURLToPath(new URL('..', import.meta.url))
const PRELUDE = join(PKG, 'test/doc-prelude.mjs')
const REPORT  = !!process.env.DOC_EXAMPLES_REPORT
const ONLY    = process.env.DOC_EXAMPLES_ONLY
const TIMEOUT = 30_000
const FILES   = ['README.md', 'AGENTS.md']

// ─── the module a block runs as ───────────────────────────────────────────────

/** `@frontierjs/<pkg>[/sub]` → the file this checkout serves it from; the block runs in a directory of its own. */
const rewriteSpecifiers = src =>
  src.replace(/(['"])(@frontierjs\/[\w-]+(?:\/[\w.-]+)?)\1/g, (all, q, spec) => {
    try { return `${q}${Bun.resolveSync(spec, PKG)}${q}` } catch { return all }
  })

/** Names the block declares or imports, so the prelude never shadows them. */
function declaredIn(body) {
  const declared = new Set()
  for (const m of body.matchAll(/\b(?:const|let|var|function|class)\s+([\w$]+)/g)) declared.add(m[1])
  for (const m of body.matchAll(/^\s*import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}/gm))
    for (const n of m[1].split(',')) declared.add(n.split(/\s+as\s+/).pop().trim())
  return declared
}

const HOISTED = /^import\s[\s\S]*?from\s+['"][^'"]+['"][^\n]*$|^import\s+['"][^'"]+['"][^\n]*$|^export const [^\n]*$/gm

function moduleFor(block) {
  const declared = declaredIn(block.body)
  const uses = name => new RegExp(`(?<![\\w$.])${name}\\b`).test(block.body) && !declared.has(name)
  const wants = ['createResource', 'leads', 'userLevel'].filter(uses)
  const head = wants.length || /createResource|getClient/.test(block.body)
    ? [`import { boot as __boot } from '${PRELUDE}'`, 'const __doc = await __boot()', ...wants.map(n => `const ${n} = __doc.${n}`)]
    : []
  const tail = head.length ? ['await __doc.stop()', 'process.exit(0)'] : []
  const body = rewriteSpecifiers(block.body)
  if (!block.words.has('throws')) return [...head, body, ...tail].join('\n')
  // An import or a one-line export is hoisted out of the try, since a declaration inside a block is a syntax error.
  const imports = []
  const exports = []
  const rest = body.replace(HOISTED, m => { (m.startsWith('import') ? imports : exports).push(m); return '' })
  return [...imports, ...head, ...exports, 'try {', rest, '} catch (e) { ' + (head.length ? 'await __doc.stop(); ' : '') + 'process.exit(0) }',
    "console.error('expected the example to throw'); process.exit(3)"].join('\n')
}

async function runBlock(block) {
  const dir = mkdtempSync(join(PKG, '.doc-example-'))
  try {
    const file = join(dir, 'example.mjs')
    writeFileSync(file, moduleFor(block))
    const proc = Bun.spawn(['bun', file], { cwd: PKG, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), TIMEOUT - 5_000)
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The line that says what went wrong, past bun's source-context lines. */
function reason(e) {
  const lines = String(e?.message ?? e).split('\n').map(l => l.trim()).filter(Boolean)
  return lines.find(l => /^(\w*Error|error)\b/.test(l)) ?? lines.find(l => !/^\d+ \||^\^|^at /.test(l)) ?? ''
}

// ─── the corpus ───────────────────────────────────────────────────────────────

// A `fragment` runs nothing and nothing says so, so the count may only fall: a new
// sliver is written complete, or an old one is completed to make room.
const FRAGMENT_CEILING = 15

const all = []
let fragments = 0
for (const file of FILES)
  for (const f of docFences(readFileSync(join(PKG, file), 'utf8'))) {
    if (!['js', 'javascript', 'mjs'].includes(f.lang)) continue
    if (f.words.has('fragment')) { fragments++; continue }
    if (!isRunnable(f) || (ONLY && !`${file}:${f.line}`.includes(ONLY))) continue
    all.push({ id: `${file}:${f.line}`, block: { ...f, file } })
  }

// A process per block is the isolation; four wide keeps the suite to seconds.
const results = new Map()
async function runAll() {
  let next = 0
  const worker = async () => {
    while (next < all.length) {
      const { id, block } = all[next++]
      let err = null
      try { await runBlock(block) } catch (e) { err = e }
      if (block.words.has('failing')) err = err ? null : new Error('the example passes now — remove `failing` from its fence')
      results.set(id, err)
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
}

const failures = []

describe('every example in the docs runs', () => {
  beforeAll(runAll, TIMEOUT * 20)

  for (const { id, block } of all)
    test(`${id} (${block.lang})`, () => {
      const err = results.get(id)
      if (err && !REPORT) throw err
      if (err) failures.push(`${id.padEnd(22)} ${reason(err)}`)
    })

  test(`fragments ratchet down (${fragments} of ${FRAGMENT_CEILING})`, () => {
    if (ONLY) return
    expect(fragments).toBe(FRAGMENT_CEILING)
  })

  if (REPORT) test('report', () => {
    console.log(`\n${failures.length} of ${all.length} examples failing\n${failures.join('\n')}\n`)
  })
})
