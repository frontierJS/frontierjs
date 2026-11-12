---
namespace: basecamp
description: Basecamp itself — make its box at a cloud, install it, point its hostname, take it down, and release an app through it
---

<script>
// The box side — clouds, the buy, the marks and the hostnames — is
// `core/cloud.js`, shared with `fli server:*`; Basecamp's API and the Outpost
// paste are `core/basecamp.js`, shared with `fli outpost:install`.
const { CLOUDS, cloudLabel, pickCloud, cloudsToRead, listBoxes, cloudOf, runProvision, provisionScript, markHost,
  cloudflareToken, hostRecord, withHosts, boxAddress, waitForSsh, publicKey, boxName, buyBox, machineLine, ageOf }
  = await import(new URL('file://' + global.fliRoot + '/core/cloud.js'))
const { basecamp, basecampAll, pullHubArchive, basecampApi, pullRawBackup, apiCannotBackUp, backupsRoot, backupsOf, localBackups, filedKeys, keyDirOf, readBoxKey, keepKey, attestKeyCopy, KEY_COPIES, pickArchive, checkArchive, asRootOn, scriptOnBox, seedBoxKey, probeBox, putBoxKey, restartApi, probeUntil, stageOnBox, restoreFindings, readPostures, readPosture, postureLine, postureDetail, failingBySeverity, SUDO } = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))
const { plural } = await import(new URL('file://' + global.fliRoot + '/core/text.js'))

// Basecamp's own hostname, the one `pointHost` points at the box.
const webDomain = async () =>
  (await import(provisionScript().root + 'frontier.config.js')).default.deploy.web?.domain

const { resolveBasecamp, readBasecamps, writeBasecamp, reachBasecamp, reachBasecampFor, reinstallDomain, DEV_BASECAMP, DEV_BASECAMP_ORIGIN } = await import(new URL('file://' + global.fliRoot + '/core/basecamps.js'))

// The Basecamp a command talks to: `--basecamp <name>`, or the only entry
// (`reachBasecamp` owns the refusal, which lists the names when several are known).
// A command holding an App id uses `reachFor`, which asks every entry for it.
const reach    = (name, log) => reachBasecamp(name, log)
const reachFor = (name, appId, log) => reachBasecampFor(name, appId, log)

// The entry name a box-taking command talks to: `--basecamp`, else the entry
// named like the box (the ssh Host an entry is keyed by), else '' so `reach`
// falls to the only entry or refuses by name. A `user@host` box names no entry.
const entryFor = (name, server) => name || (Object.hasOwn(readBasecamps(), server) ? server : '')

// Files `name`'s entry over what is there: minting a new key must not drop the
// scoped key or the `runs` designation the entry already holds.
const fileBasecamp = (name, fields) => {
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
  return writeBasecamp(name, { ...readBasecamps()[name], ...set })
}

// The entry with its admin `apiKey`, or null after printing why there is none.
const adminEntry = (name, log) => {
  let entry
  try { entry = resolveBasecamp(name || undefined) } catch (err) { log.error(err.message); process.exitCode = 1; return null }
  if (entry.apiKey) return entry
  log.error(`Basecamp "${entry.name}" has no admin API key — fli basecamp:key --server ${entry.host ?? '<box>'} files one`)
  process.exitCode = 1
  return null
}

// A fresh install is a new database, so the narrow key kept beside the admin one
// names a key that no longer exists, and its next use fails 401 with nothing
// pointing at the reinstall. Answers whether there was one.
const dropScopedKey = (name) => {
  const { scopedKey, ...rest } = readBasecamps()[name] ?? {}
  if (!scopedKey) return false
  writeBasecamp(name, rest)
  return true
}

// The box `fli deploy` ships Basecamp to, as ssh reaches it.
const deployServer = async () =>
  (await import(provisionScript().root + 'frontier.config.js')).default.deploy.server

// Basecamp's db directory, env file and secrets directory on its box, as the
// deploy mounts them, and the login ssh uses there.
const deployFiles = async (server) => {
  const { apiFiles, sshHost } = await import(new URL('file://' + global.fliRoot + '/core/deploy-target.js'))
  const deploy = (await import(provisionScript().root + 'frontier.config.js')).default.deploy
  return { ...apiFiles(deploy, deploy.path), host: sshHost(deploy.user ?? null, server) }
}

