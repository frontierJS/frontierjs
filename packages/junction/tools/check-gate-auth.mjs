import { createBaseService } from '/home/claude/review/junction/src/core/service.ts'
import { parse } from '/home/claude/review/litestone/src/core/parser.js'

const chk = (l, ok, d='') => console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? '  — ' + d : ''}`)

const schema = (gate) => parse(`
database main { path "./x.db" }
model Lead {
  id    Int    @id
  name  String
  ${gate}
}
`).schema

const run = async (svc, method, user, db) => {
  const ctx = { method, data: { name: 'x' }, locals: { db }, auth: user ? { user } : {}, app: {} }
  for (const h of (svc.hooks.before[method] ?? [])) await h(ctx)
  return ctx
}
const tryRun = async (...a) => { try { await run(...a); return null } catch (e) { return e } }

// @@gate("4") — everything requires auth
{
  const db = { $schema: schema('@@gate("4")'), lead: {} }
  const svc = createBaseService({ name: 'leads', model: 'lead' })
  chk('gate 4: anonymous find rejected',   (await tryRun(svc, 'find',   null, db))?.message === 'Authentication required')
  chk('gate 4: anonymous create rejected', !!(await tryRun(svc, 'create', null, db)))
  chk('gate 4: authenticated find passes', (await tryRun(svc, 'find', { userId: 'u1' }, db)) === null)
}

// @@gate("0.4") — public read, authenticated writes
{
  const db = { $schema: schema('@@gate("0.4")'), lead: {} }
  const svc = createBaseService({ name: 'leads', model: 'lead' })
  chk('gate 0.4: anonymous find ALLOWED',  (await tryRun(svc, 'find',   null, db)) === null)
  chk('gate 0.4: anonymous get ALLOWED',   (await tryRun(svc, 'get',    null, db)) === null)
  chk('gate 0.4: anonymous create rejected', !!(await tryRun(svc, 'create', null, db)))
  chk('gate 0.4: anonymous remove rejected', !!(await tryRun(svc, 'remove', null, db)))
}

// per-op: @@gate("0.4.4.5")
{
  const db = { $schema: schema('@@gate("0.4.4.5")'), lead: {} }
  const svc = createBaseService({ name: 'leads', model: 'lead' })
  chk('gate 0.4.4.5: read public',         (await tryRun(svc, 'find', null, db)) === null)
  chk('gate 0.4.4.5: delete needs auth',   !!(await tryRun(svc, 'remove', null, db)))
}

// no gate at all → unrestricted
{
  const db = { $schema: schema(''), lead: {} }
  const svc = createBaseService({ name: 'leads', model: 'lead' })
  chk('no gate: anonymous allowed',        (await tryRun(svc, 'find', null, db)) === null)
}

// non-litestone client → no-op
{
  const svc = createBaseService({ name: 'leads', model: 'lead' })
  chk('plain client: no-op',               (await tryRun(svc, 'find', null, { lead: {} })) === null)
}
