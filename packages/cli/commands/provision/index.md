---
title: provision:create
description: Create a DigitalOcean droplet for Basecamp and print its IP and an ssh config block
alias: provision
effects: creates a droplet at DigitalOcean, billed to the token's account
confirm: human
examples:
  - fli provision
  - fli provision --size 8gb --region sfo3
  - fli provision --name ops --key ~/.ssh/id_rsa.pub
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
    description: The droplet's name, and the Host in the ssh block
    defaultValue: basecamp
  image:
    type: string
    description: DigitalOcean image slug
    defaultValue: ubuntu-24-04-x64
  key:
    type: string
    description: The SSH public key put on the box (default ~/.ssh/id_ed25519.pub, else id_rsa.pub)
    defaultValue: ''
  json:
    char: j
    type: boolean
    description: Print the answer as JSON
    defaultValue: false
---

Creates one droplet with your SSH key on it, waits until it has an address,
and prints the `Host` block for `~/.ssh/config`. Nothing is installed on it and
nothing writes your ssh config: `fli deploy:setup --auto-install` installs over
SSH, and `fli deploy` from `packages/basecamp` puts Basecamp on it.

A second run refuses while a box made by an earlier one is still at the
account, so a retry never buys two. `fli provision:destroy <id>` removes it.

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

let install = false
if (process.stdin.isTTY && !flag.json) {
  const { createPrompts } = await import(resolve(global.fliRoot, 'core/prompt.js'))
  const p = createPrompts()
  install = await p.confirm('Install Basecamp on it once it is up? (fli deploy:setup --auto-install, then fli deploy)', { default: false })
  p.close()
  if (install && flag.key)
    log.warn(`ssh offers your default identity, not ${keyPath}: if the install cannot connect, add the Host block it prints and run it from packages/basecamp`)
}

log.info(`Creating ${flag.name} (${flag.size}, ${flag.region}) — about a minute`)
const made = await runProvision({
  action: 'create', name: flag.name, region: flag.region, image: flag.image, size: flag.size,
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
echo`  ip       ${made.ip}

  Add to ~/.ssh/config:

  Host ${made.name}
    HostName ${made.ip}
    User root
    IdentityFile ${identity.replace(home, '~')}
`

if (!install) {
  echo`  Then, in packages/basecamp, set deploy.server to that Host and run:
    fli deploy:setup --auto-install && fli deploy
`
  return
}

// Ring 0 on the box it just made, named as `root@ip` so nothing has to be in
// ~/.ssh/config yet. Each command runs on this terminal: what it asks, it asks
// the person, and what fails, fails with its own words.
const dest = `root@${made.ip}`
log.info(`Waiting for ssh on ${dest} — a fresh droplet answers in about a minute`)
if (!await waitForSsh(dest, { identity })) {
  log.error(`${dest} did not answer ssh in four minutes. When it does, in packages/basecamp: fli deploy:setup --auto-install --server ${dest} && fli deploy --server ${dest}`)
  process.exitCode = 1
  return
}
for (const argv of [['deploy:setup', '--auto-install', '--server', dest], ['deploy', '--server', dest]]) {
  const status = await runFli(argv)
  if (status !== 0) {
    log.error(`fli ${argv.join(' ')} exited ${status}. Fix what it said and run it again from packages/basecamp`)
    process.exitCode = status || 1
    return
  }
}
log.success(`Basecamp is on ${made.name} (${made.ip})`)
```
