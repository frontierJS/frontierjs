/*
 * run.mjs — what the printer promises, against a real Chrome.
 *
 *   bun test/run.mjs            every spec
 *   bun test/run.mjs wedged     specs whose filename matches
 *
 * Each `specs/*.spec.mjs` exports `run(t)`. One printer serves every spec, so
 * its launch count is the warm-browser claim; a spec that needs a printer of
 * its own makes one and closes it.
 *
 * The text of a PDF is read back with poppler's pdftotext: a PDF's text is
 * compressed and glyph-encoded, so grepping its bytes proves nothing. With no
 * Chrome the run says so and passes; with no pdftotext each row that needs it
 * says so by name.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome } from '@frontierjs/mesa/drive'
import { createPrinter } from '../index.js'

const HERE    = fileURLToPath(new URL('.', import.meta.url))
const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'))

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red   = (s) => `\x1b[31m${s}\x1b[0m`
const dim   = (s) => `\x1b[2m${s}\x1b[0m`

if (!findChrome()) {
  console.log(dim('print-kit specs skipped: no Chrome on this machine'))
  process.exit(0)
}

const hasPoppler = spawnSync('sh', ['-c', 'command -v pdftotext']).status === 0
const scratch    = mkdtempSync(join(tmpdir(), 'print-kit-'))

function pdfText(bytes) {
  const file = join(scratch, `${Math.random().toString(36).slice(2)}.pdf`)
  writeFileSync(file, bytes)
  return spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).stdout
}

const printer = createPrinter()
let files = readdirSync(join(HERE, 'specs')).filter((f) => f.endsWith('.spec.mjs')).sort()
if (filters.length) files = files.filter((f) => filters.some((x) => f.includes(x)))

let failures = 0, passes = 0
for (const file of files) {
  const mod  = await import(join(HERE, 'specs', file))
  const rows = []
  const t = {
    printer, hasPoppler, pdfText,
    ok:    (v, label) => rows.push({ name: label, ok: !!v, detail: `got ${JSON.stringify(v)}` }),
    is:    (actual, expected, label) => rows.push({
      name: label, ok: Object.is(actual, expected),
      detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    }),
    match: (actual, re, label) => rows.push({
      name: label, ok: re.test(String(actual ?? '')), detail: `expected ${re} to match ${JSON.stringify(actual)}`,
    }),
    skip:  (label) => rows.push({ name: label, ok: true, skipped: true }),
  }
  try { await mod.run(t) } catch (err) {
    rows.push({ name: 'spec threw', ok: false, detail: String(err?.message ?? err) })
  }
  const bad = rows.filter((r) => !r.ok).length
  failures += bad
  passes   += rows.length - bad
  console.log(`${bad ? red('✗') : green('✓')} ${mod.name ?? file} ${dim(`(${rows.length - bad}/${rows.length})`)}`)
  for (const r of rows) {
    if (!r.ok) console.log(`    ${red('✗')} ${r.name}\n      ${r.detail}`)
    else if (r.skipped) console.log(`    ${dim(`- ${r.name}: skipped, no pdftotext`)}`)
  }
}

await printer.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? red(`${failures} failing`) + dim(`, ${passes} passing`) : green(`${passes} passing`))
process.exit(failures ? 1 : 0)
