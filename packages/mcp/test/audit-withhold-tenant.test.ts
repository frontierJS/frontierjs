/*
 * test/audit-withhold-tenant.test.ts — AUDIT 1.2 (2026-10-05). EXPECTED TO FAIL.
 *
 * `plugin.ts` run() backstops a system-write return (FJS-D473) with
 * `withholdProtected(result, { locals: { db: app.db }, model, service })`.
 *
 * Under `tenancy { strategy database }` there is NO app-wide client, so
 * `app.db` is undefined — the plugin states this itself for `parsedSchema` and
 * `standingOf`. But run() still reaches for `app.db` as the client
 * `withholdProtected` reads `$protectedFields` from, and `protectedFieldsFor`
 * returns `{}` for an undefined db — so the row is returned UNCHANGED. A custom
 * method that returns an `asSystem()` read/write (the `credentials.mint` shape)
 * then hands the agent a decrypted `@secret`/`@guarded` column in plaintext.
 *
 * `plugin.test.ts` exercises FJS-D473 only on the non-tenant app, where
 * `app.db` exists, so the tenant-per-database shape — which is `example`, the
 * flagship — goes untested. This asserts the redaction the plugin promises; it
 * fails because an undefined db makes it a no-op.
 */

import { describe, test, expect } from 'bun:test'
import { withholdProtected } from '@frontierjs/junction'

describe('AUDIT: withholdProtected must still redact when app.db is absent (strategy database)', () => {

  test('a @secret / @guarded column is withheld even with an undefined db', () => {
    // The row a system write returned, carrying a decrypted secret and a guarded
    // column — exactly what credentials.mint answers.
    const row = { id: 7, label: 'prod-key', value: 'hunter2', scope: 'admin:all' }

    // What run() passes under tenancy { strategy database }: app.db is undefined.
    const out = withholdProtected(row, {
      locals: { db: undefined } as never,
      model:  'Credential',
      service: 'credentials',
    } as never) as Record<string, unknown>

    expect(out.value, 'the @secret column leaked to the agent').not.toBe('hunter2')
    expect(out.scope, 'the @guarded column leaked to the agent').not.toBe('admin:all')
  })
})
