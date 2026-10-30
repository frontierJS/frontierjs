// Every runnable fence in README.md — the editor's sample schema — is parsed by the
// parser bundle the extension ships (FJS-D860, Invariant 16).
//
// Run:  npm test  ·  node test/doc-examples.test.mjs
//
// The README's only runnable fence is a ```lite block; a schema the language
// server would underline in its own documentation is the failure this catches.
// The reader is the workspace's toolbelt, by path: this package is npm and
// depends on nothing in the workspace.

import { readFileSync, readdirSync } from 'node:fs'
import { createRequire }             from 'node:module'
import { join }                      from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT    = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { docFences, isRunnable } = await import(
  pathToFileURL(join(ROOT, '..', 'toolbelt', 'src', 'docfences', 'docfences.js')).href)
const { parse } = require(join(ROOT, 'out', 'litestone', 'parser-bundle'))

const pages = ['README.md', 'AGENTS.md', 'CLAUDE.md']
try {
  for (const f of readdirSync(join(ROOT, 'docs')))
    if (f.endsWith('.md') && !f.includes('.snapshot.')) pages.push(`docs/${f}`)
} catch {}

let pass = 0
const failures = []
for (const file of pages) {
  let text
  try { text = readFileSync(join(ROOT, file), 'utf8') } catch { continue }
  for (const fence of docFences(text)) {
    if (!isRunnable(fence)) continue
    const where = `${file}:${fence.line} (${fence.lang})`
    if (fence.lang !== 'lite') { failures.push(`${where}  no runner for this language here — mark it fragment`); continue }
    let result, error
    try { result = parse(fence.body) } catch (e) { error = e.message }
    const refused = fence.words.has('throws') || fence.words.has('failing')
    const bad     = error || !result?.schema
    if (bad && !refused) failures.push(`${where}  ${error ?? result?.errors?.[0]?.message ?? 'did not parse'}`)
    else { pass++; console.log(`  ok    ${where}`) }
  }
}

console.log(`\n${pass} pass, ${failures.length} fail`)
for (const f of failures) console.log(`  FAIL  ${f}`)
process.exit(failures.length ? 1 : 0)
