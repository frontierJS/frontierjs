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
// The client imports `MAX_DICE`, `MAX_SIDES` and `parseRoll` (`Dice.mesa`) from
// `shared/dice.ts`, so what it needs of a roll never waits on this file's
// junction import.

import type { App } from '@frontierjs/junction'

import type { Roll } from '#shared/dice.ts'

import { ensureVoice, VOICES } from './keyless.ts'

/** The dice's nick. */
export const DICE = VOICES.dice

type Db = { asSystem: () => any }

/** A whole number in `[0, n)` from the OS's random source, redrawn past the last whole multiple of `n` so no face is likelier. */
function below (n: number): number {
  const limit = 2 ** 32 - (2 ** 32 % n)
  const draw  = new Uint32Array(1)
  do crypto.getRandomValues(draw); while (draw[0]! >= limit)
  return draw[0]! % n
}

/** The throw: each die from `below`, not `Math.random`, since a roll is a promise nobody can predict. */
export const throwDice = ({ count, sides }: Roll): number[] =>
  Array.from({ length: count }, () => 1 + below(sides))

export function rollLine (nick: string, { count, sides }: Roll, dice: number[]): string {
  const total = dice.reduce((a, b) => a + b, 0)
  return `${nick} rolls ${count}d${sides}: ${count === 1 ? total : `${dice.join(' + ')} = ${total}`}`
}

export function createDice (app: App, db: Db) {
  let id: Promise<number> | null = null
  const diceId = () => (id ??= ensureVoice(db, DICE).catch((e) => { id = null; throw e }))

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
