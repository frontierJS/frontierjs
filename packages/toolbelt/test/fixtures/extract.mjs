#!/usr/bin/env node
/*
 * extract.mjs — refresh guide-samples.json from the @frontierjs/css guide.
 *
 * The corpus is a snapshot, not a mirror: it is committed so that glow's
 * suite has no cross-package dependency, and refreshed by hand when the
 * guide grows samples of a kind glow has not seen. Run it from anywhere:
 *
 *   node test/fixtures/extract.mjs
 *
 * Samples containing `${` are skipped — they interpolate at render time and
 * cannot be reconstructed from the source text.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const guide = join(here, '..', '..', '..', 'css', 'guide', 'guide.js')

const src = readFileSync(guide, 'utf8')
const out = []
let skipped = 0
let i = 0

while ((i = src.indexOf('code(`', i)) !== -1) {
  const start = i + 'code(`'.length
  let j = start
  for (;;) {
    if (j > src.length) throw new Error('unterminated template literal at ' + start)
    if (src[j] === '\\') { j += 2; continue }
    if (src[j] === '`') break
    j++
  }
  const body = src.slice(start, j)
  if (body.includes('${')) skipped++
  else out.push(body.replace(/\\`/g, '`').replace(/\\\\/g, '\\'))
  i = j + 1
}

writeFileSync(join(here, 'guide-samples.json'), JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${out.length} samples (${skipped} skipped as interpolated)`)
