---
title: utils:dev
description: Start the dev server on this app's own ports — refuses a taken one, offers an install and an ENCRYPTION_KEY, warns on an empty database
alias: dev
examples:
  - fli dev
  - fli dev --dry
  - fli dev --no-check
  - fli dev --debug
  - fli dev --verbose
  - fli dev --host
  - fli dev --tunnel
  - fli dev --tunnel=demo.example.com
  - fli dev --api production
  - fli dev --api stage
  - fli dev --api my-box:3001
flags:
  check:
    type: boolean
    description: Skip the preflights — the ports, the install, the key and the database
    defaultValue: true
  host:
    type: boolean
    description: Serve the web surface on every interface, so a phone on the LAN can open it
    defaultValue: false
  tunnel:
    type: string
    description: "Put the app on a public https URL to share, with the API trusting that one proxy hop: bare --tunnel is <package>.$FLI_TUNNEL_DOMAIN through a Cloudflare named tunnel, else a random trycloudflare.com URL; --tunnel=<host> names the host"
    defaultValue: ''
  basecamp:
    type: string
    description: The Basecamp holding the App BASECAMP_APP_ID names, by its name in basecamps.json (default the only one; none resolvable means no port lookup)
    defaultValue: ''
  api:
    type: string
    description: "Run the other surfaces against a deployed API over an ssh tunnel: production, stage, or an ssh destination[:port]"
    defaultValue: ''
---

Runs the project's own `dev` script with the right runner, on this app's own
ports, after four preflights.

**A `dev` that only runs surface scripts side by side is run by fli, one child
per surface, each line behind its surface's name** (`api │`, `web │`) —
`core/dev-run.js`. Two servers sharing a terminal unlabeled made a vite error
read as the API's. Any other `dev` (a `&&` chain, a command that is not a
surface script, a single surface) runs as written. `composedSurfaces` in
`core/ports.js` decides.

**Each surface says it is up in one line, and the boot banners are
`--verbose`.** fli starts the servers with `FLI_DEV=1`; Junction and Sierra
then print a ready line in place of their banners (the format is
`@frontierjs/toolbelt/devline`), and fli lays them out as one summary — the URL
and what came up, two lines a surface. A Mesa warning arrives as one line naming
its file. Nothing else a server prints is dropped: it is held until the summary
prints, and a surface that exits or never reports (an older package, a custom
script) lets the summary print without it after 15 seconds. `--verbose` starts
the servers without the variable, so each prints the banner it always has. In a
terminal, `o` opens the web surface, `r` restarts every surface, `v` restarts
them in the other mode, `q` quits.

**An app the ports table does not name gets a slot of its own.** Every app
`fli new` writes is project 0, so two of them derive the same 8000/8100. `fli
dev` gives each app directory a slot in `~/.fli/sessions.lock` and hands its
ports to the servers it starts as `FRONTIER_PORT_FE`, `FRONTIER_PORT_BE` and the rest,
which the scaffolded configs read: the second app runs on 8001/8101. The slot is
remembered, so an app comes back on the port a browser tab, an OAuth redirect
and a `FRONTIER_APP_URL` already name. An app whose configs ignore the variables stays
at 0, since moving the probe would not move the server (`core/ports.js` § Dev
slots). `fli ps` lists the slots.

**The port check refuses; the database check warns.** They are different kinds
of fact. An empty database is the correct state for a first run, so saying so is
a courtesy — but it is worth saying, because an app with no rows boots clean,
serves every route, answers every request correctly and shows a person a blank
screen, and the first thing anyone does is look for a bug in the app.

**A declared package that is not installed is offered an install, between the
two.** A fresh clone has no `node_modules`, and both surfaces start anyway and
fail in words that do not say *install*: `vite: command not found` and `Cannot
find module '@frontierjs/junction/…'`. Each package is looked for, not the
directory, because a pull that added one dependency fails the same way with a
`node_modules` present (`core/install-preflight.js`). A terminal is asked; a
run with none is refused with the command. A `link:` dependency this machine
never `bun link`ed is refused before the install, because the install itself
fails on it — that is a `--source local` app opened somewhere else.

