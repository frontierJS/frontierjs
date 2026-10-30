// shared/dice.ts
// What a roll may be and how `/roll 2d6` is read: `Dice.mesa` checks a spec
// before sending it and the dice service checks it again before throwing, so
// both sides must agree on the limits. The throw itself is `api/src/dice.ts`:
// it draws from the OS's random source, which is no business of shared code.

/** The most dice in one roll, and the most faces on one. */
export const MAX_DICE  = 10
export const MAX_SIDES = 100

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
