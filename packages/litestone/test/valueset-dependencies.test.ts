// A DEPENDENT value set — the list is that country's states (`FJS-D122`).
//
// The dependency is a JOIN, declared on the binding, and which column of the
// SOURCE it matches is derived from the relation path. Two properties are what
// the design turns on and both are asserted here rather than described:
//
//   1. **The pair is graded in BOTH directions.** A write naming only the
//      dependent column is graded against the stored controller, and a write
//      naming only the CONTROLLER is graded against the stored dependent value
//      — because moving the controller is the other way to end up with an
//      invalid row, and it is the one a one-directional check leaves open.
//   2. **An `open` set stamps the controller on the row it creates.** Without
//      it the value just added sits outside the list that was just narrowed,
//      and the next read does not offer it.
//
// Every refusal is paired with the same shape one column away (`FJS-351`): a
// check that refused all dependent writes, or a parse that refused every
// `dependsOn`, would satisfy a suite that only asked about the refusal.

import { describe, it, expect } from 'bun:test'
import { createClient, ValidationError } from '../src/index.js'

const GEO = `
model Country {
  id        String  @id
  name      String
  states    State[]
  addresses Address[]
}
model State {
  id        String  @id
  name      String
  countryId String
  country   Country @relation(fields: [countryId], references: [id])
  @@label(name)
}
valueset States { source State }
`

const SCHEMA = GEO + `
model Address {
  id        Int     @id
  line      String
  countryId String
  country   Country @relation(fields: [countryId], references: [id])
  stateId   String? @values(States, dependsOn: countryId)
}
`

async function seeded(schema = SCHEMA) {
  const db  = await createClient({ schema, db: ':memory:' })
  const sys = db.asSystem()
  await sys.country.create({ data: { id: 'US', name: 'United States' } })
  await sys.country.create({ data: { id: 'FR', name: 'France' } })
  await sys.state.create({ data: { id: 'TX',  name: 'Texas',         countryId: 'US' } })
  await sys.state.create({ data: { id: 'CA',  name: 'California',    countryId: 'US' } })
  await sys.state.create({ data: { id: 'IDF', name: 'Ile-de-France', countryId: 'FR' } })
  return { db, sys }
}

const refuses = async (fn: () => Promise<unknown>) => {
  try { await fn() } catch (e) { return e }
  return null
}
const parses = async (schema: string) => {
  try { await createClient({ schema, db: ':memory:' }); return null }
  catch (e) { return e as Error }
}

describe('the source column is derived, and an undecidable one is refused', () => {
  it('resolves the relation path with nothing else written', async () => {
    expect(await parses(SCHEMA)).toBe(null)
  })

  it('refuses a dependsOn that is not a column, and takes the one that is', async () => {
    const bad = await parses(SCHEMA.replace('dependsOn: countryId', 'dependsOn: nope'))
    expect(bad!.message).toContain("'nope' is not a field")
    expect(await parses(SCHEMA)).toBe(null)
  })

  it('refuses a column that narrows by itself', async () => {
    const bad = await parses(SCHEMA.replace('dependsOn: countryId', 'dependsOn: stateId'))
    expect(bad!.message).toContain('cannot narrow by itself')
  })

  it('refuses a controller that is not a foreign key, and names the escape', async () => {
    // Nothing to walk: there is no relation from the controller to a model the
    // source also reaches, so the source column has to be stated.
    const plain = `
model Country { id String @id  name String  states State[] }
model State {
  id String @id  name String  countryId String
  country Country @relation(fields: [countryId], references: [id])
  @@label(name)
}
valueset States { source State }
model Address {
  id      Int     @id
  region  String
  stateId String? @values(States, dependsOn: region)
}
`
    const bad = await parses(plain)
    expect(bad!.message).toContain('is not a foreign key')
    expect(bad!.message).toContain('on <column>')
    // …and the same schema with the escape taken parses.
    expect(await parses(plain.replace('dependsOn: region', 'dependsOn: region on countryId'))).toBe(null)
  })

  it('refuses an ambiguous path, naming both ways, and the escape settles it', async () => {
    const two = `
model Country { id String @id  name String }
model State {
  id String @id  name String
  countryId String
  country Country @relation(fields: [countryId], references: [id])
  taxCountryId String
  taxCountry Country @relation(fields: [taxCountryId], references: [id], name: "tax")
  @@label(name)
}
valueset States { source State }
model Address {
  id Int @id
  countryId String
  country Country @relation(fields: [countryId], references: [id])
  stateId String? @values(States, dependsOn: countryId)
}
`
    const bad = await parses(two)
    expect(bad!.message).toContain('2 ways')
    expect(bad!.message).toContain('taxCountryId')
    expect(await parses(two.replace('dependsOn: countryId', 'dependsOn: countryId on countryId'))).toBe(null)
  })

  it('takes a strength beside the dependency, and refuses an unknown named argument', async () => {
    expect(await parses(SCHEMA.replace('@values(States, dependsOn', '@values(States, suggested, dependsOn'))).toBe(null)
    const bad = await parses(SCHEMA.replace('dependsOn: countryId', 'narrows: countryId'))
    expect(bad!.message).toContain("unknown argument")
  })
})