**A blank `ENCRYPTION_KEY` is offered one, when `.env.example` names it.** The
same clone has no `.env` — it is gitignored — so the API refuses at load while
the web surface comes up beside it. With no `.env`, the example is copied first;
the key is written by `fli keygen`, the generator `auth:install` uses. Only this
key: it is random bytes, where every other blank names a credential somebody has
to go and get (`core/env-preflight.js`). It is offered and never refused,
because the API's own refusal already says what is wrong. Over a database that
already holds encrypted values it asks for the key that sealed them instead.

A port that is already answering is not correct in any reading, and the two dev
runners fail differently and badly: `bun --watch` prints EADDRINUSE and **keeps
watching**, so the process stays alive and whatever is waiting on it waits
forever, and vite exits on `strictPort` after somebody has already been confused
once. The worst version is a stale server from an earlier run — it still owns
the port AND still holds the old database open, including one that has been
deleted, since an unlinked SQLite file lives on while a handle does. The new
server never starts, every request is answered by the ghost, and `db:reset`
looks like it did nothing.

**Which ports are checked comes from what this app's own `dev` script RUNS**,
resolved through `core/ports.js` — which owns the formula and the project table,
so a list kept per app cannot go stale the day somebody adds a surface.

It used to be the surfaces that EXIST, and the two are only the same set in a
scaffolded app: `fli new` composes every surface into one `dev`, so there the
question does not arise. Every app in this repo answers it differently —
`example` has five surfaces and a `dev` that starts two — so a storefront left
running on 8610 refused `fli dev` by naming a port nothing it was about to start
would have taken (`FJS-568`). `devPorts()` narrows `appPorts()` by walking the
`dev` script's `bun run` targets, transitively. A `dev` that runs no other
script cannot be narrowed and is not: that is a single-surface app whose `dev`
IS the surface command, and every surface it has is one it starts.

**`--debug` is the flag every command has, carried one process further**: it
also sets `DEBUG=1` on the servers `fli dev` starts. That is the switch
Junction already reads — its boot diagnostics, and `config.debug`, which puts
`debug=true` on the banner and a 5xx's detail in the response — so it asks the
servers the same thing it asks fli: the whole error, not the clean line.

**`--host` is the same shape**: it sets `FRONTIER_HOST=1` on the servers, and
Sierra's base vite config reads it into `server.host`, so vite binds every
interface and prints a Network URL. Only the web port has to be reachable — vite
proxies `/api` and `/ws` to the API on localhost. An app config that replaces
`server` rather than spreading `base.server` drops the setting, and vite's banner
then shows no Network line.

**`--tunnel` puts the app on a public URL to share** (`core/public-tunnel.js`),
through one of two cloudflared tunnels, picked once before anything starts:

- `--tunnel=<host>` is a Cloudflare NAMED tunnel at that hostname, and a bare
  `--tunnel` with `FLI_TUNNEL_DOMAIN` set (the shell, the project's `.env` or
  `~/.config/fli/.env`) is `<package name>.<domain>`. The same URL every run, on
  a zone the `cf` login reaches: fli finds or makes the tunnel `fli-<host, dots
  as dashes>` and its proxied CNAME, and runs cloudflared with the tunnel's
  token (`TUNNEL_TOKEN`, never argv). A record already on the name that is not
  this tunnel's CNAME is refused by name; fli never replaces one.
- A bare `--tunnel` with no domain is a quick tunnel: no account, a fresh
  `*.trycloudflare.com` name each run.

**A host or a domain never falls back to a quick tunnel.** A run that cannot
make the named tunnel (no zone for the host, no `cf` login, a held name) stops
with the cause, because the person would otherwise share a random URL while
believing it was `example.awe.dev`.

It tunnels the web port alone, for the same reason `--host` only binds it,
and the API's when there is no web surface. Three settings ride with it, so
none can be left behind:

- `FRONTIER_TRUST_PROXY=1` on the API. Cloudflare appends the visitor's
  address to `X-Forwarded-For` in both shapes; without the setting every
  visitor is 127.0.0.1, and one stranger's failed logins lock out everyone
  (`FJS-1841`).
