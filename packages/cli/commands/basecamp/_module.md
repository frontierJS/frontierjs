---
namespace: basecamp
description: Basecamp itself — make its box at DigitalOcean, install it, point its hostname, take it down, and release an app through it
---

<script>
// ─── The Basecamp checkout ────────────────────────────────────────────────────
// The vendor's dialect is Basecamp's compute connector, run in place — never a
// copy here (FJS-D1253). Basecamp is private, so this needs the framework
// checkout fli runs from, the same as ring 0's `fli deploy` of Basecamp.
const provisionScript = () => {
  const root = new URL('../basecamp/', 'file://' + global.fliRoot + '/').pathname
  return { root }
}

// `host-record.ts` beside it is the Cloudflare half, for `basecamp:dns` and `pointHost`.
const runProvision = async (input, file = 'provision-host.ts', env = {}) => {
  const { spawnSync }  = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { root } = provisionScript()
  const script = root + 'api/src/core/' + file
  if (!existsSync(script))
    return { error: `no Basecamp checkout at ${root}: the basecamp commands run from the framework repository` }

  const run = spawnSync('bun', [script, JSON.stringify(input)], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const last = (run.stdout || '').trim().split('\n').pop()
  try { return JSON.parse(last) }
  catch { return { error: `${file} answered no JSON (exit ${run.status})` } }
}

// Basecamp's own hostname, the one `pointHost` points at the box.
const webDomain = async () =>
  (await import(provisionScript().root + 'frontier.config.js')).default.deploy.web?.domain

// The token page and what to pick on it are `basecamp:dns`'s `requires:`, read
// off that file so install and create cannot send a person to a different page.
// They ask here rather than declaring it: no token is not a refusal for them.
const cloudflareToken = async ({ interactive, write = true, say }) => {
  if (process.env.CLOUDFLARE_TOKEN) return true
  const { resolve }                    = await import('node:path')
  const { loadModuleFile }             = await import(resolve(global.fliRoot, 'core/registry.js'))
  const { requiresOf, acquireMissing } = await import(resolve(global.fliRoot, 'core/requires.js'))
  const { meta } = loadModuleFile(resolve(global.fliRoot, 'commands/basecamp/dns.md'))
  const left = await acquireMissing('basecamp', requiresOf(meta).filter(r => r.key === 'CLOUDFLARE_TOKEN'), { interactive, write, say })
  return !left.length
}

// spawnSync hands the child the environment bun STARTED with, so a token
// pasted just now goes on the call itself.
const hostRecord = (input) => runProvision(input, 'host-record.ts', { CLOUDFLARE_TOKEN: process.env.CLOUDFLARE_TOKEN })

// Asked before the install, so a token that opens no zone holding the hostname
// refuses before minutes of apt rather than after them. No token is not a
// refusal — the record can come later. Answers `{ refusal, points }`, points
// being the address Basecamp's record there holds now: null with none.
const zoneRefusal = async ({ domain, log, echo, chalk }) => {
  if (!await cloudflareToken({ interactive: !!process.stdin.isTTY, say: (t) => log.warn(t) })) {
    log.warn(`No CLOUDFLARE_TOKEN: the install leaves ${domain} without a DNS record and prints the line that writes it`)
    return { refusal: null, points: null }
  }
  const found = await hostRecord({ host: domain, check: true })
  if (found.error) return { refusal: `Cloudflare: ${found.error.replace(/^Cloudflare:\s*/, '')}`, points: null }
  echo(`  ${chalk.green('✓')} ${chalk.dim(`${found.zone} is at Cloudflare`)}\n`)
  return { refusal: null, points: found.points ?? null }
}

// The box's IPv4 address. An ssh alias names none, so ssh's own reading of its
// config is asked, then the resolver; null when neither gives one.
const boxAddress = async (dest) => {
  const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
  const host = dest.split('@').pop()
  if (IPV4.test(host)) return host
  const { spawnSync } = await import('node:child_process')
  const named = (spawnSync('ssh', ['-G', dest], { encoding: 'utf8' }).stdout || '').match(/^hostname (\S+)$/m)?.[1] ?? host
  if (IPV4.test(named)) return named
  try { return (await (await import('node:dns')).promises.lookup(named, { family: 4 })).address }
  catch { return null }
}

// Basecamp's own record, written once Basecamp answers on the box — the
// `basecamp:dns` write, so the record carries the fleet's mark either way. Never
// asks for a token: `zoneRefusal` already did, before the install. A record
// already behind the proxy stays there. Answers the record, or null after
// printing the line that finishes the job.
const dnsLine = (host, ip, configured) => `fli basecamp:dns ${ip ?? '<ip>'}${host === configured ? '' : ` --host ${host}`}`
const pointHost = async ({ host, ip, configured, log }) => {
  const manual = dnsLine(host, ip, configured)
  if (!ip) { log.warn(`  No address for the box, so ${host} has no DNS record. With its address: ${manual}`); return null }
  if (!process.env.CLOUDFLARE_TOKEN) { log.warn(`  ${host} has no DNS record. Once you have a CLOUDFLARE_TOKEN: ${manual}`); return null }
  const done = await hostRecord({ host, ip })
  if (done.error) { log.error(`  ${done.error}. Then: ${manual}`); return null }
  log.success(`${done.host} → ${done.ip} in ${done.zone}, ${done.proxied ? 'behind the proxy' : 'DNS-only'}`)
  return done
}

// Does https://<host> answer on a certificate this machine trusts? Bun's fetch
// refuses an invalid one, so any answer at all is the pass. DNS and Caddy's
// certificate order both sit between the record and the first answer.
const httpsAnswers = async (host, { tries = 18, everyMs = 10_000 } = {}) => {
  for (let i = 0; i < tries; i++) {
    try { await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(8_000) }); return true }
    catch {}
    await new Promise(r => setTimeout(r, everyMs))
  }
  return false
}