// Asked before the install, so a token that opens no zone holding the hostname
// refuses before minutes of apt rather than after them. No token is not a
// refusal — the record can come later. Answers `{ refusal, points, zone, zones }`,
// points being the address Basecamp's record there holds now (null with none),
// zone the one holding the hostname and zones every `{ id, name }` the token opens.
// With the box's address it also refuses a name another live Basecamp holds, before
// the install rather than at its dns step, where the old install is already gone.
const zoneRefusal = async ({ domain, ip, log, echo, chalk }) => {
  if (!await cloudflareToken({ interactive: !!process.stdin.isTTY, say: (t) => log.warn(t) })) {
    log.warn(`No CLOUDFLARE_TOKEN: the install leaves ${domain} without a DNS record and prints the line that writes it`)
    return { refusal: null, points: null, zone: null, zones: [] }
  }
  const found = await hostRecord({ host: domain, check: true, ...(ip ? { ip } : {}) })
  if (found.live) return { refusal: found.error, points: found.live }
  if (found.error) return { refusal: `Cloudflare: ${found.error.replace(/^Cloudflare:\s*/, '')}`, points: null, rejected: /HTTP 40[13]|invalid access token/i.test(found.error) }
  echo(`  ${chalk.green('✓')} ${chalk.dim(`${found.zone} is at Cloudflare`)}\n`)
  return { refusal: null, points: found.points ?? null, zone: found.zone, zones: found.zones ?? [] }
}

