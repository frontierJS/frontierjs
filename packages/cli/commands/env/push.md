---
title: env:push
description: Push keys from a local env file into the deploy target's env file on the server
alias: epush
examples:
  - fli epush
  - fli epush VAPID_SUBJECT VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
  - fli epush 'VAPID_*' --dry
  - fli epush --production
  - fli epush STRIPE_KEY --overwrite
  - fli epush --server myvps --path /srv/app/.env.production
args:
  -
    name: keys
    description: Only these keys, a * matching any characters — quote it, or the shell may expand it (the whole file when none)
    variadic: true
flags:
  file:
    char: f
    type: string
    description: Local env file the keys are read from
    defaultValue: '.env.production'
  production:
    type: boolean
    description: Push to the production target
    defaultValue: false
  stage:
    type: boolean
    description: Push to the staging target
    defaultValue: false
  server:
    type: string
    description: "An ssh destination for this run: an alias from ~/.ssh/config, or user@host. Replaces the configured server"
    defaultValue: ''
  path:
    char: p
    type: string
    description: The env file on the server (default deploy.api.env, else <deploy.path>/.env.production)
    defaultValue: ''
  overwrite:
    char: o
    type: boolean
    description: Replace a key the server already holds with another value (left alone by default)
    defaultValue: false
---

<script>
import { resolve } from 'path'

// The heredoc's end line. A value equal to it would end the file early, so the
// push refuses it rather than writing half a file.
const EOF_MARK = 'FLI_ENV_PUSH_EOF'
</script>

The other direction from `env:pull --from ssh`: keys from a local env file
(`.env.production` by default) into the env file the deploy target's API
container reads — the file `fli deploy`'s env check reads. The target is
resolved as a deploy resolves it (`--production`, `--stage`, the branch, else
dev), off `frontier.config.js` § deploy.

A key the server lacks is added. A key it holds with another value is left
alone and named, unless `--overwrite`. Output names keys, never values;
`--dry` reads the server and says what would change without writing.

```js
const { loadFrontierConfig } = await import(resolve(global.fliRoot, 'core/utils.js'))
const { PLACEHOLDER_SERVER, resolveTarget, resolveSide, apiFiles } = await import(resolve(global.fliRoot, 'core/deploy-target.js'))
const { pickEnv, pushEnvLines } = await import(resolve(global.fliRoot, 'core/global-env.js'))
const { createMachine, shQuote } = await import(resolve(global.fliRoot, 'core/machine.js'))

const refuse = (msg) => { log.error(msg); $.config.abort = true }

// ─── What is pushed ───────────────────────────────────────────────────────────
let picked
try {
  picked = pickEnv({ root: $.paths.root, file: flag.file, keys: (arg.keys?.trim() || '').split(/\s+/).filter(Boolean) })
} catch (err) { return refuse(err.message) }
if (!picked.count) return refuse(`${picked.source} holds no KEY=value line to push`)
if (picked.body.split('\n').some(l => l.trim() === EOF_MARK)) return refuse(`${picked.source} has a line reading ${EOF_MARK}, which would end the pushed file early`)

// ─── Where it goes ────────────────────────────────────────────────────────────
const target     = resolveTarget(flag, $.git)
const deployConf = (await loadFrontierConfig($.paths.root))?.deploy ?? null
const side       = resolveSide(flag.server ? { ...deployConf, server: flag.server } : deployConf, target, 'api')
const host       = flag.server || side?.host
if (!host) return refuse(`No server for ${target}: set deploy.server in frontier.config.js, or pass --server <ssh alias>`)
if (host.split('@').pop() === PLACEHOLDER_SERVER) return refuse(`deploy.server is still the placeholder '${PLACEHOLDER_SERVER}'. Set it, or pass --server <ssh alias>`)
const envFile = flag.path || (side && apiFiles(deployConf, side.path).envFile)
if (!envFile) return refuse(`No env file for ${target}: set deploy.path in frontier.config.js, or pass --path`)

const machine = createMachine({ host, exec: $.exec, transport: deployConf?.transport ?? null, path: side?.path ?? null })

// ─── What the server holds ────────────────────────────────────────────────────
// The first line says whether the file exists, so an unreadable file throws
// rather than reading as empty — an empty read would be written back as only
// the pushed keys. Read under --dry too: what would change is the answer.
let current
try {
  const out = machine.capture(`set -e\nif [ -e ${shQuote(envFile)} ]; then echo present; cat ${shQuote(envFile)}; else echo absent; fi`, { dry: false })
  const [head, ...rest] = String(out).split('\n')
  current = head === 'present' ? rest.join('\n') + '\n' : ''
  if (head === 'absent') log.info(`${envFile} does not exist on ${machine.describe()} — it will be created`)
} catch (err) { return refuse(`Could not read ${envFile} on ${host}: ${err.message.split('\n')[0]}`) }

const { text, added, replaced, same, differs } = pushEnvLines(current, picked.body, { overwrite: flag.overwrite })

// One key a line, under the sentence that says what happened to them.
const list = (say, head, keys) => { if (!keys.length) return; say(head); for (const k of keys) say(`  ${k}`) }
list(log.info, 'Already set:', same)
list(log.warn, 'Set to another value on the server, left alone (--overwrite replaces them):', differs)

if (!added.length && !replaced.length) {
  log.success(`Nothing to push to ${envFile} on ${machine.describe()} (${target})`)
  return
}

if (flag.dry) {
  list(log.dry, `Would add to ${envFile} on ${machine.describe()}:`, added)
  list(log.dry, `Would replace in ${envFile} on ${machine.describe()}:`, replaced)
  return
}

// ─── Write ────────────────────────────────────────────────────────────────────
// In place, so the file keeps its owner and mode; umask 077 is the mode of one
// this creates. The script carries the values, so nothing here prints it.
try {
  machine.run(`umask 077\ncat > ${shQuote(envFile)} <<'${EOF_MARK}'\n${text.replace(/\n$/, '')}\n${EOF_MARK}`, { dry: false })
} catch (err) { return refuse(`Could not write ${envFile} on ${host}: ${err.message.split('\n')[0]}`) }

list(log.success, `Added to ${envFile} on ${machine.describe()} (${target}):`, added)
list(log.success, `Replaced in ${envFile} on ${machine.describe()} (${target}):`, replaced)
log.info('A running container read the file at its start — redeploy (fli deploy) to apply it')
```
