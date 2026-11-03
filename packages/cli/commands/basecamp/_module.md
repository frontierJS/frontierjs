---
namespace: basecamp
description: Basecamp itself — make its box at a cloud, install it, point its hostname, take it down, and release an app through it
---

<script>
// The box side — clouds, the buy, the marks and the hostnames — is
// `core/cloud.js`, shared with `fli server:*`; Basecamp's API and the Outpost
// paste are `core/basecamp.js`, shared with `fli outpost:install`.
const { CLOUDS, cloudLabel, pickCloud, cloudsToRead, listBoxes, cloudOf, runProvision, provisionScript, markHost,
  cloudflareToken, hostRecord, withHosts, boxAddress, waitForSsh, publicKey, boxName, buyBox, machineLine }
  = await import(new URL('file://' + global.fliRoot + '/core/cloud.js'))
const { basecamp, basecampAll, pullAppArchive, LOCAL_BASECAMP } = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))

// Basecamp's own hostname, the one `pointHost` points at the box.
const webDomain = async () =>
  (await import(provisionScript().root + 'frontier.config.js')).default.deploy.web?.domain

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
  if (found.error) return { refusal: `Cloudflare: ${found.error.replace(/^Cloudflare:\s*/, '')}`, points: null, rejected: /HTTP 40[13]|invalid access token/i.test(found.error) }
  echo(`  ${chalk.green('✓')} ${chalk.dim(`${found.zone} is at Cloudflare`)}\n`)
  return { refusal: null, points: found.points ?? null }
}

// After a refusal that says the token itself is wrong: where it is read from
// and where a new one is made, in blue under the error. The page and what to
// pick on it come off `basecamp:dns`'s `requires:`, as `cloudflareToken` reads them.
const tokenHint = async ({ echo, chalk }) => {
  const { resolve }                = await import('node:path')
  const { loadModuleFile }         = await import(resolve(global.fliRoot, 'core/registry.js'))
  const { requiresOf }             = await import(resolve(global.fliRoot, 'core/requires.js'))
  const { esetHint, globalEnvPath } = await import(resolve(global.fliRoot, 'core/global-env.js'))
  const need = requiresOf(loadModuleFile(resolve(global.fliRoot, 'commands/basecamp/dns.md')).meta).find(r => r.key === 'CLOUDFLARE_TOKEN')
  const home = process.env.HOME ?? ''
  echo(chalk.blue(`  ℹ Check CLOUDFLARE_TOKEN in this project's .env or the global one (${globalEnvPath().replace(home, '~')})`))
  echo(chalk.blue(`    OR make a new one: ${need?.url ?? 'https://dash.cloudflare.com/profile/api-tokens'}`))
  if (need?.note) echo(chalk.blue(`    ${need.note}`))
  echo(chalk.blue(`    Then set it: ${esetHint('CLOUDFLARE_TOKEN')}`))
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

// ─── Ring 0 from here ─────────────────────────────────────────────────────────
// `fli deploy:setup` and `fli deploy` as child runs of this fli, in the Basecamp
// checkout, on this terminal. Not imported: each is a command with its own
// steps, journal and lock, and running it as a process is what keeps that so.
// Async so the stage bar's clock ticks, and inside an aside: this run's raw-mode
// keyboard would otherwise take the keys the child's questions wait for.
const runFli = async (argv, tty) => {
  const { spawn }   = await import('node:child_process')
  const { resolve } = await import('node:path')
  const { root } = provisionScript()
  return await tty.aside(() => new Promise((done) => {
    const child = spawn(process.execPath, [resolve(global.fliRoot, 'bin/fli.js'), ...argv],
      { cwd: root, stdio: 'inherit', env: process.env })
    child.on('close', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 1)))
    child.on('error', () => done(1))
  }))
}