- `FRONTIER_APP_URL` is the tunnel's URL, since that is where a person reaches
  the app: a reset link names it, and Sierra's vite config allows its host,
  which vite otherwise answers 403.
- The summary's title carries the URL.

Anyone with the URL reaches the dev database. `--api` refuses it: the API
whose trust it sets is not this run's. `--dry` names the shape and makes no
`cf` call.

**`--api <target>` runs every surface but the API, against a deployed one**
(`core/api-tunnel.js`). A deployed API listens on its box's loopback only, so
fli opens `ssh -L` from this app's own API port to it and starts the rest: the
proxies already point at that port, so nothing else changes. `production` and
`stage` resolve off the deploy block the way `fli deploy` does, and the box's
port is `deploy.api.port`; anything else is an ssh destination, with `:port` to
name another. With `BASECAMP_APP_ID` set, a named target is an App of that project, asked of the Basecamp in `basecamps.json` (`--basecamp`, else the only entry; the local dev Basecamp is the reserved entry `dev`, written in by hand; with none resolvable there is no lookup): the
port is the one Basecamp allocated it and the health path its `healthCheck`,
and the App is the target's: the one with the same slug in the project's
environment of that tier (`FJS-D1965`), refused by name when the project has
none (`FJS-3938`). The machine stays the deploy block's ssh destination
where it names one, else the one Basecamp placed the App on. The surfaces start only once the health path answers through the
tunnel, and the summary names the target, because every write goes to that
API's database. The key and database preflights are skipped: neither is the
one being used.

**The runner is decided by a lockfile found by walking UP.** A package inside a
workspace has no lockfile of its own — the one lockfile is at the workspace root
— so looking only beside `package.json` reported *npm detected* for every
package in a bun monorepo, and then ran the wrong runner.

<script>
import { existsSync, readFileSync, copyFileSync } from 'fs'
import { resolve } from 'path'

const core = name => import(resolve(global.fliRoot, `core/${name}.js`))

function readManifest(root) {
  try {
    return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  } catch { return {} } // an app with no manifest still has surfaces
}

// The App of `target` in the project `BASECAMP_APP_ID` names, whose port is the
// one Basecamp allocated on its machine; null for no id, and for a machine
// with no Basecamp entry to ask (the port is then the deploy block's, never a
// refusal here). A project with no such App throws the resolver's refusal.
async function placedApp(name, target) {
  const appId = process.env.BASECAMP_APP_ID
  if (!appId) return null
  const { entry } = (await core('basecamps')).lookupBasecamp(name)
  if (!entry) return null
  const { resolveBasecampApp } = await core('basecamp')
  return resolveBasecampApp(entry.url, entry.key, appId, target, { where: entry.name })
}

// Before the check, because the slot decides which ports are checked.
async function claimSlot($, root, manifest) {
  const { claimSession } = await core('ports')
  try {
    return await claimSession(root, { name: manifest.name, scripts: manifest.scripts, dry: $.flag.dry })
  } catch (err) {
    $.log.error(err.message)
    process.exit(1)
  }
}

// `--api`: where the tunnel goes, and the local port it takes from the API surface.
async function resolveRemote($, root, session) {
  const { log } = $
  const { resolveApiTarget, TARGETS } = await core('api-tunnel')
  const { loadFrontierConfig } = await core('utils')
  const { PLACEHOLDER_SERVER } = await core('deploy-target')
  const target = $.flag.api
  const named = TARGETS[String(target).trim().toLowerCase()]
  let app = null
  try { app = named ? await placedApp($.flag.basecamp, named) : null } catch (err) { log.error(err.message); process.exit(1) }
  const resolved = resolveApiTarget(target, (await loadFrontierConfig(root))?.deploy ?? null, app)
  if (!resolved.ok) { log.error(resolved.reason); process.exit(1) }
  if (resolved.host.endsWith(PLACEHOLDER_SERVER)) {
    log.error(`deploy.server is still the placeholder '${PLACEHOLDER_SERVER}' — set it, or pass --api <ssh alias>`)
    process.exit(1)
  }
  const apiRow = session.rows.find(r => r.surface === 'api')
  if (!apiRow) { log.error('--api replaces the API surface, and this app\'s dev starts none'); process.exit(1) }
  return { ...resolved, localPort: apiRow.port, label: resolved.target ?? `${resolved.host}:${resolved.port}` }
}

