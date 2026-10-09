/*
 * corpus.mjs — compile every .mesa file in the workspace and compare the output
 * against a saved run, byte for byte.
 *
 *   bun run corpus -- --save before      compile all, write the outputs under .cache/mesa-corpus/before
 *   bun run corpus -- --diff before      compile all, name every file whose output differs from that save,
 *                                        and write this run beside it as before.now to diff against
 *   bun run corpus                       compile all, report refusals and invalid JS only
 *
 * This is the grade for a compiler change meant to change NOTHING — the IR
 * extraction (`IDEAS/mesa-ir.md` § 6 step 1) above all. Invariant 12 makes the
 * output reproducible, so a byte that moves is either a bug or a change to be
 * named; there is no third kind and no tolerance.
 *
 * Each file compiles twice: once as a production build compiles it and once as
 * a dev server does, because `data-fjs-loc`, the debug labels and the HMR-facing
 * shape exist only in the second and a refactor can break either alone.
 *
 * A refusal is an output too. A file that threw before must throw the same
 * message after, so the error text is saved and compared like the JS is.
 *
 * Every output is parsed with acorn (Invariant 15): a compile that returns is
 * not a compile that produced JavaScript.
 *
 * ── What it does not see ─────────────────────────────────────────────
 *
 * The files are compiled raw. Sierra rewrites a page before handing it over
 * (injected imports and props), so a defect that lives only in that rewritten
 * shape is invisible here; `example`'s drives are where that shape runs.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const CACHE = join(ROOT, '.cache/mesa-corpus')

const MODES = {
  prod: (filename) => ({ filename, dev: false }),
  dev:  (filename) => ({ filename, dev: true, loc: true, locRoot: '' })
}

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
const saveAs = flag('--save')
const diffAgainst = flag('--diff')

// rg skips node_modules and gitignored build output, which is the corpus: a
// built copy of a component under dist/ is not a second source file.
const files = execFileSync('rg', ['--files', '-g', '*.mesa'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .sort()

const results = []
const warningsOff = () => {}

for (const file of files) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  for (const [mode, configFor] of Object.entries(MODES)) {
    let out
    let refused = null
    try {
      const ctx = await compile(source, { ...configFor(file), warning: warningsOff })
      out = ctx.result
    } catch (err) {
      refused = String(err?.message ?? err)
      out = `/* refused */\n${refused}\n`
    }
    let invalid = null
    if (!refused) {
      try {
        acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' })
      } catch (err) {
        invalid = err.message
      }
    }
    results.push({ file, mode, out, refused, invalid, hash: sha(out) })
  }
}

const refusedCount = results.filter((r) => r.refused).length
const invalid = results.filter((r) => r.invalid)
console.log(`${files.length} files · ${results.length} compiles · ${refusedCount} refused · ${invalid.length} invalid JS`)
for (const r of invalid) console.log(`  invalid  ${r.file} [${r.mode}]  ${r.invalid}`)

if (saveAs) console.log(`saved ${relative(ROOT, save(saveAs))}`)

if (diffAgainst) {
  const dir = join(CACHE, diffAgainst)
  const manifest = join(dir, 'manifest.json')
  if (!existsSync(manifest)) {
    console.error(`no save named ${diffAgainst} — run with --save ${diffAgainst} first`)
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(manifest, 'utf8'))
  const now = manifestOf(results)
  const changed = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(now)])) {
    if (before[key] !== now[key]) changed.push(key)
  }
  if (changed.length === 0) {
    console.log(`identical to ${diffAgainst}: ${results.length} outputs`)
  } else {
    const nowDir = save(`${diffAgainst}.now`)
    for (const key of changed.sort()) {
      const why = !(key in before) ? 'new' : !(key in now) ? 'gone' : 'differs'
      console.log(`  ${why.padEnd(7)}  ${key}`)
    }
    const [mode, file] = changed[0].split(/:(.*)/)
    console.log(`${changed.length} of ${results.length} outputs moved — the first, compared:`)
    console.log(`  git diff --no-color --no-index ${relative(ROOT, join(dir, mode, `${file}.js`))} ${relative(ROOT, join(nowDir, mode, `${file}.js`))}`)
    process.exitCode = 1
  }
}

if (invalid.length) process.exitCode = 1

function save(name) {
  const dir = join(CACHE, name)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
  for (const r of results) {
    const path = join(dir, r.mode, `${r.file}.js`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, r.out)
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestOf(results), null, 1))
  return dir
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function manifestOf(rs) {
  return Object.fromEntries(rs.map((r) => [`${r.mode}:${r.file}`, r.hash]))
}
