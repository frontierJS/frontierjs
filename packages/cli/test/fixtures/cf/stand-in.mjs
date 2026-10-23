// stand-in.mjs — `cf` as `test/cloudflare.test.js` puts it first on the PATH.
//
// It answers each verb `core/cloudflare.js` spawns from the fixture `CF_FIXTURE`
// names, and keeps the three behaviors of the real one the module is written
// against: `CLOUDFLARE_API_TOKEN` WINS over `--profile`, a list pages with
// `--per-page`/`--page` and answers `[]` past the end, and a zone or account the
// credential does not reach is the same 403 an unknown id is. `CF_LOG`, when
// set, gets one JSON line per spawn — the argv, and whether a token reached it.

import { readFileSync, appendFileSync } from 'fs'

const fixture = JSON.parse(readFileSync(process.env.CF_FIXTURE, 'utf8'))
const argv = process.argv.slice(2)
const token = process.env.CLOUDFLARE_API_TOKEN
if (process.env.CF_LOG) appendFileSync(process.env.CF_LOG, JSON.stringify({ argv, token: token ?? null }) + '\n')

const words = []
const flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--force') flags.force = true
  else if (a.startsWith('-')) flags[a.replace(/^-+/, '')] = argv[++i]
  else words.push(a)
}
const verb = words.slice(0, 3).join(' ')

function refuse(kind, path = '') {
  process.stderr.write(fixture.refusals[kind].replace('{path}', path))
  process.exit(1)
}
const answer = (value) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); process.exit(0) }

if (verb === 'auth list') answer(Object.keys(fixture.profiles).map(name => ({ name, boundDirectories: [] })))

const credential = token !== undefined ? fixture.tokens[token] : fixture.profiles[flags.profile ?? 'default']
const reach = fixture.accounts[credential] ?? []
const reaches = (accountId) => reach.some(a => a.id === accountId)
const zoneOf = (id) => Object.entries(fixture.zones).find(([, zs]) => zs.some(z => z.id === id))?.[0]

function page(rows, kind) {
  const perPage = Number(flags['per-page'] ?? fixture.perPage[kind])
  const at = Number(flags.page ?? 1)
  answer(rows.slice((at - 1) * perPage, at * perPage))
}

function guard(path) {
  if (credential === undefined) refuse(token !== undefined ? 'token' : 'profile', path)
}

if (verb === 'accounts list') {
  guard('/accounts')
  page(reach, 'accounts')
}
if (verb === 'zones list') {
  guard('/zones')
  page(reaches(flags['account-id']) ? fixture.zones[flags['account-id']] : [], 'zones')
}
if (verb.startsWith('dns records')) {
  const zoneId = flags.z
  const path = `/zones/${zoneId}/dns_records`
  guard(path)
  if (!reaches(zoneOf(zoneId))) refuse('path', verb === 'dns records list' ? `${path}?page=${flags.page ?? 1}&per_page=${flags['per-page'] ?? fixture.perPage.records}` : path)
  const rows = fixture.records[zoneId] ?? []
  const stamp = { created_on: '2026-10-22T00:00:00Z', modified_on: '2026-10-22T00:00:00Z' }
  if (verb === 'dns records list') page(rows, 'records')
  if (verb === 'dns records create') answer({ id: 'rec-created', proxiable: true, settings: {}, meta: {}, comment: null, tags: [], ...JSON.parse(flags.body), ...stamp })
  if (verb === 'dns records edit') answer({ ...rows.find(r => r.id === words[3]), ...JSON.parse(flags.body), modified_on: stamp.modified_on })
  if (verb === 'dns records delete') answer({ id: words[3] })
}

process.stderr.write(`stand-in cf: no answer for ${argv.join(' ')}\n`)
process.exit(2)