// The summary names each URL, so the ports are the long version.
function sayPorts({ echo, chalk }, session, at) {
  if (!session.rows.length) return
  const where = session.rows.map(r => `${r.label} ${r.port}`).join(' · ')
  echo(chalk.dim(at ? `${at} — ${where}` : where))
}

// Name the holder rather than guess. The two cases want different hands:
// this app's own earlier run is killed, another app's slot is left alone.
async function refuseBusyPorts({ echo, log, chalk }, busy, root, manifest) {
  const { whoHolds } = await core('ports')
  log.error(`Port${busy.length === 1 ? '' : 's'} already in use`)
  const lines = ['']
  let ownRun = false, otherApp = false
  for (const b of busy) {
    lines.push(`${chalk.bold(String(b.port))}  ${b.label}${b.script ? chalk.dim(`  (bun run ${b.script})`) : ''}`)
    const holders = whoHolds(b.port, root)
    if (!holders.length) lines.push(chalk.dim('       held by a process this user cannot see'))
    for (const h of holders) {
      const who = h.own ? 'this app\'s own run'
        : h.session ? `${h.session.name}${Number.isInteger(h.session.slot) ? ` on slot ${h.session.slot}` : ''}`
        : 'a process outside any dev slot'
      const where = h.own ? '' : h.session ? `  ${h.session.root}` : h.cwd ? `  ${h.cwd}` : ''
      lines.push(`       ${chalk.dim('held by')} ${who} ${chalk.dim(`-- pid ${h.pid}`)}${chalk.dim(where)}`)
      if (h.cmd) lines.push(chalk.dim(`         ${h.cmd}`))
      if (h.own) ownRun = true
      else if (h.session) otherApp = true
    }
  }
  lines.push('')
  if (ownRun) lines.push(
    chalk.dim('A run of this app still holds the old database open, so `db:reset` will'),
    chalk.dim('appear to do nothing while it lives.') + ' fli kill <port> ' + chalk.dim('stops it.'))
  if (otherApp) lines.push(
    chalk.dim('Another app has this slot. Stop it, or forget this app\'s slot with'),
    chalk.dim(`\`${`fli ps --clean ${manifest.name ?? ''}`.trim()}\` and run again for a free one.`))
  if (!ownRun && !otherApp) lines.push(chalk.dim('fli ps 8000 ') + chalk.dim('asks about a port by number.'))
  lines.push('')
  echo.lines(lines, { indent: 2 })
  process.exit(1)
}

async function offerInstall($, root, missing) {
  const { echo, log, chalk, tty } = $
  const { detectRunner } = await core('db-preflight')
  const { missingPackages, unregisteredLinks } = await core('install-preflight')
  const { plural } = await core('text')
  const install = `${detectRunner(root)} install`
  log.warn(`${plural(missing.length, 'declared package')} not installed — ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}`)
  const links = unregisteredLinks(root)
  if (links.length) {
    log.error(`${install} will fail: no \`bun link\` on this machine for ${links.join(', ')}`)
    echo.lines([chalk.dim('Run `bun link` in each of those packages, or point the manifest at published versions.')], { indent: 2 })
    process.exit(1)
  }
  if (!tty.interactive) {
    log.error(`Install first: ${install}`)
    process.exit(1)
  }
  const answer = (await tty.line(`Run ${install} now? [Y/n]`)).trim().toLowerCase()
  if (answer && answer !== 'y' && answer !== 'yes') process.exit(1)
  $.exec({ command: `cd ${root} && ${install}` })
  const still = missingPackages(root)
  if (still.length) {
    log.error(`still not installed after ${install}: ${still.join(', ')}`)
    process.exit(1)
  }
}

