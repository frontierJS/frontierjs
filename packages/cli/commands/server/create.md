---
title: server:create
description: Buy a box at a cloud with your SSH key on it, print its IP and add its ssh Host
effects: creates a box at a cloud, billed to the token's account
confirm: human
examples:
  - fli server:create
  - fli server:create --cloud hetzner --size 8gb --name box1
  - fli server:create --yes --name box1
  - fli server:create --name box1 --no-reserved-ip --json
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
    description: The box's name, and the Host in the ssh block (asked at a terminal; required otherwise)
    defaultValue: ''
  image:
    type: string
    description: The cloud's image slug (default its Ubuntu 24.04)
    defaultValue: ''
  key:
    type: string
    description: The SSH public key put on the box (default ~/.ssh/id_ed25519.pub, else id_rsa.pub)
    defaultValue: ''
  reserved-ip:
    type: boolean
    description: Hold an address apart from the box, so a replacement keeps it and outbound traffic leaves from it (billed at the cloud's rate, Setup names it)
    defaultValue: true
  yes:
    char: y
    type: boolean
    description: Say yes to every question and take Enter's answer for the rest
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Print the answer as JSON
    defaultValue: false
---

Asks the box's name — `--name` skips the question, and a run with no terminal
needs it — and whether to add a `Host` block for it to `~/.ssh/config`. At a
terminal the answers are shown together and one last key buys the box or
leaves it. Then creates one box with your SSH key on it, waits until it has an
address, and writes the `Host` block when asked; a `Host` of that name already
there is left alone and the block printed instead.

Nothing is installed on it. The run ends on the three lines that put something
there: `fli deploy:setup --server <box>` from an app's directory, `fli
outpost:install <box> --url <basecamp>` to make it a machine of a fleet, and
`fli basecamp:install <box> --domain <host>` to put Basecamp on it.

The box answers on a reserved IP unless `--no-reserved-ip`: the address the
ssh block and any DNS record name, and the one its outbound traffic leaves
from. It outlives the box and bills at the cloud's rate. A reservation refused
refuses the run with nothing bought; one that does not reach the box warns,
and the run goes on with the box's own address.

`--yes` answers every question for you: the purchase is yes and each typed
answer is what Enter takes. It refuses without `--name`, and without `--cloud`
unless exactly one cloud's token is stored. A missing token is still asked
for, since it has no default.

A fleet takes many boxes, so a second run buys a second box; `fli server`
lists them, and `fli server:stop <id>` then `fli server:destroy <id>` removes one.

```js
const key = await publicKey(flag.key)
if (key.error) { log.error(key.error); process.exitCode = 1; return }

// Under --yes the tty answers each question with its default, so the run takes
// the asking path with nobody at it.
const asking = (process.stdin.isTTY || flag.yes) && !flag.json

// A default name under --yes or with no terminal would buy a box nobody named.
let name = flag.name
if (!name && (flag.yes || !asking)) {
  log.error(`Pass --name: ${flag.yes ? '--yes buys without asking, so' : 'with no terminal'} the box is named on the command line. Nothing was bought`)
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

if (asking) echo(`\n  ${chalk.bold('fli server:create')}  ${chalk.dim(`a box at ${vendor}`)}\n`)

// Every question before the box is bought, so the minute it takes is one
// the person can walk away from.
let addHost = false
if (asking) {
  name ||= await ask('Server name', 'required')
  if (!name) { log.error('A box needs a name. Nothing was bought'); process.exitCode = 1; return }
  addHost = await yes(`Add Host ${name} to ~/.ssh/config once it has an address?`, true)
}
if (!boxName(name)) {
  log.error(`"${name}" is not a hostname: letters, digits, dots and dashes`)
  process.exitCode = 1
  return
}

// The last stop before money is spent, so it shows what the answers add up to.
if (asking) {
  echo('')
  row('server', `${chalk.bold(name)} ${chalk.dim(`· ${vendor} · ${flag.size} · ${flag.region || 'its default region'} · ${flag.image || 'its default image'}`)}`)
  row('key', key.keyPath.replace(process.env.HOME, '~'))
  row('address', flag['reserved-ip'] ? `reserved IP ${chalk.dim('— a new one, kept when the box goes')}` : chalk.dim("the box's own"))
  row('ssh', addHost ? `Host ${name} in ~/.ssh/config` : chalk.dim('print the Host block'))
  echo('')
  if (!await yes(`Buy the box at ${vendor}?`, true)) { log.info('Nothing was bought'); return }
  echo('')
}

const bought = await buyBox({
  cloud, name, size: flag.size, region: flag.region, image: flag.image, keyPath: key.keyPath,
  reservedIp: flag['reserved-ip'], addHost, log, echo, chalk,
})
if (bought.error) { log.error(bought.error); process.exitCode = 1; return }
if (flag.json)    { echo(JSON.stringify(bought.made, null, 2)); return }
if (!bought.dest) return

echo`
  ${chalk.dim('Then, once it answers ssh — about a minute:')}
    ${chalk.cyan(`fli deploy:setup --server ${bought.box}`)}        ${chalk.dim('from an app, to put that app on it')}
    ${chalk.cyan(`fli outpost:install ${bought.box} --url <basecamp>`)}   ${chalk.dim("to make it a machine of a Basecamp's fleet")}
    ${chalk.cyan(`fli basecamp:install ${bought.box} --domain <host>`)}  ${chalk.dim('to put Basecamp on it')}
`
```