// FJS-D1380's last step: the flip to proxied is offered only once the origin's
// own certificate is proven, since the edge verifies it from then on (Full
// (strict), for this host alone). No terminal, or a no, leaves it DNS-only.
// Answers false only when a flip that was asked for failed.
const offerProxy = async ({ record, configured, log, yes }) => {
  if (record.proxied) return true
  const { host, ip } = record
  const later = `${dnsLine(host, ip, configured)} --proxied`
  log.info(`Waiting for https://${host} to answer on Caddy's certificate — up to three minutes`)
  if (!await httpsAnswers(host)) {
    log.warn(`  https://${host} did not answer on a valid certificate: left DNS-only. Once it does: ${later}`)
    return true
  }
  log.success(`https://${host} answers on a valid certificate`)
  if (!yes) { log.info(`  Left DNS-only. To put it behind Cloudflare's proxy: ${later}`); return true }
  if (!await yes(`Put ${host} behind Cloudflare's proxy? The edge then verifies this certificate (Full (strict), this host only)`, true)) {
    log.info(`  Left DNS-only. Later: ${later}`)
    return true
  }
  const done = await hostRecord({ host, ip, proxied: true })
  if (done.error) { log.error(`  ${done.error}. Left DNS-only; then: ${later}`); return false }
  log.success(`${host} is behind Cloudflare's proxy, Full (strict) for this host`)
  return true
}

// One row of `basecamp:list`, and of the pick `basecamp:stop` and `basecamp:destroy` offer with no id.
// A droplet with no server id is the Basecamp host: `fli basecamp:create` is the
// only maker of one, and refuses to make a second while one is at the account.
// Each column is padded before it is painted: an escape code counts toward padEnd.
// `chalk` is handed in, since a module script does not see `$`.
const STATUS_TONE = { running: 'green', off: 'gray', starting: 'yellow', deleting: 'red' }
const machineLine = (m, chalk) => {
  const paint  = chalk[STATUS_TONE[m.status] ?? 'yellow']
  const status = paint(`● ${m.status.padEnd(8)}`)
  const ip     = m.ip ? chalk.cyan(m.ip.padEnd(15)) : chalk.dim('no address yet')
  const role   = m.serverId
    ? chalk`📡 {magenta fleet machine} {dim · server ${m.serverId} · destroy it in Basecamp}`
    : chalk`⛺ {bold.green Basecamp host}`
  return chalk`{bold ${m.id}}  ${status}  ${ip}  {dim 🌐 ${(m.region ?? '-').padEnd(5)}}  ${role}`
}