// The new key, or '' when the person declined: it travels to the servers on `env:`.
async function offerKey($, root, keyState) {
  const { echo, log, chalk, tty } = $
  const { envValue, KEY, checkKey, askHeldKey } = await core('env-preflight')
  const schema = resolve($.paths.db, 'schema.lite')
  const check  = existsSync(schema) ? checkKey($, schema) : null
  if (check?.values.length) return (await askHeldKey($, schema, check))?.[KEY] ?? ''
  const keygen = `fli keygen aes --format hex --name ${KEY} --env`
  log.warn(keyState === 'no-env'
    ? `no .env — the API refuses to start without ${KEY}`
    : `${KEY} is blank in .env — the API refuses to start without it`)
  const ask = keyState === 'no-env' ? `Create .env from .env.example with a new ${KEY}?` : `Generate ${KEY} into .env?`
  const answer = tty.interactive ? (await tty.line(`${ask} [Y/n]`)).trim().toLowerCase() : 'n'
  if (answer && answer !== 'y' && answer !== 'yes') {
    echo.lines([chalk.dim(`${keyState === 'no-env' ? 'cp .env.example .env && ' : ''}${keygen}`)], { indent: 2 })
    return ''
  }
  if (keyState === 'no-env') copyFileSync(resolve(root, '.env.example'), resolve(root, '.env'))
  $.exec({ command: `cd ${root} && ${$.fli} keygen aes --format hex --name ${KEY} --env` })
  // fli loaded the blank from .env at startup, and a child's own copy of the
  // name wins over the file bun reads for it.
  return envValue(readFileSync(resolve(root, '.env'), 'utf8'), KEY)
}

// A preflight that throws must not stop a dev server. It is a courtesy.
async function warnIfEmpty($, verbose) {
  const { warnIfDatabaseEmpty } = await core('db-preflight')
  try {
    warnIfDatabaseEmpty($)
  } catch (err) {
    if (verbose) $.echo($.chalk.dim(`database preflight skipped: ${err.message}`))
  }
}

// Nothing migrates at start (FJS-D123), so an app that reads a table while it
// boots crashes on `no such table` — the server is not worth starting first.
async function offerMigrate($, root) {
  const { echo, log, chalk, tty } = $
  const { unmigratedDatabases, readScripts, detectRunner } = await core('db-preflight')
  const { plural } = await core('text')
  const waiting = unmigratedDatabases(root, $.paths.db)
  if (!waiting.length || !readScripts(root)['db:migrate']) return false
  const migrate = `${detectRunner(root)} run db:migrate`
  for (const { name, where, files } of waiting) {
    log.warn(`database "${name}" has no tables — ${where}`)
    echo.lines([chalk.dim(`${plural(files, 'migration')} in db/migrations not yet applied`)], { indent: 2 })
  }
  if (!tty.interactive) {
    log.error(`Migrate first: ${migrate}`)
    process.exit(1)
  }
  const answer = (await tty.line(`Run ${migrate} now? [Y/n]`)).trim().toLowerCase()
  if (answer && answer !== 'y' && answer !== 'yes') return true
  $.exec({ command: `cd ${root} && ${migrate}` })
  return false
}

async function openTunnelFor({ echo, log, chalk, tty }, remote, verbose) {
  const { openTunnel, sshArgs } = await core('api-tunnel')
  echo(chalk`{dim ·} tunnel {bold ${remote.label}} {dim —} localhost:${remote.localPort} → ${remote.host}:${remote.port}`)
  if (verbose) echo(chalk.dim(`ssh ${sshArgs(remote).join(' ')}`))
  let tunnel
  try {
    tunnel = await openTunnel(remote)
  } catch (err) {
    log.error(`tunnel to ${remote.host} did not open: ${err.message}`)
    process.exit(1)
  }
  if (tunnel.status >= 400) log.warn(`${remote.health} answered ${tunnel.status} through the tunnel`)
  if (remote.target === 'production') log.warn(`every write goes to the ${chalk.bold('production')} database`)
  // ssh shares the terminal's process group so a passphrase prompt can reach
  // the person, and so Ctrl-C signals it directly: a signal is a quit, not a drop.
  let quitting = false
  tty.onExit(() => { quitting = true; tunnel.child.kill() })
  tunnel.child.on('close', (code, signal) => {
    if (!quitting && !signal) log.error(`tunnel to ${remote.host} closed — the surfaces have no API until fli dev restarts`)
  })
  return tunnel
}