// After a refusal that says the token itself is wrong: where it is read from
// and where a new one is made, in blue under the error. The page and what to
// pick on it come off `basecamp:dns`'s `requires:`, as `cloudflareToken` reads them.
const tokenHint = async ({ echo, chalk }) => {
  const { resolve }                = await import('node:path')
  const { loadModuleFile }         = await import(resolve(global.fliRoot, 'core/registry.js'))
  const { requiresOf }             = await import(resolve(global.fliRoot, 'core/requires.js'))
  const { esetHint, keyFile }      = await import(resolve(global.fliRoot, 'core/global-env.js'))
  const need = requiresOf(loadModuleFile(resolve(global.fliRoot, 'commands/basecamp/dns.md')).meta).find(r => r.key === 'CLOUDFLARE_TOKEN')
  const home = process.env.HOME ?? ''
  const profile = process.env.FLI_PROFILE || undefined
  echo(chalk.blue(`  ℹ Check CLOUDFLARE_TOKEN in this project's .env or ${profile ? `profile ${profile}` : 'the global one'} (${keyFile({ profile }).replace(home, '~')})`))
  echo(chalk.blue(`    OR make a new one: ${need?.url ?? 'https://dash.cloudflare.com/profile/api-tokens'}`))
  if (need?.note) echo(chalk.blue(`    ${need.note}`))
  echo(chalk.blue(`    Then set it: ${esetHint('CLOUDFLARE_TOKEN', profile)}`))
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
  log.done(`${done.host} → ${done.ip} in ${done.zone}, ${done.proxied ? 'behind the proxy' : 'DNS-only'}`)
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
  log.done(`${host} is behind Cloudflare's proxy, Full (strict) for this host`)
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
// `fli deploy` refuses an unpushed or ungraded HEAD at its preflight, which a
// create reaches only after the box is bought and readied (`FJS-4206`). Asked
// before the buy, or before `deploy:setup` on a box already there, the refusal
// costs nothing. Answers whether the install may go on.
const deployGateOpen = async ({ unverified, log }) => {
  const { checkDeployGate } = await import(new URL('file://' + global.fliRoot + '/core/deploy-gate.js'))
  const gate = checkDeployGate(provisionScript().root, { unverified })
  for (const [level, text] of gate.lines) log[level](text)
  return gate.ok
}

const ringZero = async (dest, domain, { unverified = false, tty, stage }) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { resolve } = await import('node:path')
  const tmp  = mkdtempSync(resolve(tmpdir(), 'fli-basecamp-urls-'))
  const urls = resolve(tmp, 'env')
  writeFileSync(urls, `FRONTIER_APP_URL=https://${domain}\nFRONTIER_API_URL=https://${domain}\n`)
  const steps = [
    ['deploy:setup', '--auto-install', '--no-next-steps', '--server', dest, '--domain', domain],
    ['env:push', '--file', urls, '--server', dest],
    ['deploy', '--no-outpost', '--server', dest, '--domain', domain, ...(unverified ? ['--unverified'] : [])],
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

// fwupd and multipathd off on the box Basecamp is installed on (`FJS-D1825`).
// The lines are the install script's own, `UNNEEDED_SERVICES_OFF` in Basecamp's
// enrollment.ts, run over ssh: a box Basecamp only installs on never runs that
// script, and a second copy of the commands would drift from the posture
// control that grades them. A box that joins the fleet runs the script too, so
// a no there turns them off at the enrollment regardless; `unneededKept` says
// so rather than leaving a no that does nothing.
const UNNEEDED_QUESTION = 'Turn off fwupd and multipathd? Neither has work on a cloud machine'
const unneededRow = (on, chalk) => on ? `yes ${chalk.dim('— disable multipathd, mask fwupd')}` : chalk.dim('no')
const unneededKept = (on, outpost, log) => {
  if (!on && outpost) log.warn('The Outpost install turns fwupd and multipathd off on every machine it enrolls; --no-outpost leaves them as they are')
}
const turnOffUnneeded = async (dest, identity, log) => {
  const { UNNEEDED_SERVICES_OFF } = await import(provisionScript().root + 'api/src/providers/compute/enrollment.ts')
  const run = scriptOnBox(dest, `${SUDO}\nsudo sh -s <<'FLI_UNNEEDED_EOF'\n${UNNEEDED_SERVICES_OFF}\nFLI_UNNEEDED_EOF\n`, { identity })
  if (run.ok) log.done('fwupd and multipathd are off')
  else log.warn(`Could not turn off fwupd and multipathd on ${dest}${run.said ? `: ${run.said}` : ''}. As root there: ${UNNEEDED_SERVICES_OFF.split('\n').join('; ')}`)
}

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
  const generated = !password
  if (generated) password = (await import('node:crypto')).randomBytes(18).toString('base64url')
  const { default: conf } = await import(provisionScript().root + 'frontier.config.js')
  const body = JSON.stringify({ workspace_name: workspace, name: admin.split('@')[0], email: admin, password })
  const setup = scriptOnBox(dest, `curl -sS -w '\\n%{http_code}' -X POST -H 'content-type: application/json' --data-binary @- http://localhost:${conf.deploy.api.port}/setup <<'FLI_SETUP_EOF'\n${body}\nFLI_SETUP_EOF\n`, { identity })
  const [code, ...rest] = setup.out.split('\n').reverse()
  const said = (() => { try { return JSON.parse(rest.reverse().join('\n')).message } catch { return setup.said } })()
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
// `core/basecamp-key.js`, shared with Workbench's Basecamps screen. `where` is
// `{ server }`: a box frontier.config.js does not name is every box `create` made.
const { replLine, holders, mint, keyName } = await import(new URL('file://' + global.fliRoot + '/core/basecamp-key.js'))

// `create`'s key for the admin `/setup` just made, filed in `basecamps.json` as
// `basecamp:key` files one. `entry` is `{ name, host, domain, cloud, boxId }`:
// the ssh Host name the index is keyed by, and the hostname the API origin is.
// The token is printed only to a terminal: a run piped into a CI
// log would keep a never-expiring admin credential in it. `yes` is create's
// own, so `--yes` copies without asking. Answers the token, or false when none was minted.
const KEY_QUESTION = `Mint an admin API key for the first admin, filed under the new Basecamp's name?`
const adminKey = async ({ dest, admin, entry, yes, log, echo, chalk }) => {
  const domain = entry.domain || await webDomain()
  const later  = `fli basecamp:key --server ${dest} --as ${admin}`
  if (!domain) { log.error(`A key is filed with Basecamp's hostname, and none is known. Mint one later: ${later} --domain <hostname>`); return false }
  const where  = { server: dest }
  const made   = await (async () => {
    const holder = (await holders(where)).find(p => p.email === admin)
    if (!holder) return { error: `${admin} is no owner or admin on the new Basecamp` }
    return await mint({ name: keyName(), scopes: ['admin'], expiresIn: 'never' }, holder, where)
  })().catch(e => ({ error: e.message }))
  if (made.error) { log.error(`${made.error}. Mint one later: ${later}`); return false }

  const file = fileBasecamp(entry.name, { url: `https://${domain}`, host: entry.host, cloud: entry.cloud, boxId: entry.boxId, apiKey: made.token })
  echo`  {green ✓} {bold api key} {dim ${made.tokenHint ?? ''} for ${entry.name}} → ${file}`
  if (!process.stdout.isTTY) return made.token

  echo`  {dim api key } {bold ${made.token}}   {dim shown once — revoke it on the API keys screen if it leaks}\n`
  if (!await yes('Copy it to the clipboard?', true)) return made.token
  const { copyToClipboard, clipboardTools } = await import(new URL('file://' + global.fliRoot + '/core/clipboard.js'))
  if (copyToClipboard(made.token)) echo`  {green ✓} copied`
  else log.warn(`Could not copy — is ${clipboardTools() ?? 'a clipboard tool'} installed?`)
  return made.token
}

// ─── An install: the questions, then the run ──────────────────────────────────
// `install` asks and runs at once; `reinstall` asks before its backup and runs
// after its retire, so the two cannot ask or install differently. `restore`
// drops the admin and the enrollment: `/setup` answers 409 once the archive
// brings its admins back, and the box enrolls into the restored workspace.

const questionLine = (chalk, q, hint) => `${chalk.cyan('?')} ${chalk.bold(q)}${hint ? chalk.dim(`  ${hint}`) : ''}`

/** Answers `{ domain, configured, admin, password, outpost, unneeded, ingress }`,
 *  or `{ refusal, rejected }` before anything is installed. `edge` asks Q4's
 *  question (`FJS-D1855`); `ingress` is then the zone picked, or null. `dest` is
 *  the box the hostname is about to point at. */
const askInstall = async ({ flag, dest, restore = false, edge = false, asking = !!process.stdin.isTTY, tty, log, echo, chalk }) => {
  const configured = (await webDomain()) || ''
  const asked = flag.domain || configured
  if (!asked) return { refusal: `Installing needs Basecamp's hostname: Caddy routes by it and fetches its certificate. Pass --domain` }
  const domain = await hostnameOf(asked)
  if (!domain) return { refusal: `"${asked}" is not a hostname: letters, digits, dots and dashes` }

  const ask = async (q, hint) => (await tty.line(`${questionLine(chalk, q, hint)}\n  ${chalk.cyan('›')}`)).trim()
  const yes = async (q) => await tty.keys(questionLine(chalk, q), { y: 'yes', n: 'no' }) === 'y'

  // tty.line, not prompt.js: a readline closed on this stdin leaves the secret
  // after it echoing, with an Enter that never arrives.
  let admin = ''
  let password = ''
  if (!restore) {
    admin = flag.admin || ''
    if (asking && !admin) admin = await askAdmin(ask)
    admin ||= EMAIL.test(process.env.ME ?? '') ? process.env.ME : ''
    if (!admin) return { refusal: NO_ADMIN }
    if (!EMAIL.test(admin)) return { refusal: `"${admin}" is not an email address` }
    if (asking) password = await tty.secret(`${questionLine(chalk, `Password for ${admin}`, 'Enter generates one')}\n  ${chalk.cyan('›')}`)
  }
  const outpost  = flag.outpost !== false && (!asking || await yes(OUTPOST_QUESTION))
  const unneeded = !asking || await yes(UNNEEDED_QUESTION)
  unneededKept(unneeded, outpost, log)

  const { refusal, rejected, zone, zones } = await zoneRefusal({ domain, ip: await boxAddress(dest), log, echo, chalk })
  if (refusal) return { refusal, rejected }
  if (!edge || restore) return { domain, configured, admin, password, outpost, unneeded }
  const ingress = zones.length ? await askIngress({ zone, zones, asking, tty, echo, chalk }) : null
  return { domain, configured, admin, password, outpost, unneeded, ingress }
}

// The install's token kept as Basecamp's own Cloudflare provider key, and a zone
// it opens made the ingress zone, so the checklist's DNS step is done at the
// first login. Yes and the hostname's zone are what Enter and --yes take; the
// token may be scoped to Basecamp's zone alone, which is why it is asked.
const INGRESS_QUESTION = `Keep the Cloudflare token as Basecamp's provider key, for app records?`
const askIngress = async ({ zone, zones, asking, tty, echo, chalk }) => {
  const named = zones.find(z => z.name === zone) ?? zones[0]
  if (!asking) return { zoneId: named.id, zoneName: named.name }
  if (await tty.keys(questionLine(chalk, INGRESS_QUESTION), { y: 'yes', n: 'no' }) !== 'y') return null
  if (zones.length === 1) return { zoneId: named.id, zoneName: named.name }
  const q = 'Which zone do app records go in?'
  if (zones.length <= 9) {
    const shown  = [named, ...zones.filter(z => z !== named)]
    const picked = await tty.keys(questionLine(chalk, q), Object.fromEntries(shown.map((z, i) => [String(i + 1), z.name])))
    const z = shown[Number(picked) - 1] ?? named
    return { zoneId: z.id, zoneName: z.name }
  }
  for (;;) {
    const typed = (await tty.line(`${questionLine(chalk, q, `Enter: ${named.name} · ${zones.length} zones open to the token`)}\n  ${chalk.cyan('›')}`)).trim().toLowerCase()
    const z = typed ? zones.find(z => z.name === typed) : named
    if (z) return { zoneId: z.id, zoneName: z.name }
    echo(chalk`  {yellow ${typed}} {dim is not a zone the token opens}`)
  }
}

/** The answers as `[label, value]` rows, for the summary before the run. */
const installRows = ({ domain, admin, password, outpost, unneeded, ingress, unverified }, chalk, restore = false) => [
  ['hostname', domain],
  unverified && ['deploy', chalk`{yellow unverified} {dim — HEAD ships though it is unpushed or CI did not pass on it}`],
  ingress !== undefined && ['ingress', ingress ? `${ingress.zoneName} ${chalk.dim('— the token kept as a provider key, app records there')}` : chalk.dim('no')],
  admin && ['admin', `${admin} ${chalk.dim(password ? '' : '— password generated')}`],
  ['outpost', !outpost ? chalk.dim('no') : `yes ${chalk.dim(restore ? '— enrolled into the restored workspace' : '— fli deploy:outpost once the admin is made')}`],
  ['services', unneededRow(unneeded, chalk)],
].filter(Boolean)

/** Install Basecamp on `dest` as answered. Answers `{ code, installed }`: the
 *  exit code, 0 or the first failure's, and whether Basecamp runs on the box. A
 *  record or proxy that failed fails the run and lets it finish. */
const runInstall = async (dest, answers, { restore = false, tty, log, echo, chalk }) => {
  const { domain, configured, admin, password, outpost, unneeded, unverified } = answers
  const asking = !!process.stdin.isTTY
  const yes = async (q) => await tty.keys(questionLine(chalk, q), { y: 'yes', n: 'no' }) === 'y'
  let code = 0

  echo(chalk`  {dim Installing Basecamp on} ${dest} {dim as} ${domain}`)
  const stages = stageBar({ tty, echo, chalk }, installStages(outpost).filter(s => !restore || !['admin', 'deploy:outpost'].includes(s.name)))
  const failed = await ringZero(dest, domain, { unverified, tty, stage: stages.at })
  if (failed) {
    log.error(`fli ${failed.argv.join(' ')} exited ${failed.status}. Fix what it said and run this again`)
    stages.stop()
    return { code: failed.status || 1, installed: false }
  }
  echo(chalk`  {green ✓} {bold Basecamp is on ${dest}}`)
  if (unneeded) await turnOffUnneeded(dest, '', log)
  stages.at('dns')
  const ip = await boxAddress(dest)
  await markHost({ ip, log })

  const record = await pointHost({ host: domain, ip, configured, log })
  if (!record || !await offerProxy({ record, configured, log, yes: asking && yes })) code = 1

  const named = domain === configured ? '' : ` --domain ${domain}`
  echo`
  A later deploy, from packages/basecamp:
    fli deploy --server ${dest}${named}
`
  if (restore) { stages.stop(); return { code, installed: true } }

  // An alias names the workspace after the box; a bare address has no name to give.
  const host = dest.split('@').pop()
  const workspace = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? 'basecamp' : host
  if (!await adminThenFleet({ dest, workspace, admin, password, log, echo, chalk, outpost, domain, later: ` --server ${dest}${named}`, tty, stage: stages.at })) code = 1
  stages.stop()
  return { code, installed: true }
}

// ─── Basecamp's backup, taken ─────────────────────────────────────────────────
// `backup` takes it on its own and `reinstall` before anything changes. The key
// copy is asked per run (`FJS-D1852`); reinstall asks before its confirmation
// and passes `how`.

/** Where the key's copy goes; a run with no terminal files it. */
const howToKeep = async (tty, chalk) =>
  tty.interactive ? await tty.keys(chalk`{cyan ?} {bold Where does a copy of the key go?}`, KEY_COPIES) : 'f'

/** Keep the box's key off the box as asked, and attest it when `attest` says
 *  the API runs that key; the backup stands whatever happens here. Answers the
 *  kept key's fingerprint, or null when the box keeps none. */
const keepKeyCopy = async ({ server, key, host, how, attest, tty, log, echo, chalk }) => {
  if (!key) { log.warn(`No ENCRYPTION_KEY on ${host}, in its secrets directory or env file — no copy of the key was kept`); return null }
  const kept = keepKey({ server, key, how: how ?? await howToKeep(tty, chalk), echo })
  if (kept.keyFile) echo(chalk`    {dim ·} {dim key} ${kept.fingerprint.slice(0, 12)} ${kept.already ? chalk`{dim already filed in}` : chalk`{dim filed in}`} ${kept.keyFile}`)
  if (!attest) { echo(chalk`    {dim ·} {dim not attested to Basecamp: a raw copy cannot show the API runs this key — the next API backup attests it}\n`); return kept.fingerprint }
  const done = await attest(kept.fingerprint).catch(err => err)
  if (done instanceof Error) log.warn(`The key copy was kept, but not attested to Basecamp: ${done.message}\n`)
  else echo(chalk`    {dim ·} {dim attested to Basecamp, so hub.key-escrowed reads} {green kept off the box}\n`)
  return kept.fingerprint
}

/** After an API backup: the box's key, attested only when the archive was
 *  taken under it. A key changed on the box without a restart is not the one
 *  the API still runs, which is the one the archive needs. Answers `{ keyKept, key }`. */
const keepArchiveKey = async ({ server, origin, key, taken, how, tty, log, echo, chalk }) => {
  const files = await deployFiles(server)
  const boxKey = await readBoxKey(files).catch(err => { log.warn(`${err.message} — no copy of the key was kept`); return undefined })
  if (boxKey === undefined) return { keyKept: null, key: null }
  const same = !!boxKey && new Bun.CryptoHasher('sha256').update(boxKey).digest('hex') === taken
  if (boxKey && !same) log.warn(`The key on ${files.host} is not the ${taken.slice(0, 12)} this archive was taken under — the API has not restarted since it changed. This archive needs that key; keeping the one on the box, unattested`)
  const attest = same ? (fingerprint) => attestKeyCopy({ origin, key, fingerprint }) : null
  const keyKept = await keepKeyCopy({ server, key: boxKey, host: files.host, how, attest, tty, log, echo, chalk })
  return { keyKept, key: keyKept ? boxKey : null }
}

/** The ssh path, printed as raw so nobody mistakes it for an archive. */
const copyRaw = async ({ server, out, say, how, dry, tty, log, echo, chalk }) => {
  const files = await deployFiles(server)
  echo(chalk`\n  {bold Copying Basecamp's files} {dim off} ${files.host} {dim — raw, so /setup cannot take them}`)
  const got = await pullRawBackup({ server, ...files, out, dry, log, say })
    .catch(err => { log.error(err.message); process.exitCode = 1; return null })
  if (!got) return null
  const ways = [...new Set(Object.values(got.record.copiedWith))].join(', ')
  echo(chalk`  {green ✓} {bold Copied ${got.record.takenAt}} {dim into} ${got.dir}`)
  echo(chalk`    {dim ·} ${plural(Object.keys(got.record.copiedWith).length, 'database')} {dim copied with} ${ways}${got.record.files.some(f => f.path === '.env.production') ? chalk` {dim and the env file}` : ''}`)
  const keyKept = await keepKeyCopy({ server, key: got.key, host: files.host, how, attest: null, tty, log, echo, chalk })
  return { kind: 'raw', dir: got.dir, takenAt: got.record.takenAt, keyKept, key: keyKept ? got.key : null }
}

/**
 * Take Basecamp's backup through its API, or over ssh when the API cannot or
 * `raw` asks. Answers `{ kind: 'archive' | 'raw', dir, takenAt, keyKept, key }` —
 * `keyKept` the fingerprint of the key copy now off the box and `key` that key,
 * both null with none — or null after printing why there is none.
 */
const takeBackup = async ({ server, out, basecamp: name, raw, how, dry, tty, log, echo, chalk }) => {
  const say = (line) => echo(chalk`  {dim ${line}}`)
  if (raw) return await copyRaw({ server, out, say, how, dry, tty, log, echo, chalk })

  // A ring-0 verb takes the admin key, so it never goes through `reach`, which
  // answers a runs entry's run key and refuses one that has none (FJS-D2031).
  const target = adminEntry(name, log)
  if (!target) { log.info('--raw copies the files over ssh with no key'); return null }
  const { url: origin, apiKey: key } = target

  echo(chalk`\n  {bold Backing up Basecamp} {dim at} ${origin} {dim on} ${server}`)
  const got = await pullHubArchive({ origin, key, out, dry, log, say }).catch(err => err)
  if (got instanceof Error && apiCannotBackUp(got)) {
    log.warn(`${got.message} — copying its files over ssh instead, which /setup cannot take`)
    return await copyRaw({ server, out, say, how, dry, tty, log, echo, chalk })
  }
  if (got instanceof Error) { log.error(got.message); process.exitCode = 1; return null }
  if (!got) return null

  echo(chalk`  {green ✓} {bold Archive taken ${got.manifest.takenAt}} {dim unpacked into} ${got.dir}`)
  echo(chalk`    {dim ·} ${plural(got.manifest.files.length, 'file')} {dim match manifest.json}`)
  const taken = got.manifest.encryptionKeyFingerprint
  const done = { kind: 'archive', dir: got.dir, takenAt: got.manifest.takenAt, keyKept: null, key: null }
  if (!taken) { echo(chalk`    {dim ·} {dim key} the development placeholder {dim — nothing to keep a copy of}\n`); return done }
  return { ...done, ...await keepArchiveKey({ server, origin, key, taken, how, tty, log, echo, chalk }) }
}

// ─── An archive, checked on this machine ──────────────────────────────────────
// `restore` and `reinstall`'s restore mode refuse here, before the box is
// touched: `/setup` grades the archive only on the new box, which in a
// reinstall is after the old one is gone.

/** The archive's key: `--key`, else the filed one its manifest names. */
const keyFor = (server, manifest, given) => {
  if (given) return given
  const fingerprint = manifest.encryptionKeyFingerprint
  if (!fingerprint) throw new Error('the archive was taken under the development key, which a production Basecamp refuses to boot on')
  const filed = filedKeys(server).get(fingerprint)
  if (!filed) throw new Error(`no key filed under ${keyDirOf(server)} has the fingerprint ${fingerprint.slice(0, 12)} the archive names — pass --key <file>`)
  return filed
}

/** Every refusal the laptop can find, before the box is asked anything. */
const checkHere = async ({ picked, keyFile, log, echo, chalk }) => {
  const verdict = await checkArchive({ archive: picked.archive, keyFile, basecampRoot: provisionScript().root })
  if (verdict.refused) {
    log.error(`${picked.archive} cannot be restored onto this checkout's Basecamp — the box was not touched:`)
    for (const why of verdict.refused) echo(chalk`    {red ✗} ${why}`)
    return false
  }
  echo(chalk`  {green ✓} {bold Archive taken ${picked.manifest.takenAt}} {dim checked here:} ${plural(picked.manifest.files.length, 'file')}{dim , the key and the migrations}`)
  echo(chalk`    {dim ·} {dim from} ${picked.dir}`)
  echo(chalk`    {dim ·} {dim key} ${keyFile}`)
  return true
}

// ─── An archive, onto a Basecamp with no admin ────────────────────────────────
// `restore` runs these onto an empty install, and `reinstall`'s restore mode
// onto the one it just made.

const sha256 = (text) => new Bun.CryptoHasher('sha256').update(text).digest('hex')

/** A box whose Basecamp has an admin already is never overwritten. */
const emptyOnBox = async ({ host, port, log, echo, chalk }) => {
  const probe = await probeBox({ host, port })
  if (!probe.needs_setup) {
    log.error(`Basecamp on ${host} is set up already (${plural(probe.users, 'user')}, ${plural(probe.workspaces, 'workspace')}) — an archive only fills an empty one, so retire it and install again first`)
    return false
  }
  echo(chalk`  {green ✓} {bold Basecamp on ${host} is empty} {dim — /setup is waiting}`)
  return true
}

/** The box must run the archive's key before `/setup` will take the archive. */
const boxRunsKey = async ({ files, port, container, key, say, echo, chalk }) => {
  const boxKey = await readBoxKey(files)
  if (boxKey && sha256(boxKey) === sha256(key)) { echo(chalk`    {dim ·} {dim the box runs the archive's key already}`); return }
  say(`Writing the archive's key to ${files.secretsDir}/ENCRYPTION_KEY and restarting ${container}`)
  await putBoxKey({ ...files, key })
  await restartApi({ host: files.host, container })
  await probeUntil({ host: files.host, port, until: () => true })
  echo(chalk`    {dim ·} {dim the API restarted on the archive's key} ${sha256(key).slice(0, 12)}`)
}

/** Stage the archive, restart, and wait for the boot that swaps it in. */
const swapIn = async ({ files, port, container, tar, say }) => {
  say('Sending the archive to /setup/restore, which checks it again and stages it')
  await stageOnBox({ host: files.host, port, tar })
  say(`Restarting ${container}, which swaps the staged archive in before any database opens`)
  await restartApi({ host: files.host, container })
  const probe = await probeUntil({ host: files.host, port, until: (p) => p.restore !== 'staged' })
  if (probe.restore !== 'done') throw new Error(`the restore ${probe.restore ?? 'did not run'}: ${probe.restore_message ?? 'no reason given'}`)
  return probe
}

/** Each machine, and whether the restored hub has heard it. */
const machineRows = (machines, chalk) => machines.map(m => m.beat
  ? chalk`{green ✓} ${m.name}  {dim heard} ${ageOf(m.lastHeartbeatAt)} {dim ago}`
  : chalk`{yellow ·} ${m.name}  {dim ${m.lastHeartbeatAt ? `not heard since the archive; last ${ageOf(m.lastHeartbeatAt)} ago` : 'never heard'}}`)

const foundRows = (found, takenAt, chalk) => [
  ...found.replicas.map(r => chalk`{cyan ·} ${r.name}  {dim replica synced} ${r.syncedAt ?? '?'} {dim — its screen offers the restore}`),
  found.hubReplica && (Date.parse(found.hubReplica.syncedAt ?? '') > Date.parse(takenAt)
    ? chalk`{yellow ·} {bold Basecamp's own replica}  {dim synced} ${found.hubReplica.syncedAt} {dim — newer than this archive; /hub/backups/ names the runbook for it}`
    : chalk`{cyan ·} {bold Basecamp's own replica}  {dim synced} ${found.hubReplica.syncedAt ?? '?'} {dim — no newer than this archive}`),
  ...found.archives.map(a => chalk`{cyan ·} ${a.app}  {dim archive} ${a.location} {dim (${a.status})}`),
]

/** Read the restored hub for its fleet and findings; the restore stands whatever this reads. */
const reportFindings = async ({ basecamp: name, takenAt, log, echo, chalk }) => {
  const target = (() => { try { return resolveBasecamp(name || undefined) } catch { return null } })()
  if (!target?.apiKey) { echo(chalk`    {dim ·} {dim fli basecamp:key files a key, and --basecamp names it, to read which machines the restored hub hears and what it found}\n`); return }
  const { url: origin, apiKey: key } = target
  echo(chalk`  {dim Reading} ${origin} {dim for its machines and what the reconcile found — up to a minute and a half}`)
  const found = await restoreFindings({ origin, key, takenAt }).catch(err => err)
  if (found instanceof Error) { log.warn(`The restore stands; what the hub found could not be read: ${found.message}`); return }
  const heard = found.machines.filter(m => m.beat).length
  echo(chalk`\n  {bold Fleet}  {dim ${heard} of ${plural(found.machines.length, 'enrolled machine')} heard since the archive}`)
  echo.lines(machineRows(found.machines, chalk), { indent: 4 })
  const rows = foundRows(found, takenAt, chalk).filter(Boolean)
  echo(chalk`\n  {bold Found}  {dim ${rows.length ? plural(rows.length, 'thing') + ' in the buckets so far' : 'nothing in the buckets so far'}}`)
  echo.lines(rows, { indent: 4 })
  if (found.hubReplica === undefined) echo(chalk`    {dim · the key cannot read hubConfig, so Basecamp's own replica is unknown}`)
  echo('')
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
a project, an environment of the target's tier (`--production`, `--stage`, else
development) and a bare container App placed on a server — and writes
`BASECAMP_APP_ID` to the app's `.env`, so `fli deploy` releases through
Basecamp from then on. With `BASECAMP_APP_ID` already set it adds another
target's environment and App to that project; `fli deploy` picks the App by the
same target flags (`FJS-D1965`, `FJS-D1966`).

`fli basecamp:deploy --app <id>` builds an app's image here, loads it onto
every machine Basecamp runs that app on, and asks Basecamp to release it. It
needs an API key from the running Basecamp, not a cloud token. Every
`basecamp:*` command that calls the API reads its origin and key from the index
of Basecamps (`~/.config/fli/basecamps.json`, keyed by the ssh Host name), and
takes `--basecamp <name>`: with one entry it is the default, and with several
and no flag the command refuses and lists them.

`fli basecamp:key` mints that key over ssh — `api-keys.create` called as an
owner through `fli deploy:repl` — and files it in that index, with no
browser and no password. `fli basecamp:create` offers one for the first admin
once the install is done.

`fli basecamp:backup` takes a backup of Basecamp itself and brings it to this
machine, checked against its manifest. An App's archive is `fli db:download`'s
(`FJS-D1848`). `fli basecamp:restore` puts one back onto a Basecamp nobody has
set up, checked against this checkout before the box is touched.
`fli basecamp:backups` sends a Basecamp's backups off the box: B2 buckets
made with this laptop's key, a narrow key and a tested destination per
workspace, and the hub and the Apps named pointed at them (`FJS-D2080`).

`fli basecamp:reinstall` is the three with `fli deploy:retire` between them,
on Basecamp's own box: it reads what runs there, asks every question first,
confirms once, then backs up, retires and installs again — fresh, or restored
from the backup it just took.

`fli basecamp:live` says why a released App is not answering — its release,
its machine, then each hostname's zone, DNS and HTTPS — and `--retry` reloads
Caddy on its machines so a certificate waiting out its backoff is asked for
now (`FJS-D1715`).

`fli basecamp:posture` prints each machine's security grade as Basecamp
stored it, with the report's age, and `fli basecamp:posture <server>` every
control of one with its fix. A server with no report reads `unknown`.
