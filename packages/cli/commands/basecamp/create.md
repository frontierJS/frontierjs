---
title: basecamp:create
description: Create a box for Basecamp at a cloud, print its IP and add its ssh Host
effects: creates a box at a cloud, billed to the token's account; installing also writes its DNS record at Cloudflare
confirm: human
examples:
  - fli basecamp:create
  - fli basecamp:create --cloud hetzner --size 8gb
  - fli basecamp:create --name ops --key ~/.ssh/id_rsa.pub
  - fli basecamp:create --domain ops.example.com
  - fli basecamp:create --yes --domain ops.example.com --name ops
flags:
  cloud:
    type: string
    description: The cloud to buy at, by kind (default the one whose token is stored; asked at a terminal when both or neither are, required under --yes then)
    defaultValue: ''
  size:
    type: string
    description: Memory (1gb, 4gb, 8gb …) for the cheapest x86 size with that much, or the cloud's own size slug
    defaultValue: 4gb
  region:
    type: string
    description: The cloud's region slug (default its US one)
    defaultValue: ''
  name:
    type: string
    description: The box's name, and the Host in the ssh block (asked at a terminal, basecamp otherwise)
    defaultValue: ''
  domain:
    type: string
    description: Basecamp's hostname (asked at a terminal; default the web.domain in packages/basecamp/frontier.config.js)
    defaultValue: ''
  image:
    type: string
    description: The cloud's image slug (default its Ubuntu 24.04)
    defaultValue: ''
  key:
    type: string
    description: The SSH public key put on the box (default ~/.ssh/id_ed25519.pub, else id_rsa.pub)
    defaultValue: ''
  admin:
    type: string
    description: Install Basecamp without asking, and make this email its first admin
    defaultValue: ''
  reserved-ip:
    type: boolean
    description: Hold an address apart from the box, so a replacement keeps it and outbound traffic leaves from it (billed at the cloud's rate, Setup names it)
    defaultValue: true
  outpost:
    type: boolean
    description: When installing, enroll the box in Basecamp's own fleet, so apps can run beside it (asked at a terminal)
    defaultValue: true
  yes:
    char: y
    type: boolean
    description: Say yes to every question, installing included, and take Enter's answer for the rest
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Print the answer as JSON
    defaultValue: false
---

Asks Basecamp's hostname first — Enter takes `deploy.web.domain` from
`packages/basecamp/frontier.config.js` (none when it is empty), `--domain` skips
the question. Then the server's name — Enter takes the hostname's first label (`ops2` for
`ops2.example.com`, `basecamp` with no hostname), `--name` skips the
question, and a run with no terminal uses that label. At a terminal the answers
are shown together and one last key buys the box or leaves it. Then creates one box
with your SSH key on it, waits until it has an address,
and adds a `Host` block for it to `~/.ssh/config` — asked first, yes unless you
say no; a `Host` of that name already there is left alone and the block printed
instead. Nothing is installed on it unless asked: `fli basecamp:install` puts
Basecamp on it, and the run prints that line.

The box answers on a reserved IP unless `--no-reserved-ip`: the address the
ssh block, the install and the DNS record all name, and the one its outbound
traffic leaves from. At a cloud that routes it beside the box's own address, a
timer on the box sends egress through it while it is assigned, and back
through the box's own once it is not; at one that puts it on the box itself,
there is nothing to route. When the hostname's record already holds a reserved
IP in the region that no box holds, that one is reused, so a replaced Basecamp
keeps its address and its DNS; otherwise a new one is reserved, before the box
is bought. It outlives the box and bills at the cloud's rate. A reservation
refused refuses the run with nothing bought; one that does not reach the box
warns, and the run goes on with the box's own address.

`--admin <email>` installs without asking, which is how a run with no terminal
gets past the bare box: `deploy:setup --auto-install` asks nothing, makes the
`ENCRYPTION_KEY` into your local `.env.production` when there is none, and
`fli deploy` follows. Basecamp's first admin is then made through its own
`POST /setup`, over ssh on the box, so no DNS is needed yet. At a terminal the
password is asked; Enter, or no terminal, generates one and prints it once.
**An install always makes the admin**, since `/setup` makes the workspace too:
a run that would install with no email refuses before anything is bought.
An install also asks whether the box is an Outpost of Basecamp's own fleet —
yes by default, `--no-outpost` to leave it out — and enrolls it with `fli
deploy:outpost` after the admin, as `fli basecamp:install` does.

The box and the hostname reach the install as `--server` and `--domain`, and
every deploy line the run prints carries both, so nothing is written into
`packages/basecamp/frontier.config.js`. Installing needs a hostname, and a run
with none refuses before anything is bought.

Once Basecamp is up the run points the hostname at the box — `fli
basecamp:dns`'s write, DNS-only, in a record Basecamp's own edge reads as its
own. The token is checked right after the hostname, before any other question or
purchase: one that opens no zone holding it refuses the run, so nothing is spent
on a box whose name cannot be pointed at it. With no `CLOUDFLARE_TOKEN` a
terminal takes the paste, and a run with no terminal warns, installs, and prints
the `fli basecamp:dns` line instead of writing the record.

`--yes` answers every question for you: each yes/no is yes — installing,
the Outpost and the purchase included — and each typed answer is what Enter
takes. It refuses without `--domain`, since a run that asks nothing
names the box on the command line (`--name` defaults to the hostname's first
label), and without `--cloud` unless exactly one
cloud's token is stored. The admin is `--admin`, else
`ME` from your global fli env, and with neither it refuses; the password is
generated. The summary still prints. A missing
token is still asked for, since it has no default.

A second run refuses while a box made by an earlier one is still at the
account with nothing installed on it, so a retry never buys two. Once Basecamp
answers, the install marks the box as Basecamp's host, which a later create
passes over. `fli server` shows it, and `fli server:stop <id>` then `fli server:destroy <id>` removes it. The box half alone is `fli server:create`; this is that and `fli basecamp:install` in one run.

```js
const key = await publicKey(flag.key)
if (key.error) { log.error(key.error); return }
const keyPath = key.keyPath
const home    = process.env.HOME

if (flag.admin && flag.json) {
  log.error('--json prints the box and stops, so it never installs: drop one of --json and --admin')
  process.exitCode = 1
  return
}

// Under --yes the tty answers each question with its default, so the run takes
// the asking path with nobody at it; `yes` below turns a no-default into yes.
const asking = (process.stdin.isTTY || flag.yes) && !flag.json

// A default hostname or name under --yes would buy a box nobody named.
const unnamed = flag.yes && !flag.domain
if (unnamed) {
  log.error(`--yes needs --domain: it buys and installs without asking, so the box is named on the command line. Nothing was bought`)
  process.exitCode = 1
  return
}
const cloudPick = await pickCloud({ cloud: flag.cloud, interactive: !!process.stdin.isTTY, choose: !!process.stdin.isTTY && !flag.yes, tty, chalk, say: (t) => log.warn(t) })
if (cloudPick.error) { log.error(`${cloudPick.error}. Nothing was bought`); process.exitCode = 1; return }
const cloud  = cloudPick.cloud
const vendor = cloudLabel(cloud)

const question = (q, hint) => `${chalk.cyan('?')} ${chalk.bold(q)}${hint ? chalk.dim(`  ${hint}`) : ''}`
const ask = async (q, hint) => (await tty.line(`${question(q, hint)}\n  ${chalk.cyan('›')}`)).trim()
const yes = async (q, fallback) => flag.yes ||
  await tty.keys(question(q), fallback ? { y: 'yes', n: 'no' } : { n: 'no', y: 'yes' }) === 'y'
const row = (label, value) => echo(`  ${chalk.dim(label.padEnd(9))} ${value}`)

if (asking) echo(`\n  ${chalk.bold('fli basecamp:create')}  ${chalk.dim(`a box at ${vendor} for Basecamp`)}\n`)

// The hostname is asked before anything else, and the DNS step this run ends by
// naming is checked on it: a token that opens no zone holding the hostname
// refuses here, not after the questions, the box and the install. No token
// is not a refusal — the record can come later.
const configured = (await webDomain()) || ''
let domain = flag.json ? '' : flag.domain || configured
if (asking && !flag.domain)
  domain = await ask(`Basecamp's hostname`, configured ? `Enter: ${configured}` : 'e.g. basecamp.frontierjs.dev — Enter: none yet') || configured
if (domain) {
  const named = await hostnameOf(domain)
  if (!named) {
    log.error(`"${domain}" is not a hostname: letters, digits, dots and dashes`)
    process.exitCode = 1
    return
  }
  domain = named
}
// The address the hostname's record holds now: a reserved IP there is reused,
// so a replacement box keeps its DNS.
let points = null
if (domain) {
  const zone = await zoneRefusal({ domain, log, echo, chalk })
  points = zone.points
  if (zone.refusal) {
    log.error(`${zone.refusal}. Nothing was bought`)
    process.exitCode = 1
    return
  }
}
else if (asking) echo('')

// Every question before the box is bought, so the minute it takes is one
// the person can walk away from.
// The hostname's first label names the box: ops2.example.com is ops2.
const fallbackName = domain.split('.')[0] || 'basecamp'
let name = flag.name
let admin = flag.admin
let password = ''
let install = !!admin
let outpost = flag.outpost
let addHost = false
if (asking) {
  name ||= await ask('Server name', `Enter: ${fallbackName}`) || fallbackName
  addHost = await yes(`Add Host ${name} to ~/.ssh/config once it has an address?`, true)
  install ||= await yes('Install Basecamp on it once it is up?', false)
  if (install && !admin) admin = await askAdmin(ask)
  if (install && outpost) outpost = await yes(OUTPOST_QUESTION, true)
  if (admin) password = await tty.secret(`${question(`Password for ${admin}`, 'Enter generates one')}\n  ${chalk.cyan('›')}`)
  if (install && flag.key && !addHost)
    log.warn(`ssh offers your default identity, not ${keyPath}: if the install cannot connect, add the Host block it prints and run it from packages/basecamp`)
}

name ||= fallbackName
if (install && !domain) {
  log.error(`Installing needs Basecamp's hostname: Caddy routes by it and fetches its certificate. Pass --domain, or answer the hostname question`)
  process.exitCode = 1
  return
}
if (install && !admin) {
  log.error(`${NO_ADMIN}. Nothing was bought`)
  process.exitCode = 1
  return
}
if (admin && !EMAIL.test(admin)) {
  log.error(`"${admin}" is not an email address`)
  process.exitCode = 1
  return
}

if (!boxName(name)) {
  log.error(`"${name}" is not a hostname: letters, digits, dots and dashes`)
  process.exitCode = 1
  return
}

// The last stop before money is spent, so it shows what the answers add up to.
if (asking) {
  echo('')
  row('hostname', domain || chalk.dim('none yet'))
  row('server', `${chalk.bold(name)} ${chalk.dim(`· ${vendor} · ${flag.size} · ${flag.region || 'its default region'} · ${flag.image || 'its default image'}`)}`)
  row('key', keyPath.replace(home, '~'))
  row('address', flag['reserved-ip'] ? `reserved IP ${chalk.dim(points ? `— ${points} if it is a spare in ${flag.region || 'the region'}, else a new one` : '— a new one, kept when the box goes')}` : chalk.dim('the box\'s own'))
  row('ssh', addHost ? `Host ${name} in ~/.ssh/config` : chalk.dim('print the Host block'))
  row('install', install ? `yes ${chalk.dim('— deploy:setup --auto-install, then deploy')}` : chalk.dim('no — fli basecamp:install later'))
  if (admin) row('admin', `${admin} ${chalk.dim(password ? '' : '— password generated')}`)
  if (install) row('outpost', outpost ? `yes ${chalk.dim('— fli deploy:outpost once the admin is made')}` : chalk.dim('no'))
  echo('')
  if (!await yes(`Buy the box at ${vendor}?`, true)) { log.info('Nothing was bought'); return }
  echo('')
}

const bought = await buyBox({
  cloud, name, size: flag.size, region: flag.region, image: flag.image, keyPath,
  reservedIp: flag['reserved-ip'], reuse: points, sole: true, addHost, json: flag.json, log, echo, chalk,
})
if (bought.error) { log.error(bought.error); process.exitCode = 1; return }
if (flag.json)    { echo(JSON.stringify(bought.made, null, 2)); return }
if (!bought.dest) return
const { made, dest, box, identity } = bought
const named = domain && domain !== configured ? ` --domain ${domain}` : ''
const later = ` --server ${box}${named}`
const installLine = `fli basecamp:install ${box}${named}`
if (!install) {
  echo`
  ${chalk.dim('Then, from anywhere in this checkout:')}
    ${chalk.cyan(installLine)}
`
  return
}

// Ring 0 on the box it just made, named as `root@ip` so nothing has to be in
// ~/.ssh/config yet. Each command runs on this terminal: what it asks, it asks
// the person, and what fails, fails with its own words.
log.info(`Waiting for ssh on ${dest} — a fresh box answers in about a minute`)
if (!await waitForSsh(dest, { identity })) {
  log.error(`${dest} did not answer ssh in four minutes. When it does: ${installLine}`)
  process.exitCode = 1
  return
}
const failed = await ringZero(dest, domain)
if (failed) {
  log.error(`fli ${failed.argv.join(' ')} exited ${failed.status}. Fix what it said and run ${installLine}`)
  process.exitCode = failed.status || 1
  return
}
log.success(`Basecamp is on ${made.name} (${made.ip})`)
await markHost({ cloud, id: made.id, log })

const record = await pointHost({ host: domain, ip: made.ip, configured, log })
if (!record || !await offerProxy({ record, configured, log, yes: asking && yes })) process.exitCode = 1
echo`
  A later deploy, from packages/basecamp:
    fli deploy${later}
`

if (!await adminThenFleet({ dest, identity, workspace: made.name, admin, password, log, echo, outpost, domain, later })) process.exitCode = 1
```