// The web surface serves the whole app, since vite proxies /api and /ws.
function sharedRow(session) {
  return session.rows.find(r => r.surface === 'web') ?? session.rows.find(r => r.surface === 'api')
}

// A host or domain that cannot be used is an error here, before any server starts.
async function chooseTunnel({ log, flag }, manifest) {
  const { tunnelHost } = await core('public-tunnel')
  try {
    return tunnelHost({ flag: flag.tunnel, domain: process.env.FLI_TUNNEL_DOMAIN, packageName: manifest.name })
  } catch (err) {
    log.error(err.message)
    process.exit(1)
  }
}

async function sayTunnelDry({ log }, share, row) {
  const { quickTunnelArgs, namedTunnelArgs, tunnelName } = await core('public-tunnel')
  if (share.mode === 'quick') { log.dry(`Would run:   cloudflared ${quickTunnelArgs(row.port).join(' ')}`); return }
  log.dry(`Would find or make the Cloudflare tunnel ${tunnelName(share.host)} and a proxied CNAME for ${share.host}`)
  log.dry(`Would run:   cloudflared ${namedTunnelArgs(row.port).join(' ')}   (token in TUNNEL_TOKEN)`)
  log.dry(`Would serve: https://${share.host} → ${row.surface} ${row.port}`)
}

function requireCloudflared({ echo, log, chalk }, hasCloudflared) {
  if (hasCloudflared()) return
  log.error('--tunnel needs cloudflared on the PATH')
  echo.lines([chalk.dim('https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')], { indent: 2 })
  process.exit(1)
}

// Any refusal here ends the run: the named tunnel has no quick-tunnel fallback.
async function startTunnel({ log }, share, row) {
  const pub = await core('public-tunnel')
  try {
    if (share.mode === 'quick') return { ...await pub.openQuickTunnel(row.port), shape: 'quick tunnel' }
    const prepared = await pub.prepareNamedTunnel(share.host)
    const made = prepared.created.tunnel || prepared.created.record
    return { ...await pub.openNamedTunnel(row.port, prepared), shape: `named tunnel ${pub.tunnelName(share.host)}${made ? ' (created)' : ''}` }
  } catch (err) {
    log.error(`the tunnel did not open: ${err.message}`)
    process.exit(1)
  }
}

async function openPublicTunnel($, session, share) {
  const { echo, log, chalk, tty, flag } = $
  const { hasCloudflared } = await core('public-tunnel')
  const row = sharedRow(session)
  if (!row) { log.error('--tunnel shares the web or API surface, and this app\'s dev starts neither'); process.exit(1) }
  if (flag.dry) { await sayTunnelDry($, share, row); return null }
  requireCloudflared($, hasCloudflared)
  const tunnel = await startTunnel($, share, row)
  echo(chalk`{dim ·} tunnel {bold ${tunnel.url}} {dim → ${row.surface} ${row.port} · ${tunnel.shape} · API trusts 1 proxy hop · anyone with the URL reaches the dev database}`)
  let quitting = false
  tty.onExit(() => { quitting = true; tunnel.child.kill() })
  tunnel.child.on('close', () => {
    if (!quitting) log.error(`the tunnel closed — ${tunnel.url} answers nothing until fli dev restarts`)
  })
  return tunnel
}

// The keys wait for the summary, so the first thing on screen is whether the app came up.
function keyHints({ chalk }, run) {
  return run.summarized && [
    `${chalk.bold('o')} open`, `${chalk.bold('r')} restart`,
    `${chalk.bold('v')} ${run.compact ? 'verbose' : 'compact'}`, `${chalk.bold('q')} quit`,
  ].map(chalk.dim)
}

async function keyLoop({ tty }, run, footer) {
  const { openUrl } = await core('open-url')
  const KEYS = { o: 'open', r: 'restart', v: 'verbose', q: 'quit' }
  let exited = false
  run.done.then(() => { exited = true })
  while (!exited) {
    const key = await Promise.race([tty.keys(null, KEYS), run.done.then(() => null)])
    if (key === 'q' || key === null) break
    if (key === 'o') {
      const url = run.frontUrl()
      if (url) openUrl(url)
    }
    if (key === 'r') await run.restart()
    if (key === 'v') await run.restart({ compact: !run.compact })
    footer.update()
  }
  footer.stop()
  if (!exited) process.kill(process.pid, 'SIGINT')
}
</script>

