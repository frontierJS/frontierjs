/**
 * auth-default-kind.test.ts — a writable column `@default(auth().x)` fills is
 * marked `x-litestone-kind: 'stamped'`, so a `make()` factory can leave it out
 * (`FJS-2108`). A nullable one is otherwise indistinguishable from `String?`,
 * and the null make() seeds is a value that beats the stamp (`FJS-2032`).
 */

import { describe, test, expect } from 'bun:test'
import { createClient, generateJsonSchema } from '../src/index.js'

const def = async (mode?: string) => {
  const db = await createClient({ db: ':memory:', schema: `
model User {
  id String @id
  @@auth
}
model Inspection {
  id          String  @id
  note        String?
  inspectorId String? @default(auth().id)
  inspector   User?   @relation(fields: [inspectorId], references: [id])
  authorId    String  @default(auth().id)
  author      User    @relation(fields: [authorId], references: [id])
}` })
  return (generateJsonSchema(db.$schema, mode ? { mode } as any : undefined) as any).$defs.Inspection.properties
}

describe('a column auth() fills is marked stamped', () => {
  test('nullable and NOT NULL alike, and a plain column is not', async () => {
    const p = await def('create')
    expect(p.inspectorId['x-litestone-kind']).toBe('stamped')
    expect(p.authorId['x-litestone-kind']).toBe('stamped')
    expect(p.note['x-litestone-kind']).toBeUndefined()
  })

  test('it stays writable: a caller may name another author', async () => {
    const p = await def('create')
    expect(p.inspectorId.readOnly).toBeUndefined()
  })
})
