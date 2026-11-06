---
title: env:push
description: Push keys from a local env file into the deploy target's env — the server's env file, or the App's Variables when BASECAMP_APP_ID is set
alias: epush
examples:
  - fli epush
  - fli epush VAPID_SUBJECT VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
  - fli epush 'VAPID_*' --dry
  - fli epush --production
  - fli epush STRIPE_KEY --overwrite
  - fli epush --server myvps --path /srv/app/.env.production
  - fli epush ENCRYPTION_KEY --basecamp yuma
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
    description: Push to the production target — with BASECAMP_APP_ID set, the project's production App
    defaultValue: false
  stage:
    type: boolean
    description: Push to the staging target — with BASECAMP_APP_ID set, the project's staging App
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
  basecamp:
    type: string
    description: With BASECAMP_APP_ID set, the Basecamp to call, by its name in basecamps.json (default the only one)
    defaultValue: ''
  overwrite:
    char: o
    type: boolean
    description: Replace a key the target already holds with another value (left alone by default)
    defaultValue: false
---

<script>
import { resolve } from 'path'

// The heredoc's end line. A value equal to it would end the file early, so the
// push refuses it rather than writing half a file.
const EOF_MARK = 'FLI_ENV_PUSH_EOF'

const ROWS = [
  ['added',    'green',  '+', 'added',                  'would be added'],
  ['replaced', 'yellow', '~', 'replaced',               'would be replaced'],
  ['same',     'dim',    '=', 'already set',            'already set'],
  ['differs',  'yellow', '!', 'held with another value, left alone (--overwrite replaces it)'],
  ['skipped',  'dim',    '·', 'the release sets it, skipped (name it to push it)'],
]

/** One line a key, marked with what happened to it — never its value. */
function keyLines(result, chalk, dry) {
  const width  = Math.max(0, ...ROWS.flatMap(([kind]) => (result[kind] ?? []).map(k => k.length)))
  const secret = new Set(result.secret ?? [])
  return ROWS.flatMap(([kind, tone, mark, said, wouldSay = said]) => (result[kind] ?? []).map(key =>
    chalk`${chalk[tone](mark)} ${key.padEnd(width)}  {dim ${dry ? wouldSay : said}${secret.has(key) ? ' as a secret' : ''}}`))
}

/** The App of `target` in the project `id` names, and its environment's
 *  Variable rows. */
async function readApp({ resolveBasecampApp, basecampAll }, entry, id, target) {
  const app = await resolveBasecampApp(entry.url, entry.key, id, target, { where: entry.name })
  const rows = await basecampAll(entry.url, entry.key, `/variables?environmentId=${encodeURIComponent(app.environmentId)}`)
  return { app, rows }
}

/** The pushes, one row at a time; answers the keys written before any refusal. */
async function writeVariables({ basecamp }, entry, app, push) {
  const done = []
  try {
    for (const v of push.create) {
      await basecamp(entry.url, entry.key, '/variables', { method: 'POST', body: { environmentId: app.environmentId, ...v } })
      done.push(v.key)
    }
    for (const v of push.patch) {
      await basecamp(entry.url, entry.key, `/variables/${encodeURIComponent(v.id)}`, { method: 'PATCH', body: { value: v.value, version: v.version } })
      done.push(v.key)
    }
  } catch (err) { return { done, error: err } }
  return { done, error: null }
}
</script>

The other direction from `env:pull --from ssh`: keys from a local env file
(`.env.production` by default) into the env the deploy target's API container
starts with. A key the target lacks is added. A key it holds with another value
is left alone and named, unless `--overwrite`. Output names keys, never values;
`--dry` reads the target and says what would change without writing.

