// test/doc-examples.test.ts — every example in the docs is run, not read.
//
// The 2026-10-09 docs audit found 165 claims the tree did not say back, 17 of
// them examples that fail as written, and the reason each had lived was that
// nothing ran them: `catalog.test.ts` grades the links and the `snapshots`
// phase grades the generated pages, and a hand-written fence had no grader at
// all. Invariant 16 says a runnable example is verified; this is where.
//
// The contract a fence enters into:
//
//   ```lite        is parsed AND built — `createClient` over `:memory:` —
//                  because a schema that parses and refuses to build is the
//                  class the audit kept finding
//   ```js / ```ts  runs as a module, under a `db` already built from the
//                  nearest ```lite block above it in the same file, in a tmpdir
//                  holding that schema as `./schema.lite`, so an example that
//                  opens `{ path: './schema.lite' }` opens the real thing
//   `fragment`     on the info string (```js fragment) is the one opt-out: the
//                  block is a sliver — three attributes, a handler body — and
//                  runs nothing. Marking it is the author saying so in the file,
//                  where the next reader sees it
//   `throws`       says the block is an example of a refusal: it passes only
//                  when it throws
//   `failing`      pins the block to a filed defect, `test.failing`'s way: it
//                  passes while it fails, and goes red the day the defect is
//                  fixed so the word gets removed
//
// A block is a process, because an example that starts a server, calls
// `process.exit` or leaks a timer must not take the suite down with it; one
// `bun` per block is ~40ms and they run eight wide.
//
// DOC_EXAMPLES_REPORT=1 prints every failure as `file:line  reason` and skips
// the expect, which is how the backlog is triaged rather than read one red test
// at a time.

import { describe, test, beforeAll } from 'bun:test'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }                                      from 'node:os'
import { join, resolve }                               from 'node:path'
import { fileURLToPath }                               from 'node:url'

import { parse }        from '../src/core/parser.js'
import { createClient } from '../src/index.js'
import * as litestone   from '../src/index.js'

const PKG     = fileURLToPath(new URL('..', import.meta.url))
const REPORT  = !!process.env.DOC_EXAMPLES_REPORT
const ONLY    = process.env.DOC_EXAMPLES_ONLY   // a substring of file:line
const KEY     = 'a'.repeat(64)                  // any 32 bytes; @encrypted needs one
const TIMEOUT = 15_000

// ─── the corpus ───────────────────────────────────────────────────────────────

function corpus() {
  const md = d => readdirSync(join(PKG, d)).filter(f => f.endsWith('.md') && !f.includes('.snapshot.')).map(f => `${d}/${f}`)
  return ['README.md', 'AGENTS.md', 'CLAUDE.md', ...md('docs'), ...md('docs/guides')]
}

type Block = { file: string, line: number, lang: string, words: Set<string>, body: string, schema: string | null }

/** Every fenced block, with the schema in scope for a code block. */
function blocksOf(file: string): Block[] {
  const lines = readFileSync(join(PKG, file), 'utf8').split('\n')
  const out: Block[] = []
  let schema: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^```(\w+)\s*(.*)$/)
    if (!m) continue
    const [, lang, info] = m
    const words = new Set(info.split(/\s+/).filter(Boolean))
    let j = i + 1
    while (j < lines.length && !lines[j].startsWith('```')) j++
    const body = lines.slice(i + 1, j).join('\n')
    out.push({ file, line: i + 1, lang, words, body, schema })
    if (lang === 'lite' && !words.has('fragment')) schema = body
    i = j
  }
  return out
}

const EXPORTS = new Set(Object.keys(litestone))

// ─── a schema block ───────────────────────────────────────────────────────────

const declaresDatabase = (schema: string) => /^\s*database\s+\w+/m.test(schema)

function clientOptions(schema: string) {
  return declaresDatabase(schema)
    ? { databases: ':memory:' as const, encryptionKey: KEY }
    : { db: ':memory:', encryptionKey: KEY }
}

async function buildSchema(body: string) {
  parse(body)
  await createClient({ schema: body, ...clientOptions(body) })
}

// ─── a code block ─────────────────────────────────────────────────────────────

const EXPORT_MAP: Record<string, string> = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).exports

