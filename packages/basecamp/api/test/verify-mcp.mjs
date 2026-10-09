/*
 * verify-mcp.mjs — basecamp's agent surface, spoken to by a REAL MCP client.
 *
 *   bun run verify:mcp
 *
 * `example`'s `verify:mcp` is the protocol against `strategy database`, where a
 * standing travels with the user. This is the other shape and the one only this
 * app has: `strategy row` with `membershipClaim`, where the standing is *admin of
 * THIS workspace* — a claim the principal resolver adds per call off a
 * `WorkspaceMember` row, which the session does not carry. A projection graded
 * off the session offers an admin and a viewer one identical list, and that is
 * what the first measurement here found (`docs/changes-archive/mcp.md`).
 *
 * What it gates is the RELATIONS — the ladder is strictly ordered, each rung a
 * named tool apart, the tenant scopes the rows — and never the counts, which are
 * `FJS-773`'s failure the moment a service gains a method.
 *
 * No browser. Its own database, seeded, and the API on test-tier 7120.
 *
 * Traps, each paid for once:
 *   - The workspace is a HEADER (`x-workspace-id`, read by `resolveWorkspaceId`).
 *     A client naming none holds no role, and the list it gets is the bare
 *     sign-in's — so every rung below sends it, and one row asks the no-header
 *     case on purpose.
 *   - A port that answers is not evidence the right process is on it. 7120 is
 *     REFUSED if held at the start (`FJS-740`).
 *   - Its own database: DATABASE_URL and AUDIT_PATH point into a temp directory.
 *     Seeding `db/` instead wrecks whatever else is running off it.
 *   - Runs under bun: the seed and the workspace lookup reach `bun:sqlite`.
 */

import { spawn, execFileSync }       from 'node:child_process'
import { mkdtempSync, rmSync }       from 'node:fs'
import { tmpdir }                    from 'node:os'
import { dirname, join }             from 'node:path'
import { fileURLToPath }             from 'node:url'
import { Database }                  from 'bun:sqlite'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API_PORT = 7120
const API      = `http://localhost:${API_PORT}`
const SCRATCH  = mkdtempSync(join(tmpdir(), 'basecamp-mcp-'))
const DB_PATH  = join(SCRATCH, 'basecamp.db')

// The seed's people and their roles in the workspaces they share (`db/seed.js`).
const PASSWORD = 'hunter2hunter2'
const OWNER = 'sam@example.com', ADMIN = 'kim@example.com', DEVELOPER = 'remy@example.com', VIEWER = 'jo@example.com'

