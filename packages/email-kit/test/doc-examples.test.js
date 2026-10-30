// test/doc-examples.test.js — every runnable fence in README.md and docs/ runs (FJS-D860).
//
// Invariant 16. A ```mesa block is a template: it is written beside the package
// root, so its `@frontierjs/email-kit/components/*` imports resolve through this
// package's own `exports`, and rendered with `renderEmailFile`. Its props default
// in the block, so it renders with no data. `fragment` on the info string is the
// opt-out and `throws` expects a refusal. A js/ts block has no prelude to run
// under here and must be marked `fragment`.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docFences, isRunnable } from '@frontierjs/toolbelt/docfences'
import { renderEmailFile }       from '../render.js'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')

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

async function run(block) {
  if (block.lang !== 'mesa') throw new Error(`no runner for a ${block.lang} block here; mark it fragment`)
  const dir = mkdtempSync(join(PKG, '.doc-example-'))
  try {
    const file = join(dir, 'Example.mesa')
    writeFileSync(file, block.body)
    const out = await renderEmailFile(file, { data: {} })
    if (!out.html.includes('<!DOCTYPE')) throw new Error('rendered no document')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('every example in the docs runs', () => {
  for (const block of blocks)
    it(`${block.file}:${block.line} (${block.lang})`, async () => {
      if (block.words.has('failing') || block.words.has('throws')) return expect(run(block)).rejects.toThrow()
      await run(block)
    })
})
