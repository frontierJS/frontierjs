// api/src/townhall.ts
// The town hall as the server reads it (`IDEAS/haven.md` Phase 15): the room
// it is, and the ideas that stand in it -- `web/src/townhall.data.json`,
// written by `bun run townhall` from `IDEAS/overview.md`. The server reads the
// file the hall is drawn from, as `world.ts` reads a scene's `world.json`, so a
// vote can name only a delegate a screen can walk up to.

import { readFileSync } from 'node:fs'

/** The hall's Room slug, and so its channel's room. */
export const HALL = 'townhall'

type Wave = { n: number, name: string, ideas: Array<{ id: string }> }

let ideas: Set<string> | null = null

/** Every idea standing in the hall, read once. */
export function hallIdeas (): Set<string> {
  if (!ideas) {
    const waves = JSON.parse(readFileSync(new URL('../../web/src/townhall.data.json', import.meta.url), 'utf8')) as Wave[]
    ideas = new Set(waves.flatMap(w => w.ideas.map(i => i.id)))
  }
  return ideas
}

/** Each idea's count, aye and nay, over the rows a caller may read. */
export function tallyOf (rows: Array<{ idea: string, aye: boolean }>): Record<string, { aye: number, nay: number }> {
  const out: Record<string, { aye: number, nay: number }> = {}
  for (const r of rows) {
    const t = out[r.idea] ??= { aye: 0, nay: 0 }
    if (r.aye) t.aye++
    else t.nay++
  }
  return out
}
