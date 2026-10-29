// src/providers/outpost-dev.ts — this laptop, enrolled as a machine in the fleet.
//
// Stands the REAL Outpost up beside a running dev API, so a release has somewhere
// to go: log in, find or make the Server row, enroll it under a key pair made
// here, start the Outpost with that key and the hub's, and wait until its
// heartbeat brings the row online.
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
// and `db:reset` removes the directory too, since a key for a database that
// no longer exists is a credential for nothing.
//
// Signs in as the seed's owner unless told otherwise. Enrolling a machine is an
// admin's act (`issueEnrollment` is admin/owner), so the credentials must be a
// person who holds that in the workspace named:
//
//   BASECAMP_EMAIL · BASECAMP_PASSWORD   default: the seed's dev@knight.works
//   BASECAMP_WORKSPACE                   a slug or a name; default: the first
//   BASECAMP_URL                         default: http://localhost:8120
//
// Ports 8180 (commands) and 8181 (the static origin) are the Outpost's own
// (`packages/cli/core/ports.js`, project 8), plus a branch's offset. A port that already answers is
// REFUSED rather than shared: the heartbeat would register whichever process
// holds it, and every release would go to a machine this script did not start.

import { spawn }                                    from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection }                         from 'node:net'
import { hostname }                                 from 'node:os'
import { dirname, join }                            from 'node:path'
import { fileURLToPath }                            from 'node:url'
import { portFor }                                  from '@frontierjs/cli/core/ports.js'
import { createJunctionClient }                     from '@frontierjs/junction/client'
import { generateSigningKeys }                      from '@frontierjs/toolbelt/signature'
import { ensureCert }                               from '@frontierjs/outpost/cert'

const API          = (process.env.BASECAMP_URL ?? 'http://localhost:8120').replace(/\/$/, '')
const EMAIL        = process.env.BASECAMP_EMAIL    ?? 'dev@knight.works'
const PASSWORD     = process.env.BASECAMP_PASSWORD ?? 'test1234'
const WORKSPACE    = process.env.BASECAMP_WORKSPACE
// From the formula, not a literal: in a branch the offset moves both, and the
// drive that reaches them asks the same function (`FJS-2497`).
const PORT         = await portFor(import.meta.url, 'be', { env: 'dev', project: 'outpost' })
const STATIC_PORT  = await portFor(import.meta.url, 'be', { env: 'dev', project: 'outpost', service: 1 })

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

// ─── The API ─────────────────────────────────────────────────────────────

const client = createJunctionClient({ url: API })

/** A client call that failed, as this script's refusal. The client throws the
 *  service's own sentence, which names what to fix far more often than a status
 *  code does. */
const refuse = (what: string, hint?: string) => (err: any): never =>
  fail(`${what}: ${err?.message ?? err}`, hint)

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

const session = await client.auth.signIn(EMAIL, PASSWORD).catch(refuse(`could not sign in as ${EMAIL}`,
  'A seeded database has this account (`bun run db:seed`); otherwise set BASECAMP_EMAIL and BASECAMP_PASSWORD.'))
if (!('token' in session))
  fail(`${EMAIL} owes a second factor`, 'Sign in as an account without one — this script has no code to give.')
// Signing in opens the client's socket. The calls below are HTTP, each stating
// its workspace, and a socket opening mid-script would take the later ones.
client.disconnect()

const workspaces: any[] = (await client.service('workspaces').find().catch(refuse('could not list workspaces'))).data
const workspace  = WORKSPACE
  ? workspaces.find((w: any) => w.slug === WORKSPACE || w.name === WORKSPACE)
  : workspaces[0]
if (!workspace)
  fail(WORKSPACE ? `${EMAIL} is not in a workspace called '${WORKSPACE}'` : `${EMAIL} is in no workspace`,
    workspaces.length ? `Theirs: ${workspaces.map((w: any) => w.slug).join(', ')}` : undefined)
client.setWorkspace(workspace.id)
const servers = client.service('servers')

// ─── The machine ─────────────────────────────────────────────────────────

interface Machine { api: string; workspaceId: string; serverId: string; signingKey: string; hubKey: string; cert?: string }

// The command port's certificate. Kept across runs, because the enrolled row
// pins exactly this one — the same TLS a fleet machine speaks, not a loopback
// exemption beside it (`FJS-1603`).
const tls = ensureCert(join(HOME, 'tls'))

function remembered(): Machine | null {
  if (!existsSync(MACHINE_FILE)) return null
  try { return JSON.parse(readFileSync(MACHINE_FILE, 'utf8')) } catch { return null }
}