describe('a write is graded as the row will be', () => {
  it('takes a value from the controller’s own list', async () => {
    const { sys } = await seeded()
    const row = await sys.address.create({ data: { id: 1, line: 'a', countryId: 'US', stateId: 'TX' } })
    expect(row.stateId).toBe('TX')
  })

  it('refuses one from another controller’s list, naming both', async () => {
    const { sys } = await seeded()
    const err = await refuses(() => sys.address.create({
      data: { id: 2, line: 'b', countryId: 'FR', stateId: 'TX' },
    })) as Error
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('TX')
    expect(err.message).toContain('countryId')
  })

  it('refuses a value offered with no controller at all', async () => {
    // The row as it will be has nothing in the controlling column, so which
    // list the value must come from is unknown. Empty is not a list.
    const { sys } = await seeded()
    const err = await refuses(() => sys.address.create({
      data: { id: 3, line: 'c', stateId: 'TX' },
    })) as Error
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('countryId')
  })

  it('leaves a row with no dependent value alone', async () => {
    const { sys } = await seeded()
    const row = await sys.address.create({ data: { id: 4, line: 'd', countryId: 'FR' } })
    expect(row.stateId).toBe(null)
  })
})

describe('both directions, which is the half a one-way check leaves open', () => {
  it('grades a patch naming only the value against the STORED controller', async () => {
    const { sys } = await seeded()
    await sys.address.create({ data: { id: 1, line: 'a', countryId: 'US', stateId: 'TX' } })
    const ok = await sys.address.update({ where: { id: 1 }, data: { stateId: 'CA' } })
    expect(ok.stateId).toBe('CA')
    expect(await refuses(() => sys.address.update({ where: { id: 1 }, data: { stateId: 'IDF' } })))
      .toBeInstanceOf(ValidationError)
  })

  it('grades a patch naming only the CONTROLLER against the stored value', async () => {
    // Moving the country makes the state that is already there illegal. Nothing
    // in the payload mentions `stateId`.
    const { sys } = await seeded()
    await sys.address.create({ data: { id: 1, line: 'a', countryId: 'US', stateId: 'TX' } })
    const err = await refuses(() => sys.address.update({ where: { id: 1 }, data: { countryId: 'FR' } }))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('TX')
  })

  it('accepts the same move when both halves travel together', async () => {
    const { sys } = await seeded()
    await sys.address.create({ data: { id: 1, line: 'a', countryId: 'US', stateId: 'TX' } })
    const row = await sys.address.update({ where: { id: 1 }, data: { countryId: 'FR', stateId: 'IDF' } })
    expect([row.countryId, row.stateId]).toEqual(['FR', 'IDF'])
  })

  it('accepts moving the controller on a row that has no dependent value', async () => {
    const { sys } = await seeded()
    await sys.address.create({ data: { id: 5, line: 'e', countryId: 'US' } })
    const row = await sys.address.update({ where: { id: 5 }, data: { countryId: 'FR' } })
    expect(row.countryId).toBe('FR')
  })

  it('grades a BULK patch against every controller it matches', async () => {
    // Two rows, two countries, one payload. The write is legal for one of them
    // and that is not enough.
    const { sys } = await seeded()
    await sys.address.create({ data: { id: 1, line: 'a', countryId: 'US' } })
    await sys.address.create({ data: { id: 2, line: 'b', countryId: 'FR' } })
    expect(await refuses(() => sys.address.updateMany({ where: {}, data: { stateId: 'TX' } })))
      .toBeInstanceOf(ValidationError)
    // The same call over just the US row lands.
    const out = await sys.address.updateMany({ where: { countryId: 'US' }, data: { stateId: 'TX' } })
    expect(out.count).toBe(1)
  })
})

describe('strength still decides what an unknown value does', () => {
  const OPEN = `
model Country { id String @id  name String  states State[] }
model State {
  id        String  @id @default(cuid())
  code      String  @unique
  name      String
  countryId String
  country   Country @relation(fields: [countryId], references: [id])
  @@label(name)
}
valueset OpenStates { source State  value code }
model Address {
  id        Int     @id
  countryId String
  country   Country @relation(fields: [countryId], references: [id])
  stateCode String? @values(OpenStates, open, dependsOn: countryId)
}
`

  it('open creates the missing row and STAMPS the controller on it', async () => {
    // Unstamped, the row lands outside the list that was just narrowed and the
    // next read does not offer the value that was just added.
    const db  = await createClient({ schema: OPEN, db: ':memory:' })
    const sys = db.asSystem()
    await sys.country.create({ data: { id: 'US', name: 'United States' } })
    await sys.address.create({ data: { id: 1, countryId: 'US', stateCode: 'TX' } })

    const made = await sys.state.findFirst({ where: { code: 'TX' } })
    expect(made.countryId).toBe('US')
    expect(made.name).toBe('TX')

    // …and it is now offered to the next write under that country, while the
    // other country still refuses it.
    await sys.country.create({ data: { id: 'FR', name: 'France' } })
    const second = await sys.address.create({ data: { id: 2, countryId: 'US', stateCode: 'TX' } })
    expect(second.stateCode).toBe('TX')
    expect(await sys.state.count({ where: { code: 'TX' } })).toBe(1)
  })

  it('suggested asks nothing at all, dependency included', async () => {
    const db  = await createClient({ schema: SCHEMA.replace('@values(States, dependsOn', '@values(States, suggested, dependsOn'), db: ':memory:' })
    const sys = db.asSystem()
    await sys.country.create({ data: { id: 'FR', name: 'France' } })
    const row = await sys.address.create({ data: { id: 1, line: 'a', countryId: 'FR', stateId: 'TX' } })
    expect(row.stateId).toBe('TX')
  })
})
