---
title: haven:walk
description: Walk into Haven — the place in the terminal every fli user shares
alias: haven
effects: signs this Frontier member's machine in to a Haven server, making a Haven member on its first login; with --browser, opens the browser Haven handed the session
examples:
  - fli haven
  - fli haven --browser
  - fli haven --api http://localhost:5505
  - fli haven --frame /tavern/
flags:
  api:
    char: a
    type: string
    description: Haven's API origin, when it is not haven.api in ~/.fli/config.json or the one Haven's web/ config names
    defaultValue: ''
  browser:
    char: b
    type: boolean
    description: Open the browser Haven, handed this login's session, instead of walking in here
    defaultValue: false
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

A member walks in as their Frontier chain (`fli frontier:stake`, or
`fli frontier:link` from a machine already in it): the login carries the
member's links and the post's signed row, every machine in the chain is the
same figure, and the nick is the row's. A row past half its age is fetched
from the post first. A machine in no chain is refused (`FJS-D1477`). Every run
signs a fresh login, so no session is kept on disk. A checkout's haven started
here is handed the post key this machine pinned, as `HAVEN_POST_KEY`.

`--browser` signs in the same way and opens the browser Haven with the session
in its address, since a browser holds no key (`FJS-D1477`). From a checkout the
page is `bun run web`'s on 5506, which this door does not start: a haven it
started would stop when it exits, so run `bun run dev` in the haven first.

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
{ "haven": { "api": "https://haven.knightly.dev" } }
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
let config = {}
if (existsSync(CONFIG_FILE)) {
  try { config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  catch (e) { log.warn(`${CONFIG_FILE} is not JSON (${e.message}) — walking in without it`) }
}
const saved = config.haven ?? {}
if (!config.frontier?.nick) {
  log.error('This machine is in no Frontier chain, and a haven takes only a member\'s machine — run `fli frontier:stake` with an invite, or `fli frontier:link` from a machine already in your member.')
  process.exitCode = 1
  return
}
const after = flag.browser ? 'open the browser Haven on that session' : 'run the haven\'s web/ in this terminal'

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
    if (!answer && flag.browser) {
      log.error(`No haven answers at ${api} — run \`bun run dev\` in ${haven}, which serves the browser Haven beside it`)
      process.exitCode = 1
      return
    }
    if (!answer) {
      if (flag.dry) {
        log.dry(`Would run bun run api in ${haven}, sign this machine in to ${api}, then ${after}`)
        return
      }
      const { spawn } = await import('node:child_process')
      const { openSync } = await import('node:fs')
      const logFile = join(homedir(), '.fli', 'haven', 'api.log')
      mkdirSync(join(homedir(), '.fli', 'haven'), { recursive: true })
      const out = openSync(logFile, 'a')
      // Its own process group: `bun run api` is bun running a script that runs
      // the app, and a signal to the wrapper's pid leaves the server answering.
      // The post this machine pinned is the one its row is signed by, so the
      // checkout's haven takes this member's login without being told.
      const env = { ...process.env, HAVEN_POST_KEY: process.env.HAVEN_POST_KEY || config.frontier?.postKey || '' }
      local = spawn('bun', ['run', 'api'], { cwd: haven, env, detached: true, stdio: ['ignore', out, out] })
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
      log.dry(`Would install ${spec} into ${root}, sign this machine in to ${api}, then ${after}`)
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
  log.dry(`Would sign this machine in to ${api}, then ${after}`)
  return
}

const { signIn } = await import(signInOf(haven))
// A Frontier member walks in as their chain: every machine of it is one
// figure, and the nick is the post's row (`IDEAS/frontier-network.md` 3.1). A
// row past half its age is fetched fresh; when the post does not answer, the
// one held is sent anyway, and the haven names its age if it is too old.
const chainLogin = async () => {
  const fm = await import(resolve(global.fliRoot, 'core/frontier-member.js'))
  const member = await fm.currentMember()
  if (await fm.rowStale(member)) {
    const fresh = await fm.refreshRow(member).catch(e => ({ refused: `the post did not answer (${e.message})` }))
    if (fresh.refused) log.warn(`This member's row was not refreshed: ${fresh.refused}`)
  }
  const row = fm.readOwnRow()
  if (!row) throw new Error('This machine holds no member row from the post, so it cannot walk in as a Frontier member — run it again once the post answers.')
  return signIn(api, { keys: member.keys, links: await fm.ownChain(member.keys), row })
}

let walker
try { walker = await chainLogin() }
catch (e) {
  log.error(e.message)
  process.exitCode = 1
  return
}

if (flag.browser) {
  // The page talks to its own origin: a checkout's is the dev server proxying
  // to the API, a hosted haven's is the API.
  const { GLOBAL } = await import(resolve(global.fliRoot, 'core/ports.js'))
  const page = checkout ? `http://localhost:${GLOBAL.havenWeb}` : api
  if (!await fetch(page, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)) {
    log.error(`No browser Haven answers at ${page}${checkout ? ` — run \`bun run dev\` in ${haven}` : ''}`)
    process.exitCode = 1
    return
  }
  const { openUrl } = await import(resolve(global.fliRoot, 'core/open-url.js'))
  const url = `${page}/#session=${walker.token}`
  openUrl(url)
  log.info(`Opened the browser Haven as ${walker.member.nick}. If no browser opened, this address walks in, and is a session: ${url}`)
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
