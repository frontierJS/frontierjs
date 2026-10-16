// audit-trail-model.ts — the SQLite audit trail for a test that builds its
// schema from text. createClient drops an `import` in an inline schema, so the
// reference's trait is read from disk and prepended instead.

import { readFileSync } from 'fs'

const TRAIT = readFileSync(
  Bun.resolveSync('@frontierjs/litestone/references/AuditTrail.lite', import.meta.dir), 'utf8')

// The audit database is a file in the test's own directory, because a model on
// a SQLite database is required and the table is made when the client is.
export const auditDatabase = (dir: string) => `
${TRAIT}
database audit { path "${dir}/audit.db" model AuditTrail }
model AuditTrail { id Int @id @default(autoincrement())  @@trait(AuditTrail) @@db(audit) @@gate(8) }
`
