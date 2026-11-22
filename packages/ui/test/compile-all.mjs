/*
 * compile-all.mjs
 * Compiles every .mesa in the package and parses the emitted JavaScript.
 *
 * Both halves matter. Mesa's compiler can report zero analysis errors and
 * still emit a module that throws on load (packages/mesa/CLAUDE.md), so a
 * green compile is not the check — parsing the output is.
 *
 * Run: node test/compile-all.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJs } from 'acorn'
// Deliberately a relative path, not the '@frontierjs/mesa' specifier. bun
// resolves the workspace dep to a *copy* under node_modules/.bun rather than a
// symlink, so the specifier reads a snapshot taken at install time — an edit to
// packages/mesa/compiler.js would not be seen, and this harness would report
// green against stale code. Testing in-repo means testing the tree.
import { compileSource } from '../../mesa/src/compiler.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.mesa')) out.push(p)
  }
  return out
}

const files = walk(join(ROOT, 'components')).sort()
let failed = 0

for (const file of files) {
  const rel = relative(ROOT, file)
  const src = readFileSync(file, 'utf8')

  const warnings = []

  let ctx
  try {
    ctx = await compileSource(src, {
      filename: rel,
      warning: (w) => warnings.push(w.message ?? String(w)),
    })
  } catch (err) {
    console.error(`✗ ${rel}\n    threw during compile: ${err.message}`)
    failed++
    continue
  }

  // The half a clean compile does not cover.
  try {
    parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch (err) {
    console.error(`✗ ${rel}\n    emitted unparseable JS: ${err.message}`)
    failed++
    continue
  }

  if (warnings.length) {
    console.error(`! ${rel}`)
    for (const w of warnings) console.error(`    ${w}`)
  }
}

const passed = files.length - failed
console.log(`${passed}/${files.length} components compile and emit parseable JS`)

// ─── No bare rem ────────────────────────────────────────────────────
// A component inside a widget's shadow root reads rem off the HOST page's
// root, so a 62.5% marketing page draws it at 10/16 size (FJS-2072). Sizes
// are spelled calc(N * var(--rem)) (FJS-D1164); an @media or @container
// condition cannot read a var() and is exempt.
const BARE_REM = /(^|[^\w.$-])-?\d*\.?\d+rem\b/
let bareRem = 0
for (const file of files) {
  // A comment opens after whitespace, so 'image/*' in a string opens none.
  const src = readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
  src.split('\n').forEach((line) => {
    if (/^\s*@(media|container)\b/.test(line) || !BARE_REM.test(line)) return
    console.error(`✗ ${relative(ROOT, file)}: bare rem — ${line.trim()}`)
    bareRem++
  })
}
if (bareRem) console.error(`${bareRem} bare rem in components; write calc(N * var(--rem))`)

if (failed || bareRem) process.exit(1)
