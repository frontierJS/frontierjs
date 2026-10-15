// api/src/booth.ts
// A booth is a room for two: where two members who sit across one table go to
// talk. It is an ordinary Room row whose `pairLoId` and `pairHiId` name the
// pair, so everything a room already is — the channel, the line's broadcast,
// the history, retention — is a booth's too, and what makes it private is the
// Room and Message read policies in the schema (Invariant 6), not anything here.
//
// The slug is the pair, lower id first, so either member computes the same one
// and the second to sit finds the row the first made.

import { BadRequest, NotFound } from '@frontierjs/junction'

type Db = { asSystem: () => any }

export const boothSlug = (a: number, b: number): string => `booth-${Math.min(a, b)}-${Math.max(a, b)}`

/**
 * The booth for `me` and `them`, made if this is the first time they have sat
 * across from each other. The partner must be a member who is not banned: a
 * banned one is nobody's row to everyone else, and a booth with them would be
 * a room one side can never read.
 */
export async function boothFor (db: Db, me: number, them: unknown): Promise<{ id: number, slug: string, name: string, pairLoId: number, pairHiId: number }> {
  if (!Number.isInteger(them) || (them as number) < 1) throw new BadRequest('A booth is for a member id')
  if (them === me) throw new BadRequest('A booth is for two')
  const sys = db.asSystem()
  const other = await sys.member.findFirst({ where: { id: them }, select: { nick: true, bannedAt: true } })
  if (!other || other.bannedAt) throw new NotFound('Nobody sits there')

  const slug = boothSlug(me, them as number)
  const found = () => sys.room.findFirst({ where: { slug } })
  const row = await found()
  if (row) return row
  try {
    return await sys.room.create({
      data: { slug, name: 'A booth', pairLoId: Math.min(me, them as number), pairHiId: Math.max(me, them as number) },
    })
  } catch (e) {
    // Both of them sat in the same instant and the other call made it first.
    const raced = await found()
    if (raced) return raced
    throw e
  }
}
