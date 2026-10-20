// readme-fences.test.js — a README code block whose first line names a `.mesa`
// file is fenced `mesa`. Fenced `javascript`, the block neither parses as JS
// (the markup half is `<`) nor reads as the Mesa it is (FJS-2416).

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const README = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'README.md')

test('a README block that opens by naming a .mesa file is fenced mesa', () => {
  const text = readFileSync(README, 'utf8')
  const wrong = []
  for (const m of text.matchAll(/^```(\w*)\n(?:\/\/|<!--)\s*\S*\.mesa\b/gm)) {
    if (m[1] !== 'mesa') wrong.push(m[1] || '(none)')
  }
  expect(wrong).toEqual([])
})
