// api/src/crier.ts
// Haven's crier (`IDEAS/haven.md` 8.3): a system member who announces a
// member's first walk-in and a release, in the square.
//
// The crier is a Member row with no key, so no login can be it, and it speaks
// through `messages.create` inside `app.runAs(itsId)` rather than writing a row
// as the system: the service call is the one place a write is broadcast
// (Invariant 4), so a line written straight through `asSystem()` would be in
// the history and on nobody's screen. Speaking as a member also puts it under
// the line rate limit, which is the guard it needs: every key minted in a loop
// is a first walk-in, and without the limit a spammer would flood the square
// through the crier's mouth. A welcome past the limit is dropped, not queued.
//
// The client imports `CRIER` and `CRY_MS` (`Crier.mesa`), so this file
// imports types only.

import type { App } from '@frontierjs/junction'

/** The crier's nick. A first login asking for it is refused as taken. */
export const CRIER = 'crier'

/** How long a cry stays over the square, in ms. */
export const CRY_MS = 8000

/** The crier's `publicKey`: not a key, so no signature verifies under it. */
const KEYLESS = 'none:crier'

type Db = { asSystem: () => any }

export const welcomeLine = (nick: string): string => `Hear ye! ${nick} walks into Haven for the first time.`
export const releaseLine = (version: string): string => `Hear ye! Haven ${version} has landed.`

/** The crier's member id, made on first asking. */
export async function ensureCrier (db: Db): Promise<number> {
  const sys = db.asSystem()
  const found = await sys.member.findFirst({ where: { publicKey: KEYLESS }, select: { id: true } })
  if (found) return found.id
  const row = await sys.member.create({ data: { nick: CRIER, publicKey: KEYLESS }, select: { id: true } })
  return row.id
}

/** `room` is the slug the crier stands in. */
export function createCrier (app: App, db: Db, room: string) {
  let id: Promise<number> | null = null
  const crierId = () => (id ??= ensureCrier(db).catch((e) => { id = null; throw e }))

  const roomId = async (): Promise<number | null> =>
    (await db.asSystem().room.findFirst({ where: { slug: room }, select: { id: true } }))?.id ?? null

  async function cry (body: string): Promise<boolean> {
    const at = await roomId()
    if (at == null) return false
    await app.runAs(String(await crierId()), () => app.service('messages').create({ roomId: at, body }))
    return true
  }

  return {
    /** A member's first walk-in. A cry the rate limit refuses is dropped. */
    async welcome (nick: string): Promise<void> {
      try { await cry(welcomeLine(nick)) }
      catch (e) { console.warn(`[haven] crier: no welcome for ${nick}: ${(e as Error).message}`) }
    },

    /**
     * A release, once per version: said at boot unless the room already holds
     * the line. Retention keeps a room's newest 500 lines, so a version whose
     * cry has rolled off is cried again at the next restart.
     */
    async release (version: string): Promise<boolean> {
      const body = releaseLine(version)
      try {
        const memberId = await crierId()
        const said = await db.asSystem().message.findFirst({ where: { memberId, body, roomId: await roomId() }, select: { id: true } })
        if (said) return false
        return await cry(body)
      } catch (e) {
        // A server that will not boot over a greeting: a database where a
        // member already holds the nick makes no crier.
        console.warn(`[haven] crier: no release cry for ${version}: ${(e as Error).message}`)
        return false
      }
    },
  }
}

export type Crier = ReturnType<typeof createCrier>
