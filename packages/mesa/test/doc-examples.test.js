// test/doc-examples.test.js — every runnable fence in the docs compiles and its output parses (FJS-D860).
//
// Invariant 15 and 16: a runnable example is verified, and a clean compile is
// not proof of valid JS. A `mesa` block is a component; a `js` block is the
// body of a component's instance `<script>`, because that is what every js
// fence in these pages shows. Either way the compiler must report no error and
// acorn must accept what it emitted. A js block that is not a component script
// (a Node call, a Vite config, the compiler's own output) says `fragment` on
// its info string, in the file, where the next reader sees it.
//
// A capitalized tag the block never imports is bound to a stub import, since
// the page that shows `<Card>` is not the page that shows `Card.mesa`.

import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as acorn from 'acorn'
import { docFences, isRunnable } from '@frontierjs/toolbelt/docfences'
import { compileSource } from '../src/compiler.js'

const PKG = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..')

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

/** The component a block is: a `mesa` block as written, a `js` block as an instance script. */
function componentOf(block) {
  if (block.lang === 'mesa') {
    const tags = [...new Set([...block.body.matchAll(/<([A-Z]\w*)/g)].map(m => m[1]))]
    const unbound = tags.filter(t => !new RegExp(`\\b(?:import|const|let|function|class)\\s+${t}\\b`).test(block.body))
    const imports = unbound.map(t => `import ${t} from './${t}.mesa'`).join('\n')
    if (!imports) return block.body
    return /<script\s+module/.test(block.body)
      ? block.body.replace(/(<script\s+module[^>]*>)/, `$1\n${imports}`)
      : `<script module>\n${imports}\n</script>\n${block.body}`
  }
  return `<script>\n${block.body}\n</script>`
}

async function check(block) {
  const ctx = await compileSource(componentOf(block), { filename: `${block.file}:${block.line}.mesa`, dev: false, css: false, warning: () => {} })
  const errors = ctx?.analysis?.errors ?? []
  if (errors.length) throw new Error(String(errors[0]))
  acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
}

describe('every example in the docs compiles and its output parses', () => {
  // A walker that matched nothing would pass every test below.
  test('the docs fence runnable examples', () => expect(blocks.length).toBeGreaterThan(40))

  for (const block of blocks)
    test(`${block.file}:${block.line} (${block.lang})`, async () => {
      if (block.words.has('failing') || block.words.has('throws')) return expect(check(block)).rejects.toThrow()
      await check(block)
    })
})
