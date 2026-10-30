// shared/checkers.ts
// The rules of checkers (`IDEAS/haven.md` 9.1b), American: eight by eight, a
// man steps and takes forward, a king both ways, a capture is compulsory and
// one that can go on must, and a man that crowns stops there. Pure and
// importing nothing, because the client reads the same file to parse a move
// and to draw the board -- the server is still the only place a move is
// APPLIED (`services/games.service.ts`).
//
// The board is a 64-character string, rank 8 first and file `a` first within a
// rank, so a square's place in it is `(8 - rank) * 8 + file` and the string
// reads the way a diagram does. `r` and `R` are red's man and king, `b` and `B`
// black's, `.` is empty. Red starts on ranks 1 to 3 and moves first, up the
// board. Every piece lives on a dark square: file (a=0) plus rank odd, so `a1`.

export type Side = 'r' | 'b'

export const FILES = 'abcdefgh'

const COLS = 8

/** `a1` to its place in the board string, or null for anything that is not a square. */
export function squareIndex (name: string): number | null {
  const m = /^([a-h])([1-8])$/.exec(name)
  return m ? (8 - Number(m[2])) * COLS + FILES.indexOf(m[1]!) : null
}

export const squareName = (i: number): string => `${FILES[i % COLS]}${8 - Math.floor(i / COLS)}`

const colOf  = (i: number): number => i % COLS
const rankOf = (i: number): number => 8 - Math.floor(i / COLS)
const at     = (col: number, rank: number): number | null => col < 0 || col > 7 || rank < 1 || rank > 8 ? null : (8 - rank) * COLS + col

export const isDark = (i: number): boolean => (colOf(i) + rankOf(i)) % 2 === 1

/** A fresh board: red below, black above, the two middle ranks empty. */
export const START: string = Array.from({ length: 64 }, (_, i) => {
  if (!isDark(i)) return '.'
  return rankOf(i) <= 3 ? 'r' : rankOf(i) >= 6 ? 'b' : '.'
}).join('')

export const sideOf = (c: string | undefined): Side | null => c === 'r' || c === 'R' ? 'r' : c === 'b' || c === 'B' ? 'b' : null
export const other  = (s: Side): Side => s === 'r' ? 'b' : 'r'
const isKing = (c: string): boolean => c === 'R' || c === 'B'

/** The ranks a piece may move toward: a man one way, a king both. */
const ahead = (c: string): number[] => isKing(c) ? [1, -1] : c === 'r' ? [1] : [-1]

/** The rank where a man of `side` is crowned. */
const CROWN: Record<Side, number> = { r: 8, b: 1 }

type Hop = { to: number, over: number }

/** The captures `piece` could make from `from`, `board` read with its own square empty and `taken` still standing but not capturable twice. */
function jumpsFrom (board: string[], from: number, piece: string, taken: ReadonlySet<number>): Hop[] {
  const side = sideOf(piece)!
  const out: Hop[] = []
  for (const dr of ahead(piece)) for (const dc of [-1, 1]) {
    const over = at(colOf(from) + dc, rankOf(from) + dr)
    const to   = at(colOf(from) + 2 * dc, rankOf(from) + 2 * dr)
    if (over === null || to === null) continue
    if (sideOf(board[over]) !== other(side) || taken.has(over)) continue
    if (board[to] !== '.') continue
    out.push({ to, over })
  }
  return out
}

function stepsFrom (board: string[], from: number, piece: string): number[] {
  const out: number[] = []
  for (const dr of ahead(piece)) for (const dc of [-1, 1]) {
    const to = at(colOf(from) + dc, rankOf(from) + dr)
    if (to !== null && board[to] === '.') out.push(to)
  }
  return out
}

const NONE: ReadonlySet<number> = new Set()

/** Whether `side` has a capture anywhere: when it does, it must take one. */
export function mustCapture (board: string, side: Side): boolean {
  const b = [...board]
  return b.some((c, i) => sideOf(c) === side && jumpsFrom(b, i, c, NONE).length > 0)
}

/** Whether `side` has any move at all; a side without one has lost. */
export function canMove (board: string, side: Side): boolean {
  const b = [...board]
  return b.some((c, i) => sideOf(c) === side && (jumpsFrom(b, i, c, NONE).length > 0 || stepsFrom(b, i, c).length > 0))
}

/** The side that has won on `board` with `toMove` to play, or null while the game goes on. */
export const winnerOf = (board: string, toMove: Side): Side | null => canMove(board, toMove) ? null : other(toMove)

/**
 * `side`'s move along `path` (squares, the piece's own first) applied to
 * `board`. Throws an Error whose message says why not, in words a player reads.
 * A step is two squares. A capture is every landing of the chain, which must go
 * on while it can; a capture open anywhere on the board is the only move.
 */
export function applyMove (board: string, side: Side, path: readonly number[]): string {
  if (path.length < 2) throw new Error('A move is two squares, like c3 d4')
  const b = [...board]
  const from  = path[0]!
  let piece   = b[from]!
  if (sideOf(piece) !== side) throw new Error('That is not your piece')

  if (!mustCapture(board, side)) {
    if (path.length !== 2) throw new Error('Only a capture can go on past the second square')
    const to = path[1]!
    if (!stepsFrom(b, from, piece).includes(to)) throw new Error('A piece steps one square diagonally onto an empty square')
    b[from] = '.'
    b[to]   = !isKing(piece) && rankOf(to) === CROWN[side] ? piece.toUpperCase() : piece
    return b.join('')
  }

  b[from] = '.'
  const taken = new Set<number>()
  let pos = from
  let crowned = false
  for (const to of path.slice(1)) {
    if (crowned) throw new Error('A man that crowns stops there')
    const hop = jumpsFrom(b, pos, piece, taken).find(h => h.to === to)
    if (!hop) throw new Error(taken.size ? 'That is not a capture from there' : 'A capture is open, so you must take it')
    taken.add(hop.over)
    pos = to
    if (!isKing(piece) && rankOf(pos) === CROWN[side]) { piece = piece.toUpperCase(); crowned = true }
  }
  if (!crowned && jumpsFrom(b, pos, piece, taken).length) throw new Error('You must keep capturing: more is open from there')
  for (const i of taken) b[i] = '.'
  b[pos] = piece
  return b.join('')
}

/**
 * What a member typed after `/move`: `c3 d4`, `c3-d4`, `c3xe5xg7`. The squares
 * as board places, or null when it is not a list of two or more squares.
 */
export function parseMove (text: string): number[] | null {
  const t = String(text).trim().toLowerCase()
  if (!/^[a-h][1-8]([\s,>x-]+[a-h][1-8])+$/.test(t)) return null
  return (t.match(/[a-h][1-8]/g) ?? []).map(s => squareIndex(s)!)
}

/** A path as it is said back: `c3-e5-g7`. */
export const pathText = (path: readonly number[]): string => path.map(squareName).join('-')
