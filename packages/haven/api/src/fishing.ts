// api/src/fishing.ts
// Fishing off the pier (`IDEAS/haven.md` § the fishing pier): `/fish` is a
// roll the SERVER makes, as the dice are, and what bites is read off the
// almanac -- the hour, the moon, the season, the weather and the cold -- so a
// moonfish comes up only on a full-moon night, and most often in the snow.
//
// The almanac is the server's clock, never the caster's screen: `/weather`
// and `/season` hold one screen's sky, and a hold that changed the catch would
// let a member order their own fish.
//
// What is caught goes into the member's inventory (`inventory.ts`), each kind
// an item of its own; the nothing and the boot are thrown back. The client
// is told the float's cell and its wait in the answer, so it imports nothing
// from here.

import { randomInt } from 'node:crypto'

import { STEP, isFacing } from './facing.ts'
import type { Facing } from './facing.ts'
import type { ItemName } from './inventory.ts'

/** The pieces a line may be cast into: the docks' water, the glade's and the lane's ponds, and the ravine's river. */
export const WATER = new Set(['water', 'pond', 'river'])

/** One cast per member per this long, a bite included. */
export const CAST_MS = 5000

/** The float sits on the water this long before the line comes up: the server's dice, within these. */
export const BITE_MS = { min: 1200, max: 3200 }

/** The part of the almanac (`web/src/sky.js`, `almanacAt`) a fish answers to. */
export interface Sky {
  darkness: number
  season:   string
  weather:  string
  temp:     number
  moon:     { light: number }
}

type Landed = ItemName | 'nothing' | 'boot'

const night = (s: Sky) => s.darkness === 1
const wet   = (s: Sky) => s.weather === 'rain' || s.weather === 'storm'

/**
 * What may come up, each weighed against the sky at the cast. A weight of 0
 * is a fish that is not out; the list's order is the tie-break nobody sees.
 */
export const CATCH: { what: Landed, weight: (s: Sky) => number }[] = [
  { what: 'nothing',  weight: () => 5 },
  { what: 'boot',     weight: () => 2 },
  { what: 'minnow',   weight: () => 6 },
  { what: 'perch',    weight: s => night(s) ? 1 : 4 },
  { what: 'trout',    weight: s => wet(s) ? 4 : s.season === 'spring' || s.season === 'fall' ? 2 : 1 },
  { what: 'catfish',  weight: s => night(s) ? 4 : s.darkness > 0 ? 1 : 0 },
  { what: 'eel',      weight: s => s.weather === 'storm' ? 3 : night(s) ? 1 : 0 },
  { what: 'pike',     weight: s => s.temp <= 2 ? 3 : 0 },
  { what: 'moonfish', weight: s => night(s) && s.moon.light === 1 ? (s.weather === 'snow' ? 4 : 1) : 0 },
]

/** The catch `roll` lands on, `roll` in `[0, total)` of the sky's weights. */
export function catchOf (sky: Sky, roll: number): Landed {
  let left = roll
  for (const c of CATCH) {
    const w = c.weight(sky)
    if (left < w) return c.what
    left -= w
  }
  return 'nothing'
}

/** The weights' sum under `sky`: what a roll is drawn below. */
export const weightOf = (sky: Sky): number => CATCH.reduce((n, c) => n + c.weight(sky), 0)

/** Every fish, in the order `/feed` offers them when none is named: what `CATCH` lands that a pack holds. */
export const FISH = CATCH.map(c => c.what).filter((w): w is ItemName => w !== 'nothing' && w !== 'boot')

/** The pacer that takes a missed cast's bait while it is in the scene, one miss in `odds`. */
export const THIEF = { name: 'gull', odds: 3, line: 'a gull swoops down and makes off with your bait' }

/** The pacers that take a fish from a member's hand, and what each does with it. */
export const EATERS: Record<string, string> = {
  cat:   'it purrs and winds round your legs',
  otter: 'it rolls onto its back to eat it',
  gull:  'it gulps it down whole',
}

/** How near a figure stands to an eater's sprite to feed it: cells off either end, rows above or below. */
export const FEED_REACH = 2

/** Whether a figure at `x, y` can reach a sprite drawn at `at`. */
export const canFeed = (at: { x: number, y: number, text: string }, x: number, y: number): boolean =>
  Math.abs(y - at.y) <= FEED_REACH && x >= at.x - FEED_REACH && x < at.x + at.text.length + FEED_REACH

/** The throw, from the OS's random source as the dice's is. */
export const castLine = (sky: Sky): Landed => catchOf(sky, randomInt(0, weightOf(sky)))

/** How long this cast's float sits before the line comes up. */
export const biteMs = (): number => randomInt(BITE_MS.min, BITE_MS.max + 1)

type Water = (x: number, y: number) => boolean

/**
 * The water cell a figure at `x, y` casts into: the cell it faces when that
 * is water, else the first water beside it in `n e s w`, else null -- a cast
 * from anywhere but the water's edge reaches nothing.
 */
export function castInto (isWater: Water, x: number, y: number, facing?: Facing | unknown): { x: number, y: number } | null {
  const ways: Facing[] = isFacing(facing) ? [facing, 'n', 'e', 's', 'w'] : ['n', 'e', 's', 'w']
  for (const f of ways) {
    const c = { x: x + STEP[f].dx, y: y + STEP[f].dy }
    if (isWater(c.x, c.y)) return c
  }
  return null
}

/** What the caster is told the line brought up. */
export function landedLine (what: Landed, held?: number): string {
  if (what === 'nothing') return 'nothing bites -- you reel in an empty hook'
  if (what === 'boot') return 'you reel in an old boot and throw it back'
  const a = /^[aeiou]/.test(what) ? 'an' : 'a'
  return `you catch ${a} ${what}${held === undefined ? '' : ` (${held} in your pack)`}`
}

export function createCasts ({ now = Date.now }: { now?: () => number } = {}) {
  const ready = new Map<number, number>()
  return {
    /** 0 and the cast starts, or the ms until this member may cast again. */
    cast (memberId: number): number {
      const t = now()
      const wait = (ready.get(memberId) ?? 0) - t
      if (wait > 0) return wait
      ready.set(memberId, t + CAST_MS)
      return 0
    },
  }
}

export type Casts = ReturnType<typeof createCasts>
