// FJS-2817 — nothing exports a `SYSTEM` principal. The app acts as itself
// through `app.runAs(null, fn)` (`createApp({ system })`), so a guide or a
// type comment spelling `{ user: SYSTEM }` sends a reader to an
// identifier that is a ReferenceError.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

describe('docs name no SYSTEM identifier', () => {
  for (const file of ['AGENTS.md', 'README.md', 'src/core/app.ts']) {
    test(file, () => {
      expect(read(file)).not.toMatch(/user:\s*SYSTEM\b/)
    })
  }
})
