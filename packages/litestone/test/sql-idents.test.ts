// A hand-quoted identifier — `"${…}"` inside a template literal — is the
// spelling `ident()` replaces (IDEAS/shipped/litestone-by-construction.md § Step 1).
// Nothing tells a schema-derived name from a caller's once both are written
// that way, so Invariant 8 holds at each of these sites only because someone
// read it. The count per file may only go down: a new site is refused here, and
// a conversion lowers its ceiling in the table below so it cannot creep back.
//
// Counts are OCCURRENCES, not lines, measured on 2026-10-07 after `buildSQL`,
// `updateMany` and `deleteMany` were converted. The `"${tableName}"` in a
// precomputed statement and the `"${col(x)}"` in a SET helper are still here;
// each later step moves a verb and lowers its number.

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE = join(import.meta.dir, '../src/core')

const CEILING: Record<string, number> = {
  'args.js':          7,
  'cardinality.js':   2,
  'client.js':        350,
  'commitment.js':    3,
  'cross-process.js': 9,
  'ddl.js':           100,
  'exclusion.js':     5,
  'include.js':       66,
  'migrate.js':       47,
  'migrations.js':    26,
  'opportunities.js': 3,
  'parser.js':        20,
  'plugin.js':        2,
  'policy.js':        39,
  'query.js':         76,
  'schema-maps.js':   20,
  'stamps.js':        3,
  'validate.js':      3,
}

const count = (src: string) => (src.match(/"\$\{/g) ?? []).length

describe('hand-quoted identifiers in src/core ratchet down', () => {
  const files = readdirSync(CORE).filter(f => f.endsWith('.js')).sort()

  for (const file of files) {
    it(`${file} has no new "\${…}" site`, () => {
      const n       = count(readFileSync(join(CORE, file), 'utf8'))
      const ceiling = CEILING[file] ?? 0
      expect(n,
        `${file} has ${n} hand-quoted "\${…}" identifiers and its ceiling is ${ceiling}. ` +
        `Write the new one as ident(name) from query.js — it quotes through quoteIdent and ` +
        `travels as a fragment beside its binds. A conversion lowers the number in CEILING.`,
      ).toBeLessThanOrEqual(ceiling)
    })
  }

  it('a ceiling that has been beaten is lowered, not left', () => {
    const slack: string[] = []
    for (const [file, ceiling] of Object.entries(CEILING)) {
      const n = count(readFileSync(join(CORE, file), 'utf8'))
      if (n < ceiling) slack.push(`${file}: ${n} < ${ceiling}`)
    }
    expect(slack, `lower these ceilings in CEILING so the improvement cannot creep back: ${slack.join(', ')}`).toEqual([])
  })
})
