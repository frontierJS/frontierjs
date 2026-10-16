// Fishing off the pier (`IDEAS/haven.md` § the fishing pier, `fishing.ts`):
// `cast` rolls what bites against the server's almanac and puts it in the
// caster's pack; `feed` hands a fish from it to an animal in reach. The caller
// must stand in the room's presence -- presence is where they are, so a call
// names no cell. What only the caller sees is the answer; what an animal does
// is the room's, told as an `animal` event, since every screen draws it.
import { randomInt } from 'node:crypto'

import { createService, rateLimitHook, $, BadRequest, TooManyRequests } from '@frontierjs/junction'
import type { Channel } from '@frontierjs/junction'

import type { HavenApp } from '../app.ts'
import { biteMs, canFeed, castInto, castLine, EATERS, FISH, landedLine, THIEF, WATER } from '../fishing.ts'
import { isItem, ITEMS } from '../inventory.ts'
import type { ItemName } from '../inventory.ts'
import type { Trace } from '../memory.ts'
import { pacerNow } from '../pacer.ts'
import { roomChannelName } from '../rooms.ts'
import { pieceAt, worldFor } from '../world.ts'
import type { SceneWorld } from '../world.ts'
import { almanacAt } from '../../../web/src/sky.js'

type Roster = { localPresence: (channel: string) => Array<{ userId: string | number, meta: Record<string, unknown> }> }
type PondApp = HavenApp & { channel: (name: string) => Channel, channels: Roster }

export function createFishingService (app: HavenApp) {
  const a = app as PondApp

  /** The caller, the room they stand in and their cell -- or the refusal that says which is missing. */
  async function standing (verb: string) {
    const me = Number(($.auth?.user as { userId?: string } | undefined)?.userId)
    if (!Number.isInteger(me)) throw new BadRequest(`Walk in first: nobody is ${verb}`)
    const { roomId } = ($.data ?? {}) as { roomId?: unknown }
    const row = await ($.db as any).room.findFirst({ where: { id: roomId }, select: { id: true, slug: true } })
    if (!row) throw new BadRequest('No such room')
    const channel = roomChannelName(row.id)
    const mine = a.channels.localPresence(channel).find(m => Number(m.userId) === me)
    if (!mine) throw new BadRequest('Stand in the room first')
    const { x, y, facing } = mine.meta as { x?: number, y?: number, facing?: unknown }
    return { me, channel, world: worldFor(row.slug), x, y, facing }
  }

  /** Where the pacer `name` is drawn now, on every screen: null when the scene has none, it is out of its hours or sky, or a bolt scared it off. */
  function animalAt (channel: string, world: SceneWorld | null, name: string, ms: number) {
    const spec = world?.pacers.find(p => p.name === name)
    if (!spec) return null
    const s = a.memory.live(channel, 'spooked').find(t => t.id === name)
    return pacerNow(spec, ms, s && { at: s.at, dir: s.dir, width: world!.width })
  }

  const nickOf = async (me: number): Promise<string> =>
    (await ($.db as any).member.findFirst({ where: { id: me }, select: { nick: true } }))?.nick ?? 'someone'

  const told = (t: Trace) => ({ kind: t.kind, x: t.x, y: t.y, id: t.id, at: t.at, until: t.until, ...(t.dir && { dir: t.dir }) })

  return createService({
    model:   'Member',
    methods: ['cast', 'feed'],
    hooks: {
      before: {
        // The cast's wait is the real bound (`CAST_MS`); this keeps a loop of refused calls cheap.
        cast: [rateLimitHook({ max: 10, window: '10s', message: 'Slow down' })],
        feed: [rateLimitHook({ max: 5, window: '10s', message: 'Slow down -- it is still eating' })],
      },
    },

    /** `{ roomId }` -- answers `{ caught, line, at, biteMs, held?, thief? }`: what came up, the caster's line, the water cell the float sits on and for how long. */
    async cast () {
      const { me, channel, world, x, y, facing } = await standing('fishing')
      const at = world && x !== undefined && y !== undefined
        ? castInto((cx, cy) => WATER.has(pieceAt(world, cx, cy) ?? ''), x, y, facing)
        : null
      if (!at) throw new BadRequest('Stand at the water\'s edge to fish -- the pier at the docks')

      const wait = a.casts.cast(me)
      if (wait > 0) throw new TooManyRequests(`Your line is still out for ${Math.ceil(wait / 100) / 10}s`)

      const now    = Date.now()
      const caught = castLine(almanacAt(now), pieceAt(world!, at.x, at.y))
      // The answer is not a Member row for the bus to announce.
      $.dispatch = false
      const thief = caught === 'nothing' ? animalAt(channel, world, THIEF.name, now) : null
      if (thief && randomInt(0, THIEF.odds) === 0) {
        // It flies off with the bait, away from the caster, and is gone from every screen until the trace ends.
        const dir = x === undefined || x === thief.x ? undefined : x > thief.x ? -1 : 1
        const laid = a.memory.add(channel, { kind: 'spooked', x: thief.x, y: thief.y, id: THIEF.name, by: me, ...(dir && { dir }) })
        a.channel(channel).send('animal', { id: THIEF.name, by: me, line: `a gull makes off with ${await nickOf(me)}'s bait`, laid: told(laid) })
        return { caught, line: THIEF.line, at, biteMs: biteMs(), thief: THIEF.name }
      }
      const held = isItem(caught) ? a.inventory.give(me, caught) : undefined
      return { caught, line: landedLine(caught, held), at, biteMs: biteMs(), ...(held !== undefined && { held }) }
    },

    /** `{ roomId, fish? }` -- hands one fish (the first held, unless named) to the eater in reach. Answers `{ animal, fish, line, held }`. */
    async feed () {
      const { me, channel, world, x, y } = await standing('feeding')
      const { fish: named } = ($.data ?? {}) as { fish?: unknown }
      if (named !== undefined && !FISH.includes(named as ItemName)) throw new BadRequest(`No fish is called ${String(named)}; there are ${FISH.join(', ')}`)
      const now = Date.now()
      const animal = x === undefined || y === undefined ? undefined : Object.keys(EATERS).find(name => {
        const at = animalAt(channel, world, name, now)
        return at && canFeed(at, x, y)
      })
      if (!animal) throw new BadRequest('Nothing here will take a fish -- stand beside the tavern cat')
      const fish = (named as ItemName | undefined) ?? FISH.find(f => a.inventory.count(me, f) > 0)
      if (!fish || !a.inventory.take(me, fish)) throw new BadRequest(fish ? `You have no ${ITEMS[fish].many}` : 'You have no fish -- /fish at the water first')
      $.dispatch = false
      const what = `${/^[aeiou]/.test(fish) ? 'an' : 'a'} ${fish}`
      a.channel(channel).send('animal', { id: animal, by: me, line: `${await nickOf(me)} feeds the ${animal} ${what} -- ${EATERS[animal]}` })
      return { animal, fish, line: `you feed the ${animal} ${what} -- ${EATERS[animal]}`, held: a.inventory.count(me, fish) }
    },
  })
}
