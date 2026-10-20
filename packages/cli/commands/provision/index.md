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

echo(`  ip       ${made.ip}`)
echo('')
echo('  Add to ~/.ssh/config:')
echo('')
echo(`  Host ${made.name}`)
echo(`    HostName ${made.ip}`)
echo('    User root')
echo(`    IdentityFile ${keyPath.replace(/\.pub$/, '').replace(home, '~')}`)
echo('')
echo('  Then, in packages/basecamp, set deploy.server to that Host and run:')
echo('    fli deploy:setup --auto-install && fli deploy')
echo('')
```
