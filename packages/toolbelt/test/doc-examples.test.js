// test/doc-examples.test.js — every runnable fence in README.md and docs/ runs (FJS-D860).
//
// Invariant 16: a runnable example is verified. A block runs as a module in its
// own `bun` process, so one that exits or leaks a timer cannot take the suite
// down; `fragment` on the info string is the opt-out, `throws` expects a
// refusal. The kits are pure, so a block needs no prelude beyond its imports.

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }        from 'node:os'
import { join }          from 'node:path'
import { fileURLToPath } from 'node:url'
import { docFences, isRunnable } from '../src/docfences/docfences.js'

const PKG = fileURLToPath(new URL('..', import.meta.url))

const pages = () => {
  const md = readdirSync(join(PKG, 'docs')).filter(f => f.endsWith('.md') && !f.includes('.snapshot.')).map(f => `docs/${f}`)
  return ['README.md', 'AGENTS.md', 'CLAUDE.md', ...md]
}

const blocks = []
for (const file of pages()) {
  let text
  try { text = readFileSync(join(PKG, file), 'utf8') } catch { continue }
  for (const f of docFences(text)) if (isRunnable(f)) blocks.push({ ...f, file })
}

// A block is run from a directory under this package, since `@frontierjs/toolbelt/<kit>`
// resolves through this package's own `exports` only from inside it.
async function run(block) {
  const dir = mkdtempSync(join(PKG, '.doc-example-'))
  try {
    const file = join(dir, 'example.mjs')
    const body = block.words.has('throws')
      ? `try {\n${block.body}\n} catch { process.exit(0) }\nconsole.error('expected the example to throw'); process.exit(3)`
      : block.body
    writeFileSync(file, body)
    const proc = Bun.spawn(['bun', file], { cwd: PKG, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), 15_000)
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(stderr.trim() || `exit ${code}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('every example in the docs runs', () => {
  for (const block of blocks)
    test(`${block.file}:${block.line} (${block.lang})`, async () => {
      if (block.words.has('failing')) return expect(run(block)).rejects.toThrow()
      await run(block)
    }, 20_000)
})
