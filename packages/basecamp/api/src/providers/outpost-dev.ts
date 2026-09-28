// src/providers/outpost-dev.ts — this laptop, enrolled as a machine in the fleet.
//
// Stands the REAL Outpost up beside a running dev API, so a release has somewhere
// to go: log in, find or make the Server row, enroll it, start the Outpost with
// the secret the exchange handed back, and wait until its heartbeat brings the
// row online.
//
//   bun run dev             # the API and the SPA, first
//   bun run dev:outpost     # then this
//
// Without it the only executors in development are the stub, which answers
// every route and does nothing, and a refusal. The stub is honest about that —
// every step it touches says *no /deploy was issued* — but an inline app
// released through it serves nothing, and that is the one kind a person can
// check by opening a URL.
//
// The identity is REMEMBERED in `.outpost/machine.json`, so a restart reuses the
// same Server row rather than adding one to the fleet per run. It is thrown away
// when the row it names has gone, which is what `bun run db:reset` does to it —
// and `db:reset` removes the directory too, since a secret for a database that
// no longer exists is a credential for nothing.
//
// Signs in as the seed's owner unless told otherwise. Enrolling a machine is an
// admin's act (`issueEnrollment` is admin/owner), so the credentials must be a
// person who holds that in the workspace named:
//
//   BASECAMP_EMAIL · BASECAMP_PASSWORD   default: the seed's sam@example.com
//   BASECAMP_WORKSPACE                   a slug or a name; default: the first
//   BASECAMP_URL                         default: http://localhost:8120
//
// Ports 8180 (commands) and 8181 (the static origin) are the Outpost's own
// (`packages/cli/core/ports.js`, project 8). A port that already answers is
// REFUSED rather than shared: the heartbeat would register whichever process
// holds it, and every release would go to a machine this script did not start.

import { spawn }                                    from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection }                         from 'node:net'
import { hostname }                                 from 'node:os'
import { dirname, join }                            from 'node:path'
import { fileURLToPath }                            from 'node:url'

const API          = (process.env.BASECAMP_URL ?? 'http://localhost:8120').replace(/\/$/, '')
const EMAIL        = process.env.BASECAMP_EMAIL    ?? 'sam@example.com'
const PASSWORD     = process.env.BASECAMP_PASSWORD ?? 'hunter2hunter2'
const WORKSPACE    = process.env.BASECAMP_WORKSPACE
const PORT         = 8180
const STATIC_PORT  = 8181

const APP_ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HOME         = join(APP_ROOT, '.outpost')
const MACHINE_FILE = join(HOME, 'machine.json')

/** The Server row this laptop is. One slug per workspace, so a lost
 *  `machine.json` finds the row it left behind rather than colliding on the
 *  unique slug with a create. */
const SLUG = 'dev-outpost'

const say  = (line: string) => console.log(`  ${line}`)
const fail = (line: string, hint?: string): never => {
  console.error(`\n  ✗ ${line}${hint ? `\n    ${hint}` : ''}\n`)
  process.exit(1)
}

// ─── HTTP ────────────────────────────────────────────────────────────────

interface Call { method?: string; body?: unknown; token?: string; workspace?: string; serviceMethod?: string }

async function call(path: string, o: Call = {}) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (o.body)          headers['content-type']     = 'application/json'
  if (o.token)         headers.authorization       = `Bearer ${o.token}`
  if (o.workspace)     headers['x-workspace-id']   = o.workspace
  if (o.serviceMethod) headers['x-service-method'] = o.serviceMethod

  const res  = await fetch(API + path, {
    method: o.method ?? (o.body || o.serviceMethod ? 'POST' : 'GET'),
    headers,
    body:   o.body ? JSON.stringify(o.body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  return { ok: res.ok, status: res.status, data }
}

/** The service's own sentence, which names what to fix far more often than a
 *  status code does. */
const said = (r: { status: number; data: any }) => r.data?.message ?? `HTTP ${r.status}`

// ─── Preflight ───────────────────────────────────────────────────────────

function answers(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error',   () => resolve(false))
  })
}

