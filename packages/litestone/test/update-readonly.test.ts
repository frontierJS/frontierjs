// The UPDATE schema's read-only set -- the columns a patch may not name.
//
// A service narrowing a patch used to retype this as a hand list beside the
// schema (`FJS-1393`). The schema says it now: the row stamps, the
// tenant column and the field a @@transitions names are read-only in update
// mode and writable in create (`FJS-D1243`).

import { describe, it, expect } from 'bun:test'
import { generateJsonSchema } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const SCHEMA = `
enum Phase {
  open
  closed
}

model Ticket {
  id          String    @id @default(uuid())
  workspaceId String
  title       String
  slug        String    @immutable
  phase       Phase     @default(open)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
  @@transitions(phase, open -> closed)
}
`

const update = (opts = {}) => {
  const out = generateJsonSchema(parse(SCHEMA).schema, {
    mode: 'update', includeTimestamps: true, includeDeletedAt: true, ...opts,
  }) as any
  return out.$defs.Ticket.properties
}

describe('the update schema read-only set', () => {
  it('marks the stamps, the tenant column and a transitions field', () => {
    const p = update()
    expect(p.id.readOnly).toBeUndefined()
    expect(p.workspaceId.readOnly).toBe(true)
    expect(p.createdAt.readOnly).toBe(true)
    expect(p.updatedAt.readOnly).toBe(true)
    expect(p.deletedAt.readOnly).toBe(true)
    expect(p.phase.readOnly).toBe(true)
    expect(p.phase['x-litestone-kind']).toBe('transition')
    expect(p.slug.readOnly).toBe(true)
    expect(p.title.readOnly).toBeUndefined()
  })

  it('leaves them writable in create', () => {
    const out = generateJsonSchema(parse(SCHEMA).schema, { mode: 'create', includeTimestamps: true }) as any
    const p = out.$defs.Ticket.properties
    expect(p.phase.readOnly).toBeUndefined()
    expect(p.workspaceId.readOnly).toBeUndefined()
  })
})