// ─── The run's stages ─────────────────────────────────────────────────────────
// Each stage opens with an `n/of` header in the scrollback, and a line pinned to
// the terminal's foot says which one is running and for how long: deploy:setup
// is minutes of apt with long stretches where nothing prints.
const clock = (ms) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const stageBar = ({ tty, echo, chalk, quiet = false }, stages) => {
  if (quiet) return { at() {}, stop() {} }
  const began = Date.now()
  let at = -1
  let since = began
  const pin = tty.pin(() => {
    const s = stages[at]
    if (!s) return null
    return [
      chalk`{cyan ▸ ${at + 1}/${stages.length}} {bold ${s.name}}  ${clock(Date.now() - since)}`,
      chalk.dim(s.what),
      chalk.dim(`${clock(Date.now() - began)} in all`),
    ]
  })
  return {
    at(name) {
      at = stages.findIndex(s => s.name === name)
      since = Date.now()
      const s = stages[at]
      echo(chalk`\n  {cyan ${at + 1}/${stages.length}} {bold ${s.name}}  {dim ${s.what}}\n`)
      pin.update()
    },
    stop: pin.stop,
  }
}

// What every Basecamp install runs on the box, in order. `create` puts its buy
// and wait for ssh before them; an install with no Outpost drops the last.
const INSTALL_STAGES = [
  { name: 'deploy:setup',   what: 'docker and caddy on the box — a few minutes on a fresh one' },
  { name: 'env:push',       what: 'the addresses people and machines reach Basecamp at' },
  { name: 'deploy',         what: 'build the image, ship it, start Basecamp' },
  { name: 'dns',            what: 'mark the box as Basecamp\'s host and point the hostname at it' },
  { name: 'admin',          what: 'the first admin and the workspace, over ssh' },
  { name: 'deploy:outpost', what: 'enroll the box in Basecamp\'s own fleet' },
]
const installStages = (outpost) => INSTALL_STAGES.filter(s => outpost || s.name !== 'deploy:outpost')

// ─── Basecamp on a box ────────────────────────────────────────────────────────
// `fli basecamp:create` runs these on the box it just bought and `basecamp:install`
// on one that already answers ssh, so the two cannot install differently.
// Answers the first run that failed, or null. `stage` hears each step's name
// as it starts. The deploy runs `--no-outpost`: a fresh Basecamp has no workspace until
// `/setup`, so its enrollment step finds nothing to enroll into. `joinFleet`
// enrolls once the admin is made.
//
// The API's two public addresses are pushed between the two, because the box's
// env file starts without them and the API defaults both to localhost: every
// emailed link and every provisioned machine's enrollment then names the box
// itself. `env:push` adds what the file lacks and leaves, and names, a value
// the operator already set, so a re-run never overwrites a copy that is theirs.
const ringZero = async (dest, domain, { tty, stage }) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { resolve } = await import('node:path')
  const tmp  = mkdtempSync(resolve(tmpdir(), 'fli-basecamp-urls-'))
  const urls = resolve(tmp, 'env')
  writeFileSync(urls, `FRONTIER_APP_URL=https://${domain}\nFRONTIER_API_URL=https://${domain}\n`)
  const steps = [
    ['deploy:setup', '--auto-install', '--no-next-steps', '--server', dest, '--domain', domain],
    ['env:push', '--file', urls, '--server', dest],
    ['deploy', '--no-outpost', '--server', dest, '--domain', domain],
  ]
  try {
    for (const argv of steps) {
      stage(argv[0])
      const status = await runFli(argv, tty)
      if (status !== 0) return { argv, status }
    }
    return null
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// Basecamp's box as a machine of its own fleet, so apps can run beside it
// (`FJS-D1191`). After `makeAdmin`: enrollment files the box under the one
// workspace `/setup` made, and with none yet `deploy:outpost` says so and exits 0.
const OUTPOST_QUESTION = 'Make the box an Outpost too, so apps can run beside Basecamp on it?'
const joinFleet = async (dest, domain, tty) => await runFli(['deploy:outpost', '--server', dest, '--domain', domain], tty) === 0

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
const makeAdmin = async ({ dest, identity, workspace, admin, password, log, echo, chalk }) => {
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
  echo(`  ${chalk.dim('admin   ')} ${chalk.bold(admin)}`)
  if (generated) echo(`  ${chalk.dim('password')} ${chalk.bold(password)}   ${chalk.dim('shown once — change it after you sign in')}`)
  return true
}

// The admin, then the Outpost: enrollment files the box under the workspace
// `/setup` made, so when that failed the enrollment is printed rather than run.
// `later` is the `--server`/`--domain` tail a person types from packages/basecamp.
// Answers false when either failed.
const adminThenFleet = async ({ outpost, domain, later, tty, stage, ...admin }) => {
  stage('admin')
  if (!await makeAdmin(admin)) {
    if (outpost) admin.log.info(`  Once the admin is made at https://${domain}/setup, from packages/basecamp: fli deploy:outpost${later}`)
    return false
  }
  if (!outpost) return true
  stage('deploy:outpost')
  return await joinFleet(admin.dest, domain, tty)
}

// ─── An API key, minted over ssh ──────────────────────────────────────────────
// `deploy:repl -e` in the Basecamp checkout: the answer is the child's stdout
// alone, the boot's chatter its stderr — held, and shown only when it fails.
// `extra` is the argv tail; `--server` there names a box frontier.config.js
// does not, which is every box `create` made.
const replLine = async (code, extra = []) => {
  const { spawnSync } = await import('node:child_process')
  const { resolve }   = await import('node:path')
  const { root } = provisionScript()
  const r = spawnSync(process.execPath, [resolve(global.fliRoot, 'bin/fli.js'), 'deploy:repl', '-e', code, ...extra],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env })
  if (r.status !== 0) {
    const said = (r.stderr || '').trim().split('\n').filter(l => !l.startsWith('{"level"')).slice(-4).join('\n')
    throw new Error(`deploy:repl exited ${r.status ?? 'on a signal'}${said ? `:\n${said}` : ''}`)
  }
  try { return JSON.parse(r.stdout) }
  catch { throw new Error(`deploy:repl answered something that is not JSON: ${r.stdout.trim().slice(0, 200)}`) }
}

