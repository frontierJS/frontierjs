/*
 * agents-md.mjs
 * Every import AGENTS.md tells an agent to write resolves in the tarball.
 *
 * The kit ships no generated component catalog, so AGENTS.md carries the
 * vocabulary by hand (FJS-D163) — and a hand list goes stale in the direction
 * that reads as authoritative: a component renamed or moved leaves the guide
 * sending an agent to an import that fails at build time, with the guide still
 * the only thing it read.
 *
 * So each `@frontierjs/ui/...` specifier in the file is resolved the way a
 * bundler resolves it — through this package's `exports` map, where `*` is
 * Node's subpath pattern and matches across `/` — and the target must exist on
 * disk AND sit under an entry `files:` publishes. The count is asserted first,
 * because a file naming no imports passes every lookup.
 *
 * Run: node test/agents-md.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg  = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const doc  = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')

function resolveExport(subpath) {
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (!key.includes('*')) { if (key === subpath) return target; continue }
    const [pre, post] = key.split('*')
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= pre.length + post.length)
      return target.replace('*', subpath.slice(pre.length, subpath.length - post.length))
  }
  return null
}

const shipped = (rel) => pkg.files.some(f => rel === f || rel.startsWith(f.replace(/\/$/, '') + '/'))

const specifiers = [...new Set([...doc.matchAll(/@frontierjs\/ui(\/[\w./-]+)/g)].map(m => m[1].replace(/[.]$/, '')))]
const failures   = []

if (specifiers.length < 10) failures.push(`AGENTS.md names ${specifiers.length} imports — expected the kit's vocabulary`)

function refusal(sub) {
  const target = resolveExport('.' + sub)
  if (!target) return `@frontierjs/ui${sub} — no exports entry matches`
  const rel = target.replace(/^\.\//, '')
  if (!existsSync(join(ROOT, rel))) return `@frontierjs/ui${sub} → ${rel} does not exist`
  if (!shipped(rel))                return `@frontierjs/ui${sub} → ${rel} is not in files:`
  return null
}

for (const sub of specifiers) {
  const why = refusal(sub)
  if (why) failures.push(why)
}

// A pair: the same check must refuse a component the kit does not have and
// accept one it does, or every row above passes against a check that
// accepts — or refuses — everything.
if (!refusal('/components/forms/NoSuchThing.mesa')) failures.push('control: a nonexistent component was accepted')
if (refusal('/components/forms/Form.mesa'))         failures.push('control: forms/Form.mesa was refused')

if (failures.length) {
  console.error(`✗ agents-md — ${failures.length} failure(s)`)
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log(`✓ agents-md — ${specifiers.length} imports named in AGENTS.md resolve in the tarball`)