```js
const root = $.paths.root

const { detectRunner } = await core('db-preflight')
const { busyPorts, composedSurfaces } = await core('ports')
const { runSurfaces } = await core('dev-run')
const { missingPackages } = await core('install-preflight')
const { encryptionKeyState, KEY } = await core('env-preflight')

const manifest = readManifest(root)
const session = await claimSlot($, root, manifest)
const remote = flag.api ? await resolveRemote($, root, session) : null
if (flag.tunnel && remote) { log.error('--tunnel shares this run\'s API, and --api replaces it'); process.exit(1) }
const share = flag.tunnel ? await chooseTunnel($, manifest) : null

const verbose = flag.verbose === true
const at = [session.branch && `branch ${session.branch}`, session.slot && `slot ${session.slot}`].filter(Boolean).join(' · ')
if (verbose) sayPorts($, session, at)

let generatedKey = ''
if (flag.check) {
  // Ports first. A refusal here is the whole point, and it must happen before
  // anything that takes time — including reading a database the ghost still
  // has open.
  const busy = await busyPorts(session.rows)
  if (busy.length && !flag.dry) await refuseBusyPorts($, busy, root, manifest)

  const missing = missingPackages(root)
  if (missing.length && !flag.dry) await offerInstall($, root, missing)

  const keyState = remote ? 'remote' : encryptionKeyState(root)
  if ((keyState === 'no-env' || keyState === 'blank') && !flag.dry) generatedKey = await offerKey($, root, keyState)

  // A declined migrate has already said what is wrong with the database.
  const declined = !remote && !flag.dry && await offerMigrate($, root)
  if (!remote && !declined) await warnIfEmpty($, verbose)
}

// After the port check, so a ghost on the web port is never the one shared.
const tunnel = share ? await openPublicTunnel($, session, share) : null

const runner = detectRunner(root)
// `env:` and never an assignment to process.env, which a child under bun does not see.
const env = {
  ...process.env,
  ...session.vars,
  ...(flag.debug && { DEBUG: '1' }),
  ...(flag.host && { FRONTIER_HOST: '1' }),
  ...(tunnel && { FRONTIER_TRUST_PROXY: '1', FRONTIER_APP_URL: tunnel.url }),
  ...(generatedKey && { [KEY]: generatedKey }),
}

let composed = composedSurfaces(manifest.scripts, session.rows)
if (remote) {
  // A `dev` fli does not compose cannot be run without its API.
  composed = composed?.filter(r => r.surface !== 'api')
  if (!composed?.length) {
    log.error('--api needs a dev script that runs its surfaces side by side, e.g. `bun run --parallel api web`')
    process.exit(1)
  }
}
if (!composed) {
  echo(chalk`{dim ·} ${runner} run dev`)
  $.exec({ command: `cd ${root} && ${runner} run dev`, dry: flag.dry, env })
  return
}

if (remote) {
  if (flag.dry) {
    const { sshArgs } = await core('api-tunnel')
    log.dry(`Would run:   ssh ${sshArgs(remote).join(' ')}`)
  } else {
    await openTunnelFor($, remote, verbose)
  }
}

if (verbose) echo(chalk.dim(composed.map(r => `${runner} run ${r.script}`).join('  ·  ')))
if (flag.dry) return

const title = [
  (manifest.name ?? '').replace(/^@[^/]+\//, ''), at,
  remote && chalk.yellow(`API → ${remote.label}`),
  tunnel && chalk.cyan(`shared at ${tunnel.url}`),
].filter(Boolean).join(chalk.dim(' · '))
let footer = null
const run = runSurfaces({
  root, runner, rows: composed, env, echo, onExit: tty.onExit, compact: !verbose, title,
  onSummary: () => footer?.update(),
})

if (tty.interactive) {
  footer = tty.live(() => keyHints($, run))
  await keyLoop($, run, footer)
}
process.exitCode = await run.done
```
