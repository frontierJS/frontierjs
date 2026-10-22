---
title: provision:create
description: Create a DigitalOcean droplet for Basecamp, print its IP and add its ssh Host
alias: provision
effects: creates a droplet at DigitalOcean, billed to the token's account
confirm: human
examples:
  - fli provision
  - fli provision --size 8gb --region sfo3
  - fli provision --name ops --key ~/.ssh/id_rsa.pub
  - fli provision --domain ops.example.com
flags:
  size:
    type: string
    description: Memory (1gb, 4gb, 8gb …) for the cheapest size with that much, or a DigitalOcean slug
    defaultValue: 4gb
  region:
    type: string
    description: DigitalOcean region slug
    defaultValue: nyc3
  name:
    type: string
    description: The droplet's name, and the Host in the ssh block (asked at a terminal, basecamp otherwise)
    defaultValue: ''
  domain:
    type: string
    description: Basecamp's hostname (asked at a terminal; default the web.domain in packages/basecamp/frontier.config.js)
    defaultValue: ''
  image:
    type: string
    description: DigitalOcean image slug
    defaultValue: ubuntu-24-04-x64
  key:
    type: string
    description: The SSH public key put on the box (default ~/.ssh/id_ed25519.pub, else id_rsa.pub)
    defaultValue: ''
  admin:
    type: string
    description: Install Basecamp without asking, and make this email its first admin
    defaultValue: ''
  json:
    char: j
    type: boolean
    description: Print the answer as JSON
    defaultValue: false
---

Asks Basecamp's hostname first — Enter takes `deploy.web.domain` from
`packages/basecamp/frontier.config.js` (none when it is empty), `--domain` skips
the question. Then the server's name — Enter takes `basecamp`, `--name` skips the
question, and a run with no terminal uses `basecamp`. Then creates one droplet
with your SSH key on it, waits until it has an address,
and adds a `Host` block for it to `~/.ssh/config` — asked first, yes unless you
say no; a `Host` of that name already there is left alone and the block printed
instead. Nothing is installed on it unless asked: `fli provision:install` puts
Basecamp on it, and the run prints that line.

`--admin <email>` installs without asking, which is how a run with no terminal
gets past the bare box: `deploy:setup --auto-install` asks nothing, makes the
`ENCRYPTION_KEY` into your local `.env.production` when there is none, and
`fli deploy` follows. Basecamp's first admin is then made through its own
`POST /setup`, over ssh on the box, so no DNS is needed yet. At a terminal the
password is asked; Enter, or no terminal, generates one and prints it once.

The box and the hostname reach the install as `--server` and `--domain`, and
every deploy line the run prints carries both, so nothing is written into
`packages/basecamp/frontier.config.js`. Installing needs a hostname, and a run
with none refuses before anything is bought.

Once Basecamp is up the run prints the `fli provision:dns` line that points
the hostname at the box, in a record Basecamp's own edge reads as its own.
That token is checked right after the hostname, before any other question or
purchase: one that opens no zone holding it refuses the run, so nothing is spent
on a box whose name cannot be pointed at it. With no `CLOUDFLARE_TOKEN` a
terminal takes the paste, and a run with no terminal warns and goes on.

A second run refuses while a box made by an earlier one is still at the
account, so a retry never buys two. `fli provision:list` shows it and `fli provision:destroy <id>` removes it.

```js
const { existsSync, readFileSync } = await import('node:fs')
const { homedir }                  = await import('node:os')
const { resolve }                  = await import('node:path')

const home = homedir()
const expand = p => p.replace(/^~(?=\/|$)/, home)
const keyPath = flag.key
  ? expand(flag.key)
  : [`${home}/.ssh/id_ed25519.pub`, `${home}/.ssh/id_rsa.pub`].find(p => existsSync(p))

if (!keyPath || !existsSync(keyPath)) {
  log.error(flag.key ? `No public key at ${keyPath}` : 'No ~/.ssh/id_ed25519.pub or id_rsa.pub: pass --key <file.pub>')
  return
}
if (!keyPath.endsWith('.pub')) {
  log.error(`${keyPath} is not a .pub file: pass the PUBLIC key`)
  return
}

if (flag.admin && flag.json) {
  log.error('--json prints the box and stops, so it never installs: drop one of --json and --admin')
  process.exitCode = 1
  return
}

// The hostname is asked before anything else, and the DNS step this run ends by
// naming is checked on it: a token that opens no zone holding the hostname
// refuses here, not after the questions, the droplet and the install. No token
// is not a refusal — the record can come later.
const configured = (await webDomain()) || ''
let domain = flag.json ? '' : flag.domain || configured
if (process.stdin.isTTY && !flag.json && !flag.domain) {
  const { createPrompts } = await import(resolve(global.fliRoot, 'core/prompt.js'))
  const p = createPrompts()
  domain = (await p.ask(`Basecamp's hostname${configured ? ` [${configured}]` : ', e.g. basecamp.frontierjs.dev (Enter: none yet)'} › `)).trim() || configured
  p.close()
}
if (domain) {
  const named = await hostnameOf(domain)
  if (!named) {
    log.error(`"${domain}" is not a hostname: letters, digits, dots and dashes`)
    process.exitCode = 1
    return
  }
  domain = named
}
if (domain) {
  if (await cloudflareToken({ interactive: !!process.stdin.isTTY, say: (t) => log.warn(t) })) {
    const found = await hostRecord({ host: domain, check: true })
    if (found.error) {
      log.error(`Cloudflare: ${found.error.replace(/^Cloudflare:\s*/, '')}. Nothing was bought`)
      process.exitCode = 1
      return
    }
    log.info(`${domain} is in ${found.zone} at Cloudflare`)
  }
  else log.warn(`No CLOUDFLARE_TOKEN: fli provision:dns asks for one once the box is up`)
}