const ENV = {
  ...process.env,
  DATABASE_URL: DB_PATH,
  AUDIT_PATH:   join(SCRATCH, 'audit/'),
  PORT:         String(API_PORT),
  // The workbench is offered here, so withholding it is not the refusal every
  // non-local API gives. A stand-in that exits at once, so a hole costs no run.
  LOCAL_MACHINE: '1',
  WORKBENCH_DIR: join(SCRATCH, 'workbench'),
  CLAUDE_BIN:    '/bin/false',
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
  const body = await res.json()
  const token = body.token ?? body.data?.token
  if (!token) throw new Error(`login ${email}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  return token
}

// One real client per standing. `connect()` is the handshake, so a server that
// gets the protocol wrong fails here rather than in a count.
async function connect(token, workspace) {
  const client = new Client({ name: 'verify-mcp', version: '1.0.0' })
  const headers = { authorization: `Bearer ${token}`, ...(workspace ? { 'x-workspace-id': workspace } : {}) }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers } }))
  return client
}


const names  = async client => new Set((await client.listTools()).tools.map(t => t.name))
const called = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }).catch(e => ({ isError: true, content: [{ text: String(e) }] }))
  const text = r.content?.[0]?.text ?? ''
  let data = null
  try { data = JSON.parse(text) } catch { /* a refusal is prose */ }
  return { refused: !!r.isError, text, data }
}

// ─── The run ─────────────────────────────────────────────────────────────

console.log('\nBasecamp — the agent surface\n')

try {
  if (await answers()) throw new Error(`port ${API_PORT} is already answering — stop whatever holds it`)

  execFileSync(process.execPath, ['db/seed.js'], { cwd: ROOT, env: ENV, stdio: 'ignore' })

  // A workspace all four belong to, read off the seed rather than named, so a
  // reseeded id changes nothing here.
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

  const owner     = await connect(tokens[OWNER],     WS)
  const admin     = await connect(tokens[ADMIN],     WS)
  const developer = await connect(tokens[DEVELOPER], WS)
  const viewer    = await connect(tokens[VIEWER],    WS)
  const nowhere   = await connect(tokens[ADMIN])
  check('a real MCP client completes the handshake at every standing', true)

  const list = {
    owner: await names(owner), admin: await names(admin), developer: await names(developer),
    viewer: await names(viewer), nowhere: await names(nowhere),
  }

  // ── the ladder is the membership role, not the session ──────────────────
  console.log('\n  the ladder')
  const within = (a, b) => [...a].every(n => b.has(n))
  check('viewer ⊂ developer ⊂ admin ⊆ owner, each list containing the one below',
    within(list.viewer, list.developer) && within(list.developer, list.admin) && within(list.admin, list.owner))
  check('and each workspace rung is strictly larger — three roles are three lists',
    list.viewer.size < list.developer.size && list.developer.size < list.admin.size,
    `viewer ${list.viewer.size} · developer ${list.developer.size} · admin ${list.admin.size}`)

  // Each rung a NAMED tool apart, asked as a pair, because a list that offered
  // everybody everything and one that offered nobody anything both satisfy a
  // size comparison run the wrong way round.
  const pair = (tool, below, above, b, a) =>
    check(`${tool}: offered to the ${a}, not to the ${b}`, !below.has(tool) && above.has(tool))
  pair('servers_reboot',    list.viewer,    list.developer, 'viewer',    'developer')
  pair('alerts_create',     list.developer, list.admin,     'developer', 'admin')
  pair('workspaces_remove', list.admin,     list.owner,     'admin',     'owner')

  check('the admin naming no workspace holds no role, and is offered less than the viewer who names one',
    list.nowhere.size < list.viewer.size && !list.nowhere.has('servers_find'),
    `no workspace ${list.nowhere.size} · viewer ${list.viewer.size}`)

  // ── a call runs as the caller, in the workspace the header named ────────
  console.log('\n  a call')
  const servers = await called(viewer, 'servers_find')
  const rows    = servers.data?.data ?? []
  check('the viewer reads servers through the tool', !servers.refused && rows.length > 0, servers.text.slice(0, 200))
  check('and every row is in the workspace the header named', rows.length > 0 && rows.every(r => r.workspaceId === WS))

  const reboot = await called(viewer, 'servers_reboot', { id: rows[0]?.id ?? 'x' })
  check('a tool the viewer was not offered fails closed when called anyway', reboot.refused, reboot.text.slice(0, 200))

  // ── a service over no model, graded by the level it declares ────────────
  // `FJS-1342`: the hub has no model, and while its standing was a hook every
  // member was OFFERED `hub_setSystemAdmin`. Each method declares SYSADMIN now
  // (`FJS-D408`), so the list and the boundary read one number. The seed's
  // owner is the system administrator — the pair.
  console.log('\n  the hub tier')
  pair('hub_setSystemAdmin', list.admin, list.owner, 'workspace admin', 'system administrator')
  pair('conduit-targets_remove', list.admin, list.owner, 'workspace admin', 'system administrator')
  const promote = await called(viewer, 'hub_setSystemAdmin', { id: 'x', data: { isSystemAdmin: true } })
  check('hub_setSystemAdmin called by a viewer anyway fails closed', promote.refused, promote.text.slice(0, 200))
  const hub = await called(owner, 'hub_users')
  check('and the same hub read answers a system administrator — the refusal is about the caller', !hub.refused, hub.text.slice(0, 200))
  // The plugin names at boot every tool on a model-less service that declares
  // no level. The phrase is packages/mcp/src/plugin.ts `disclose`'s.
  const ungraded = api.out.split('\n').find(l => l.includes('graded by nothing'))
  check('and the boot names no model-less tool as graded by nothing', !ungraded, ungraded)

  // ── the workbench is the operator's, never an agent's ───────────────────
  // Each send is `claude -p` with permissions bypassed in a checkout on this
  // machine, so an agent holding it reaches past its own standing.
  console.log('\n  the workbench')
  const benched = Object.entries(list).filter(([, l]) => [...l].some(n => n.startsWith('workbench_')))
  check('no rung, the owner included, is offered a workbench tool', !benched.length,
    benched.map(([r, l]) => `${r}: ${[...l].filter(n => n.startsWith('workbench_')).join(', ')}`).join(' · '))
  // `pins` and not `send`: it answers under LOCAL_MACHINE=1 with nothing
  // pinned, so a refusal here is the agent's and not an unknown pin id's.
  const pins = await called(owner, 'workbench_pins')
  check('and workbench_pins called by the owner anyway fails closed', pins.refused, pins.text.slice(0, 200))

  for (const c of [owner, admin, developer, viewer, nowhere]) await c.close().catch(() => {})
} catch (err) {
  check('the run completed', false, err?.stack ?? String(err))
} finally {
  await cleanup()
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`)
process.exit(failed ? 1 : 0)
