// one-to-one.test.ts — the non-owning side of a 1:1 (FJS-563).
//
// `b B?` where B holds the foreign key carries no @relation and no column, and
// is the exact singular counterpart of the plural hasMany back-reference. It
// used to fail the type check and be reported as `unknown type 'B'` for a model
// that IS registered, which sends the reader hunting a model that is plainly
// there. Found by converting three published Prisma schemas — 37 occurrences,
// and the single cause of every `unknown type` error in all three — because
// Prisma requires no label for a 1:1 and whoever writes .lite by hand learns
// the label habit, so no hand-written fixture had ever taken this shape.
//
// The corpus fixtures that found it are only partly committed (licence — see
// fixtures/corpus/README.md), so the guarantee is pinned here.

import { describe, test, expect } from 'bun:test'
import { parse, createClient } from '../src/index.js'

const first = (src: string) => {
  const r = parse(src)
  return r.valid ? null : String(r.errors[0])
}

describe('a one-to-one back-reference', () => {
  test('pairs unlabelled, both optional and required', () => {
    expect(first(`model A { id String @id
      b B? }
    model B { id String @id
      aId String @unique
      a A @relation(fields: [aId], references: [id]) }`)).toBeNull()

    expect(first(`model A { id String @id
      b B }
    model B { id String @id
      aId String @unique
      a A @relation(fields: [aId], references: [id]) }`)).toBeNull()
  })

  test('accepts a foreign key that is unique by being the primary key', () => {
    // calcom's CalVideoSettings — `eventTypeId Int @id` is the FK and the PK.
    expect(first(`model A { id Int @id
      b B? }
    model B { aId Int @id
      a A @relation(fields: [aId], references: [id]) }`)).toBeNull()
  })

  test('accepts uniqueness declared at model level, exactly', () => {
    expect(first(`model A { id String @id
      b B? }
    model B { id String @id
      aId String
      a A @relation(fields: [aId], references: [id])
      @@unique([aId]) }`)).toBeNull()

    // Unique on (aId, z) says nothing about aId alone.
    expect(first(`model A { id String @id
      b B? }
    model B { id String @id
      aId String
      z String
      a A @relation(fields: [aId], references: [id])
      @@unique([aId, z]) }`)).toContain('is not unique')
  })

  test('pairs a composite foreign key against a composite @@unique', () => {
    // calcom's Host / HostLocation.
    expect(first(`model A { userId Int
      eventTypeId Int
      id String @id
      loc L? }
    model L { id String @id
      userId Int
      eventTypeId Int
      a A @relation(fields: [userId, eventTypeId], references: [userId, eventTypeId])
      @@unique([userId, eventTypeId]) }`)).toBeNull()
  })

  test('a non-unique foreign key is refused as a to-many written as a to-one', () => {
    // The read would answer one of many rows arbitrarily, so it is named
    // rather than allowed.
    const err = first(`model A { id String @id
      b B? }
    model B { id String @id
      aId String
      a A @relation(fields: [aId], references: [id]) }`)
    expect(err).toContain('is not unique')
    expect(err).toContain('b B[]')          // the to-many way out
    expect(err).toContain('@unique')        // the one-to-one way out
  })

  test('no back reference at all is named, and points at the labelled case when there is one', () => {
    expect(first(`model A { id String @id
      b B? }
    model B { id String @id }`)).toContain('declares no unlabelled @relation back')

    expect(first(`model A { id String @id
      b B? }
    model B { id String @id
      aId String @unique
      a A @relation("x", fields: [aId], references: [id]) }`)).toContain('It has a LABELLED one')
  })

  test('two unlabelled candidates are named, both of them', () => {
    const err = first(`model A { id String @id
      b B? }
    model B { id String @id
      aId String @unique
      cId String @unique
      a A @relation(fields: [aId], references: [id])
      a2 A @relation(fields: [cId], references: [id]) }`)
    expect(err).toContain('has 2 unlabelled')
    expect(err).toContain('a, a2')
  })

  test('a genuinely unknown type still says unknown type', () => {
    expect(first(`model A { id String @id
      b Nope? }`)).toContain("unknown type 'Nope'")
  })
})

describe('reading through a one-to-one', () => {
  const schema = `model User { id String @id @default(cuid())
    email String
    profile Profile? }
  model Profile { id String @id @default(cuid())
    bio String
    userId String @unique
    user User @relation(fields: [userId], references: [id]) }`

  test('include answers the row itself, never a list of one', async () => {
    const db = await createClient({ schema, db: ':memory:', autoMigrate: true })
    try {
      const u = await db.user.create({ data: { email: 'a@b.c' } })
      await db.profile.create({ data: { bio: 'hello', userId: u.id } })

      const withProfile = await db.user.findFirst({ where: { id: u.id }, include: { profile: true } })
      expect(Array.isArray(withProfile.profile)).toBe(false)
      expect(withProfile.profile.bio).toBe('hello')

      // A nested select still shapes the row rather than a list.
      const shaped = await db.user.findFirst({ where: { id: u.id }, include: { profile: { select: { bio: true } } } })
      expect(shaped.profile).toEqual({ bio: 'hello' })

      // The absent side is null, not [].
      const bare = await db.user.create({ data: { email: 'd@e.f' } })
      const none = await db.user.findFirst({ where: { id: bare.id }, include: { profile: true } })
      expect(none.profile).toBeNull()

      // The owning side is unchanged.
      const back = await db.profile.findFirst({ include: { user: true } })
      expect(back.user.email).toBe('a@b.c')
    } finally {
      if ('close' in db) db.close()
    }
  })
})
