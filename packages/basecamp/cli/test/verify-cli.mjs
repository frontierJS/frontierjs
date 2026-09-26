/*
 * verify-cli.mjs — `basecamp` on a command line, run as the process a person runs.
 *
 *   bun run verify:cli
 *
 * The app's own CLI (`cli/src/main.js`, `FJS-D397`): its commands are `/mcp`'s
 * tool list at the signed-in key's standing (`FJS-D396`) plus the routes under
 * `cli/src/routes/`. Every row spawns it and is paired with the tool call it
 * stands for rather than with a literal — a CLI that printed the wrong rows
 * neatly is the failure a snapshot of its output would pass.
 *
 * No browser. Its own database, seeded, and the API on test-tier 7120, which
 * `verify:mcp` also uses — the two cannot run at once.
 *
 * Traps, each paid for once:
 *   - `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` are this run's scratch directory. A
 *     `login` here must never write into the developer's own `~/.config`.
 *   - The API states a build (`FJS_BUILD`), or the command cache is never used
 *     and its rows pass against a CLI that lists live every time.
 *   - A port that answers is not evidence the right process is on it. 7120 is
 *     REFUSED if held at the start (`FJS-740`).
 *   - Runs under bun: the seed and the lookups below reach `bun:sqlite`.
 */

import { spawn, execFileSync }       from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir }                    from 'node:os'
import { dirname, join }             from 'node:path'
import { fileURLToPath }             from 'node:url'
import { Database }                  from 'bun:sqlite'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { loadRoutes, checkRoutes }   from '@frontierjs/mcp/client'
import { buildCli }                  from '@frontierjs/mcp/client/build'
import cliConfig                     from '../config/cli.config.js'

const ROOT        = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN        = join(ROOT, 'cli', 'src', 'main.js')
const API_PORT    = 7120
const API         = `http://localhost:${API_PORT}`
const SCRATCH     = mkdtempSync(join(tmpdir(), 'basecamp-cli-'))
const DB_PATH     = join(SCRATCH, 'basecamp.db')
const CONFIG_HOME = join(SCRATCH, 'config')

const PASSWORD = 'hunter2hunter2'
const OWNER = 'sam@example.com', ADMIN = 'kim@example.com', DEVELOPER = 'remy@example.com', VIEWER = 'jo@example.com'

const ENV = {
  ...process.env,
  DATABASE_URL: DB_PATH,
  AUDIT_PATH:   join(SCRATCH, 'audit/'),
  PORT:         String(API_PORT),
  FJS_BUILD:    'verify-cli-build-1',
}

// ─── Harness ─────────────────────────────────────────────────────────────

const children = []
const sleep    = ms => new Promise(r => setTimeout(r, ms))
let failed = 0, passed = 0

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`)
  ok ? passed++ : failed++
}

async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch {} }
  await sleep(1500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  rmSync(SCRATCH, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => cleanup().then(() => process.exit(130)))

const answers = () => fetch(`${API}/health`).then(r => r.status < 500, () => false)

async function login(email) {
  const res  = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body:   JSON.stringify({ email, password: PASSWORD }),
  })
  const body  = await res.json()
  const token = body.token ?? body.data?.token
  if (!token) throw new Error(`login ${email}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  return token
}

/** A real MCP client, for the tool call each CLI row is paired with. */
async function connect(token, workspace) {
  const client  = new Client({ name: 'verify-cli', version: '1.0.0' })
  const headers = { authorization: `Bearer ${token}`, ...(workspace ? { 'x-workspace-id': workspace } : {}) }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers } }))
  return client
}

const called = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }).catch(e => ({ isError: true, content: [{ text: String(e) }] }))
  const text = r.content?.[0]?.text ?? ''
  let data = null
  try { data = JSON.parse(text) } catch { /* a refusal is prose */ }
  return { refused: !!r.isError, text, data }
}

/**
 * One CLI invocation, as its own process: exit code, stdout, stderr.
 * `signedIn` runs with no endpoint and no key in the environment — the saved
 * profile is then the only place either can come from. `bin` runs a compiled
 * binary in place of the source.
 */
