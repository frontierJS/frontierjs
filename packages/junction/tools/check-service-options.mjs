import { createBaseService } from '/home/claude/review/junction/src/core/service.ts'
import { parse } from '/home/claude/review/litestone/src/core/parser.js'
import { readFileSync } from 'fs'

const chk = (l, ok, d='') => console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? '  — ' + d : ''}`)
const parsed = parse(readFileSync('/home/claude/review/smoke-test-fullstack/db/schema.lite','utf8')).schema

const svc = createBaseService({
  name: 'leads', model: 'lead',
  idField: 'id', softDelete: 'deletedAt', cache: { ttl: '30s' },
})

chk('accepts idField / softDelete / cache', !!svc)
chk('_meta.softDelete carried',  svc._meta?.softDelete === 'deletedAt', String(svc._meta?.softDelete))
chk('_meta.cache flag carried',  svc._meta?.cache === true)
chk('_meta.idField carried',     svc._meta?.idField === 'id')
chk('cache declaration passed',  !!svc.cache)
chk('CRUD still present',        ['find','get','create','patch','remove','restore'].every(m => typeof svc[m] === 'function'))
chk('derived hooks still there', !!svc.hooks?.before?.create?.length)

// defaults when omitted
const bare = createBaseService({ name: 'x', model: 'lead' })
chk('defaults: idField id',      bare._meta?.idField === 'id')
chk('defaults: softDelete null', bare._meta?.softDelete === null)
chk('defaults: cache false',     bare._meta?.cache === false)
chk('no cache key when omitted', !('cache' in bare))

// the three still-derived behaviors survive the fold
const db = { $schema: parsed, lead: {} }
const run = async (method, user, data) => {
  const ctx = { method, data, locals: { db }, auth: user ? { user } : {}, app: {} }
  try { for (const h of (bare.hooks.before[method] ?? [])) await h(ctx); return null }
  catch (e) { return e }
}
chk('gate auth still derived',   (await run('find', null))?.code === 401)
chk('validation still derived',  /email/.test((await run('create', { userId: 'u' }, { name: 'A', email: 'bad' }))?.message ?? ''))
