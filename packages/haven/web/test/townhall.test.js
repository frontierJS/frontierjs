// web/test/townhall.test.js — the town hall's reading of `IDEAS/overview.md`
// (`src/townhall.js`): a wave's open rows are its delegates, a struck or
// settled row has left, an item holding a ` | ` of its own is still one row,
// and a delegate keeps their name. Over an overview written here, so the real
// file's next edit fails nothing. Nothing checks `townhall.data.json` against
// the real file: like the ledger it is a snapshot `bun run townhall` rewrites,
// and a check would fail Haven on every edit to the overview.
import { test, expect } from 'bun:test'
import { wavesOf, nameOf, idsOf, NAMES } from '../src/townhall.js'

const OVERVIEW = `
# Overview

## How to read the columns

| 9.9 | **not a wave** — a table row outside any wave | S | ●○○○ | — | — | idea | \`x.md\` |

## Wave 1 — make the thesis visible

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 | **Schema → UI (\`foundry\`)** — <AutoForm>. | M | ●●●○ | **only** | U | partial | \`foundry.md\` · \`more.md\` |
| 1.1a | ~~**Generate the form**~~ — shipped. | S | ●●○○ | edge | U | ~~\`shipped\`~~ | \`forms.md\` |
| 1.2 | **A row that says a b | c in its item** — and goes on | L | ●○○○ | stakes | A D | idea | \`pipes.md\` |
| 1.3 | **Built already** — and says so | S | ●○○○ | — | — | built 2026-08-14 | \`built.md\` |

## Wave 2 — production blockers

| 2.1 | **A defect** — it is wrong today | S | ●●●● | stakes | T | **defect** | \`[link](../ISSUES.md)\` |

## Wave 3 — nothing open

| 3.1 | **Gone** — closed | S | ●○○○ | — | — | **shipped** | \`gone.md\` |
`

test('a wave holds its open rows as delegates, in order, with the reading of each', () => {
  const waves = wavesOf(OVERVIEW)
  expect(waves.map((w) => [w.n, w.name])).toEqual([[1, 'make the thesis visible'], [2, 'production blockers']])
  expect(waves[0].ideas[0]).toEqual({
    id: '1.1', title: 'Schema → UI (foundry)', effort: 'M', payoff: 3, edge: 'only', realms: 'U', status: 'partial', paper: 'foundry.md',
  })
  expect(waves[1].ideas[0]).toMatchObject({ id: '2.1', status: 'defect', payoff: 4 })
})

test('a struck or settled row has left the hall, and a wave left with nobody is no wave', () => {
  const ids = [...idsOf(wavesOf(OVERVIEW))]
  expect(ids).toEqual(['1.1', '1.2', '2.1'])
})

test('an item holding a | of its own is one row, its cells read from the right', () => {
  const two = wavesOf(OVERVIEW)[0].ideas[1]
  expect(two).toMatchObject({ id: '1.2', title: 'A row that says a b | c in its item', effort: 'L', realms: 'A D', paper: 'pipes.md' })
})

test('a delegate is the same person for the same idea, and one of the town', () => {
  expect(nameOf('4.31')).toBe(nameOf('4.31'))
  expect(NAMES).toContain(nameOf('2.24c'))
  expect(new Set(['1.1', '1.2', '2.1', '2.2', '3.4', '4.31'].map(nameOf)).size).toBeGreaterThan(1)
})
