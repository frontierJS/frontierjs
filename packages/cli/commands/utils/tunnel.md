---
title: utils:tunnel
description: Put a local port on a public https URL — a fixed hostname through a Cloudflare named tunnel, else a random trycloudflare.com one
alias: tunnel
examples:
  - fli tunnel
  - fli tunnel 8000
  - fli tunnel --host demo.example.com
  - fli tunnel 8000 --host demo.example.com
  - fli tunnel --dry
args:
  -
    name: port
    description: The local port to share (default this app's web port, else its API's)
flags:
  host:
    type: string
    description: The hostname to serve, through a Cloudflare named tunnel (default <package name>.$FLI_TUNNEL_DOMAIN when that is set and this directory has a package.json, else a quick tunnel)
    defaultValue: ''
---

Shares a server already running, in one of two shapes (`core/public-tunnel.js`):

- **A named tunnel** at `--host <host>`, or at `<package name>.<FLI_TUNNEL_DOMAIN>`
  when that variable is set and this directory has a `package.json`: the same
  `https://` URL every run, on a zone the `cf` login reaches. fli finds or makes
  the tunnel `fli-<host, dots as dashes>` and its proxied CNAME; a record already
  on the name that is not this tunnel's CNAME is refused by name. A host or
  domain never falls back to a quick tunnel; a run that cannot make the named
  one stops with the cause.
- **A quick tunnel** otherwise: no account, a fresh `*.trycloudflare.com` name
  each run.

With no port it shares this app's web surface, which serves the whole app
because vite proxies `/api` and `/ws`.

**This opens a tunnel to a server already running, and cannot change how that
server was started.** A Junction API behind it needs `FRONTIER_TRUST_PROXY=1`,
or every visitor is 127.0.0.1 and one stranger's failed logins lock out
everyone (`FJS-1841`); vite needs the host allowed. `fli dev --tunnel` starts
the servers with both, which is why it is the one to reach for.

<script>
import { readFileSync } from 'fs'
import { resolve } from 'path'

const core = name => import(resolve(global.fliRoot, `core/${name}.js`))

function readManifest(root) {
  try { return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) } catch { return null }
}

// The port `fli dev` would give this app's web surface, else its API.
async function defaultPort(root, manifest) {
  const { appPorts } = await core('ports')
  const rows = appPorts(root, { name: manifest?.name, scripts: manifest?.scripts })
  return (rows.find(r => r.surface === 'web') ?? rows.find(r => r.surface === 'api'))?.port ?? null
}

// An explicit host wins; a domain with a package.json to name it is the host
// `fli dev --tunnel` would use; otherwise a quick tunnel.
async function chooseTunnel({ log, flag }, manifest) {
  const { tunnelHost } = await core('public-tunnel')
  const asked = flag.host || (process.env.FLI_TUNNEL_DOMAIN && manifest ? 'true' : '')
  try {
    return tunnelHost({ flag: asked, domain: process.env.FLI_TUNNEL_DOMAIN, packageName: manifest?.name }) ?? { mode: 'quick' }
  } catch (err) {
    log.error(err.message)
    process.exit(1)
  }
}

async function sayDry({ log }, share, port) {
  const { quickTunnelArgs, namedTunnelArgs, tunnelName } = await core('public-tunnel')
  if (share.mode === 'quick') { log.dry(`Would run:   cloudflared ${quickTunnelArgs(port).join(' ')}`); return }
  log.dry(`Would find or make the Cloudflare tunnel ${tunnelName(share.host)} and a proxied CNAME for ${share.host}`)
  log.dry(`Would run:   cloudflared ${namedTunnelArgs(port).join(' ')}   (token in TUNNEL_TOKEN)`)
  log.dry(`Would serve: https://${share.host} → localhost:${port}`)
}

// Any refusal here ends the run: the named tunnel has no quick-tunnel fallback.
async function open({ log }, share, port) {
  const pub = await core('public-tunnel')
  try {
    if (share.mode === 'quick') return { ...await pub.openQuickTunnel(port), shape: 'quick tunnel' }
    const prepared = await pub.prepareNamedTunnel(share.host)
    const made = prepared.created.tunnel || prepared.created.record
    return { ...await pub.openNamedTunnel(port, prepared), shape: `named tunnel ${pub.tunnelName(share.host)}${made ? ' (created)' : ''}` }
  } catch (err) {
    log.error(`the tunnel did not open: ${err.message}`)
    process.exit(1)
  }
}

async function serve($, share, port) {
  const { echo, log, chalk, tty, flag } = $
  const { hasCloudflared } = await core('public-tunnel')
  const { isPortInUse } = await core('ports')
  if (flag.dry) { await sayDry($, share, port); return }
  if (!hasCloudflared()) { log.error('cloudflared is not on the PATH'); process.exit(1) }
  if (!(await isPortInUse(port))) log.warn(`nothing answers on ${port} yet — the URL serves 502 until it does`)
  const tunnel = await open($, share, port)
  echo(chalk`{dim ·} tunnel {bold ${tunnel.url}} {dim → localhost:${port} · ${tunnel.shape}}`)
  echo.lines([
    chalk.dim('The API behind it must run with FRONTIER_TRUST_PROXY=1; `fli dev --tunnel` starts it so.'),
    chalk.dim('Ctrl-C closes it.'),
  ], { indent: 2 })
  tty.onExit(() => tunnel.child.kill())
  await new Promise(done => tunnel.child.on('close', done))
}
</script>

```js
const manifest = readManifest($.paths.root)
const port = Number(arg.port) || await defaultPort($.paths.root, manifest)
if (!port) { log.error('no port given, and this directory is no app with a web or API surface'); process.exit(1) }
await serve($, await chooseTunnel($, manifest), port)
```
