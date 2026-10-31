// core/cloud.js — a box at a cloud, from this side: which cloud, its token, the
// buy, and the marks that say what is on the box. `fli server:*` and `fli
// basecamp:create` share every line here, so the two cannot buy differently.
//
// The vendor's dialect is Basecamp's compute connector, run in place — never a
// copy here (FJS-D1253). Basecamp is private, so this needs the framework
// checkout fli runs from, the same as ring 0's `fli deploy` of Basecamp.

export const provisionScript = () => {
  const root = new URL('../basecamp/', 'file://' + global.fliRoot + '/').pathname
  return { root }
}

// `host-record.ts` beside it is the Cloudflare half, for `basecamp:dns` and `pointHost`.
export const runProvision = async (input, file = 'provision-host.ts', env = {}) => {
  const { spawnSync }  = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { root } = provisionScript()
  const script = root + 'api/src/domain/host/' + file
  if (!existsSync(script))
    return { error: `no Basecamp checkout at ${root}: the server and basecamp commands run from the framework repository` }

  const run = spawnSync('bun', [script, JSON.stringify(input)], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const last = (run.stdout || '').trim().split('\n').pop()
  try { return JSON.parse(last) }
  catch { return { error: `${file} answered no JSON (exit ${run.status})` } }
}

// ─── Clouds ──────────────────────────────────────────────────────────────────
// The one place on this side a vendor is named: the token key provision-host.ts
// reads (the kind upper-cased, then _TOKEN), the page that makes one, and what a
// held address costs there.
export const CLOUDS = {
  digitalocean: { label: 'DigitalOcean', key: 'DIGITALOCEAN_TOKEN',
    url: 'https://cloud.digitalocean.com/account/api/tokens/new', note: 'Pick Full Access',
    addresses: 'https://cloud.digitalocean.com/networking/reserved_ips', held: '$5/mo while no box holds it' },
  hetzner: { label: 'Hetzner', key: 'HETZNER_TOKEN',
    url: 'https://console.hetzner.cloud/projects', note: 'Open the project, then Security → API tokens → Generate, Read & Write',
    addresses: 'https://console.hetzner.cloud/projects', held: '€0.50/mo plus VAT, held or not' },
}
export const cloudLabel = (cloud) => CLOUDS[cloud]?.label ?? cloud
export const storedClouds = () => Object.keys(CLOUDS).filter(k => process.env[CLOUDS[k].key])

// Asked rather than declared in `requires:`: which token a run needs is not
// known until the cloud is.
export const cloudToken = async (cloud, { interactive, write = true, say }) => {
  const c = CLOUDS[cloud]
  if (process.env[c.key]) return true
  const { resolve }        = await import('node:path')
  const { acquireMissing } = await import(resolve(global.fliRoot, 'core/requires.js'))
  const left = await acquireMissing('basecamp', [{ key: c.key, url: c.url, note: c.note }], { interactive, write, say })
  return !left.length
}

// The cloud a command buys at or acts on (FJS-D1478): --cloud, else the one
// whose token is stored. With both stored a terminal is asked and none is
// refused; with neither, a terminal is asked which and then for its token.
// `interactive` is false under --yes, which would otherwise take the first
// cloud as Enter's answer and buy at one nobody named.
// choose is whether the cloud may be asked, apart from whether a token may be
// pasted: Enter's answer to which cloud would buy at whichever is listed first.
export const pickCloud = async ({ cloud, interactive, choose = interactive, tty, chalk, say }) => {
  const kinds = Object.keys(CLOUDS)
  if (cloud && !CLOUDS[cloud]) return { error: `--cloud takes ${kinds.join(' or ')}, not '${cloud}'` }
  const stored = storedClouds()
  cloud ||= stored.length === 1 ? stored[0] : ''
  if (!cloud) {
    if (!choose) return { error: stored.length
      ? `tokens for ${stored.map(cloudLabel).join(' and ')} are stored: pass --cloud ${kinds.join('|')}`
      : `no cloud token is stored: pass --cloud ${kinds.join('|')}, or set ${kinds.map(k => CLOUDS[k].key).join(' or ')}` }
    const keys = Object.fromEntries(kinds.map(k => [k[0], cloudLabel(k)]))
    const pick = await tty.keys(chalk`{cyan ?} {bold Which cloud?}`, keys)
    cloud = kinds.find(k => k[0] === pick)
  }
  if (!await cloudToken(cloud, { interactive, say })) return { error: `${CLOUDS[cloud].key} is not set` }
  return { cloud }
}

// The clouds a read spans: every one with a stored token unless --cloud names
// one, else the one pickCloud settles on.
export const cloudsToRead = async (opts) => {
  const stored = storedClouds()
  if (!opts.cloud && stored.length) return { clouds: stored }
  const picked = await pickCloud(opts)
  return picked.error ? picked : { clouds: [picked.cloud] }
}

// Every fleet-marked box across those clouds, each carrying its cloud. One
// cloud failing fails the read: a pick offered off a partial list is not the
// whole account.
export const listBoxes = async (clouds) => {
  const machines = []
  for (const cloud of clouds) {
    const done = await runProvision({ cloud, action: 'list' })
    if (done.error) return { error: `${cloudLabel(cloud)}: ${done.error}` }
    machines.push(...done.machines.map(m => ({ ...m, cloud })))
  }
  return { machines }
}

// The box at an address, among every box a stored cloud token reaches, or
// null: one no token reaches was made by hand and has nothing to mark.
const boxAt = async (ip) => {
  const read = await listBoxes(storedClouds())
  if (read.error) return read
  return { box: (ip && read.machines.find(m => m.ip === ip || m.reservedIp === ip)) || null }
}

// The host mark, once Basecamp answers on the box. Without it the box reads as
// a bare one, which `fli basecamp:create` refuses to buy a second of.
export const markHost = async ({ ip, cloud, id, log }) => {
  const unmarked = (why) => log.warn(`  Not marked as Basecamp's host: ${why}. A rerun of fli basecamp:install marks it`)
  if (!id) {
    const found = await boxAt(ip)
    if (found.error) return unmarked(found.error)
    if (!found.box) return
    cloud = found.box.cloud
    id    = found.box.id
  }
  const done = await runProvision({ cloud, action: 'host', id: String(id) })
  if (done.error) unmarked(done.error)
}

// The app mark, once `fli deploy:setup` readied an app on the box. Without it
// the box reads as bare, and `fli basecamp:create` refuses while it is there.
export const markApp = async ({ ip, log }) => {
  const unmarked = (why) => log.warn(`  Not marked as an app box at its cloud: ${why}. fli server reads it as bare until a rerun of fli deploy:setup marks it`)
  const found = await boxAt(ip)
  if (found.error) return unmarked(found.error)
  if (!found.box) return
  const done = await runProvision({ cloud: found.box.cloud, action: 'app', id: String(found.box.id) })
  if (done.error) unmarked(done.error)
}

// The server mark, once the box is a fleet machine: the Server row's id, the
// mark a box Basecamp bought itself carries from birth. Without it the box
// reads as bare, and `fli server:destroy` would take a machine the fleet runs on.
export const markServer = async ({ ip, serverId, log }) => {
  const unmarked = (why) => log.warn(`  Not marked as server ${serverId} at its cloud: ${why}. fli server reads it as a bare box until it is`)
  const found = await boxAt(ip)
  if (found.error) return unmarked(found.error)
  if (!found.box) return
  const done = await runProvision({ cloud: found.box.cloud, action: 'server', id: String(found.box.id), serverId })
  if (done.error) unmarked(done.error)
}

// The cloud a typed id is at. Ids are per cloud and may collide, so an id at
// two of them is refused rather than guessed.
export const cloudOf = (id, machines, clouds) => {
  const at = [...new Set(machines.filter(m => String(m.id) === id).map(m => m.cloud))]
  if (at.length > 1) return { error: `${id} is a box at ${at.map(cloudLabel).join(' and ')}: pass --cloud` }
  if (at.length) return { cloud: at[0] }
  if (clouds.length === 1) return { cloud: clouds[0] }
  return { error: `${id} is not a box fli server:create made at ${clouds.map(cloudLabel).join(' or ')}` }
}

// ─── Cloudflare, for the hostnames ───────────────────────────────────────────
// The token page and what to pick on it are `basecamp:dns`'s `requires:`, read
// off that file so install and create cannot send a person to a different page.
// They ask here rather than declaring it: no token is not a refusal for them.
export const cloudflareToken = async ({ interactive, write = true, say }) => {
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
export const hostRecord = (input) => runProvision(input, 'host-record.ts', { CLOUDFLARE_TOKEN: process.env.CLOUDFLARE_TOKEN })

// Each machine's hostname, read off the A record pointing at its address —
// Basecamp's config names no domain and create keeps the one it was handed
// nowhere, so Cloudflare is the only place the pairing lives. The reserved IP
// is asked too, since the record names that and not the box's own. No
// token leaves every machine unnamed rather than refusing the list.
export const withHosts = async (machines) => {
  if (!process.env.CLOUDFLARE_TOKEN) return machines
  const ips = [...new Set(machines.flatMap(m => [m.reservedIp, m.ip]).filter(Boolean))]
  if (!ips.length) return machines
  const records = (await hostRecord({ find: ips })).records ?? []
  return machines.map(m => {
    for (const ip of [m.reservedIp, m.ip].filter(Boolean)) {
      const at   = records.filter(r => r.ip === ip)
      const name = (at.find(r => r.marked) ?? at[0])?.name
      if (name) return { ...m, host: name }
    }
    return m
  })
}

// ─── The box, over ssh ───────────────────────────────────────────────────────
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

// The box's IPv4 address. An ssh alias names none, so ssh's own reading of its
// config is asked, then the resolver; null when neither gives one.
export const boxAddress = async (dest) => {
  const host = dest.split('@').pop()
  if (IPV4.test(host)) return host
  const { spawnSync } = await import('node:child_process')
  const named = (spawnSync('ssh', ['-G', dest], { encoding: 'utf8' }).stdout || '').match(/^hostname (\S+)$/m)?.[1] ?? host
  if (IPV4.test(named)) return named
  try { return (await (await import('node:dns')).promises.lookup(named, { family: 4 })).address }
  catch { return null }
}

// A box has an address before it has an sshd. BatchMode, so nothing here
// can wait on a password; accept-new records the host key once, so the runs
// after it meet a known host and ask nothing.
export const waitForSsh = async (dest, { identity, timeoutMs = 240_000, everyMs = 5_000 } = {}) => {
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

// The public key that goes on the box: --key, else the usual two. Answers
// { keyPath, identity } or { error }.
export const publicKey = async (key) => {
  const { existsSync } = await import('node:fs')
  const { homedir }    = await import('node:os')
  const home = homedir()
  const expand = p => p.replace(/^~(?=\/|$)/, home)
  const keyPath = key
    ? expand(key)
    : [`${home}/.ssh/id_ed25519.pub`, `${home}/.ssh/id_rsa.pub`].find(p => existsSync(p))
  if (!keyPath || !existsSync(keyPath))
    return { error: key ? `No public key at ${keyPath}` : 'No ~/.ssh/id_ed25519.pub or id_rsa.pub: pass --key <file.pub>' }
  if (!keyPath.endsWith('.pub')) return { error: `${keyPath} is not a .pub file: pass the PUBLIC key` }
  return { keyPath, identity: keyPath.replace(/\.pub$/, '') }
}

// The name is a hostname at the cloud and a Host pattern in ~/.ssh/config: a
// space or a `*` would buy the box and then write a Host line matching others.
export const boxName = (name) => /^[a-z0-9][a-z0-9.-]*$/i.test(name)

// One box bought and made reachable: the cloud's create, the stale known_hosts
// line dropped, and a Host block in ~/.ssh/config when asked. `sole` refuses
// while a bare box an earlier run left is at the account, so a retry never buys
// two — Basecamp's rule, since one Basecamp has one box; a fleet takes many.
// Prints the box and its address; `json` prints nothing and stops at the buy.
// Answers { error }, { made } when the box has no address yet or under json,
// else { made, dest, box, identity, block, added }.
export const buyBox = async ({ cloud, name, size, region, image, keyPath, reservedIp, reuse, sole = false, addHost, json = false, log, echo, chalk }) => {
  const { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { homedir }   = await import('node:os')
  const home = homedir()
  const row  = (label, value) => echo(`  ${chalk.dim(label.padEnd(9))} ${value}`)

  log.info(`Creating ${name} at ${cloudLabel(cloud)} (${[size, region].filter(Boolean).join(', ')}) — about a minute`)
  const made = await runProvision({
    cloud, action: 'create', name, region, image, size, sole,
    publicKey: readFileSync(keyPath, 'utf8'),
    reservedIp, reuse: reuse ?? undefined,
  })
  if (made.error) return { error: made.error }
  if (json) return { made }

  const monthly = made.monthly == null ? '' : ` · ${(made.monthly / 100).toFixed(2)} ${made.currency}/mo`
  echo('')
  row('box', `${chalk.bold(made.name)}  ${made.id}  ${chalk.dim(`${made.size} · ${made.region} · ${made.image}${monthly}`)}`)

  if (made.pending) {
    log.warn(`  It has no address yet. fli server reads it later, or destroy it: fli server:stop ${made.id}, then fli server:destroy ${made.id}`)
    return { made }
  }

  const identity = keyPath.replace(/\.pub$/, '')
  const block = `Host ${made.name}
  HostName ${made.ip}
  User root
  IdentityFile ${identity.replace(home, '~')}
`
  row('ip', made.reserved?.ip
    ? `${chalk.bold(made.ip)} ${chalk.dim(`reserved${made.reserved.reused ? ', reused' : ''}${made.boxIp !== made.ip ? ` · box ${made.boxIp}` : ''}`)}`
    : chalk.bold(made.ip))
  if (made.reserved?.error) log.warn(`  No reserved IP: ${made.reserved.error}. The box answers on its own address`)
  echo('')

  // The box is minutes old, so a known_hosts line for its address is an older
  // box's — a reused reserved IP always has one — and accept-new refuses a
  // changed key, which reads as ssh never answering.
  if (spawnSync('ssh-keygen', ['-F', made.ip], { stdio: 'ignore' }).status === 0) {
    spawnSync('ssh-keygen', ['-R', made.ip], { stdio: 'ignore' })
    log.info(`  Dropped the old known_hosts line for ${made.ip}`)
  }

  // A Host of the same name is somebody's existing machine: ssh takes the FIRST
  // match, so appending a second would be silently ignored, and replacing it would
  // point that alias at a stranger's box.
  const sshConfig = `${home}/.ssh/config`
  let added = false
  if (addHost) {
    const had = existsSync(sshConfig) ? readFileSync(sshConfig, 'utf8') : null
    const taken = had != null && had.split('\n').some(line => {
      const [word, ...patterns] = line.trim().split(/\s+/)
      return word?.toLowerCase() === 'host' && patterns.includes(made.name)
    })
    if (taken) log.warn(`  ~/.ssh/config already has a Host ${made.name}: left alone`)
    else {
      if (had == null) { mkdirSync(`${home}/.ssh`, { recursive: true, mode: 0o700 }); writeFileSync(sshConfig, '', { mode: 0o600 }) }
      appendFileSync(sshConfig, (had && !had.endsWith('\n') ? '\n' : '') + (had ? '\n' : '') + block)
      added = true
      log.success(`  Added Host ${made.name} to ~/.ssh/config — ssh ${made.name}`)
    }
  }
  if (!added) echo`  Add to ~/.ssh/config:

${block.replace(/^(?=.)/gm, '  ')}`

  // The Host alias when this run wrote it, the address otherwise.
  const dest = `root@${made.ip}`
  return { made, dest, box: added ? made.name : dest, identity, block, added }
}

// ─── The list ────────────────────────────────────────────────────────────────
// One row of `fli server`, and of the pick `server:stop` and `server:destroy`
// offer with no id. A box with no server id, no host mark and no app mark is
// bare: bought and nothing on it yet. Each column is padded before it is painted: an escape
// code counts toward padEnd. `chalk` is handed in, since a module script does
// not see `$`.
const STATUS_TONE = { running: 'green', off: 'gray', starting: 'yellow', deleting: 'red' }
// Age since the vendor made the box, not uptime: a box powered off and on
// keeps its first date, so the column is never called "online for".
export const ageOf = (createdAt, now = Date.now()) => {
  const ms = now - Date.parse(createdAt ?? '')
  if (!(ms >= 0)) return '-'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m`
  if (min < 1440) return `${Math.floor(min / 60)}h`
  return `${Math.floor(min / 1440)}d`
}
export const machineLine = (m, chalk) => {
  const paint  = chalk[STATUS_TONE[m.status] ?? 'yellow']
  const status = paint(`● ${m.status.padEnd(8)}`)
  const age    = chalk.dim(`⏱ ${ageOf(m.createdAt).padEnd(5)}`)
  const ip     = m.ip ? chalk.cyan(m.ip.padEnd(15)) : chalk.dim('no address yet')
  const role   = m.serverId ? chalk`📡 {magenta fleet machine} {dim · server ${m.serverId} · destroy it in Basecamp}`
    : m.basecampHost ? chalk`⛺ {bold.green Basecamp host}`
    : m.app ? chalk`🚀 {blue app box} {dim · fli outpost:install enrolls it in a fleet}`
    : chalk`📦 {yellow bare} {dim · deploy an app to it, fli outpost:install, or fli basecamp:install}`
  const host   = m.host ? chalk`  {cyan https://${m.host}}` : ''
  const name   = chalk.bold((m.name ?? '-').padEnd(14))
  const where  = `${cloudLabel(m.cloud).padEnd(12)} ${(m.region ?? '-').padEnd(5)}`
  return chalk`{bold ${m.id}}  ${name}  ${status}  ${age}  ${ip}  {dim 🌐 ${where}}  ${role}${host}`
}
