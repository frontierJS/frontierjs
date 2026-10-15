/**
 * scripts/share.mjs — Haven's API on https://haven.knightly.dev, for the first
 * people who are not on this machine. Started by `bun run share`.
 *
 * The API and the tunnel start together because the setting that makes the
 * visitor's address survive (`FJS_TRUST_PROXY=1`, one hop) is right only behind
 * cloudflared. Apart, a tunnel with the setting off keys every visitor as
 * 127.0.0.1, so one stranger's failed logins lock out everyone
 * (`IDEAS/tunnel.md`, `FJS-1841`).
 *
 * A port that already answers is refused, not reused: it serves the code it
 * started with, and that is not the process this run would be tunnelling
 * (`FJS-740`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = Number(process.env.PORT ?? 5505)
const LOCAL = `http://localhost:${PORT}`
const CLIENT = '/haven/client'
// Both are `fli tunnel`'s: the named tunnel in ~/.cloudflared/, and the public
// hostname its dashboard routes to this machine's port. The hostname is also
// the default of `fli haven` (cli commands/haven/walk.md).
const TUNNEL = 'local-dev'
const PUBLIC_URL = 'https://haven.knightly.dev'

const fail = (msg) => {
  console.error(`share: ${msg}`)
  process.exit(1)
}
const answers = async (url) => {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).error) {
  fail('cloudflared is not on the PATH (https://github.com/cloudflare/cloudflared)')
}
if (await answers(LOCAL + CLIENT)) {
  fail(`${LOCAL} already answers, so it is not the API this run would start. Stop it, or set PORT.`)
}

const children = []
const stop = () => {
  for (const c of children) {
    try {
      c.kill()
    } catch {}
  }
}
process.on('exit', stop)
process.on('SIGINT', () => {
  stop()
  process.exit(130)
})
process.on('SIGTERM', () => {
  stop()
  process.exit(143)
})

// The key digests session tokens. Every `fli haven` signs a fresh login and
// keeps no session on disk, so a key that dies with this run costs nothing.
const api = spawn(process.execPath, ['api/index.ts'], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    FJS_TRUST_PROXY: '1',
    HAVEN_SESSION_KEY: process.env.HAVEN_SESSION_KEY || randomBytes(32).toString('hex')
  }
})
children.push(api)
api.on('exit', (code) => {
  stop()
  fail(`the API exited (${code}) before the tunnel was up`)
})

let up = false
for (let i = 0; i < 80 && !up; i++) {
  up = await answers(LOCAL + CLIENT)
  if (!up) await sleep(250)
}
if (!up) fail(`the API never answered on ${LOCAL}`)

const tunnel = spawn('cloudflared', ['tunnel', 'run', TUNNEL], { stdio: ['ignore', 'ignore', 'inherit'] })
children.push(tunnel)
tunnel.on('exit', (code) => {
  stop()
  fail(`cloudflared exited (${code})`)
})

// A hostname the tunnel does not route answers 404 or a Cloudflare error page,
// and /haven/client is the only path that says it is this API.
let reachable = false
for (let i = 0; i < 40 && !reachable; i++) {
  reachable = await answers(PUBLIC_URL + CLIENT)
  if (!reachable) await sleep(1000)
}
if (!reachable) {
  fail(
    `${PUBLIC_URL} never answered ${CLIENT}. Is haven.knightly.dev a public hostname of tunnel ${TUNNEL} pointing at ${LOCAL}?`
  )
}

console.log(`
Haven is public at ${PUBLIC_URL}
  trust setting  FJS_TRUST_PROXY=1 (one hop: cloudflared appends the visitor's address)
  a friend runs  fli haven --nick <name>   (from a checkout: add --api ${PUBLIC_URL})
  you run        fli haven --api ${PUBLIC_URL}
Ctrl-C stops the API and the tunnel.
`)

await new Promise(() => {})
