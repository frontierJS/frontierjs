// test/doc-examples.test.ts — every runnable fence in README.md and docs/guide/ runs (Invariant 16).
//
// The fence contract is toolbelt's `docfences`: a ```lite block is the schema
// the js/ts blocks below it run against, written as ./schema.lite in a tmpdir of
// its own; a js/ts block runs as a module in its own `bun` process unless its
// info string says `fragment`; `throws` passes only when the block throws.
//
// A block that drives a browser needs Chrome. It runs where `findChrome()`
// answers and is reported skipped where it does not, so a machine with no
// Chrome is not told the example is broken.
//
// DOC_EXAMPLES_ONLY=<substring of file:line> runs one block.

import { describe, test, beforeAll } from 'bun:test'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }        from 'node:os'
import { join }          from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse }         from '@frontierjs/litestone'
import { findChrome }    from '@frontierjs/mesa/drive'
import { docFences, isRunnable } from '@frontierjs/toolbelt/docfences'

const PKG     = fileURLToPath(new URL('..', import.meta.url))
const ONLY    = process.env.DOC_EXAMPLES_ONLY
const TIMEOUT = 60_000
const GUIDE   = join(PKG, 'docs/guide')
const FILES   = ['README.md', ...readdirSync(GUIDE, { withFileTypes: true }).filter((e) => e.isDirectory())
  .flatMap((e) => readdirSync(join(GUIDE, e.name)).filter((f) => f.endsWith('.md')).map((f) => `docs/guide/${e.name}/${f}`))]

/** `@frontierjs/<pkg>[/sub]` → the file this checkout serves it from; the block runs in a directory of its own. */
const rewriteSpecifiers = (src: string) =>
  src.replace(/(['"])(@frontierjs\/[\w-]+(?:\/[\w.-]+)?)\1/g, (all, q, spec) => {
    try { return `${q}${Bun.resolveSync(spec, PKG)}${q}` } catch { return all }
  })

const needsChrome = (body: string) => /@frontierjs\/(?:testing|mesa)\/drive/.test(body)

type Block = { file: string, line: number, lang: string, words: Set<string>, body: string, schema: string | null }

async function runBlock(block: Block) {
  const dir = mkdtempSync(join(tmpdir(), 'testing-doc-example-'))
  try {
    if (block.schema) writeFileSync(join(dir, 'schema.lite'), block.schema)
    const file = join(dir, block.lang === 'ts' ? 'example.ts' : 'example.mjs')
    writeFileSync(file, rewriteSpecifiers(block.body))
    const proc = Bun.spawn(['bun', file], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill() }, TIMEOUT)
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    clearTimeout(timer)
    if (timedOut) throw new Error(`timed out after ${TIMEOUT}ms`)
    if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const all: { id: string, block: Block }[] = []
for (const file of FILES)
  for (const f of docFences(readFileSync(join(PKG, file), 'utf8')))
    if (isRunnable(f) && !f.words.has('fragment') && (!ONLY || `${file}:${f.line}`.includes(ONLY)))
      all.push({ id: `${file}:${f.line}`, block: { ...f, file } })

const chrome = !!findChrome()
const results = new Map<string, Error | null>()

async function runAll() {
  let next = 0
  const worker = async () => {
    while (next < all.length) {
      const { id, block } = all[next++]
      if (needsChrome(block.body) && !chrome) continue
      let err: Error | null = null
      try {
        if (block.lang === 'lite') parse(block.body)
        else await runBlock(block)
      } catch (e) { err = e as Error }
      if (block.words.has('throws')) err = err ? null : new Error('expected the example to throw')
      results.set(id, err)
    }
  }
  // A drive binds ports and opens a browser; two at a time is plenty.
  await Promise.all(Array.from({ length: 2 }, worker))
}

describe('every example in the docs runs', () => {
  beforeAll(runAll, TIMEOUT * all.length)

  for (const { id, block } of all)
    (needsChrome(block.body) && !chrome ? test.skip : test)(`${id} (${block.lang})`, () => {
      const err = results.get(id)
      if (err) throw err
    })
})