// Every question before the droplet is bought, so the minute it takes is one
// the person can walk away from.
let name = flag.name
let admin = flag.admin
let password = ''
let install = !!admin
let addHost = false
if (process.stdin.isTTY && !flag.json) {
  const { createPrompts } = await import(resolve(global.fliRoot, 'core/prompt.js'))
  const p = createPrompts()
  name ||= (await p.ask('Server name [basecamp] › ')) || 'basecamp'
  addHost = await p.confirm(`Add Host ${name} to ~/.ssh/config once it has an address?`, { default: true })
  install ||= await p.confirm('Install Basecamp on it once it is up? (fli deploy:setup --auto-install, then fli deploy)', { default: false })
  if (install && !admin) admin = (await p.ask('Email for its first admin (Enter: make one at /setup in the browser) › ')).trim()
  p.close()
  if (admin) password = await tty.secret(`Password for ${admin} (Enter generates one)`)
  if (install && flag.key && !addHost)
    log.warn(`ssh offers your default identity, not ${keyPath}: if the install cannot connect, add the Host block it prints and run it from packages/basecamp`)
}

name ||= 'basecamp'
if (install && !domain) {
  log.error(`Installing needs Basecamp's hostname: Caddy routes by it and fetches its certificate. Pass --domain, or answer the hostname question`)
  process.exitCode = 1
  return
}
if (admin && !EMAIL.test(admin)) {
  log.error(`"${admin}" is not an email address`)
  process.exitCode = 1
  return
}

// The name is a hostname at DigitalOcean and a Host pattern in ~/.ssh/config: a
// space or a `*` would buy the box and then write a Host line matching others.
if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name)) {
  log.error(`"${name}" is not a hostname: letters, digits, dots and dashes`)
  process.exitCode = 1
  return
}

log.info(`Creating ${name} (${flag.size}, ${flag.region}) — about a minute`)
const made = await runProvision({
  action: 'create', name, region: flag.region, image: flag.image, size: flag.size,
  publicKey: readFileSync(keyPath, 'utf8'),
})

if (made.error) { log.error(made.error); process.exitCode = 1; return }
if (flag.json)  { echo(JSON.stringify(made, null, 2)); return }

const monthly = made.monthly == null ? '' : ` · ${(made.monthly / 100).toFixed(2)} ${made.currency}/mo`
echo('')
echo(`  droplet  ${made.name}  ${made.id}  (${made.size} · ${made.region} · ${made.image}${monthly})`)

if (made.pending) {
  log.warn(`  It has no address yet. Read it later in the DigitalOcean console, or destroy it: fli provision:destroy ${made.id}`)
  return
}

const identity = keyPath.replace(/\.pub$/, '')
const block = `Host ${made.name}
  HostName ${made.ip}
  User root
  IdentityFile ${identity.replace(home, '~')}
`
echo`  ip       ${made.ip}
`

// A Host of the same name is somebody's existing machine: ssh takes the FIRST
// match, so appending a second would be silently ignored, and replacing it would
// point that alias at a stranger's box.
const sshConfig = `${home}/.ssh/config`
let added = false
if (addHost) {
  const { appendFileSync, mkdirSync, writeFileSync } = await import('node:fs')
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

// Basecamp's frontier.config.js leaves `deploy.server` empty on purpose, so the
// box travels as `--server` on every line this run prints, never as an edit to
// that file. The Host alias when this run wrote it, the address otherwise.
const dest = `root@${made.ip}`
const box = added ? made.name : dest
const named = domain && domain !== configured ? ` --domain ${domain}` : ''
const later = ` --server ${box}${named}`
const installLine = `fli provision:install ${box}${named}`
if (!install) {
  echo`  Then, from anywhere in this checkout:
    ${installLine}
`
  return
}

// Ring 0 on the box it just made, named as `root@ip` so nothing has to be in
// ~/.ssh/config yet. Each command runs on this terminal: what it asks, it asks
// the person, and what fails, fails with its own words.
log.info(`Waiting for ssh on ${dest} — a fresh droplet answers in about a minute`)
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

echo`
  Point ${domain} at it (DNS-only, so Caddy's certificate is what the browser sees):
    fli provision:dns ${made.ip}${domain === configured ? '' : ` --host ${domain}`}
`
echo`  A later deploy, from packages/basecamp:
    fli deploy${later}
`

if (admin && !await makeAdmin({ dest, identity, workspace: made.name, admin, password, log, echo })) process.exitCode = 1
```