function cli(args, { token, tenant, stdin, signedIn = false, bin } = {}) {
  return new Promise(resolve => {
    const child = spawn(bin ?? process.execPath, bin ? args : [MAIN, ...args], {
      cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: CONFIG_HOME, XDG_CACHE_HOME: join(SCRATCH, 'cache'), FJS_CLI_TRACE: '1',
        FJS_MCP_URL: signedIn ? '' : `${API}/mcp`, FJS_TOKEN: signedIn ? '' : token ?? '',
        FJS_TENANT: tenant ?? '',
      },
    })
    child.stdin.end(stdin ?? '')
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('exit', code => {
      let json = null
      try { json = JSON.parse(out) } catch { /* human output */ }
      resolve({ code, out, err, json })
    })
  })
}
const ids = rows => (rows ?? []).map(r => r.id).sort()

// ─── The run ─────────────────────────────────────────────────────────────

console.log('\nBasecamp — the app CLI\n')

try {
  if (await answers()) throw new Error(`port ${API_PORT} is already answering — stop whatever holds it`)

  execFileSync(process.execPath, ['db/seed.js'], { cwd: ROOT, env: ENV, stdio: 'ignore' })

  const WS = new Database(DB_PATH, { readonly: true }).query(`
    select m.workspaceId as id from workspace_member m join user u on u.id = m.userId
    where u.email in (?, ?, ?, ?) group by m.workspaceId having count(*) = 4 limit 1
  `).get(OWNER, ADMIN, DEVELOPER, VIEWER)?.id
  if (!WS) throw new Error('the seed has no workspace all four people belong to')

  const api = spawn(process.execPath, ['api/index.ts'], { cwd: ROOT, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  api.out = ''
  for (const s of [api.stdout, api.stderr]) s.on('data', d => { api.out += d })
  children.push(api)
  let up = false
  for (let t = 0; t < 60_000 && !up; t += 250) { up = await answers(); if (!up) await sleep(250) }
  if (!up) throw new Error(`the API did not answer on ${API_PORT}\n${api.out.slice(-2000)}`)

  const tokens = Object.fromEntries(await Promise.all(
    [OWNER, ADMIN, DEVELOPER, VIEWER].map(async e => [e, await login(e)])))
  const owner  = await connect(tokens[OWNER],  WS)
  const viewer = await connect(tokens[VIEWER], WS)
  const rows   = (await called(viewer, 'servers_find')).data?.data ?? []
  if (!rows.length) throw new Error('the seed gave the viewer no servers to read')

  // ── derived commands ────────────────────────────────────────────────────
  console.log('  derived commands')
  const asViewer = { token: tokens[VIEWER], tenant: WS }

  const listed = await cli(['servers', 'find', '--json'], asViewer)
  check('`servers find --json` answers the rows the servers_find tool answers',
    listed.code === 0 && listed.json?.ok === true && JSON.stringify(ids(listed.json.data.data)) === JSON.stringify(ids(rows)),
    `exit ${listed.code} ${listed.err.slice(0, 200)}`)

  const status   = rows[0]?.status
  const filtered = await cli(['servers', 'find', '--status', String(status), '--quiet'], asViewer)
  const direct   = await called(viewer, 'servers_find', { query: { status } })
  check('a filter flag is the tool\'s query — the same rows, and every one of them matches',
    filtered.code === 0 && Array.isArray(filtered.json) && filtered.json.length > 0
      && filtered.json.every(r => r.status === status)
      && JSON.stringify(ids(filtered.json)) === JSON.stringify(ids(direct.data?.data)),
    `exit ${filtered.code} ${filtered.err.slice(0, 200)}`)

  const absent = await cli(['servers', 'reboot', rows[0]?.id ?? 'x'], asViewer)
  check('a command the viewer is not offered exits 2 and says so, without claiming it does not exist',
    absent.code === 2 && /not offered at your standing, or does not exist/.test(absent.err), `exit ${absent.code} ${absent.err}`)

  const typo = await cli(['servers', 'find', '--limit', 'ten'], asViewer)
  check('a value its type cannot hold exits 2, naming the flag, and nothing is sent',
    typo.code === 2 && /--limit takes a whole number/.test(typo.err), `exit ${typo.code} ${typo.err}`)

  const agent  = await cli(['servers', 'find', '--help', '--agent'], asViewer)
  const schema = (await viewer.listTools()).tools.find(t => t.name === 'servers_find')?.inputSchema
  check('`--help --agent` prints the tool\'s own input schema, verbatim',
    agent.code === 0 && JSON.stringify(agent.json) === JSON.stringify(schema))


  console.log('\n  switching the workspace')
  // Kim is an admin of both seeded workspaces, which is what makes the switch
  // visible: two answers, each wholly in the workspace it named.
  const OTHER = new Database(DB_PATH, { readonly: true }).query(`
    select m.workspaceId as id from workspace_member m join user u on u.id = m.userId
    where u.email = ? and m.workspaceId != ? limit 1
  `).get(ADMIN, WS)?.id
  const here  = await cli(['--workspace', WS, 'servers', 'find', '--quiet'], { token: tokens[ADMIN] })
  const there = await cli(['servers', 'find', '--workspace', String(OTHER), '--quiet'], { token: tokens[ADMIN] })
  check('--workspace switches the tenant, before the command or after it — each answer wholly in its own',
    !!OTHER && here.code === 0 && there.code === 0
      && here.json.length > 0 && here.json.every(r => r.workspaceId === WS)
      && there.json.every(r => r.workspaceId === OTHER)
      && !ids(here.json).some(id => ids(there.json).includes(id)),
    `exit ${here.code}/${there.code} ${here.err}${there.err}`.slice(0, 300))

  console.log('\n  signing in')
  // ── signing in with an API key (FJS-D402) ───────────────────────────────
  // The owner mints a key for the seed's bot through the CLI itself; the key is
  // then the whole credential. Scoped to `servers:read`, so the bot's own role
  // reaches `servers reboot` and the key's scope does not — and the app's
  // `narrow` leaves it out of the key's commands, so the key is never offered
  // a verb apiKeyGuard would refuse (FJS-1349).
  const BOT = new Database(DB_PATH, { readonly: true })
    .query(`select id from user where email = 'ci-deploy@bots.invalid'`).get()?.id
  const minted = await cli(['api-keys', 'create', '--userId', String(BOT), '--name', 'verify-mcp',
    '--scopes', '["servers:read"]', '--json'], { token: tokens[OWNER], tenant: WS })
  const key = minted.json?.data?.token
  check('the owner mints a bot key through `api-keys create`, and the plaintext comes back once',
    minted.code === 0 && typeof key === 'string' && key.length > 20, `exit ${minted.code} ${minted.err}${minted.out}`.slice(0, 300))

  // `login` reads the key off stdin, so it is in no argv and no shell history.
  const badKey = await cli(['--workspace', WS, 'login', '--api-key', '-', '--url', `${API}/mcp`], { stdin: 'fjs_not_a_real_key_000000000000', signedIn: true })
  check('a key the app reads as nobody is refused at login, and nothing is saved',
    badKey.code === 1 && /read this key as nobody/.test(badKey.err) && !existsSync(join(CONFIG_HOME, cliConfig.name, 'profiles.json')),
    `exit ${badKey.code} ${badKey.err}`)

  const signIn = await cli(['--workspace', WS, 'login', '--api-key', '-', '--url', `${API}/mcp`], { stdin: `${key}\n`, signedIn: true })
  const PROFILES = join(CONFIG_HOME, cliConfig.name, 'profiles.json')
  check('`login --api-key -` signs in and writes the profile 0600 under the app\'s own config directory',
    signIn.code === 0 && existsSync(PROFILES) && (statSync(PROFILES).mode & 0o777) === 0o600, `exit ${signIn.code} ${signIn.err}`)

  const byKey = await cli(['servers', 'find', '--quiet'], { signedIn: true })
  check('signed in, with no endpoint and no key in the environment, `servers find` answers the workspace\'s rows',
    byKey.code === 0 && byKey.json?.length > 0 && byKey.json.every(r => r.workspaceId === WS), `exit ${byKey.code} ${byKey.err}`)

  // A key belongs to one workspace, so naming none means its own. `--profile`
  // names one that does not exist, so the saved profile's tenant is not read.
  const unnamed = await cli(['--profile', 'no-tenant', 'servers', 'find', '--quiet'], { token: key })
  check('the key naming no workspace acts in its own — the rows are that workspace\'s',
    unnamed.code === 0 && unnamed.json?.length > 0 && unnamed.json.every(r => r.workspaceId === WS), `exit ${unnamed.code} ${unnamed.err}`.slice(0, 300))
  const person = await cli(['--profile', 'no-tenant', 'servers', 'find', '--quiet'], { token: tokens[OWNER] })
  check('and a person naming none is still asked to, since a person belongs to several',
    person.code !== 0 && /names no 'workspaceId'/.test(person.err), `exit ${person.code} ${person.err}`.slice(0, 300))

  const listing = await cli(['profiles'], { signedIn: true })
  check('`profiles` names the profile and never prints the key', listing.code === 0 && /default/.test(listing.out) && !listing.out.includes(key))

  // The pair: a session at a role that reaches reboot is offered it, so an
  // absence below is the key's scope and not the role. The admin rather than
  // the developer, whose first listing the cache rows below must see live.
  const botRole = await cli(['servers', '--help'], { token: tokens[ADMIN], tenant: WS })
  const keyTree = await cli(['servers', '--help'], { signedIn: true })
  check('an admin session is offered `servers reboot`; a servers:read key is offered `servers find` and not reboot',
    /\breboot\b/.test(botRole.out) && /\bfind\b/.test(keyTree.out) && !/\breboot\b/.test(keyTree.out),
    `${botRole.out}\n---\n${keyTree.out}`.slice(0, 400))

  const outOfScope = await cli(['servers', 'reboot', byKey.json?.[0]?.id ?? 'x'], { signedIn: true })
  check('a write outside the key\'s scope is not a command it has, and exits 2 as usage',
    outOfScope.code === 2 && /not offered at your standing/.test(outOfScope.err), `exit ${outOfScope.code} ${outOfScope.out}${outOfScope.err}`.slice(0, 300))

  console.log('\n  the command cache')
  // The tree is a quarter of a megabyte and changes per deploy, so a second run
  // at one build does not ask for it. The trace line is the only witness: both
  // answers look the same from the outside, which is the point of a cache.
  const first  = await cli(['servers', 'find', '--quiet'], { token: tokens[DEVELOPER], tenant: WS })
  const second = await cli(['servers', 'find', '--quiet'], { token: tokens[DEVELOPER], tenant: WS })
  check('the first run lists the tree live, at the build the app states',
    first.code === 0 && /tools: live, build verify-cli-build-1/.test(first.err), first.err.slice(0, 200))
  check('and the next run at that build answers from the cache, with the same rows',
    second.code === 0 && /tools: cache, build verify-cli-build-1/.test(second.err)
      && JSON.stringify(ids(second.json)) === JSON.stringify(ids(first.json)), second.err.slice(0, 200))

  console.log('\n  signing out')
  const signOut = await cli(['logout'], { signedIn: true })
  const after   = await cli(['servers', 'find'], { signedIn: true })
  check('after `logout` nothing is signed in, and a command says how to sign in',
    signOut.code === 0 && after.code === 2 && /not signed in/.test(after.err), `exit ${signOut.code}/${after.code} ${after.err}`)


  // ── --await (FJS-D406) ──────────────────────────────────────────────────
  // `jobs trigger` dispatches a Caravan `job:run` and answers at once. With
  // --await the app finds that job by the call's correlation id and holds the
  // call until it is terminal. With no outpost here it ends quickly either way —
  // `done` or `failed: no server assigned` — and either is a thing to wait for.
  console.log('\n  --await')
  const JOB = new Database(DB_PATH, { readonly: true })
    .query(`select id from job where workspaceId = ? and status != 'running' and deletedAt is null limit 1`).get(WS)?.id
  const asOwner = { token: tokens[OWNER], tenant: WS }

  const quick = await cli(['jobs', 'trigger', String(JOB), '--json'], asOwner)
  check('without --await the call answers at once and reports no jobs',
    quick.code === 0 && quick.json?.ok === true && !('jobs' in quick.json), `exit ${quick.code} ${quick.err}`)

  const held    = await cli(['jobs', 'trigger', String(JOB), '--await', '--json'], asOwner)
  const found   = held.json?.jobs ?? []
  const latest  = new Database(DB_PATH.replace('.db', '-jobs.db'), { readonly: true })
    .query(`select id, status, correlation_id from jobs where name = 'job:run' order by created_at desc limit 1`).get()
  check('with --await the call waits: it answers with the job it dispatched, found by its correlation id, already terminal',
    found.length === 1 && found[0].name === 'job:run' && found[0].id === latest?.id && !!latest?.correlation_id
      && ['done', 'failed', 'cancelled'].includes(found[0].status) && found[0].status === latest?.status,
    `exit ${held.code} jobs ${JSON.stringify(found)} latest ${JSON.stringify(latest)} ${held.err}`.slice(0, 400))
  check('and the exit code is the job\'s: 0 when it finished done, 1 when it did not',
    held.code === (found[0]?.status === 'done' ? 0 : 1) && held.json?.ok === (found[0]?.status === 'done'),
    `exit ${held.code} status ${found[0]?.status}`)
  check('progress arrived while it waited, on stderr', /· job:run: /.test(held.err), held.err.slice(0, 300))

  const nothing = await cli(['servers', 'find', '--await', '--quiet'], asOwner)
  check('--await on a call that starts no job answers at once, and says so',
    nothing.code === 0 && /started no job to wait on/.test(nothing.err), `exit ${nothing.code} ${nothing.err}`)

  // ── breadcrumbs (FJS-D398) ──────────────────────────────────────────────
  // A one-row answer names what may be done next. The moves are paired with
  // Litestone's own `transitions(row)` on the app's own client — the server's
  // answer for *what does this state allow*, which the plugin never calls —
  // narrowed to the tools the caller was offered. The relations are paired by
  // RUNNING the command line printed for each and reading where it lands.
  console.log('\n  breadcrumbs')
  const SERVER = new Database(DB_PATH, { readonly: true }).query(`
    select s.id from server s where s.workspaceId = ? and s.deletedAt is null
    order by (select count(*) from volume v where v.serverId = s.id) desc limit 1
  `).get(WS)?.id
  Object.assign(process.env, { DATABASE_URL: DB_PATH, AUDIT_PATH: ENV.AUDIT_PATH })
  const { createBasecampDb } = await import('../../api/src/core/db.ts')
  const appDb   = await createBasecampDb()
  const offered = async client => new Set((await client.listTools()).tools.map(t => t.name))
  const movesAt = async (client, row) => {
    const names = await offered(client)
    return (await appDb.asSystem().server.transitions(row)).map(t => `servers_${t.name}`).filter(n => names.has(n)).sort()
  }
  const moveCrumbs = r => (r.json?.breadcrumbs ?? []).filter(b => b.kind === 'move').map(b => b.tool).sort()

  const ownerGet  = await cli(['servers', 'get', SERVER, '--json'], asOwner)
  const viewerGet = await cli(['servers', 'get', SERVER, '--json'], asViewer)
  const row       = ownerGet.json?.data
  const ownerWant = row ? await movesAt(owner, row) : []
  check('a get names the moves the row\'s state allows among the owner\'s tools — Litestone\'s own transitions(row), narrowed',
    ownerGet.code === 0 && ownerWant.length > 0 && JSON.stringify(moveCrumbs(ownerGet)) === JSON.stringify(ownerWant),
    `status ${row?.status} got ${moveCrumbs(ownerGet)} want ${ownerWant} ${ownerGet.err}`.slice(0, 400))
  const viewerWant = row ? await movesAt(viewer, row) : []
  check('and a viewer a rung below is offered the viewer\'s own, which are fewer',
    viewerGet.code === 0 && JSON.stringify(moveCrumbs(viewerGet)) === JSON.stringify(viewerWant) && viewerWant.length < ownerWant.length,
    `viewer got ${moveCrumbs(viewerGet)} want ${viewerWant}`)

  // Human output: the row on stdout, each breadcrumb on stderr as a command.
  const human = await cli(['servers', 'get', SERVER], asOwner)
  // `FJS_CLI_TRACE` writes `· ` lines too; a breadcrumb is the one with its reason after two spaces.
  const lines = human.err.split('\n').filter(l => l.startsWith('· ') && l.includes('  — ')).map(l => l.slice(2).split('  — ')[0])
  const run   = line => cli(line.split(' '), asOwner)
  check('without --json the row is stdout and each breadcrumb is a command line on stderr',
    human.code === 0 && human.out.includes(SERVER) && lines.length === (ownerGet.json?.breadcrumbs ?? []).length,
    human.err.slice(0, 300))

  const toWorkspace = lines.find(l => l.startsWith('workspaces get '))
  const workspace   = toWorkspace ? await run(`${toWorkspace} --json`) : null
  check('the workspace it points at is a command that runs and reads that workspace',
    workspace?.code === 0 && workspace.json?.data?.id === row?.workspaceId, `${toWorkspace} → exit ${workspace?.code} ${workspace?.err}`)

  const toVolumes = lines.find(l => l.startsWith('volumes find '))
  const volumes   = toVolumes ? await run(`${toVolumes} --quiet`) : null
  const ownVolumes = new Database(DB_PATH, { readonly: true }).query('select id from volume where serverId = ?').all(SERVER)
  check('the rows pointing at it are a find that runs and lists exactly the server\'s own volumes',
    volumes?.code === 0 && ownVolumes.length > 0 && JSON.stringify(ids(volumes.json)) === JSON.stringify(ids(ownVolumes)),
    `${toVolumes} → exit ${volumes?.code} got ${ids(volumes?.json)} want ${ids(ownVolumes)}`.slice(0, 400))

  const many = await cli(['servers', 'find', '--json'], asOwner)
  check('a find answers many rows and carries none', many.code === 0 && !('breadcrumbs' in (many.json ?? {})))
  appDb.$close?.()

  // ── routes — cli/src/routes/ ────────────────────────────────────────────
  console.log('\n  routes')
  const routes = await loadRoutes(join(ROOT, 'cli', 'src', 'routes'))
  const top    = (await owner.listTools()).tools
  check('every route names only tools the app offers at its top standing — a stale route is refused by name',
    routes.length > 0 && checkRoutes(routes, top).length === 0, checkRoutes(routes, top).join('; '))

  const help = await cli(['--help'], asViewer)
  check('`--help` lists the route beside the derived commands',
    help.code === 0 && /^\s+servers\s.*\bstatus\b/m.test(help.out) && /^\s+servers\s.*\bfind\b/m.test(help.out), help.out.slice(0, 300))

  const guide = await cli(['--help', '--agent'], asViewer)
  check('`--help --agent` gives the MCP connect line for this app and workspace, names the route as shell-only, and prints no key',
    guide.code === 0 && guide.out.includes(`claude mcp add --transport http ${cliConfig.name} ${API}/mcp`)
      && guide.out.includes(`x-workspace-id: ${WS}`) && /not MCP tools[\s\S]*servers status/.test(guide.out)
      && !guide.out.includes(tokens[VIEWER]), guide.out.slice(0, 400))

  const summary = await cli(['servers', 'status', '--json'], asViewer)
  const counts  = {}
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  check('`servers status` counts the servers servers_find answers, state by state',
    summary.code === 0 && summary.json?.data?.total === rows.length && JSON.stringify(summary.json.data.counts) === JSON.stringify(counts),
    `exit ${summary.code} ${summary.err}${summary.out}`.slice(0, 300))

  const role     = rows[0].role
  const narrowed = await cli(['servers', 'status', '--role', role, '--json'], asViewer)
  check('a route\'s own flag reaches the tool it calls — --role narrows the count to that role',
    narrowed.code === 0 && narrowed.json?.data?.total === rows.filter(r => r.role === role).length, narrowed.err)

  const badRole = await cli(['servers', 'status', '--role', 'teapot'], asViewer)
  check('and is typed by the route\'s input schema like any derived flag — an unknown role exits 2',
    badRole.code === 2 && /--role is one of/.test(badRole.err), badRole.err)

  // ── the release — `fli cli:build` → cli/dist/bcamp (FJS-D397) ──────
  // Each row is the same command through the binary and through the source,
  // compared, so a binary that dropped a route or bundled a second copy of the
  // client answers differently from the program it was built from.
  console.log('\n  the binary')
  const [built] = await buildCli({ root: join(ROOT, 'cli') })
  const asBin   = { ...asViewer, bin: built.outfile }
  const binHelp = await cli(['--help'], asBin)
  check('the binary\'s --help is the source\'s, route included',
    binHelp.code === 0 && binHelp.out === help.out && /^\s+servers\s.*\bstatus\b/m.test(binHelp.out), `exit ${binHelp.code} ${binHelp.err}`.slice(0, 300))
  const binSummary = await cli(['servers', 'status', '--json'], asBin)
  check('and its route answers what the source\'s does',
    binSummary.code === 0 && JSON.stringify(binSummary.json) === JSON.stringify(summary.json), `exit ${binSummary.code} ${binSummary.err}`.slice(0, 300))
  const binBad = await cli(['servers', 'status', '--role', 'teapot'], asBin)
  check('and refuses the flag the source refuses, with the same exit',
    binBad.code === badRole.code && binBad.err === badRole.err, binBad.err)

  // The build is the one way in: compiled by hand, routes/ is not embedded.
  const byHand = join(SCRATCH, 'by-hand')
  execFileSync(process.execPath, ['build', '--compile', MAIN, '--outfile', byHand], { cwd: ROOT, stdio: 'ignore' })
  const handRun = await cli(['servers', 'status'], { ...asViewer, bin: byHand })
  check('a binary compiled by hand refuses to start rather than offer half its commands',
    handRun.code === 1 && /compiled without its routes.*fli cli:build/.test(handRun.err), `exit ${handRun.code} ${handRun.err}`.slice(0, 300))

  for (const c of [owner, viewer]) await c.close().catch(() => {})
} catch (err) {
  check('the run completed', false, err?.stack ?? String(err))
} finally {
  await cleanup()
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`)
process.exit(failed ? 1 : 0)
