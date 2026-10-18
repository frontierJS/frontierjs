// src/pieces/workshop.js — where each bench of the workshop stands
// (`layoutWorkshop`). A package with open issues has a bench with its ledger
// piled above it; one with none has no table to take room and is listed in a
// row along the bottom under `(no work)`. The benches stand in rows of
// COLUMNS on one line, so every column and every row lines up; they are
// ranked by their tallest pile and dealt into rows in that order, so the
// tall piles share a row and a short one never pays for a tall neighbour,
// and within a row they read alphabetically. Nothing is allotted by hand: a
// package that gains issues may move up a row.
import { piece } from './index.js'
import { BENCH_WIDTH, namedBench } from './bench.js'
import { ledgerBlock, PILE } from './ledger.js'

/** The taskmaster's desk, along the bottom by the door. Its name is a light like a bench's, but it is no `bench`: no worker is seated at it. */
export const deskPiece = piece('taskmaster', '[ taskmaster ]', 'wnnnnnnnnnnnnw', { spots: { keeper: { dx: 7, dy: 1 } } })

/** Benches across the room. */
const COLUMNS = 6

/** Cells between two columns, and the margin either side of them. */
const AISLE = 3
const MARGIN = 4

/** Rows from a bench to the next ledger below it: the workers' row, the line that reads a worker, and nothing else. */
const BELOW = 3

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0)

/** The key to the piles' colors, by the door, with the whole tree's count beside each severity. */
export function legendPiece(ledger) {
  let art = '[ open issues:'
  let mask = 'w wwww wwwwwww'
  for (const s of ['S1', 'S2', 'S3', 'S4']) {
    const n = String(Object.values(ledger).reduce((sum, counts) => sum + counts[s], 0))
    const c = s[1]
    art += `  ━ ${s} ${n} `
    mask += `  ${c} ww ${c.repeat(n.length)} `
  }
  return piece('legend', art + ']', mask + 'w')
}

/**
 * @param {Record<string, { S1: number, S2: number, S3: number, S4: number }>} ledger
 * @returns {{ width: number, height: number, desk: { piece: object, x: number, y: number }, benches: { name: string, bench: object, ledger: object, x: number, y: number }[], idle: { name: string, bench: object, x: number, y: number }[], listing: { x: number, y: number } | null, legend: { piece: object, x: number, y: number }, door: { x: number, y: number }, spawn: { x: number, y: number } }}
 */
export function layoutWorkshop(ledger) {
  const names = Object.keys(ledger).sort()
  const busy = names.filter((n) => total(ledger[n]) > 0)
  const pitch = BENCH_WIDTH + AISLE
  const width = MARGIN + COLUMNS * pitch

  const rowsOf = (name) => Math.max(...Object.values(ledger[name]).map((n) => Math.ceil(n / PILE)))
  const ranked = busy.sort((a, b) => rowsOf(b) - rowsOf(a) || a.localeCompare(b))
  const benches = []
  let y = 1
  for (let i = 0; i < ranked.length; i += COLUMNS) {
    const row = ranked.slice(i, i + COLUMNS).sort()
    const rows = Math.max(...row.map(rowsOf))
    const line = y + rows
    row.forEach((name, col) => {
      benches.push({ name, bench: namedBench(name, BENCH_WIDTH, total(ledger[name])), ledger: ledgerBlock(name, ledger[name], rowsOf(name)), x: MARGIN + col * pitch, y: line })
    })
    y = line + BELOW
  }

  // The no-work row: its heading, then a bench just wide enough for each name, wrapping at the wall.
  const idle = []
  const idleNames = names.filter((n) => !busy.includes(n))
  const heading = '(no work)'
  let x = MARGIN
  let listing = null
  if (idleNames.length) {
    listing = { x, y }
    x += heading.length + 2
    for (const name of idleNames) {
      const w = name.length + 4
      if (x + w > width - AISLE) { x = MARGIN; y += BELOW }
      idle.push({ name, bench: namedBench(name, w), x, y })
      x += w + 2
    }
    y += 2
  }

  // The desk, the row for his figure under it and the row he speaks on.
  const desk = { piece: deskPiece, x: MARGIN, y: listing ? y + 1 : y }
  y = desk.y + BELOW

  const height = y + 3
  return {
    width,
    height,
    benches,
    idle,
    desk,
    listing,
    heading: listing && piece('heading', heading, 'w'.repeat(heading.length)),
    legend: { piece: legendPiece(ledger), x: MARGIN + 12, y: height - 2 },
    door: { x: MARGIN, y: height - 1 },
    spawn: { x: MARGIN, y: height - 2 },
  }
}