/** The row, if this caller can still see it. A reset database answers 404 and
 *  a different workspace answers nothing — either way the identity is stale. */
async function stillThere(serverId: string) {
  return servers.get(serverId).catch(() => null) as Promise<any>
}

async function enroll(): Promise<Machine> {
  // The row this laptop left behind, if the file went and the database did not.
  let server: any = (await servers.find({ slug: SLUG }, { limit: 1 }).catch(refuse('could not look for this machine'))).data[0] ?? null

  if (!server)
    server = await servers.create({
      name: `${SLUG} (${hostname()})`, slug: SLUG, ipAddress: '127.0.0.1', role: 'general',
    }).catch(refuse('could not add this machine to the fleet'))

  const issued: any = await servers.invoke('issueEnrollment', server.id).catch(
    refuse(`could not issue an enrollment for ${SLUG}`,
      `Enrolling a machine takes an admin or an owner of '${workspace.slug}'.`))

  // The exchange is the machine's own door: a route with no session, which
  // the install script reaches with curl. Not a service call, so not the client's.
  // `token` beside the command, not scraped out of it: this is an installer,
  // and the command is written for a person pasting into a shell.
  const keys = await generateSigningKeys()
  const res = await fetch(`${API}/servers/${server.id}/enroll`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ token: issued.token, cert: tls.cert, publicKey: keys.publicKey }),
  })
  const exchanged: any = await res.json().catch(() => null)
  if (!res.ok) fail(`the enrollment was refused: ${exchanged?.message ?? `HTTP ${res.status}`}`)

  const machine = { api: API, workspaceId: workspace.id, serverId: server.id,
                    signingKey: keys.privateKey, hubKey: exchanged.hubKey, cert: tls.cert }
  mkdirSync(HOME, { recursive: true })
  // This machine's own key: whoever reads it can sign as it.
  writeFileSync(MACHINE_FILE, JSON.stringify(machine, null, 2) + '\n', { mode: 0o600 })
  return machine
}

let machine = remembered()
// A different certificate is a different machine as far as the pin is
// concerned, and one remembered from before the pin existed holds none; a
// file holding no key pair predates FJS-D1604, and the row refuses its signature.
if (!machine || machine.api !== API || machine.workspaceId !== workspace.id || machine.cert !== tls.cert
    || !machine.signingKey || !machine.hubKey
    || !(await stillThere(machine.serverId)))
  machine = await enroll()

// ─── The Outpost ─────────────────────────────────────────────────────────

const entry = fileURLToPath(import.meta.resolve('@frontierjs/outpost'))
mkdirSync(join(HOME, 'static'), { recursive: true })
mkdirSync(join(HOME, 'work'),   { recursive: true })
mkdirSync(join(HOME, 'restore'), { recursive: true })

const child = spawn(process.execPath, [entry], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    OUTPOST_SERVER_ID:   machine.serverId,
    OUTPOST_SIGNING_KEY: machine.signingKey,
    OUTPOST_HUB_KEY:     machine.hubKey,
    BASECAMP_URL:        API,
    OUTPOST_PORT:        String(PORT),
    OUTPOST_PUBLIC_URL:  `https://localhost:${PORT}`,
    OUTPOST_TLS_CERT:    tls.certPath,
    OUTPOST_TLS_KEY:     tls.keyPath,
    OUTPOST_STATIC_PORT: String(STATIC_PORT),
    OUTPOST_STATIC_URL:  `http://localhost:${STATIC_PORT}`,
    OUTPOST_STATIC_DIR:  join(HOME, 'static'),
    OUTPOST_WORK_DIR:    join(HOME, 'work'),
    // Where an archive for `apps.restoreVolume` is copied. Under the app root,
    // because a snap-packaged docker cannot bind-mount the host's /tmp.
    OUTPOST_RESTORE_DIR: join(HOME, 'restore'),
    // Where `app-backups.take` has the machine write an archive.
    OUTPOST_BACKUP_DIR:  join(HOME, 'backups'),
    // Each App's clone key; the machine's default is under /var/lib, which a
    // laptop's user cannot write.
    OUTPOST_DEPLOY_KEY_DIR: join(HOME, 'deploy-keys'),
    // Each App's data, bind-mounted at its volumePath; the machine's default
    // is under /var/lib, which a laptop's user cannot write.
    OUTPOST_APPS_DIR:    join(HOME, 'apps'),
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