// ─── Ring 0 from here ─────────────────────────────────────────────────────────
// `fli deploy:setup` and `fli deploy` as child runs of this fli, in the Basecamp
// checkout, on this terminal. Not imported: each is a command with its own
// steps, journal and lock, and running it as a process is what keeps that so.
const runFli = async (argv) => {
  const { spawnSync } = await import('node:child_process')
  const { resolve }   = await import('node:path')
  const { root } = provisionScript()
  const r = spawnSync(process.execPath, [resolve(global.fliRoot, 'bin/fli.js'), ...argv],
    { cwd: root, stdio: 'inherit', env: process.env })
  return r.status ?? 1
}

// ─── Basecamp on a box ────────────────────────────────────────────────────────
// `fli basecamp:create` runs these on the box it just bought and `basecamp:install`
// on one that already answers ssh, so the two cannot install differently.
// Answers the first run that failed, or null. `say` hears each step as it
// starts: deploy:setup is minutes of apt with nothing printed for long stretches.
// The deploy runs `--no-outpost`: a fresh Basecamp has no workspace until
// `/setup`, so its enrollment step finds nothing to enroll into. `joinFleet`
// enrolls once the admin is made.
const ringZero = async (dest, domain, say = () => {}) => {
  const steps = [
    { argv: ['deploy:setup', '--auto-install', '--no-next-steps', '--server', dest, '--domain', domain], what: 'docker and caddy on the box — a few minutes on a fresh one' },
    { argv: ['deploy', '--no-outpost', '--server', dest, '--domain', domain], what: 'build the image, ship it, start Basecamp' },
  ]
  for (const [i, step] of steps.entries()) {
    say(step, i + 1, steps.length)
    const status = await runFli(step.argv)
    if (status !== 0) return { argv: step.argv, status }
  }
  return null
}

// Basecamp's box as a machine of its own fleet, so apps can run beside it
// (`FJS-D1191`). After `makeAdmin`: enrollment files the box under the one
// workspace `/setup` made, and with none yet `deploy:outpost` says so and exits 0.
const OUTPOST_QUESTION = 'Make the box an Outpost too, so apps can run beside Basecamp on it?'
const joinFleet = async (dest, domain) => await runFli(['deploy:outpost', '--server', dest, '--domain', domain]) === 0

const EMAIL = /^[^\s@]+@[^\s@]+$/

// The first admin's email, asked with `ME` (global fli env) as what Enter takes.
// An install always makes one: `/setup` also makes the workspace, and with none
// the Outpost has nothing to enroll under and Basecamp sits open on `/setup`
// for whoever reaches it first.
const askAdmin = async (ask) => {
  const me = EMAIL.test(process.env.ME ?? '') ? process.env.ME : ''
  return await ask(`First admin's email`, me ? `Enter: ${me}` : 'required') || me
}
const NO_ADMIN = `Installing makes Basecamp's first admin, and its workspace with it: pass --admin <email>, or set your email once with fli eset ME you@example.com --global`

// The hostname as `deploy.web.domain` would hold it, or null for one Caddy
// cannot route by.
const hostnameOf = async (domain) => {
  const { resolve } = await import('node:path')
  const { edgeNames, EdgeError } = await import(resolve(global.fliRoot, 'core/edge.js'))
  try { return edgeNames({ web: { domain } }).web.domain }
  catch (e) {
    if (!(e instanceof EdgeError)) throw e
    return null
  }
}

