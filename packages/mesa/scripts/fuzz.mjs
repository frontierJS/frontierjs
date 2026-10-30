/*
 * fuzz.mjs — feed the compiler `.mesa` source it did not expect (`FJS-3548`).
 *
 *   bun run fuzz                       24 mutants of each of 40 corpus files, seed 1
 *   bun run fuzz -- --seed 7           another draw; the same seed is the same run
 *   bun run fuzz -- --files 200 --per 60
 *
 * The corpus is fixed files and `test/mutants.mjs` stubs the runtime, so
 * neither feeds the compiler a malformed component. Here one corpus file is
 * mutated one token at a time (delete it, double it, swap it with its neighbor,
 * or replace it with a token from elsewhere in the file), compiled, and graded
 * on the only two answers a compile owes:
 *
 *   - it THREW — a refusal, loud, so counted and not a finding; or
 *   - it returned and either `analysis.errors` names the problem, or the output
 *     parses with acorn (Invariant 15) and still holds a component.
 *
 * A return with no error, output acorn refuses, is `invalid`. A return with no
 * error and no component in the output is `empty` — the C9 failure the audit
 * found, a source the compiler traded for a program that does nothing. Both
 * fail the run, and each finding prints its file, the mutation and the first
 * line acorn or the check gave, so the reproduction is one slice of source.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const args = process.argv.slice(2)
const num = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : Number(args[i + 1])
}
const SEED = num('--seed', 1)
const PER = num('--per', 24)
const FILES = num('--files', 40)

// mulberry32: the run has to be repeatable from its seed or a finding cannot be re-found.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(SEED)
const pick = (n) => Math.floor(rand() * n)

// Words, runs of space, and each bracket/quote/operator on its own: a mutant lands on
// a delimiter as often as on a name, which is where a parser's assumptions are.
const TOKEN = /\s+|[A-Za-z0-9_$-]+|[^\sA-Za-z0-9_$-]/g

const OPS = ['delete', 'double', 'swap', 'replace']

function mutate(source) {
  const tokens = source.match(TOKEN) ?? []
  const at = pick(tokens.length)
  const op = OPS[pick(OPS.length)]
  const next = tokens.slice()
  let note = `${op} ${JSON.stringify(tokens[at])} @${at}`
  if (op === 'delete') next.splice(at, 1)
  else if (op === 'double') next.splice(at, 0, tokens[at])
  else if (op === 'swap' && at + 1 < next.length) [next[at], next[at + 1]] = [next[at + 1], next[at]]
  else {
    const other = tokens[pick(tokens.length)]
    note = `replace ${JSON.stringify(tokens[at])} @${at} with ${JSON.stringify(other)}`
    next[at] = other
  }
  return { source: next.join(''), note }
}

async function grade(source, filename) {
  let ctx
  try {
    ctx = await compile(source, { filename, dev: false, warning: () => {} })
  } catch {
    return 'refused'
  }
  if (ctx.analysis?.errors?.length) return 'diagnosed'
  const out = ctx.result
  try {
    acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch (err) {
    return { kind: 'invalid', why: err.message }
  }
  if (!/export\s+default\b/.test(out)) return { kind: 'empty', why: 'no default export in the output' }
  return 'ok'
}

const all = execFileSync('rg', ['--files', '-g', '*.mesa'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .sort()
// A stride, not the first N: the sorted list is grouped by package.
const stride = Math.max(1, Math.floor(all.length / FILES))
const files = all.filter((_, i) => i % stride === 0).slice(0, FILES)

const tally = { refused: 0, diagnosed: 0, ok: 0 }
const findings = []

for (const file of files) {
  const original = readFileSync(join(ROOT, file), 'utf8')
  // A corpus file that does not compile clean on its own has no baseline to mutate from.
  if ((await grade(original, file)) !== 'ok') continue
  for (let i = 0; i < PER; i++) {
    const m = mutate(original)
    if (m.source === original) continue
    const verdict = await grade(m.source, file)
    if (typeof verdict === 'string') tally[verdict]++
    else findings.push({ file, note: m.note, ...verdict, source: m.source })
  }
}

console.log(`seed ${SEED} · ${files.length} files · ${tally.refused} refused · ${tally.diagnosed} diagnosed · ${tally.ok} compiled · ${findings.length} findings`)
for (const f of findings) console.log(`  ${f.kind.padEnd(8)} ${f.file}  ${f.note}\n           ${f.why.split('\n')[0]}`)
if (findings.length) process.exitCode = 1
