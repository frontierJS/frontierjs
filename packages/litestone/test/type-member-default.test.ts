// A `@default` on a member of a `type` fills an ABSENT key of a whole-document
// write (`FJS-2301`). A merge patch is partial by definition -- an absent key
// keeps what is stored -- so it fills nothing.

import { describe, it, expect } from 'bun:test'
import { createClient, generateJsonSchema, parse } from '../src/index.js'

const SCHEMA = `
type Address {
  street     String
  postalCode String
  country    String @default("US")
  zone       Int    @default(3)
  gift       Boolean @default(true)
}
type Wrap {
  home Address
  past Address[]
}
model User {
  id      Int @id
  name    String
  address Json @type(Address)
  wrap    Json? @type(Wrap)
}
`

const street = { street: '1 Main', postalCode: '02101' }

describe('@default on a type member', () => {
  it('fills an absent key on create', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.user.create({ data: { name: 'Cy', address: { ...street } } })
    expect(row.address).toEqual({ ...street, country: 'US', zone: 3, gift: true })
  })

  it('leaves a stated key, an explicit false and the caller object alone', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const given = { ...street, country: 'FR', gift: false }
    const row = await db.user.create({ data: { name: 'Cy', address: given } })
    expect(row.address).toEqual({ ...street, country: 'FR', zone: 3, gift: false })
    expect(given).toEqual({ ...street, country: 'FR', gift: false })
  })

  it('reaches a nested type and the elements of an array of one', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.user.create({ data: {
      name: 'Cy', address: { ...street },
      wrap: { home: { ...street }, past: [{ ...street }, { ...street, country: 'CA' }] },
    } })
    expect(row.wrap.home.country).toBe('US')
    expect(row.wrap.past.map((a: any) => a.country)).toEqual(['US', 'CA'])
  })

  it('fills on a whole-value update', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.user.create({ data: { name: 'Cy', address: { ...street, country: 'FR' } } })
    const next = await db.user.update({ where: { id: row.id }, data: { address: { ...street } } })
    expect(next.address.country).toBe('US')
  })

  it('is not listed as required by the JSON Schema a caller validates against', () => {
    const defs = generateJsonSchema(parse(SCHEMA).schema).$defs
    expect(defs.Address.required).toEqual(['street', 'postalCode'])
  })

  it('does not fill a merge patch, which keeps what is stored', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const row = await db.user.create({ data: { name: 'Cy', address: { ...street, country: 'FR' } } })
    const next = await db.user.update({ where: { id: row.id }, data: { address: { $merge: { street: '2 Side' } } } })
    expect(next.address.country).toBe('FR')
  })
})
