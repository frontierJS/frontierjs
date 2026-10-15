// audit-trail-model.js — the SQLite audit trail for a test that builds its
// schema from text. createClient drops an `import` in an inline schema, so the
// reference's trait is read from disk and prepended instead.

import { readFileSync } from 'fs'

// Comments dropped: this schema's text is asserted on, and the reference's prose
// holds words a test looks for.
const TRAIT = readFileSync(new URL('../../litestone/references/AuditTrail.lite', import.meta.url), 'utf8')
  .replace(/^[ \t]*\/\/\/.*\n/gm, '')

// The audit database is a file in the test's own directory, because a model on
// a SQLite database is required and the table is made when the client is.
export const auditDatabase = (dir) => `
${TRAIT}
database audit { path "${dir}/audit.db" model AuditTrail }
model AuditTrail { id Int @id @default(autoincrement())  @@trait(AuditTrail) @@db(audit) @@gate("8") }
`
