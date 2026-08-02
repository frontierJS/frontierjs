// Field validation must be derived from the Litestone client's own $schema —
// no `schema:` option, no per-app wrapper. Checks the real smoke-test schema.
import { createBaseService } from '/home/claude/review/junction/src/core/service.ts'
import { parse } from '/home/claude/review/litestone/src/core/parser.js'
import { readFileSync } from 'fs'

const chk = (l, ok, d='') => console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? '  — ' + d : ''}`)

const parsed = parse(readFileSync('/home/claude/review/smoke-test-fullstack/db/schema.lite','utf8')).schema

// a fake Litestone client carrying the real parsed schema
const rows = []
const client = {
  $schema: parsed,
  lead: { create: async ({ data }) => { rows.push(data); return data } },
}

const svc = createBaseService({ name: 'leads', model: 'lead' })
chk('hooks installed on the service', !!svc.hooks?.before?.create?.length)

// Authenticated: gateAuth runs before validation and the Lead model is
// @@gate("4"), so an anonymous context would 401 before reaching the validator.
const run = async (data) => {
  const ctx = { method: 'create', data, locals: { db: client }, auth: { user: { userId: 'u1' } }, app: {} }
  for (const h of svc.hooks.before.create) await h(ctx)
  return ctx
}

// valid
const ok = await run({ name: 'Acme', email: 'a@b.test', status: 'new', value: 10 })
chk('valid data passes', ok.data.name === 'Acme')

// @email violation
let err = null
try { await run({ name: 'Acme', email: 'not-an-email', value: 1 }) } catch (e) { err = e }
chk('rejects a bad email', !!err, err?.message?.slice(0, 60))

// @gte(0) violation
err = null
try { await run({ name: 'Acme', email: 'a@b.test', value: -5 }) } catch (e) { err = e }
chk('rejects a negative value', !!err, err?.message?.slice(0, 60))

// @length(1,200) violation
err = null
try { await run({ name: 'x'.repeat(500), email: 'a@b.test' }) } catch (e) { err = e }
chk('rejects an over-long name', !!err, err?.message?.slice(0, 60))

// non-litestone client → no-op, no crash
const plain = { lead: { create: async () => ({}) } }
const ctx2 = { method: 'create', data: { anything: true }, locals: { db: plain }, auth: {}, app: {} }
for (const h of svc.hooks.before.create) await h(ctx2)
chk('plain client: validation no-ops', ctx2.data.anything === true)
