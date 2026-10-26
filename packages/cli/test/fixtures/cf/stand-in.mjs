// stand-in.mjs — `cf` as `test/cloudflare.test.js` puts it first on the PATH.
//
// It answers each verb `core/cloudflare.js` spawns from the fixture `CF_FIXTURE`
// names, and keeps the three behaviors of the real one the module is written
// against: `CLOUDFLARE_API_TOKEN` WINS over `--profile`, a list pages with
// `--per-page`/`--page` and answers `[]` past the end, and a zone or account the
// credential does not reach is the same 403 an unknown id is. A Pages or Workers
// verb takes its account from `CLOUDFLARE_ACCOUNT_ID` and refuses to pick one of
// several, and a Pages list over 10 a page is a 400. `CF_LOG`, when set, gets
// one JSON line per spawn — the argv, the token and the account that reached it.
//
// While the file `CF_SIGNED_OUT` names exists no profile is signed in, and
// `auth login` prints the device text, then waits for the file to go — the
// drive deleting it is the person approving the code.
//
// Each spawn is a fresh process, so a write is forgotten unless `CF_STATE`
// names a file: then a zone's records are read from it once written, and
// create, edit and delete write it — a drive rereading after a write sees the
// table change, as against the real one.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs'

const fixture = JSON.parse(readFileSync(process.env.CF_FIXTURE, 'utf8'))
const argv = process.argv.slice(2)
const token = process.env.CLOUDFLARE_API_TOKEN
const accountEnv = process.env.CLOUDFLARE_ACCOUNT_ID
if (process.env.CF_LOG) appendFileSync(process.env.CF_LOG, JSON.stringify({ argv, token: token ?? null, account: accountEnv ?? null }) + '\n')

const words = []
const flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--force') flags.force = true
  else if (a.startsWith('-')) flags[a.replace(/^-+/, '')] = argv[++i]
  else words.push(a)
}
const verb = words.slice(0, 3).join(' ')

function refuse(kind, path = '', accounts = '') {
  process.stderr.write(fixture.refusals[kind].replace('{path}', path).replace('{accounts}', accounts))
  process.exit(1)
}
const answer = (value) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); process.exit(0) }

const signedOut = () => !!process.env.CF_SIGNED_OUT && existsSync(process.env.CF_SIGNED_OUT)

if (verb === 'auth list') answer(signedOut() ? [] : Object.keys(fixture.profiles).map(name => ({ name, boundDirectories: [] })))
if (verb === 'auth login') {
  process.stdout.write(fixture.login.stdout)
  process.stderr.write(fixture.login.device)
  while (signedOut()) await new Promise(r => setTimeout(r, 100))
  process.exit(0)
}

const credential = token !== undefined ? fixture.tokens[token] : signedOut() ? undefined : fixture.profiles[flags.profile ?? 'default']
const reach = fixture.accounts[credential] ?? []
const reaches = (accountId) => reach.some(a => a.id === accountId)
const zoneOf = (id) => Object.entries(fixture.zones).find(([, zs]) => zs.some(z => z.id === id))?.[0]

function page(rows, kind) {
  const perPage = Number(flags['per-page'] ?? fixture.perPage[kind] ?? rows.length)
  const at = Number(flags.page ?? 1)
  answer(rows.slice((at - 1) * perPage, at * perPage))
}

function guard(path) {
  if (credential === undefined) refuse(token !== undefined ? 'token' : 'profile', path)
}

function account() {
  guard('/accounts')
  const id = accountEnv ?? (reach.length === 1 ? reach[0].id : null)
  if (id === null) refuse('account', '', reach.map(a => `│   \`${a.name}\`: \`${a.id}\`\n`).join(''))
  if (!reaches(id)) refuse('path', `/accounts/${id}`)
  return id
}

