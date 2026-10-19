// ─── outbox:install under row tenancy ────────────────────────────────────────
// `tenancy { strategy row }` makes every model without a tenant column a
// warning at the first migrate. OutboxMessage records its tenantId and has no
// tenant column of its own, so the installer owes it `@@tenant(none)`.

import { describe, test, expect } from 'bun:test'

import { declaresRowTenancy, outboxTenancyExtension } from '../core/app-schema.js'

const row = `
database main { path "./app.db" }
tenancy {
  strategy row
  column   agencyId
}
`

describe('declaresRowTenancy', () => {
  test('strategy row is row tenancy', () => {
    expect(declaresRowTenancy(row)).toBe(true)
  })

  test('strategy database and no block are not', () => {
    expect(declaresRowTenancy('tenancy {\n  strategy database\n}')).toBe(false)
    expect(declaresRowTenancy('model Lead { id Int @id }')).toBe(false)
  })

  test('a comment describing the feature is not the declaration', () => {
    expect(declaresRowTenancy('// tenancy { strategy row } is declared below\nmodel Lead { id Int @id }')).toBe(false)
  })
})

describe('outboxTenancyExtension', () => {
  test('a row-tenancy app gets the line OutboxMessage needs', () => {
    expect(outboxTenancyExtension(row)).toContain('extend model OutboxMessage')
    expect(outboxTenancyExtension(row)).toContain('@@tenant(none)')
  })

  test('any other app gets nothing', () => {
    expect(outboxTenancyExtension('model Lead { id Int @id }')).toBe('')
  })
})