// Basecamp's own first-run route, asked on the box itself: the hostname may not
// resolve yet. The body travels inside the script on ssh's stdin, never in an
// argv another process on either machine can read. An empty password is
// generated and printed once. Answers false when no admin was made.
const makeAdmin = async ({ dest, identity, workspace, admin, password, log, echo }) => {
  const { spawnSync }  = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const generated = !password
  if (generated) password = (await import('node:crypto')).randomBytes(18).toString('base64url')
  const { default: conf } = await import(provisionScript().root + 'frontier.config.js')
  const body = JSON.stringify({ workspace_name: workspace, name: admin.split('@')[0], email: admin, password })
  const setup = spawnSync('ssh', ['-o', 'BatchMode=yes', ...(identity && existsSync(identity) ? ['-i', identity] : []), dest, 'sh -s'], {
    encoding: 'utf8',
    input: `curl -sS -w '\\n%{http_code}' -X POST -H 'content-type: application/json' --data-binary @- http://localhost:${conf.deploy.api.port}/setup <<'FLI_SETUP_EOF'\n${body}\nFLI_SETUP_EOF\n`,
  })
  const [code, ...rest] = (setup.stdout || '').trimEnd().split('\n').reverse()
  const said = (() => { try { return JSON.parse(rest.reverse().join('\n')).message } catch { return setup.stderr.trim() } })()
  if (code === '409') { log.warn(`  ${workspace} already has an admin — ${admin} was not made`); return true }
  if (code !== '201') {
    log.error(`POST /setup answered ${code || 'nothing'}${said ? `: ${said}` : ''}. Make the admin at /setup in the browser`)
    return false
  }
  echo(`  admin    ${admin}`)
  if (generated) echo(`  password ${password}   shown once — change it after you sign in`)
  return true
}

// The admin, then the Outpost: enrollment files the box under the workspace
// `/setup` made, so when that failed the enrollment is printed rather than run.
// `later` is the `--server`/`--domain` tail a person types from packages/basecamp.
// Answers false when either failed.
const adminThenFleet = async ({ outpost, domain, later, ...admin }) => {
  if (!await makeAdmin(admin)) {
    if (outpost) admin.log.info(`  Once the admin is made at https://${domain}/setup, from packages/basecamp: fli deploy:outpost${later}`)
    return false
  }
  return !outpost || await joinFleet(admin.dest, domain)
}

// A droplet has an address before it has an sshd. BatchMode, so nothing here
// can wait on a password; accept-new records the host key once, so the ring 0
// runs after it meet a known host and ask nothing.
const waitForSsh = async (dest, { identity, timeoutMs = 240_000, everyMs = 5_000 } = {}) => {
  const { spawnSync }  = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new',
    ...(identity && existsSync(identity) ? ['-i', identity] : []), dest, 'true']
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (spawnSync('ssh', args, { stdio: 'ignore' }).status === 0) return true
    await new Promise(r => setTimeout(r, everyMs))
  }
  return false
}
</script>

## Setup

`create`, `stop`, `destroy` and the bare `fli basecamp` list need a
DigitalOcean personal access token, in your global fli env. A first run at a
terminal walks you through it: it opens the page the token is made on, takes
the paste, stores it, and asks whether to install Basecamp on the box once it
is up.

- **Full Access**, or **Custom Scopes**: `droplet` create/read/delete, `ssh_key` create/read, `tag` create, `regions` `sizes` `image` read
- **For Basecamp too** — the same token as a cloud account in Basecamp (Secrets, kind `provider_key`) — add `account` read: Basecamp's Verify reads `/v2/account`, and a token without it fails Verify though it provisions
- Store it: `fli eset DIGITALOCEAN_TOKEN <token> --global` — a run with none leaves a placeholder line there
- The token is shown once; a project `.env` overrides it, for a client's own account
- Optional: `fli eset ME you@example.com --global` — the first admin's email question then takes it on Enter, and `--yes` needs no `--admin`

## What it makes

One droplet, tagged `basecamp`, carrying your SSH public key and nothing
else. `fli basecamp:install <server> --domain <host>` then puts Basecamp on it
from any directory — `fli deploy:setup --auto-install` and `fli deploy`, run
in `packages/basecamp` — and works the same on a box you made some other way.
Both ask whether the box is also an Outpost, and enroll it with `fli
deploy:outpost` once the first admin is made.

## Releasing through it

`fli basecamp:deploy --app <id>` builds an app's image here, loads it onto
every machine Basecamp runs that app on, and asks Basecamp to release it. It
needs a `BASECAMP_API_KEY` from the running Basecamp, not a DigitalOcean token.