async function apiUp(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (await fetch(`${API}/health`).then(r => r.ok, () => false)) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

for (const port of [PORT, STATIC_PORT])
  if (await answers(port))
    fail(`port ${port} is already answering`,
      'Another Outpost is up — `bun run stop` stops this one; anything else holding it has to go first.')

if (!(await apiUp()))
  fail(`no API at ${API}`, 'Start it first: `bun run dev` (or `bun run api`).')

// ─── Who, and where ──────────────────────────────────────────────────────

const login = await call('/auth/login', { body: { email: EMAIL, password: PASSWORD } })
if (!login.ok)
  fail(`could not sign in as ${EMAIL}: ${said(login)}`,
    'A seeded database has this account (`bun run db:seed`); otherwise set BASECAMP_EMAIL and BASECAMP_PASSWORD.')
const token = login.data.token as string

const workspaces = (await call('/workspaces', { token })).data?.data ?? []
const workspace  = WORKSPACE
  ? workspaces.find((w: any) => w.slug === WORKSPACE || w.name === WORKSPACE)
  : workspaces[0]
if (!workspace)
  fail(WORKSPACE ? `${EMAIL} is not in a workspace called '${WORKSPACE}'` : `${EMAIL} is in no workspace`,
    workspaces.length ? `Theirs: ${workspaces.map((w: any) => w.slug).join(', ')}` : undefined)

// ─── The machine ─────────────────────────────────────────────────────────

interface Machine { api: string; workspaceId: string; serverId: string; secret: string }

function remembered(): Machine | null {
  if (!existsSync(MACHINE_FILE)) return null
  try { return JSON.parse(readFileSync(MACHINE_FILE, 'utf8')) } catch { return null }
}

/** The row, if this caller can still see it. A reset database answers 404 and
 *  a different workspace answers nothing — either way the identity is stale. */
async function stillThere(serverId: string) {
  const r = await call(`/servers/${serverId}`, { token, workspace: workspace.id })
  return r.ok ? r.data : null
}

async function enroll(): Promise<Machine> {
  // The row this laptop left behind, if the file went and the database did not.
  // Paged rather than filtered: `servers.find` builds its own where-clause and
  // honors no slug, so the row is found by walking the list.
  let server: any = null
  for (let offset = 0; !server; offset += 200) {
    const page = (await call(`/servers?$limit=200&$offset=${offset}`, { token, workspace: workspace.id })).data
    server = (page?.data ?? []).find((s: any) => s.slug === SLUG) ?? null
    if (!page?.data?.length || offset + 200 >= (page.total ?? 0)) break
  }

  if (!server) {
    const made = await call('/servers', { token, workspace: workspace.id, body: {
      name: `${SLUG} (${hostname()})`, slug: SLUG, ipAddress: '127.0.0.1', role: 'general',
    } })
    if (!made.ok) fail(`could not add this machine to the fleet: ${said(made)}`)
    server = made.data
  }

  const issued = await call(`/servers/${server.id}`, {
    token, workspace: workspace.id, serviceMethod: 'issueEnrollment' })
  if (!issued.ok)
    fail(`could not issue an enrollment for ${SLUG}: ${said(issued)}`,
      `Enrolling a machine takes an admin or an owner of '${workspace.slug}'.`)

  // `token` beside the command, not scraped out of it: this is an installer,
  // and the command is written for a person pasting into a shell.
  const exchanged = await call(`/servers/${server.id}/enroll`, { body: { token: issued.data.token } })
  if (!exchanged.ok) fail(`the enrollment was refused: ${said(exchanged)}`)

  const machine = { api: API, workspaceId: workspace.id, serverId: server.id, secret: exchanged.data.secret }
  mkdirSync(HOME, { recursive: true })
  // This machine's own key: whoever reads it can sign as it.
  writeFileSync(MACHINE_FILE, JSON.stringify(machine, null, 2) + '\n', { mode: 0o600 })
  return machine
}

let machine = remembered()
if (!machine || machine.api !== API || machine.workspaceId !== workspace.id || !(await stillThere(machine.serverId)))
  machine = await enroll()

// ─── The Outpost ─────────────────────────────────────────────────────────

const entry = fileURLToPath(import.meta.resolve('@frontierjs/outpost'))
mkdirSync(join(HOME, 'static'), { recursive: true })
mkdirSync(join(HOME, 'work'),   { recursive: true })

const child = spawn(process.execPath, [entry], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    OUTPOST_SERVER_ID:   machine.serverId,
    OUTPOST_SECRET:      machine.secret,
    BASECAMP_URL:        API,
    OUTPOST_PORT:        String(PORT),
    OUTPOST_PUBLIC_URL:  `http://localhost:${PORT}`,
    OUTPOST_STATIC_PORT: String(STATIC_PORT),
    OUTPOST_STATIC_URL:  `http://localhost:${STATIC_PORT}`,
    OUTPOST_STATIC_DIR:  join(HOME, 'static'),
    OUTPOST_WORK_DIR:    join(HOME, 'work'),
  },
})

const prefix = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
  let buf = ''
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) out.write(`  outpost │ ${line}\n`)
  })
}
prefix(child.stdout!, process.stdout)
prefix(child.stderr!, process.stderr)

// The child is this process's to stop. A SIGTERM from `bun run stop` that
// reached only the parent would leave the Outpost holding both ports, and the
// next run would refuse them with nothing visibly running.
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => { child.kill(signal) })
child.on('exit', (code) => process.exit(code ?? 0))

// ─── Ready is ONLINE, not started ────────────────────────────────────────
// The Outpost printing its banner says the process is up. What makes a release
// possible is its first heartbeat landing — that is what registers the Conduit
// target and moves the row online — so that is what this waits for.

let online = false
for (let i = 0; i < 20 && !online; i++) {
  await new Promise(r => setTimeout(r, 1000))
  online = (await stillThere(machine.serverId))?.status === 'online'
}

if (!online) {
  say(`✗ ${SLUG} did not come online — the heartbeat has not landed. The Outpost's own lines above say why.`)
} else {
  console.log(`
  ✓ ${SLUG} is online in '${workspace.slug}'

    releases go to   http://localhost:${PORT}
    inline apps at   http://localhost:${STATIC_PORT}/<app slug>/
    files on disk    ${join(HOME, 'static')}

    Place an app on '${SLUG}' from its screen, then deploy it.
`)
}
