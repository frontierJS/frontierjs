// api/src/keyless.ts
// The members no one can be: a Member row with no key, which speaks through
// `messages.create` inside `app.runAs` (the crier, `crier.ts`; the dice,
// `dice.ts`). One list and one maker, so a new voice is a line here and the
// login refuses its nick without being told.
//
// The `root` is no chain root, so no login reaches it. Imports
// nothing: the client imports the nicks.

type Db = { asSystem: () => any }

/** Every keyless voice, by role. A member row naming one of these nicks is refused as held. */
export const VOICES = { crier: 'crier', dice: 'dice' } as const

export const isVoice = (nick: string): boolean => (Object.values(VOICES) as string[]).includes(nick)

/** The member id of the voice `nick`, made on first asking. */
export async function ensureVoice (db: Db, nick: string): Promise<number> {
  const sys   = db.asSystem()
  const key   = `none:${nick}`
  const found = await sys.member.findFirst({ where: { root: key }, select: { id: true } })
  if (found) return found.id
  const row = await sys.member.create({ data: { nick, root: key }, select: { id: true } })
  return row.id
}
