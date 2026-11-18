// `@validate` / `@@validate` — a content check written in code, bound to the
// schema so every writer is graded (`FJS-D2241`, `FJS-4221`).
//
// A `$validate` rule in `computed.js` ran only on a model that happened to
// carry some other validator: `buildValidationMap` did not count the rule, so a
// model of plain String columns skipped the pass and stored what the rule
// refuses. The model here has a String id on purpose — an Int column turns the
// pass on by itself and hides the skip.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SOURCE = `model Template {
  id     String @id
  name   String
  source String @validate
}`

const ROW = `model Template {
  id     String @id
  name   String
  source String

  @@validate
}`

const noBraces = { check: (d: any) => !String(d.source ?? '').includes('{{'), message: 'must not hold {{', path: ['source'] }
const named    = { check: (d: any) => d.name !== 'reserved', message: 'that name is reserved' }

const client = (schema: string, rules: any[]) =>
  createClient({ schema, db: ':memory:', computed: { Template: { $validate: rules } } })

describe('@validate binds a field to its $validate rule', () => {
  test('a principal client is refused a value the rule fails, on create and update', async () => {
    const db  = await client(SOURCE, [noBraces])
    const as  = db.$setAuth({ id: 1 })
    await expect(as.template.create({ data: { id: 'a', name: 'n', source: 'x {{ y' } }))
      .rejects.toThrow('source: must not hold {{')
    await as.template.create({ data: { id: 'b', name: 'n', source: 'fine' } })
    await expect(as.template.update({ where: { id: 'b' }, data: { source: '{{' } }))
      .rejects.toThrow('must not hold {{')
    expect((await db.template.findMany()).map((r: any) => r.source)).toEqual(['fine'])
  })

  test('asSystem() is graded too', async () => {
    const db = await client(SOURCE, [noBraces])
    await expect(db.asSystem().template.create({ data: { id: 'a', name: 'n', source: '{{' } }))
      .rejects.toThrow('must not hold {{')
  })

  test('a path-less rule runs under @@validate', async () => {
    const db = await client(ROW, [named])
    await expect(db.template.create({ data: { id: 'a', name: 'reserved', source: 's' } }))
      .rejects.toThrow('that name is reserved')
  })
})

describe('boot refuses a binding that does not meet', () => {
  test('a @validate field no rule names', async () => {
    await expect(client(SOURCE, [])).rejects.toThrow(/Template\.source.*@validate.*no \$validate rule/)
    await expect(createClient({ schema: SOURCE, db: ':memory:' })).rejects.toThrow(/no \$validate rule/)
  })

  test('a rule naming a field without @validate', async () => {
    await expect(client(ROW, [noBraces, named])).rejects.toThrow(/Template\.source.*without @validate/)
  })

  test('a path-less rule on a model without @@validate', async () => {
    await expect(client(SOURCE, [noBraces, named])).rejects.toThrow(/Template.*needs @@validate/)
  })

  test('@@validate with no path-less rule', async () => {
    await expect(client(ROW, [])).rejects.toThrow(/@@validate.*no path-less \$validate rule/)
  })

  test('a rule naming a field the model does not have', async () => {
    await expect(client(SOURCE, [noBraces, { ...noBraces, path: ['body'] }]))
      .rejects.toThrow(/Template has no field 'body'/)
  })
})
