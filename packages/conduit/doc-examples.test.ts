// doc-examples.test.ts — every runnable example in README.md and docs/ is run, not read.
//
// Invariant 16: a runnable example is verified (FJS-D860, FJS-3671). The fence
// contract is toolbelt's `docfences`: a ```ts block runs as a module in its own
// `bun` process unless its info string says `fragment`; `throws` passes only
// when the block throws, `failing` pins it to a filed defect and passes while it
// fails.
//
// The prelude is what a block may assume without declaring it:
//   app      a `createTestApp()` with `conduit({ credentials: <empty> })` configured
//            unless the block calls `app.configure` itself. No target is declared,
//            so a send to a named provider answers `target_not_found` and nothing
//            leaves the process
//   <name>   any export of `@frontierjs/conduit` the block uses and does not
//            import or declare
// A sliver naming a free variable (`row`, `serverId`), a placeholder (`…`), or a
// connector's own export is a `fragment`: it runs nothing, and the count may
// only fall.
//
// DOC_EXAMPLES_REPORT=1 prints every failure as `file:line  reason` and skips
// the expect, which is how the backlog is triaged. DOC_EXAMPLES_ONLY=<substring
// of file:line> runs one block.

import { describe, test, beforeAll } from 'bun:test'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }        from 'node:os'
import { join }          from 'node:path'
import { fileURLToPath } from 'node:url'

import { docFences, isRunnable } from '@frontierjs/toolbelt/docfences'
import * as conduitExports       from './src/index.ts'

const PKG     = fileURLToPath(new URL('.', import.meta.url))
const REPORT  = !!process.env.DOC_EXAMPLES_REPORT
const ONLY    = process.env.DOC_EXAMPLES_ONLY
const TIMEOUT = 20_000
const EXPORTS = new Set(Object.keys(conduitExports))

type Block = ReturnType<typeof docFences>[number] & { file: string }

// ─── the module a block runs as ───────────────────────────────────────────────

/** `@frontierjs/<pkg>[/sub]` → the file this checkout serves it from; the block runs in a tmpdir. */
const rewriteSpecifiers = (src: string) =>
  src.replace(/(['"])(@frontierjs\/[\w-]+(?:\/[\w.-]+)?)\1/g, (all, q, spec) => {
    try { return `${q}${Bun.resolveSync(spec, PKG)}${q}` } catch { return all }
  })

/** Names the block declares or imports, so the prelude never shadows them. */
function declaredIn(body: string) {
  const declared = new Set<string>()
  for (const m of body.matchAll(/\b(?:const|let|var|function|class|interface|type)\s+([\w$]+)/g)) declared.add(m[1])
  for (const m of body.matchAll(/^\s*import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}/gm))
    for (const n of m[1].split(',')) declared.add(n.split(/\s+as\s+/).pop()!.trim())
  for (const m of body.matchAll(/^\s*import\s+([\w$]+)\s*(?:,|from)/gm)) declared.add(m[1])
  return declared
}

function moduleFor(block: Block) {
  const declared = declaredIn(block.body)
  const used = new Set<string>()
  for (const m of block.body.matchAll(/[\w$]+/g)) if (EXPORTS.has(m[0]) && !declared.has(m[0])) used.add(m[0])
  const head: string[] = []
  if (used.size) head.push(`import { ${[...used].join(', ')} } from '${join(PKG, 'src/index.ts')}'`)
  if (/\bapp\b/.test(block.body) && !declared.has('app')) {
    head.push(`import { createTestApp as __createTestApp } from '@frontierjs/junction/testing'`)
    head.push(`import { conduit as __conduit, createStaticResolver as __empty } from '${join(PKG, 'src/index.ts')}'`)
    head.push('const app = await __createTestApp()')
    if (!/\bapp\.configure\(/.test(block.body)) head.push('app.configure(__conduit({ credentials: __empty({}) }))')
  }
  const body = rewriteSpecifiers(block.body)
  if (!block.words.has('throws')) return [...head, body].join('\n')
  // An import is hoisted out of the try, since a declaration inside a block is a syntax error.
  const imports: string[] = []
  const rest = body.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"][^\n]*$|^import\s+['"][^'"]+['"][^\n]*$/gm, m => { imports.push(m); return '' })
  return [...head, ...imports, 'try {', rest, '} catch (e) { process.exit(0) }', "console.error('expected the example to throw'); process.exit(3)"].join('\n')
}

async function runBlock(block: Block) {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-doc-example-'))
  try {
    const file = join(dir, 'example.ts')
    writeFileSync(file, moduleFor(block))
    const proc = Bun.spawn(['bun', file], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
    const timer = setTimeout(() => proc.kill(), TIMEOUT)
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The line that says what went wrong, past bun's source-context lines. */
function reason(e: unknown) {
  const lines = String((e as Error)?.message ?? e).split('\n').map(l => l.trim()).filter(Boolean)
  return lines.find(l => /^(\w*Error|error)\b/.test(l)) ?? lines.find(l => !/^\d+ \||^\^|^at /.test(l)) ?? ''
}

// ─── the corpus ───────────────────────────────────────────────────────────────

const TS = new Set(['ts', 'typescript'])

// A `fragment` runs nothing and nothing says so, so the count may only fall: a new
// sliver is written complete, or an old one is completed to make room.
const FRAGMENT_CEILING = 21

const FILES = ['README.md', ...readdirSync(join(PKG, 'docs')).filter(f => f.endsWith('.md') && !f.includes('.snapshot.')).map(f => `docs/${f}`)]

const all: { id: string, block: Block }[] = []
let fragments = 0
for (const file of FILES)
  for (const f of docFences(readFileSync(join(PKG, file), 'utf8'))) {
    if (!TS.has(f.lang)) continue
    if (f.words.has('fragment')) { fragments++; continue }
    if (!isRunnable(f) || (ONLY && !`${file}:${f.line}`.includes(ONLY))) continue
    all.push({ id: `${file}:${f.line}`, block: { ...f, file } })
  }

// A process per block is the isolation; eight wide keeps the suite to seconds.
const results = new Map<string, Error | null>()
async function runAll() {
  let next = 0
  const worker = async () => {
    while (next < all.length) {
      const { id, block } = all[next++]
      let err: Error | null = null
      try { await runBlock(block) } catch (e) { err = e as Error }
      if (block.words.has('failing')) err = err ? null : new Error('the example passes now — remove `failing` from its fence')
      results.set(id, err)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
}

const failures: string[] = []

describe('every example in the docs runs', () => {
  beforeAll(runAll, TIMEOUT * 20)

  for (const { id, block } of all)
    test(`${id} (${block.lang})`, () => {
      const err = results.get(id)
      if (err && !REPORT) throw err
      if (err) failures.push(`${id.padEnd(22)} ${reason(err)}`)
    })

  test(`fragments ratchet down (${fragments} of ${FRAGMENT_CEILING})`, () => {
    if (fragments > FRAGMENT_CEILING) throw new Error(`${fragments} fragments, ceiling ${FRAGMENT_CEILING}: complete one, or lower the ceiling only`)
    if (fragments < FRAGMENT_CEILING) throw new Error(`${fragments} fragments: lower FRAGMENT_CEILING to ${fragments}`)
  })

  if (REPORT) test('report', () => {
    console.log(`\n${failures.length} of ${all.length} examples failing\n${failures.join('\n')}\n`)
  })
})
