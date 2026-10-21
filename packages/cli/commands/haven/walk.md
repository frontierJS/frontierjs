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
    description: Haven's API origin, when it is not haven.api in ~/.fli/config.json or the one Haven's web/ config names
    defaultValue: ''
  nick:
    char: n
    type: string
    description: The nick a first login walks in as — haven.nick in ~/.fli/config.json, else this machine's user name
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

`~/.fli/config.json` states this machine's defaults, and a flag wins over it:

```json
{ "haven": { "api": "https://haven.knightly.dev", "nick": "sam" } }
```

From a checkout with no `--api` and no `haven.api`, the door knocks on the
checkout's own API at 5505. A haven already answering there is walked into;
when nothing answers, the door runs `bun run api` in the checkout, logging to
`~/.fli/haven/api.log`, and stops it when the walk ends. Something else on the
port is refused rather than walked into (`FJS-740`).

From a checkout the study rides beside the scene: `Ctrl+\` or `/work` shows
it, Ctrl+O moves between them, and it runs Claude in the checkout
(`IDEAS/study.md`). An installed Haven has none.

```js
const { join, resolve, sep } = await import('node:path')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
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

const CONFIG_FILE = join(homedir(), '.fli', 'config.json')
let saved = {}
if (existsSync(CONFIG_FILE)) {
  try { saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).haven ?? {} }
  catch (e) { log.warn(`${CONFIG_FILE} is not JSON (${e.message}) — walking in without it`) }
}
const nick = flag.nick || saved.nick || undefined

// What the server at `origin` says it runs, or null when nothing answers.
const clientOf = async (origin) => {
  try {
    const res = await fetch(origin + CLIENT_PATH, { signal: AbortSignal.timeout(1000) })
    return res.ok ? await res.json().catch(() => ({})) : {}
  } catch { return null }
}

let haven, root, api, local
if (checkout) {
  haven = root = sibling
  api  = flag.api || saved.api || (await import(join(haven, 'web', 'config', 'sierra.config.js'))).default.junction.url
  if (!flag.api && !saved.api) {
    const answer = await clientOf(api)
    if (answer && answer.package !== HAVEN_PACKAGE) {
      log.error(`${api} answers, and not as a haven — free the port or name one with --api`)
      process.exitCode = 1
      return
    }
    if (!answer) {
      if (flag.dry) {
        log.dry(`Would run bun run api in ${haven}, sign this machine in to ${api}, then run the haven's web/ in this terminal`)
        return
      }
      const { spawn } = await import('node:child_process')
      const { openSync } = await import('node:fs')
      const logFile = join(homedir(), '.fli', 'haven', 'api.log')
      mkdirSync(join(homedir(), '.fli', 'haven'), { recursive: true })
      const out = openSync(logFile, 'a')
      // Its own process group: `bun run api` is bun running a script that runs
      // the app, and a signal to the wrapper's pid leaves the server answering.
      local = spawn('bun', ['run', 'api'], { cwd: haven, detached: true, stdio: ['ignore', out, out] })
      // Unref'd, or a server that never ends holds fli open after the walk does.
      local.unref()
      const stop = () => { try { process.kill(-local.pid, 'SIGTERM') } catch {} }
      // Closing the terminal window is a SIGHUP, which ends fli without 'exit'.
      process.on('exit', stop)
      for (const sig of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(1) })
      log.info(`Starting the checkout's haven at ${api} — its log is ${logFile}`)
      let up = false
      for (let i = 0; i < 60 && !up && local.exitCode === null; i++) {
        await new Promise(r => setTimeout(r, 500))
        up = (await clientOf(api))?.package === HAVEN_PACKAGE
      }
      if (!up) {
        stop()
        log.error(`The checkout's haven did not answer at ${api} — see ${logFile}`)
        process.exitCode = 1
        return
      }
    }
  }
} else {
  api = (flag.api || saved.api || HOSTED).replace(/\/+$/, '')
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
  walker = await signIn(api, { keys, nick })
} catch (e) {
  // The default nick is this machine's user name, which the haven's schema can
  // refuse, so the refusal names the flag that answers it.
  log.error(/\bnick\b/.test(e.message) && !nick ? `${e.message} — choose one with --nick` : e.message)
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
