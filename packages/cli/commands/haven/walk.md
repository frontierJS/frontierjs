---
title: haven:walk
description: Walk into Haven — the place in the terminal every fli user shares
alias: haven
effects: signs this machine in to a Haven server, making a member on its first login
examples:
  - fli haven
  - fli haven --nick sam
  - fli haven --api http://localhost:5505
  - fli haven --frame /tavern/
flags:
  api:
    char: a
    type: string
    description: Haven's API origin, when it is not the one Haven's web/ config names
    defaultValue: ''
  nick:
    char: n
    type: string
    description: The nick a first login walks in as — this machine's user name when not given
    defaultValue: ''
  frame:
    char: f
    type: string
    description: Print one room's frame and exit — no TTY needed
    defaultValue: ''
---

Haven is an app, `packages/haven`, and this is its door (`FJS-D977`): it
signs this machine in, then runs Haven's own `web/` in this terminal the
way `fli dev:tui` runs an app's. The sign-in is Haven's code too
(`web/src/lib/session/sign-in.js`), so the client, the login and the server version
together.

The first run writes this machine's key pair to `~/.fli/haven/key.json`. The
key is the member (`FJS-D981`) — the same key walks in as the same person on
every server `--api` names, and a nick is read only on the first login with
it. Every run signs a fresh login, so no session is kept on disk.

Haven is found beside this `fli` when it runs from a FrontierJS checkout:
that is the developer's own build, and it wins. Anywhere else the server names
its client — `GET /haven/client` answers the package and version it runs — and
that version is installed once into `~/.fli/haven/<version>/` before the sign-in
(`FJS-D982`), so the client is always the server's. The install honors the
registry bun is pointed at, which is how it is rehearsed before a publish. A
machine with no checkout walks into the hosted Haven, `haven.knightly.dev`,
unless `--api` names another.

From a checkout the study rides beside the scene: `Ctrl+\` or `/work` shows
it, Ctrl+O moves between them, and it runs Claude in the checkout
(`IDEAS/study.md`). An installed Haven has none.

```js
const { join, resolve, sep } = await import('node:path')
const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
const { homedir } = await import('node:os')
const { shippedFile } = await import(resolve(global.fliRoot, 'core/app-schema.js'))

// The path the haven's api/src/client.ts serves. Written here rather than
// imported, because it is asked before any haven is on this machine.
const CLIENT_PATH  = '/haven/client'
const HAVEN_PACKAGE = '@frontierjs/haven'
// Where a machine with no checkout walks in. packages/haven/scripts/share.mjs
// serves the same hostname; a change to one is a change to the other.
const HOSTED = 'https://haven.knightly.dev'

const signInOf = (haven) => join(haven, 'web', 'src', 'lib', 'session', 'sign-in.js')

// Under node_modules a sibling is whatever an install left beside fli, never
// the version the server runs, so only a checkout's sibling counts.
const sibling  = resolve(global.fliRoot, '..', 'haven')
const checkout = !sibling.split(sep).includes('node_modules') && existsSync(signInOf(sibling))

let haven, root, api
if (checkout) {
  haven = root = sibling
  api  = flag.api || (await import(join(haven, 'web', 'config', 'sierra.config.js'))).default.junction.url
} else {
  api = (flag.api || HOSTED).replace(/\/+$/, '')
  let stated
  try {
    const res = await fetch(api + CLIENT_PATH)
    if (!res.ok) throw new Error(`answered ${res.status}`)
    stated = await res.json()
  } catch (e) {
    log.error(`${api} does not say which haven it runs (${CLIENT_PATH}: ${e.message}) — is it a haven server?`)
    process.exitCode = 1
    return
  }
  // A server --api names is a stranger's, and what it states is installed and
  // run here, so it chooses the version of the haven and never the package.
  if (stated?.package !== HAVEN_PACKAGE || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(stated?.version ?? '')) {
    log.error(`${api}${CLIENT_PATH} answered ${JSON.stringify(stated)} — this door installs only ${HAVEN_PACKAGE} at a plain version`)
    process.exitCode = 1
    return
  }
  root = join(homedir(), '.fli', 'haven', stated.version)
  haven = join(root, 'node_modules', '@frontierjs', 'haven')
  if (!existsSync(signInOf(haven))) {
    const spec = `${stated.package}@${stated.version}`
    if (flag.dry) {
      log.dry(`Would install ${spec} into ${root}, sign this machine in to ${api}, then run its web/ in this terminal`)
      return
    }
    log.info(`${api} runs ${spec} — installing it into ${root}`)
    mkdirSync(root, { recursive: true })
    if (!existsSync(join(root, 'package.json'))) writeFileSync(join(root, 'package.json'), '{ "private": true }\n')
    const add = $.exec({ command: 'bun add --exact', args: [spec], cwd: root, env: process.env, allowFailure: true })
    if (add?.status || !existsSync(signInOf(haven))) {
      log.error(`${spec} could not be installed from the registry bun is pointed at — the server runs a haven that is not published there`)
      process.exitCode = 1
      return
    }
  }
}

const web   = join(haven, 'web')
const shell = shippedFile(root, '@frontierjs/sierra', './tui')?.file
if (!shell) {
  log.error(`The haven has no @frontierjs/sierra installed — run bun install in ${root}`)
  process.exitCode = 1
  return
}

if (flag.dry) {
  log.dry(`Would sign this machine in to ${api}, then run the haven's web/ in this terminal`)
  return
}

const { KEY_FILE, machineKeys, signIn } = await import(signInOf(haven))
let walker
try {
  const { keys, made } = await machineKeys()
  if (made) log.info(`This machine's key is ${KEY_FILE} — it is who you are in the haven, so keep it.`)
  walker = await signIn(api, { keys, nick: flag.nick || undefined })
} catch (e) {
  // The default nick is this machine's user name, which the haven's schema can
  // refuse, so the refusal names the flag that answers it.
  log.error(/\bnick\b/.test(e.message) && !flag.nick ? `${e.message} — choose one with --nick` : e.message)
  process.exitCode = 1
  return
}

// The study runs Claude with tools in the checkout, so only the developer's
// own build is handed it (`IDEAS/study.md`); an installed Haven never is.
const shellArgs = [
  '--api', api,
  ...(flag.frame ? ['--frame', flag.frame] : []),
  ...(checkout ? ['--side', 'src/components/Study.mesa'] : []),
]
// The token reaches the shell as HAVEN_TOKEN: a terminal has no storage a
// client could restore a session from (`web/src/lib/session/walk-in.js`).
$.exec({ command: `bun ${JSON.stringify(shell)}`, args: shellArgs, cwd: web, env: { ...process.env, HAVEN_TOKEN: walker.token } })
```