// Who may hold the key: a person, not a bot, who is an owner or admin of a
// workspace. A `sys` read, so it needs no --force.
const holders = async (extra = []) =>
  (await replLine(`sys.workspaceMember.findMany({ where: { role: { in: ['owner', 'admin'] } }, select: { role: true, workspaceId: true, workspace: { select: { name: true } }, user: { select: { email: true, kind: true } } } })`, extra))
    .filter(m => m.user?.kind === 'user')
    .map(m => ({ email: m.user.email, role: m.role, workspaceId: m.workspaceId, workspace: m.workspace?.name }))

// The service's own create, called as the holder in their workspace, so the
// mint is the one the API keys screen runs. Answers the token, or `{ error }`.
const mint = async (key, holder, extra = []) => {
  const made = await replLine(`call('api-keys.create', ${JSON.stringify(key)})`, ['--as', holder.email, '--tenant', holder.workspaceId, ...extra])
  return typeof made?.token === 'string'
    ? made
    : { error: 'Basecamp made the key but answered no token — revoke it on the API keys screen' }
}

const keyName = async () =>
  `fli ${(await import('node:os')).hostname()} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

// `create`'s key for the admin `/setup` just made, stored as `basecamp:key`
// stores one. The token is printed only to a terminal: a run piped into a CI
// log would keep a never-expiring admin credential in it. `yes` is create's
// own, so `--yes` copies without asking. Answers false when none was minted.
const KEY_QUESTION = `Mint an admin API key for the first admin, stored as BASECAMP_API_KEY?`
const adminKey = async ({ dest, admin, yes, log, echo, chalk }) => {
  const extra  = ['--server', dest]
  const later  = `fli basecamp:key --server ${dest} --as ${admin}`
  const made   = await (async () => {
    const holder = (await holders(extra)).find(p => p.email === admin)
    if (!holder) return { error: `${admin} is no owner or admin on the new Basecamp` }
    return await mint({ name: await keyName(), scopes: ['admin'], expiresIn: 'never' }, holder, extra)
  })().catch(e => ({ error: e.message }))
  if (made.error) { log.error(`${made.error}. Mint one later: ${later}`); return false }

  const { storeGlobal } = await import(new URL('file://' + global.fliRoot + '/core/global-env.js'))
  const file = storeGlobal('BASECAMP_API_KEY', made.token)
  echo`  {green ✓} {bold BASECAMP_API_KEY} {dim ${made.tokenHint ?? ''}} → ${file}`
  if (!process.stdout.isTTY) return true

  echo`  {dim api key } {bold ${made.token}}   {dim shown once — revoke it on the API keys screen if it leaks}\n`
  if (!await yes('Copy it to the clipboard?', true)) return true
  const { copyToClipboard, clipboardTools } = await import(new URL('file://' + global.fliRoot + '/core/clipboard.js'))
  if (copyToClipboard(made.token)) echo`  {green ✓} copied`
  else log.warn(`Could not copy — is ${clipboardTools() ?? 'a clipboard tool'} installed?`)
  return true
}

</script>

## Setup

`create` buys the box the way `fli server:create` does, so it needs a cloud's
API token — `fli server`'s Setup names each. Optional: `fli eset ME
you@example.com --global` — the first admin's email question then takes it on
Enter, and `--yes` needs no `--admin`.

### Cloudflare — `CLOUDFLARE_TOKEN`

- Made at https://dash.cloudflare.com/profile/api-tokens: **Create Token**, the **Edit zone DNS** template, then add two permissions, so the token holds three:
  - Zone › DNS › Edit — the host record `basecamp:dns` writes, and every Domain's records once Basecamp holds the token
  - Zone › Config Rules › Edit — the per-host Full (strict) rule written before a record turns proxied (`FJS-D1422`); without it `--proxied` and the flip at install are refused by Cloudflare
  - Zone › Zone Settings › Read — reading a zone's SSL mode, where Flexible plus Caddy's HTTPS redirect is a redirect loop (zero-to-live 2.4)
- **Zone Resources** names the zones it reaches; one zone is the narrowest, and every zone the account holds works
- **For Basecamp too** — the same token as an edge account in Basecamp (Secrets, kind `providerKey`, provider `cloudflare`)
- `fli eset CLOUDFLARE_TOKEN <token> --global`

## What it makes

`fli basecamp:create` is `fli server:create` and `fli basecamp:install` in one
run: one box, marked `basecamp` at its cloud, with Basecamp on it when asked.
`fli basecamp:install <server> --domain <host>` is the install alone, from any
directory — `fli deploy:setup --auto-install` and `fli deploy`, run in
`packages/basecamp` — and works the same on a box you made some other way.
Both ask whether the box is also an Outpost, and enroll it with `fli
deploy:outpost` once the first admin is made.

## Releasing through it

`fli basecamp:app`, run in an app's directory, makes it an App in Basecamp —
a project, its `production` environment and a bare container App placed on a
server — and writes `BASECAMP_APP_ID` to the app's `.env`, so `fli deploy`
releases through Basecamp from then on.

`fli basecamp:deploy --app <id>` builds an app's image here, loads it onto
every machine Basecamp runs that app on, and asks Basecamp to release it. It
needs a `BASECAMP_API_KEY` from the running Basecamp, not a cloud token.

`fli basecamp:key` mints that key over ssh — `api-keys.create` called as an
owner through `fli deploy:repl` — and stores it in the global env, with no
browser and no password. `fli basecamp:create` offers one for the first admin
once the install is done.

`fli basecamp:backup` fetches an App's newest bucket archive, or takes one
first with `--take`, and unpacks it under `db/backups/<stamp>/`; `fli
db:download` and `fli db:import` fetch the same way when `BASECAMP_APP_ID` is
set (`FJS-D1717`).

`fli basecamp:live` says why a released App is not answering — its release,
its machine, then each hostname's zone, DNS and HTTPS — and `--retry` reloads
Caddy on its machines so a certificate waiting out its backoff is asked for
now (`FJS-D1715`).