if (verb === 'accounts list') {
  guard('/accounts')
  page(reach, 'accounts')
}
if (verb === 'zones list') {
  guard('/zones')
  const acct = flags['account-id']
  page(acct ? (reaches(acct) ? fixture.zones[acct] : []) : reach.flatMap(a => fixture.zones[a.id] ?? []), 'zones')
}
if (verb.startsWith('dns records')) {
  const zoneId = flags.z
  const path = `/zones/${zoneId}/dns_records`
  guard(path)
  if (!reaches(zoneOf(zoneId))) refuse('path', verb === 'dns records list' ? `${path}?page=${flags.page ?? 1}&per_page=${flags['per-page'] ?? fixture.perPage.records}` : path)
  const kept = process.env.CF_STATE && existsSync(process.env.CF_STATE) ? JSON.parse(readFileSync(process.env.CF_STATE, 'utf8')) : {}
  const rows = kept[zoneId] ?? fixture.records[zoneId] ?? []
  const keep = (next, value) => {
    if (process.env.CF_STATE) writeFileSync(process.env.CF_STATE, JSON.stringify({ ...kept, [zoneId]: next }))
    answer(value)
  }
  const stamp = { created_on: '2026-10-22T00:00:00Z', modified_on: '2026-10-22T00:00:00Z' }
  const target = () => rows.find(r => r.id === words[3]) ?? refuse('record', `${path}/${words[3]}`)
  if (verb === 'dns records list') page(rows, 'records')
  if (verb === 'dns records get') answer(target())
  if (verb === 'dns records create') {
    const body = JSON.parse(flags.body)
    const id = rows.some(r => r.id === 'rec-created') ? `rec-created-${rows.length}` : 'rec-created'
    const made = { id, proxiable: ['A', 'AAAA', 'CNAME'].includes(body.type), settings: {}, meta: {}, comment: null, tags: [], ...body, ...stamp }
    keep([...rows, made], made)
  }
  if (verb === 'dns records edit') {
    const edited = { ...target(), ...JSON.parse(flags.body), modified_on: stamp.modified_on }
    keep(rows.map(r => r.id === edited.id ? edited : r), edited)
  }
  if (verb === 'dns records delete') keep(rows.filter(r => r.id !== target().id), { id: words[3] })
}

if (verb === 'cache purge') {
  const path = `/zones/${flags.z}/purge_cache`
  guard(path)
  if (!reaches(zoneOf(flags.z))) refuse('path', path)
  answer({ id: flags.z })
}
if (verb.startsWith('pages projects')) {
  const acct = account()
  const base = `/accounts/${acct}/pages/projects`
  if (Number(flags['per-page']) > fixture.maxPerPage.pages) refuse('listOptions', `${base}?per_page=${flags['per-page']}`)
  const projects = fixture.pages[acct] ?? []
  if (verb === 'pages projects list') page(projects, 'pages')
  if (verb === 'pages projects create') {
    const body = JSON.parse(flags.body)
    answer({ ...projects[0], id: 'proj-created', subdomain: `${body.name}.pages.dev`, latest_deployment: null, canonical_deployment: null, ...body })
  }
  if (words[3] === 'list') answer((fixture.pagesDeployments[flags['project-name']] ?? []).slice(0, Number(flags['per-page'] ?? fixture.perPage.pages)))
  if (words[3] === 'create') {
    const [template] = Object.values(fixture.pagesDeployments)[0]
    answer({ ...template, id: 'dep-created', project_name: words[4], url: null, latest_stage: { name: 'queued', status: 'active' } })
  }
}
if (verb.startsWith('workers')) {
  const acct = account()
  const rows = fixture.workers[acct] ?? []
  const named = (x) => rows.find(w => w.id === x || w.name === x) ?? refuse('notFound', `/accounts/${acct}/workers/workers/${x}`)
  if (verb === 'workers list') page(rows, 'workers')
  if (words[1] === 'get') answer(named(words[2]))
  if (verb === 'workers deployments list') answer(fixture.workerDeployments[named(flags.worker).name])
  if (verb === 'workers versions get') {
    named(flags['worker-id'])
    answer(fixture.workerVersions[words[3]])
  }
}

process.stderr.write(`stand-in cf: no answer for ${argv.join(' ')}\n`)
process.exit(2)
