// Sanity checks for the JSONL driver cache changes
import { createClient } from '../src/index.js'
import { mkdirSync, rmSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs'

const DIR = '/tmp/ls-jsonl-sanity'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(`${DIR}/logs`, { recursive: true })

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures++; console.log('FAIL:', msg) } else console.log('ok:', msg) }

const schema = `
database main { path "${DIR}/main.db" }
database logs { path "${DIR}/logs/"\n driver jsonl }
model events { kind String; n Int; createdAt DateTime @default(now()) \n @@db(logs) }
model hits { kind String; n Int \n @@index([kind]) \n @@db(logs) }`

const db = await createClient({ schema })

// basic create/find/count
await db.events.create({ data: { kind: 'a', n: 1 } })
await db.events.create({ data: { kind: 'b', n: 2 } })
assert(await db.events.count({}) === 2, 'count after creates')
const all = await db.events.findMany({})
assert(all.length === 2 && all[0].kind === 'a', 'findMany returns records')

// caller mutation must not corrupt cache
all[0].kind = 'MUTATED'
const again = await db.events.findMany({})
assert(again[0].kind === 'a', 'cache immune to caller mutation')

// createMany batch
const created = await db.events.createMany({ data: [{ kind: 'c', n: 3 }, { kind: 'd', n: 4 }] })
assert(created.length === 2, 'createMany returns records')
assert(await db.events.count({}) === 4, 'count after createMany')
assert((await db.events.findFirst({ where: { kind: 'd' } }))?.n === 4, 'findFirst finds batched record')

// external append (another process writing) → tail parse picks it up
appendFileSync(`${DIR}/logs/events.jsonl`, JSON.stringify({ kind: 'ext', n: 99, createdAt: new Date().toISOString() }) + '\n')
assert(await db.events.count({}) === 5, 'external append visible (tail parse)')
assert((await db.events.findFirst({ where: { kind: 'ext' } }))?.n === 99, 'external record readable')

// file rewrite (compaction) → full reload
const lines = readFileSync(`${DIR}/logs/events.jsonl`, 'utf8').trim().split('\n')
writeFileSync(`${DIR}/logs/events.jsonl`, lines.slice(-2).join('\n') + '\n')
assert(await db.events.count({}) === 2, 'shrunk file triggers full reload')

// indexed model: index path + count via index + fd-per-query read
await db.hits.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ kind: i % 2 ? 'odd' : 'even', n: i })) })
const odds = await db.hits.findMany({ where: { kind: 'odd' }, limit: 10 })
assert(odds.length === 10 && odds.every(r => r.kind === 'odd'), 'index query path')
assert(await db.hits.count({ where: { kind: 'even' } }) === 250, 'count via index')
assert(await db.hits.count({}) === 500, 'plain count on indexed model')

db.$close()
console.log(failures ? `\n${failures} FAILURES` : '\nAll sanity checks passed')
process.exit(failures ? 1 : 0)
