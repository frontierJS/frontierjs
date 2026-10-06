/*
 * frontmatter-oracle.mjs — reads every real frontmatter block under the roots
 * given and compares the kit's answer with js-yaml's core schema.
 *
 * js-yaml is the oracle and never a dependency: this package declares none, so
 * it is installed somewhere else and resolved from the working directory.
 *
 *   cd "$(mktemp -d)" && npm i js-yaml@4
 *   node <repo>/packages/toolbelt/test/fixtures/frontmatter-oracle.mjs <repo> <other roots…>
 *
 * Core schema rather than js-yaml's default, because the kit resolves scalars by
 * YAML 1.2 core and the default adds 1.1's timestamps. What it prints is every
 * block on which the two disagree. A refusal the subset makes on purpose (an
 * anchor, a tag) shows as KIT-REFUSED, and so does a refusal that would be
 * a regression. Reading the message is how to tell them apart. A block both
 * refuse is not a disagreement.
 *
 * The spec's rows are the cases somebody thought of. This is the cases authors
 * actually wrote.
 */

import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitFrontmatter, parseFrontmatterBlock } from '../../src/frontmatter/frontmatter.js'

const yaml = createRequire(join(process.cwd(), 'noop.js'))('js-yaml')

const roots = process.argv.slice(2)
if (!roots.length) {
  console.error('usage: node frontmatter-oracle.mjs <root> [root…]')
  process.exit(2)
}

const SKIP = new Set(['node_modules', '.git', 'dist', '.cache'])
const blocks = []
const walk = (dir) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const path = join(dir, e.name)
    if (e.isDirectory()) walk(path)
    else if (/\.(md|mesa)$/.test(e.name)) {
      const { block } = splitFrontmatter(readFileSync(path, 'utf8'))
      if (block !== null) blocks.push({ path, block })
    }
  }
}
roots.forEach(walk)

// NaN and Infinity are not JSON, and both readers produce them.
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x))

let same = 0
let bothRefused = 0
const out = []
for (const { path, block } of blocks) {
  let ref, refErr = null, kit, kitErr = null
  try { ref = yaml.load(block, { schema: yaml.CORE_SCHEMA }) ?? {} } catch (e) { refErr = e.message.split('\n')[0] }
  try { kit = parseFrontmatterBlock(block) } catch (e) { kitErr = e.message }
  if (refErr && kitErr) bothRefused++
  else if (kitErr) out.push(`KIT-REFUSED  ${path}\n  ${kitErr}`)
  else if (refErr) out.push(`KIT-ACCEPTED ${path}\n  js-yaml: ${refErr}`)
  else if (json(ref) === json(kit)) same++
  else out.push(`DIFFERENT    ${path}\n  js-yaml: ${json(ref).slice(0, 300)}\n  kit:     ${json(kit).slice(0, 300)}`)
}

console.log(out.join('\n'))
console.log(`\n${blocks.length} blocks · ${same} equal · ${bothRefused} refused by both · ${out.length} to read`)
process.exit(out.length ? 1 : 0)
