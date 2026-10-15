// web/test/bar.test.js — the bar's board: what `barActivity()` reads off a
// command, and that a stool is a seat that is sat on and never a booth.
import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { barActivity, barCommand } from '../src/errand.js'
import { bar as barPiece } from '../src/pieces/bar.js'
import { spotsOf } from '../src/pieces/index.js'
import { stageOf } from './stage.mjs'

const ROWS = [
  { text: 'client — Check access (todo created)', when: '2026-10-14T20:40:22.019Z' },
  { text: 'client — Jonathan was granted access.' },
]

test('no command is no board; the env var wins over the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-bar-'))
  const file = join(dir, 'bar')
  expect(barCommand({ env: '', file })).toBe('')
  expect(await barActivity({ cmd: '' })).toBeNull()
  writeFileSync(file, 'echo from-file\n')
  expect(barCommand({ env: '', file })).toBe('echo from-file')
  expect(barCommand({ env: 'echo from-env', file })).toBe('echo from-env')
  rmSync(dir, { recursive: true })
})

test('a list of rows is read in order, a missing when becoming empty', async () => {
  const rows = await barActivity({ cmd: `printf '%s' '${JSON.stringify(ROWS)}'` })
  expect(rows).toEqual([
    { text: ROWS[0].text, when: ROWS[0].when },
    { text: ROWS[1].text, when: '' },
  ])
})

test('nothing printed is an empty board; output that is no list, or a row with no text, is refused by name', async () => {
  expect(await barActivity({ cmd: 'true' })).toEqual([])
  await expect(barActivity({ cmd: `printf '%s' '{"text":"x"}'` })).rejects.toThrow('HAVEN_BAR printed no list')
  await expect(barActivity({ cmd: `printf '%s' '[{"when":"w"}]'` })).rejects.toThrow('HAVEN_BAR printed no list')
  await expect(barActivity({ cmd: 'exit 3' })).rejects.toThrow()
})

test('each stool of the bar is walked onto, has a floor cell to stand up to, and pairs with nobody', async () => {
  const stage = await stageOf('Tavern')
  const bar = stage.placed(barPiece)[0]
  expect(spotsOf(barPiece, 'seat')).toHaveLength(7)
  for (const s of spotsOf(barPiece, 'seat')) {
    expect(stage.walkable(bar.x + s.dx, bar.y + s.dy)).toBe(true)
    expect(stage.walkable(bar.x + s.stand.dx, bar.y + s.stand.dy)).toBe(true)
    expect(stage.seatAt(bar.x + s.dx, bar.y + s.dy)).toBeNull()
  }
})
