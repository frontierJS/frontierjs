---
title: basecamp:install
description: Install Basecamp on a box that already install ssh, from any directory
effects: installs docker, caddy and Basecamp on the box over ssh, and writes its DNS record at Cloudflare
examples:
  - fli basecamp:install root@203.0.113.7 --domain ops.example.com
  - fli basecamp:install ops --admin you@example.com
args:
  -
    name: server
    description: "The box: an alias from ~/.ssh/config, or user@host"
flags:
  domain:
    type: string
    description: Basecamp's hostname (default the web.domain in packages/basecamp/frontier.config.js)
    defaultValue: ''
  admin:
    type: string
    description: Make this email Basecamp's first admin once it is up (asked at a terminal; ME from your global fli env otherwise)
    defaultValue: ''
  outpost:
    type: boolean
    description: Enroll the box in Basecamp's own fleet, so apps can run beside it (asked at a terminal)
    defaultValue: true
  unverified:
    type: boolean
    description: Deploy Basecamp's HEAD though it is unpushed or CI did not pass on it — fli deploy prints each check it skipped
    defaultValue: false
---

The install half of `fli basecamp:create`, for a box that already exists — one an
earlier `fli basecamp:create` bought, or one made by hand. It runs
`fli deploy:setup --auto-install`, `fli env:push` of the two addresses (`FRONTIER_APP_URL`, `FRONTIER_API_URL` as `https://<hostname>`, added when the box lacks them, never replaced) and then `fli deploy` in `packages/basecamp`, with the box as
`--server` and the hostname as `--domain`, so it works from any directory and
writes nothing into `frontier.config.js`. Those two are the only deploy values
asked for: every other one in Basecamp's deploy block is what its Dockerfile
already install.

`--admin <email>` then makes the first admin through Basecamp's own
`POST /setup`, over ssh on the box, so no DNS is needed yet. At a terminal the
email is asked when not passed, with `ME` from your global fli env as what Enter
takes, and the password asked hidden; Enter, or no terminal, generates one and
prints it once. **The admin is required**, since `/setup` makes the workspace
too: with no email from any of the three, nothing is installed.

Once Basecamp is up the run points the hostname at the box — `fli
basecamp:dns`'s write, DNS-only, under the fleet's mark — at the address ssh
resolves the box to, so an alias works. The token is checked before the install:
one that opens no zone holding the hostname refuses before anything is
installed, and so does a hostname whose record holds another address where a
Basecamp still answers, since that name is another install's. With no
`CLOUDFLARE_TOKEN` a terminal takes the paste, and a run with no terminal warns,
installs, and prints the `fli basecamp:dns` line instead.

Once Basecamp install, the box is marked as Basecamp's host at its cloud,
found by its address among the boxes every stored cloud token reaches, so a
later `fli basecamp:create` does not read it as one an earlier run left behind.
A box made by hand is at no such cloud and is left unmarked.

It is also asked whether to turn off fwupd and multipathd (`FJS-D1825`), yes by
default and yes with no terminal: `turnOffUnneeded` runs the install script's own
lines over ssh once Basecamp is up. A box that joins the fleet has them turned
off by the Outpost install regardless of the answer.

`fli deploy` refuses a HEAD that is not on a remote branch, or that the last
CI run did not grade, and the install asks the same before `deploy:setup`
touches the box. `--unverified` hands that refusal's own way past it to the
deploy, for a test box that should run what is on the laptop; the deploy then
prints each check it skipped.

A rerun on the same box is a redeploy: `deploy:setup` installs only what is
missing, the record is moved to the box's address if it changed, and
`POST /setup` refuses a second admin.

The box is also asked to be an Outpost — a machine of the fleet this Basecamp
runs, so apps can run beside it. Yes by default; `--no-outpost` leaves it out
and skips the question. The enrollment runs last, as `fli deploy:outpost`,
because it files the box under the workspace `POST /setup` makes. When that
call fails the enrollment is not run, and the line that runs it is printed.

```js
const dest = String(arg.server ?? '').trim()
if (!dest) { log.error('Pass the box: fli basecamp:install <ssh alias or user@host>'); process.exitCode = 1; return }

if (process.stdin.isTTY) echo(chalk`\n  {bold fli basecamp:install}  {dim Basecamp on ${dest}}\n`)

const asked = await askInstall({ flag, dest, tty, log, echo, chalk })
const install = { ...asked, unverified: flag.unverified }
if (install.refusal) {
  log.error(`${install.refusal}. Nothing was installed`)
  if (install.rejected) await tokenHint({ echo, chalk })
  process.exitCode = 1
  return
}
if (!await deployGateOpen({ unverified: flag.unverified, log })) {
  log.error('Nothing was installed')
  process.exitCode = 1
  return
}

if (process.stdin.isTTY) {
  const rows = [['box', chalk.bold(dest)], ...installRows(install, chalk)].map(([label, value]) => `${chalk.dim(label.padEnd(9))} ${value}`)
  echo.lines(['', ...rows, ''], { indent: 2 })
}

process.exitCode = (await runInstall(dest, install, { tty, log, echo, chalk })).code || process.exitCode
```
