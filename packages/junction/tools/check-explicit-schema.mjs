// createLitestoneService is gone. `schema` is an option on createBaseService,
// and supplying it REPLACES the derived validator rather than stacking.
import { createBaseService } from '/home/claude/review/junction/src/core/service.ts'
import { parse } from '/home/claude/review/litestone/src/core/parser.js'
import { readFileSync } from 'fs'
const chk = (l, ok, d='') => console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? '  — ' + d : ''}`)
const parsed = parse(readFileSync('/home/claude/review/smoke-test-fullstack/db/schema.lite','utf8')).schema
const db = { $schema: parsed, lead: {} }
const run = async (svc, method, user, data) => {
  const ctx = { method, data, locals: { db }, auth: user ? { user } : {}, app: {} }
  try { for (const h of (svc.hooks.before[method] ?? [])) await h(ctx); return null }
  catch (e) { return e }
}

// derived path unchanged
const a = createBaseService({ name: 'leads', model: 'lead' })
chk('derived gate auth',   (await run(a, 'find', null))?.code === 401)
chk('derived validation',  /email/.test((await run(a, 'create', { userId: 'u' }, { name: 'A', email: 'bad' }))?.message ?? ''))

// explicit schema now on createBaseService
const explicit = { $defs: { lead: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } }
const b = createBaseService({ name: 'leads', model: 'lead', schema: explicit })
chk('explicit schema compiles',  !!b._schemas?.create)
chk('explicit schema enforced',  /name/.test((await run(b, 'create', { userId: 'u' }, { email: 'x' }))?.message ?? ''))
chk('explicit REPLACES derived', (await run(b, 'create', { userId: 'u' }, { name: 'ok', email: 'not-an-email' })) === null)
chk('gate auth still applies',   (await run(b, 'find', null))?.code === 401)

// a bad schema falls back with a warning rather than throwing
const warns = []; const orig = console.warn; console.warn = m => warns.push(m)
const c = createBaseService({ name: 'leads', model: 'lead', schema: { $defs: {} } })
console.warn = orig
chk('unusable schema warns',     warns.length === 1, warns[0]?.slice(0, 60))
chk('and falls back to derived', /email/.test((await run(c, 'create', { userId: 'u' }, { name: 'A', email: 'bad' }))?.message ?? ''))
