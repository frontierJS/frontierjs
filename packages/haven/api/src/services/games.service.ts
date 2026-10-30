// The checkers a pair plays across their table (`IDEAS/haven.md` 9.1b). The
// game is a row this service owns: a client never writes the board, it says a
// path, and the rules in `checkers.ts` decide whether that is a move. The
// caller must be one of the booth's two members, which the Room read policy
// already says -- a stranger's `room.findFirst` for a booth is no row.
//
// The writes go through the system (`Game` is `@@gate(3.8.8.8)`), after the
// caller has been checked against the game's own colors, never against what the
// payload says about who they are. The pair is told by name on the booth's
// channel, `checkers`, and each screen asks `get` again, so what a screen
// reads is the Game read policy and not what a frame carried.
import { createService, $, BadRequest, NotFound } from '@frontierjs/junction'
import { rateLimitHook } from '@frontierjs/junction/hooks'
import type { Channel } from '@frontierjs/junction'

import type { HavenApp } from '../app.ts'
import { START, applyMove, other, pathText, squareIndex, winnerOf } from '#shared/checkers.ts'
import type { Side } from '#shared/checkers.ts'
import { roomChannelName } from '../rooms.ts'

type GamesApp = HavenApp & { channel: (name: string) => Channel }

type Booth = { id: number, pairLoId: number | null, pairHiId: number | null }
type Row   = { id: number, roomId: number, redId: number, blackId: number, board: string, turn: Side, winnerId: number | null, last: string | null }

/** `c3` as a board place, case-insensitive; null for anything else. */
const squareOf = (s: string): number | null => squareIndex(s.trim().toLowerCase())

const COLUMNS = { id: true, roomId: true, redId: true, blackId: true, board: true, turn: true, winnerId: true, last: true } as const

// Two moves from one member in one instant would both read the same board.
// One process serves a room, so a chain per room is the whole lock. Keyed by
// app, because two apps in one process number their rooms from 1 each.
const chainsOf = new WeakMap<object, Map<number, Promise<unknown>>>()
const alone = <T>(roomId: number, fn: () => Promise<T>): Promise<T> => {
  const app = $.app
  let chains = chainsOf.get(app)
  if (!chains) chainsOf.set(app, chains = new Map())
  const run = (chains.get(roomId) ?? Promise.resolve()).then(fn, fn)
  chains.set(roomId, run.catch(() => {}))
  return run
}

const caller = (): number => {
  const me = Number(($.user as { id?: string } | undefined)?.id)
  if (!Number.isInteger(me)) throw new BadRequest('Walk in first: nobody is playing')
  return me
}

/** The caller's booth for `roomId`, or throws: a room that is not theirs is no row. */
async function boothOf (roomId: unknown): Promise<Booth> {
  const room = await ($.db as any).room.findFirst({ where: { id: roomId }, select: { id: true, pairLoId: true, pairHiId: true } }) as Booth | null
  if (!room) throw new NotFound('No such table')
  if (room.pairLoId === null || room.pairHiId === null) throw new BadRequest('Checkers is played across a table, in a booth')
  return room
}

const told = (roomId: number) => ($.app as GamesApp).channel(roomChannelName(roomId)).send('checkers', { roomId })

export default createService({
  model:   'Game',
  methods: ['get', 'start', 'move', 'resign'],
  hooks: {
    before: {
      start:  [rateLimitHook({ max: 5, window: '10s', message: 'Slow down' })],
      move:   [rateLimitHook({ max: 10, window: '10s', message: 'Slow down — ten moves in ten seconds' })],
      resign: [rateLimitHook({ max: 5, window: '10s', message: 'Slow down' })],
    },
  },

  /** `{ roomId }` -- the booth's game as it stands, or null when none has been begun. Read through the caller's client. */
  async get () {
    caller()
    const { roomId } = ($.data ?? {}) as { roomId?: unknown }
    const room = await boothOf(roomId)
    $.dispatch = false
    return await ($.db as any).game.findFirst({ where: { roomId: room.id }, select: COLUMNS }) as Row | null
  },

  /** `{ roomId }` -- begins a game, the caller red and moving first. Refused while one is on. */
  async start () {
    const me   = caller()
    const db   = $.db as any
    const room = await boothOf(($.data as { roomId?: unknown } | undefined)?.roomId)
    const them = room.pairLoId === me ? room.pairHiId! : room.pairLoId!
    return alone(room.id, async () => {
      const sys = db.asSystem()
      const was = await sys.game.findFirst({ where: { roomId: room.id }, select: COLUMNS }) as Row | null
      if (was && was.winnerId === null) throw new BadRequest('A game is on: finish it or /resign')
      const fresh = { redId: me, blackId: them, board: START, turn: 'r', winnerId: null, last: null }
      const row = was
        ? await sys.game.update({ where: { id: was.id }, data: fresh, select: COLUMNS })
        : await sys.game.create({ data: { roomId: room.id, ...fresh }, select: COLUMNS })
      $.dispatch = false
      told(room.id)
      return row as Row
    })
  },

  /** `{ roomId, path }` -- `path` the squares of one move, `['c3', 'd4']` or a chain of captures. Answers the game after it. */
  async move () {
    const me   = caller()
    const db   = $.db as any
    const { roomId, path } = ($.data ?? {}) as { roomId?: unknown, path?: unknown }
    const room = await boothOf(roomId)
    if (!Array.isArray(path) || path.some(s => typeof s !== 'string')) throw new BadRequest('A move is a list of squares, like c3 d4')
    const squares = (path as string[]).map(s => squareOf(s))
    if (squares.some(s => s === null)) throw new BadRequest('A square is a file a to h and a rank 1 to 8')
    return alone(room.id, async () => {
      const sys  = db.asSystem()
      const game = await sys.game.findFirst({ where: { roomId: room.id }, select: COLUMNS }) as Row | null
      if (!game) throw new BadRequest('No game here: /checkers begins one')
      if (game.winnerId !== null) throw new BadRequest('That game is over: /checkers begins another')
      const side: Side | null = game.redId === me ? 'r' : game.blackId === me ? 'b' : null
      if (!side) throw new BadRequest('You are not in this game')
      if (side !== game.turn) throw new BadRequest('Not your move')
      let board: string
      try { board = applyMove(game.board, side, squares as number[]) }
      catch (e) { throw new BadRequest((e as Error).message) }
      const next  = other(side)
      const won   = winnerOf(board, next)
      const row = await sys.game.update({
        where: { id: game.id },
        data:  { board, turn: next, last: pathText(squares as number[]), winnerId: won ? (won === 'r' ? game.redId : game.blackId) : null },
        select: COLUMNS,
      })
      $.dispatch = false
      told(room.id)
      return row as Row
    })
  },

  /** `{ roomId }` -- gives the game up: the other member wins it. */
  async resign () {
    const me   = caller()
    const db   = $.db as any
    const room = await boothOf(($.data as { roomId?: unknown } | undefined)?.roomId)
    return alone(room.id, async () => {
      const sys  = db.asSystem()
      const game = await sys.game.findFirst({ where: { roomId: room.id }, select: COLUMNS }) as Row | null
      if (!game || game.winnerId !== null) throw new BadRequest('There is no game to give up')
      if (game.redId !== me && game.blackId !== me) throw new BadRequest('You are not in this game')
      const row = await sys.game.update({ where: { id: game.id }, data: { winnerId: game.redId === me ? game.blackId : game.redId, last: 'resigned' }, select: COLUMNS })
      $.dispatch = false
      told(room.id)
      return row as Row
    })
  },
})