/** `@frontierjs/litestone/x` → the file this package serves it from. */
function rewriteSpecifiers(src: string) {
  return src.replace(/(['"])@frontierjs\/litestone(\/[\w-]+)?\1/g, (all, q, sub) => {
    const entry = EXPORT_MAP[`.${sub ?? ''}`]
    const target = typeof entry === 'string' ? entry : entry?.import
    return target ? `${q}${resolve(PKG, target)}${q}` : all
  })
}

/** Names the block uses that this package exports, and the block neither imports nor declares. */
function usedExports(body: string) {
  const declared = new Set<string>()
  for (const m of body.matchAll(/\b(?:const|let|var|function|class)\s+([\w$]+)/g)) declared.add(m[1])
  for (const m of body.matchAll(/\b(?:const|let|var)\s+\{([^}]*)\}/g))
    for (const n of m[1].split(',')) declared.add(n.split(':').pop()!.trim().split('=')[0].trim())
  for (const m of body.matchAll(/^\s*import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}/gm))
    for (const n of m[1].split(',')) declared.add(n.split(/\s+as\s+/).pop()!.trim())
  for (const m of body.matchAll(/^\s*import\s+([\w$]+)\s*(?:,|from)/gm)) declared.add(m[1])
  const used = new Set<string>()
  for (const m of body.matchAll(/[\w$]+/g)) if (EXPORTS.has(m[0]) && !declared.has(m[0])) used.add(m[0])
  return { used: [...used], declared }
}

function moduleFor(block: Block) {
  const body = rewriteSpecifiers(block.body)
  const { used, declared } = usedExports(block.body)
  const index = resolve(PKG, 'src/index.js')
  const head: string[] = []
  if (used.length) head.push(`import { ${used.join(', ')} } from '${index}'`)
  if (block.schema && !declared.has('db')) {
    head.push(`import { createClient as __createClient } from '${index}'`)
    head.push(`const db = await __createClient({ path: './schema.lite', ...${JSON.stringify(clientOptions(block.schema))} })`)
  }
  if (!block.words.has('throws')) return head.concat(body).join('\n')
  // A refusal example passes only by throwing. An import is hoisted out of the
  // try, since a declaration inside a block is a syntax error.
  const imports: string[] = []
  const rest = body.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"][^\n]*$|^import\s+['"][^'"]+['"][^\n]*$/gm, m => { imports.push(m); return '' })
  return [...head, ...imports, 'try {', rest, '} catch (e) { process.exit(0) }', "console.error('expected the example to throw'); process.exit(3)"].join('\n')
}

async function runBlock(block: Block) {
  const dir = mkdtempSync(join(tmpdir(), 'ls-doc-example-'))
  try {
    if (block.schema) writeFileSync(join(dir, 'schema.lite'), block.schema)
    const file = join(dir, block.lang === 'ts' ? 'example.ts' : 'example.mjs')
    writeFileSync(file, moduleFor(block))
    const proc = Bun.spawn(['bun', file], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
    const timer = setTimeout(() => proc.kill(), TIMEOUT)
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`)
    return stderr
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─── the tests ────────────────────────────────────────────────────────────────

const RUNNABLE = new Set(['lite', 'js', 'ts'])

/** The line that says what went wrong, past bun's source-context lines. */
function reason(e: unknown) {
  const lines = String((e as Error)?.message ?? e).split('\n').map(l => l.trim()).filter(Boolean)
  return lines.find(l => /^(\w*Error|error)\b/.test(l) || /\[litestone\]/.test(l) || /has errors/.test(l))
    ?? lines.find(l => !/^\d+ \||^\^|^at /.test(l)) ?? ''
}

const all: { id: string, block: Block }[] = []
for (const file of corpus())
  for (const block of blocksOf(file))
    if (RUNNABLE.has(block.lang) && !block.words.has('fragment') && (!ONLY || `${file}:${block.line}`.includes(ONLY)))
      all.push({ id: `${file}:${block.line}`, block })

// Every block runs up front, eight wide: a process per block is the isolation,
// and in series that is a minute and a half.
const results = new Map<string, Error | null>()
async function runAll() {
  let next = 0
  const worker = async () => {
    while (next < all.length) {
      const { id, block } = all[next++]
      let err: Error | null = null
      try {
        if (block.lang === 'lite') await buildSchema(block.body)
        else await runBlock(block)
      } catch (e) { err = e as Error }
      if (block.words.has('failing')) err = err ? null : new Error('the example passes now — remove `failing` from its fence')
      results.set(id, err)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
}

describe('every example in the docs runs', () => {
  beforeAll(runAll, TIMEOUT * 10)

  for (const { id, block } of all)
    test(`${id} (${block.lang})`, () => {
      const err = results.get(id)
      if (err && !REPORT) throw err
      if (err) failures.push(`${id.padEnd(44)} ${block.lang.padEnd(4)} ${reason(err)}`)
    })

  if (REPORT) test('report', () => {
    console.log(`\n${failures.length} of ${all.length} examples failing\n` + failures.join('\n') + '\n')
  })
})

const failures: string[] = []
