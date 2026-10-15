// api/src/inventory.ts
// What a member carries (`IDEAS/haven.md` 9.9). The API holds it in memory per
// member, like the room's memory and the bolt's cooldown (`app.inventory` —
// `app.ts`): a restart refills every quiver, which a game of arrows can afford,
// and no step here adds a model. It is the member's, not the room's, so it
// follows them through a door.
//
// A count below its `start` earns one back every `regenMs`, worked out when it
// is next read rather than on a timer, so a quiver nobody looks at costs
// nothing. Picking something up (`give`) may lift a count to `cap`, above the
// start, and a count above the start does not decay.

export const ITEMS = {
  arrow: { start: 10, cap: 20, regenMs: 20_000 },
} as const satisfies Record<string, { start: number, cap: number, regenMs: number }>

export type ItemName = keyof typeof ITEMS
export type Held = Record<ItemName, number>

/** What a shot spends: a bolt one arrow, `dd` one each way. */
export const ARROWS = { bolt: 1, volley: 4 } as const

export const isItem = (v: unknown): v is ItemName => typeof v === 'string' && Object.hasOwn(ITEMS, v)

type Slot = { n: number, since: number }

export function createInventories ({ now = Date.now }: { now?: () => number } = {}) {
  const slots = new Map<string, Slot>()
  const key = (member: number, item: ItemName) => `${member}:${item}`

  const read = (member: number, item: ItemName): Slot => {
    const t = now()
    const rule = ITEMS[item]
    const slot = slots.get(key(member, item)) ?? { n: rule.start, since: t }
    if (slot.n < rule.start) {
      const gained = Math.floor((t - slot.since) / rule.regenMs)
      slot.n = Math.min(rule.start, slot.n + gained)
      slot.since = slot.n >= rule.start ? t : slot.since + gained * rule.regenMs
    } else slot.since = t
    slots.set(key(member, item), slot)
    return slot
  }

  return {
    count: (member: number, item: ItemName): number => read(member, item).n,
    /** Everything held, a count each — what `/inv` lists. */
    held: (member: number): Held => Object.fromEntries((Object.keys(ITEMS) as ItemName[]).map(i => [i, read(member, i).n])) as Held,
    /** Spend `n` of an item: false, changing nothing, when fewer are held. */
    take (member: number, item: ItemName, n = 1): boolean {
      const slot = read(member, item)
      if (slot.n < n) return false
      slot.n -= n
      return true
    },
    /** Add `n` of an item up to its cap; returns the count now held. */
    give (member: number, item: ItemName, n = 1): number {
      const slot = read(member, item)
      slot.n = Math.min(ITEMS[item].cap, slot.n + n)
      return slot.n
    },
  }
}

export type Inventories = ReturnType<typeof createInventories>