**An app with `BASECAMP_APP_ID` set is an App in Basecamp**, which `fli deploy`
releases, so the target is the App's Variables. The App is the deploy target's
(`--production`, `--stage`, the branch, else dev): the one with the same slug in
the project's environment of that tier, refused by name when there is none
(`FJS-D1965`). A key whose name reads as a
credential (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`) made a secret. The keys the
release plans itself are skipped: `PORT`, `NODE_ENV`, `ENCRYPTION_KEY`, every
database path and every URL on a localhost default, since a laptop's value for
each points nowhere inside the container. A skipped key named exactly is
pushed — `fli epush ENCRYPTION_KEY` carries the key an existing database was
written with, before the first release mints another. The Basecamp is
`--basecamp`'s entry in `basecamps.json`, and its key needs `apps:read`,
`variables:read` and `variables:write`.

Otherwise the target is the env file `fli deploy`'s env check reads, resolved
as a deploy resolves it (`--production`, `--stage`, the branch, else dev) off
`frontier.config.js` § deploy, and written over ssh.

```js
const { loadFrontierConfig } = await import(resolve(global.fliRoot, 'core/utils.js'))
const { PLACEHOLDER_SERVER, resolveTarget, resolveSide, apiFiles } = await import(resolve(global.fliRoot, 'core/deploy-target.js'))
const { pickEnv, pushEnvLines } = await import(resolve(global.fliRoot, 'core/global-env.js'))
const { createMachine, shQuote } = await import(resolve(global.fliRoot, 'core/machine.js'))
const { plural } = await import(resolve(global.fliRoot, 'core/text.js'))

const refuse = (msg) => { log.error(msg); $.config.abort = true }
const named  = (arg.keys?.trim() || '').split(/\s+/).filter(Boolean)

// ─── What is pushed ───────────────────────────────────────────────────────────
let picked
try {
  picked = pickEnv({ root: $.paths.root, file: flag.file, keys: named })
} catch (err) { return refuse(err.message) }
if (!picked.count) return refuse(`${picked.source} holds no KEY=value line to push`)

// ─── An App in Basecamp ───────────────────────────────────────────────────────
if (process.env.BASECAMP_APP_ID) {
  const refused = ['server', 'path'].filter(f => flag[f])
  if (refused.length)
    return refuse(`--${refused.join(', --')} ${refused.length === 1 ? 'is' : 'are'} for a server's env file — an App Basecamp runs takes its Variables, and --production or --stage pick which App`)
  const client = await import(resolve(global.fliRoot, 'core/basecamp.js'))
  const { reachBasecamp } = await import(resolve(global.fliRoot, 'core/basecamps.js'))
  const { gatherReleaseInputs, releaseOwnedKeys, variablePush } = await import(resolve(global.fliRoot, 'core/release-preflight.js'))

  const entry = reachBasecamp(flag.basecamp, log)
  if (!entry) return
  let app, rows
  try { ({ app, rows } = await readApp(client, entry, process.env.BASECAMP_APP_ID, resolveTarget(flag, $.git))) } catch (err) { return refuse(err.message) }

  const owned = releaseOwnedKeys(gatherReleaseInputs($.paths.root))
  const push  = variablePush({ rows, appId: app.id, body: picked.body, owned, named, overwrite: flag.overwrite })
  const count = push.create.length + push.patch.length

  echo(chalk`\n  {bold ${picked.source}} {dim →} {bold App '${app.name}'} {dim on ${entry.name}}\n`)
  echo.lines(keyLines(push, chalk, flag.dry), { indent: 4 })
  if (!count) return echo(chalk`\n  {dim Nothing to push}\n`)
  if (flag.dry) return echo(chalk`\n  {dim --dry: ${plural(count, 'Variable')} would be written}\n`)

  const wrote = await writeVariables(client, entry, app, push)
  if (wrote.error) return refuse(`${wrote.done.length ? `Wrote ${wrote.done.join(', ')}, then ` : ''}${wrote.error.message}`)
  echo(chalk`\n  {green ✓} ${plural(count, 'Variable')} written {dim — the container reads them at its start, so fli deploy applies them}\n`)
  return
}

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
let current, absent
try {
  const out = machine.capture(`set -e\nif [ -e ${shQuote(envFile)} ]; then echo present; cat ${shQuote(envFile)}; else echo absent; fi`, { dry: false })
  const [head, ...rest] = String(out).split('\n')
  absent  = head === 'absent'
  current = absent ? '' : rest.join('\n') + '\n'
} catch (err) { return refuse(`Could not read ${envFile} on ${host}: ${err.message.split('\n')[0]}`) }

const lines = pushEnvLines(current, picked.body, { overwrite: flag.overwrite })
const count = lines.added.length + lines.replaced.length

echo(chalk`\n  {bold ${picked.source}} {dim →} {bold ${envFile}} {dim on ${machine.describe()} (${target})${absent ? ', a file it will create' : ''}}\n`)
echo.lines(keyLines(lines, chalk, flag.dry), { indent: 4 })
if (!count) return echo(chalk`\n  {dim Nothing to push}\n`)
if (flag.dry) return echo(chalk`\n  {dim --dry: ${plural(count, 'key')} would be written}\n`)

// ─── Write ────────────────────────────────────────────────────────────────────
// In place, so the file keeps its owner and mode; umask 077 is the mode of one
// this creates. The script carries the values, so nothing here prints it.
try {
  machine.run(`umask 077\ncat > ${shQuote(envFile)} <<'${EOF_MARK}'\n${lines.text.replace(/\n$/, '')}\n${EOF_MARK}`, { dry: false })
} catch (err) { return refuse(`Could not write ${envFile} on ${host}: ${err.message.split('\n')[0]}`) }

echo(chalk`\n  {green ✓} ${plural(count, 'key')} written {dim — a running container read the file at its start, so fli deploy applies them}\n`)
```
