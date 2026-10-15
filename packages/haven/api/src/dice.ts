// api/src/dice.ts
// The dice (`IDEAS/haven.md` 9.1): `/roll 2d6` is a line the SERVER rolled, so
// nobody can say a number they did not throw.
//
// A roll cannot be a member's own line with a number in it: a member can type
// any body, so "jo rolls 2d6: 12" would be as good as a throw. It is said by
// the dice instead, a Member with no key as the crier is -- no login can be
// it, and a first login asking for the nick is refused -- through
// `messages.create` inside `app.runAs`, so the line is broadcast and
// rate-limited like any member's. Whatever the dice say is therefore a roll.
//
// The client imports `DICE` and `parseRoll` (`Dice.mesa`), so this file imports
// types only.

import { randomInt } from 'node:crypto'

import type { App } from '@frontierjs/junction'

/** The dice's nick. A first login asking for it is refused as taken. */
export const DICE = 'dice'

/** The dice's `publicKey`: not a key, so no signature verifies under it. */
const KEYLESS = 'none:dice'

/** The most dice in one roll, and the most faces on one. */
export const MAX_DICE  = 10
export const MAX_SIDES = 100

type Db = { asSystem: () => any }

export type Roll = { count: number, sides: number }

/** `2d6`, `d20`, `3` (three six-sided dice is not meant, so a bare number is `1dN`); null for anything else. */
export function parseRoll (spec: string): Roll | null {
  const m = /^(\d{1,2})?d(\d{1,3})$/i.exec(String(spec).trim())
  if (!m) return null
  const count = m[1] === undefined ? 1 : Number(m[1])
  const sides = Number(m[2])
  if (count < 1 || count > MAX_DICE || sides < 2 || sides > MAX_SIDES) return null
  return { count, sides }
}

/** The throw: each die from the OS's random source, not `Math.random`, since a roll is a promise nobody can predict. */
export const throwDice = ({ count, sides }: Roll): number[] =>
  Array.from({ length: count }, () => randomInt(1, sides + 1))

export function rollLine (nick: string, { count, sides }: Roll, dice: number[]): string {
  const total = dice.reduce((a, b) => a + b, 0)
  return `${nick} rolls ${count}d${sides}: ${count === 1 ? total : `${dice.join(' + ')} = ${total}`}`
}

/** The dice's member id, made on first asking. */
export async function ensureDice (db: Db): Promise<number> {
  const sys = db.asSystem()
  const found = await sys.member.findFirst({ where: { publicKey: KEYLESS }, select: { id: true } })
  if (found) return found.id
  const row = await sys.member.create({ data: { nick: DICE, publicKey: KEYLESS }, select: { id: true } })
  return row.id
}

export function createDice (app: App, db: Db) {
  let id: Promise<number> | null = null
  const diceId = () => (id ??= ensureDice(db).catch((e) => { id = null; throw e }))

  return {
    /** Throws `roll` for `nick` and says it in `roomId`. Answers what was said. */
    async roll (roomId: number, nick: string, roll: Roll): Promise<{ body: string, dice: number[], total: number }> {
      const dice = throwDice(roll)
      const body = rollLine(nick, roll, dice)
      await app.runAs(String(await diceId()), () => app.service('messages').create({ roomId, body }))
      return { body, dice, total: dice.reduce((a, b) => a + b, 0) }
    },
  }
}

export type Dice = ReturnType<typeof createDice>
