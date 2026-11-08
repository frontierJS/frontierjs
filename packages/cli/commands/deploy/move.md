---
title: deploy:move
description: Move an app's install between the SSH door and the Basecamp door — its database, its env and ENCRYPTION_KEY — and stop short of the release
effects: stops the source install, writes the destination's env and database, and soft-deletes the Basecamp App when moving to ssh
confirm: human
examples:
  - fli deploy:move --to=basecamp --production --dry
  - fli deploy:move --to=basecamp --production
  - fli deploy:move --to=ssh --production
  - fli deploy:move --to=ssh --production --overwrite
flags:
  to:
    type: string
    description: The door the install moves to, basecamp or ssh
    defaultValue: ''
    required: true
  production:
    type: boolean
    description: Move production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Move staging
    defaultValue: false
  basecamp:
    type: string
    description: The Basecamp holding the App, by its name in basecamps.json (default the one holding the App — with several entries each is asked for it, and none or two holding it is refused by name)
    defaultValue: ''
  overwrite:
    type: boolean
    description: Replace a destination data directory that already holds files
    defaultValue: false
---

<script>
const bc = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))
const mv = await import(new URL('file://' + global.fliRoot + '/core/deploy-move.js'))
const { reachBasecampFor } = await import(new URL('file://' + global.fliRoot + '/core/basecamps.js'))
const { mergeVariables } = await import(new URL('file://' + global.fliRoot + '/core/release-preflight.js'))
const { plural } = await import(new URL('file://' + global.fliRoot + '/core/text.js'))
const { IMAGE_USER, ensureAppUser } = await import(new URL('file://' + global.fliRoot + '/core/deploy-image.js'))
const { randomBytes } = await import('node:crypto')

const hex = () => randomBytes(6).toString('hex')

/** Both ends of the move, resolved and read, touching nothing. Null after a refusal. */
async function resolveEnds({ $, flag, log }) {
  const refuse = (msg) => { log.error(msg); $.config.abort = true; return null }

  const head = await deployTargetFor($, flag, log, { side: 'api', why: 'the SSH door has no install to move' })
  if (!head) return null
  const { target, deployConf, appId, resolved: api } = head
  if (api.host.split('@').pop() === PLACEHOLDER_SERVER)
    return refuse(`deploy.server is still the placeholder '${PLACEHOLDER_SERVER}'. Set it, or pass --server <ssh alias>`)

  const anchor = process.env.BASECAMP_APP_ID
  if (!anchor) return refuse('BASECAMP_APP_ID is not set, so there is no App to move to or from — run fli basecamp:app')
  const entry = await reachBasecampFor(flag.basecamp, anchor, log)
  if (!entry) { $.config.abort = true; return null }

  let app, host
  try {
    app = await bc.resolveBasecampApp(entry.url, entry.key, anchor, target, { where: entry.name })
    const placed = (app.placement ?? []).filter(p => p.server?.status === 'online')
    if (placed.length !== 1)
      throw new Error(`App '${app.name}' is placed on ${placed.length} online servers; a move carries one machine's data, so place it on exactly one first`)
    host = mv.serverDestination(placed[0].server)
  } catch (err) { return refuse(err.message) }

  return {
    to: flag.to, target, entry, app, appId, deployConf, api,
    machine: machineFor($, api.host, api.path),
    files: apiFiles(deployConf, api.path),
    boxHost: host,
    dataDir: mv.outpostDataDir(app.id),
  }
}

/** The numbers and key names the move would touch. Null after a refusal. */
async function planMove({ $, flag, log }, ends) {
  const refuse = (msg) => { log.error(msg); $.config.abort = true; return null }
  const { entry, app, api, files, boxHost, dataDir, machine, appId, deployConf } = ends
  const rows = await bc.basecampAll(entry.url, entry.key, `/variables?environmentId=${encodeURIComponent(app.environmentId)}`)
  const stat = async (host, dir) => mv.parseTreeStat(await bc.asRootOn(host, mv.treeStatScript(dir), `read the size of ${dir}`))
  const plan = { ...ends, rows }

  try {
    if (ends.to === 'basecamp') {
      const token = hex()
      const read = mv.parseSourceRead(await bc.asRootOn(api.host, mv.readSourceScript({ envFile: files.envFile, secretsDir: files.secretsDir, token }), 'read the env file and secrets'), token)
      plan.source = mv.sourceVariables(read)
      plan.vars = mv.planVariables({ ...plan.source, rows, appId: app.id })
      plan.from = await stat(api.host, files.dbDir)
      plan.into = await stat(boxHost, dataDir)
      if (!plan.from.files) return refuse(`${files.dbDir} on ${api.host} holds no database, so there is nothing to move`)
      if (plan.into.entries && !flag.overwrite)
        return refuse(`${dataDir} on ${boxHost} already holds ${plural(plan.into.entries, 'item')} — pass --overwrite to replace them`)
      plan.routes = await routesHeld(ends)
      plan.running = machine.capture(`docker ps --format '{{.Names}}' | grep -x ${apiContainer(appId, deployConf)} || true`, { dry: false })
    } else {
      if (machine.capture(`[ -d ${shQuote(api.path)} ] && echo yes || echo no`, { dry: false }) !== 'yes')
        return refuse(`${api.path} does not exist on ${api.host} — run fli deploy:setup first`)
      plan.from = await stat(boxHost, dataDir)
      plan.into = await stat(api.host, files.dbDir)
      if (!plan.from.files) return refuse(`${dataDir} on ${boxHost} holds no data, so there is nothing to move`)
      if (plan.into.entries && !flag.overwrite)
        return refuse(`${files.dbDir} on ${api.host} already holds ${plural(plan.into.entries, 'item')} — pass --overwrite to replace them`)
      const siblings = await bc.basecampAll(entry.url, entry.key, `/apps?environmentId=${encodeURIComponent(app.environmentId)}`)
      Object.assign(plan, mv.frontingApps({ siblings, appId: app.id, hosts: sshHosts(deployConf) }))
      if (plan.foreign.length)
        return refuse(`${plan.foreign.map(f => `App '${f.name}' serves ${f.hosts.join(', ')}`).join('; ')} — another app's container, which a move does not take down. Move its Domain off first`)
      plan.held = [...mergeVariables(rows, app.id).values()]
      plan.current = await bc.asRootOn(api.host, `[ -f ${shQuote(files.envFile)} ] && cat ${shQuote(files.envFile)} || true`, 'read the env file')
      plan.env = mv.planEnvWrite({ variables: plan.held.map(v => ({ key: v.key, value: v.isSecret ? '<secret>' : v.value })), current: plan.current })
      if (plan.env.unwritable.length) return refuse(`${plan.env.unwritable.join(', ')} hold a line break, which an env file cannot carry — change the Variable first`)
    }
  } catch (err) { return refuse(err.message) }
  return plan
}

/** The hostnames the SSH door serves the app on; none for an app with no domain. */
function sshHosts(deployConf) {
  try {
    const edge = edgeNamesOf(deployConf)
    return [edge.web.domain, edge.api.domain].filter(Boolean)
  } catch { return [] }
}

/**
 * Basecamp's routes still holding the SSH door's hostnames on its machine, read
 * after the Apps let go: Outpost unroutes on `/stop`, and a machine that did
 * not answer the delete leaves them, which the next `fli deploy` refuses.
 */
async function basecampStillRoutes({ machine, deployConf }) {
  const { readConfigScript, parseConfigRead, heldBy } = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
  try { return heldBy(parseConfigRead(machine.capture(readConfigScript(), { dry: false })).config, 'basecamp', sshHosts(deployConf)) }
  catch { return null }
}

/** Whether Caddy on the SSH machine holds this app's routes; null where it does not answer. */
async function routesHeld({ machine, appId }) {
  const { readConfigScript, parseConfigRead, holdsRoute } = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
  try { return holdsRoute(parseConfigRead(machine.capture(readConfigScript(), { dry: false })).config, appId) }
  catch { return null }
}

const KEY_ROWS = [
  ['added',    'green',  '+', 'added'],
  ['replaced', 'yellow', '~', 'overwritten'],
  ['same',     'dim',    '=', 'already set'],
  ['kept',     'dim',    '·', 'only Basecamp holds it, left alone'],
  ['unread',   'cyan',   '?', 'a secret, read and compared only when the move runs'],
]

/** One line a key, marked with what happens to it. Never a value. */
function keyRows(groups, secret, chalk) {
  const width = Math.max(0, ...KEY_ROWS.flatMap(([kind]) => (groups[kind] ?? []).map(k => k.length)))
  return KEY_ROWS.flatMap(([kind, tone, mark, said]) => (groups[kind] ?? []).map(key =>
    chalk`${chalk[tone](mark)} ${key.padEnd(width)}  {dim ${said}${secret.has(key) ? ' as a secret' : ''}}`))
}

/** A plan never reveals a secret, so whether one would change the env file is not known until the run. */
function unrevealed(env, held) {
  const secret = new Set(held.filter(v => v.isSecret).map(v => v.key))
  const open   = (keys) => keys.filter(k => !secret.has(k))
  return { added: open(env.added), replaced: open(env.replaced), same: open(env.same), unread: [...secret].filter(k => k !== 'ENCRYPTION_KEY').sort() }
}

function printPlan({ echo, chalk, flag }, plan) {
  const { app, api, files, boxHost, dataDir, target } = plan
  const toBasecamp = plan.to === 'basecamp'
  const [from, into] = toBasecamp ? [`ssh ${api.host}`, `Basecamp App '${app.name}'`] : [`Basecamp App '${app.name}'`, `ssh ${api.host}`]
  const sizes = (s) => `${plural(s.files, 'file')}, ${mv.bytesOf(s.bytes)}`
  const keys  = toBasecamp
    ? keyRows(plan.vars, new Set(plan.vars.secret), chalk)
    : keyRows(unrevealed(plan.env, plan.held), new Set(), chalk)

  echo('')
  echo(chalk`  {bold ${from}} {dim →} {bold ${into}} {dim (${target})}`)
  echo('')
  echo.lines(toBasecamp ? [
    chalk`{dim ${'database'.padEnd(12)}}${files.dbDir} ${chalk.dim(`on ${api.host}, ${sizes(plan.from)}`)}`,
    chalk`{dim ${''.padEnd(12)}}→ ${dataDir} ${chalk.dim(`on ${boxHost}${plan.into.entries ? `, replacing ${plural(plan.into.entries, 'item')}` : ''}`)}`,
    chalk`{dim ${'stops'.padEnd(12)}}${plan.running ? plan.running : chalk.dim('no SSH container running')} ${chalk.dim('(its files stay as the fallback)')}`,
    chalk`{dim ${'routes'.padEnd(12)}}${plan.routes === true ? `fli-${plan.appId} dropped from Caddy on ${api.host}` : chalk.dim(plan.routes === false ? `none held on ${api.host}` : `Caddy on ${api.host} did not answer`)}`,
  ] : [
    chalk`{dim ${'database'.padEnd(12)}}${dataDir} ${chalk.dim(`on ${boxHost}, ${sizes(plan.from)}`)}`,
    chalk`{dim ${''.padEnd(12)}}→ ${files.dbDir} ${chalk.dim(`on ${api.host}${plan.into.entries ? `, replacing ${plural(plan.into.entries, 'item')}` : ''}`)}`,
    chalk`{dim ${'App'.padEnd(12)}}soft-deleted, restorable from the Trash ${chalk.dim('(its container stops and its routes go)')}`,
    ...plan.fronts.map(f => chalk`{dim ${''.padEnd(12)}}static App '${f.name}' too ${chalk.dim(`(it holds ${f.hosts.join(', ')})`)}`),
    chalk`{dim ${'key'.padEnd(12)}}${plan.held.some(v => v.key === 'ENCRYPTION_KEY') ? `ENCRYPTION_KEY → ${files.secretsDir}/ENCRYPTION_KEY (mode 400)` : chalk.yellow('the App holds no ENCRYPTION_KEY')}`,
    chalk`{dim ${'env'.padEnd(12)}}${files.envFile} ${chalk.dim('(mode kept)')}`,
  ], { indent: 4 })
  echo('')
  echo(chalk`  {dim ${toBasecamp ? "Variables on the App" : 'Keys into the env file'}}`)
  echo.lines(keys, { indent: 4 })
  if (toBasecamp && !plan.source.values.ENCRYPTION_KEY) echo(chalk`\n    {yellow The SSH install holds no ENCRYPTION_KEY: the App keeps the one Basecamp minted}`)
  echo('')
  if (flag.dry) echo(chalk`  {dim --dry: nothing was changed}\n`)
}

/** A person types the app's name; `--approved` stands for one who already did. */
async function confirmed({ flag, tty, chalk, echo }, plan) {
  if (flag.approved) return true
  const word = plan.app.name
  echo(chalk.bold(plan.target === 'production' ? chalk.red(`  ⚠  This moves ${word} on ${plan.target}.`) : chalk.yellow(`  ⚠  This moves ${word} on ${plan.target}.`)))
  return (await tty.line(chalk.bold(`Type ${word} to move it to ${plan.to}: `))).trim() === word
}

// ─── SSH → Basecamp ───────────────────────────────────────────────────────────

/** The App's Variables from the SSH install's. A key written stays written if a later one fails. */
async function writeVariables({ entry }, vars) {
  const done = []
  const call = (path, method, body) => bc.basecamp(entry.url, entry.key, path, { method, body })
  try {
    for (const r of vars.recreate) {
      await call(`/variables/${encodeURIComponent(r.id)}`, 'DELETE')
      const { id, ...row } = r
      await call('/variables', 'POST', row)
      done.push(r.key)
    }
    for (const v of vars.create) { await call('/variables', 'POST', v); done.push(v.key) }
    for (const v of vars.patch)  { await call(`/variables/${encodeURIComponent(v.id)}`, 'PATCH', { value: v.value, version: v.version }); done.push(v.key) }
  } catch (err) { throw new Error(`${done.length ? `wrote ${done.join(', ')}, then ` : ''}${err.message}`) }
}

/** `mv.rootPipe`, after the shared ssh master is up through the pre-auth retry: the stream's own connection has none (FJS-4100). */
const rootPipeOn = (host, script) => (bc.readyBox(host), mv.rootPipe(host, script))

/** The SSH container stopped and this app's `fli-` routes dropped, in that order, so nothing is routed into a stopping container. */
async function stopSsh({ log }, plan) {
  const { machine, appId, deployConf, api } = plan
  machine.run(`docker stop ${apiContainer(appId, deployConf)} >/dev/null 2>&1 || true`, { dry: false })
  const written = await writeEdge(machine, { appId, routes: [], ifPresent: true })
  if (written.error) throw new Error(`Caddy on ${api.host}: ${written.error}`)
  log.done(`  ${written === 'absent' ? `Caddy on ${api.host} held no route for ${appId}` : `Routes dropped on ${api.host}`}`)
}

/** `tar` over the laptop into Outpost's restore directory, then the restore Basecamp asks Outpost for. */
async function restoreInto(plan) {
  const { entry, app, api, files, boxHost, flag } = plan
  const path = `${mv.outpostRestoreDir()}/${mv.archiveName(app.id, hex())}`
  try {
    await mv.streamTar({ from: rootPipeOn(api.host, mv.tarOutScript(files.dbDir)), to: rootPipeOn(boxHost, mv.stageArchiveScript(path)) })
    const serverId = app.placement.find(p => p.server?.status === 'online').serverId
    return await bc.basecamp(entry.url, entry.key, `/apps/${encodeURIComponent(app.id)}`, {
      method: 'POST', headers: { 'x-service-method': 'restoreVolume' },
      body: { serverId, path: path.split('/').pop(), isOverwriting: flag.overwrite === true },
    })
  } finally {
    await bc.asRootOn(boxHost, mv.dropArchiveScript(path), 'remove the staged archive').catch(() => {})
  }
}

// ─── Basecamp → SSH ───────────────────────────────────────────────────────────

/** Each secret's value, one audited reveal each; the others are on the row. */
async function revealed({ entry }, held) {
  const out = []
  for (const v of held) {
    if (!v.isSecret) { out.push({ key: v.key, value: v.value }); continue }
    const got = await bc.basecamp(entry.url, entry.key, `/variables/${encodeURIComponent(v.id)}`, { method: 'POST', headers: { 'x-service-method': 'reveal' }, body: {} })
    if (got?.value == null) throw new Error(`${v.key} has no value to carry`)
    out.push({ key: v.key, value: got.value })
  }
  return out
}

/** `uid:gid` for the database directory, as `deploy:setup` gives it: the app's own user on a box, the image's on localhost. */
function ownerOf(plan) {
  if (plan.machine.local) return `${IMAGE_USER.uid}:${IMAGE_USER.gid}`
  const user = appUser(plan.appId)
  plan.machine.run(ensureAppUser(user), { dry: false })
  return `${user}:${user}`
}

/**
 * The source's files measured again once it has stopped: a SQLite that closes
 * cleanly folds its -wal into the database and empties it, so the preflight's
 * count of a running app is not what leaves.
 */
const leaving = (host, dir) => bc.asRootOn(host, mv.treeStatScript(dir), `read the size of ${dir}`).then(mv.parseTreeStat)

/** Both counts of what landed against what left, since a short tar can still exit 0. */
function checkCounts(want, got, where) {
  if (want.files !== got.files || want.bytes !== got.bytes)
    throw new Error(`${where} holds ${plural(got.files, 'file')} (${got.bytes} bytes), and ${plural(want.files, 'file')} (${want.bytes} bytes) left`)
}
</script>

An app on a box is installed by one door (`FJS-D1967`), and each door keeps its
own database and `ENCRYPTION_KEY`: the SSH door's are `<path>/db`, the env file
and `secrets/`, the Basecamp door's are the App's data directory under Outpost
and its Variables. This moves them, in one direction, and stops there. The
release is the next command, which it prints, and `.env` is never edited here.

`--to=basecamp` writes the SSH install's env into the App's Variables (every
key it holds, overwriting a differing one, `ENCRYPTION_KEY` and anything from
`secrets/` as secrets, the App's own minted key replaced), stops the SSH
container and drops its Caddy routes, then streams `<path>/db` through this
machine into Outpost's restore directory on the App's machine and has Basecamp
restore it. The SSH files stay as the fallback.

`--to=ssh` reads the App's Variables, soft-deletes the App (Outpost stops its
container and unroutes it, the data stays in place, and the Trash restores it)
and the static App beside it that holds the app's hostname, as
`fli basecamp:deploy` sets up an app with web/ — another container App holding
the hostname is refused instead —
streams the App's data directory into `<path>/db` as `deploy:setup` owns it, and
writes `ENCRYPTION_KEY` to `secrets/ENCRYPTION_KEY` and the rest into the env
file. `deploy:setup` has to have run.

A destination data directory that holds files is refused unless `--overwrite`.
`--dry` prints the keys that move and which overwrite (names, never values), the
sizes and the routes, and touches nothing. The source is stopped before the copy
so its `-wal` and `-shm` are whole.

```js
if (!['basecamp', 'ssh'].includes(flag.to)) {
  log.error(`--to is basecamp or ssh, not '${flag.to}'`)
  $.config.abort = true
  return
}

const ends = await resolveEnds({ $, flag, log })
if (!ends) return
const plan = await planMove({ $, flag, log }, ends)
if (!plan) return

printPlan({ echo, chalk, flag }, plan)
if (flag.dry) return
if (!await confirmed({ flag, tty, chalk, echo }, plan)) {
  log.info('Nothing moved')
  $.config.abort = true
  return
}

let stopped = false
try {
  if (plan.to === 'basecamp') {
    await writeVariables(plan, plan.vars)
    echo(chalk`  {green ✓} ${plural(plan.vars.create.length + plan.vars.patch.length + plan.vars.recreate.length, 'Variable')} written to '${plan.app.name}'`)
    stopped = true
    await stopSsh({ log }, plan)
    const left = await leaving(plan.api.host, plan.files.dbDir)
    const restored = await restoreInto({ ...plan, flag })
    checkCounts(left, restored, `${plan.dataDir} on ${plan.boxHost}`)
    echo(chalk`  {green ✓} {dim database →} ${plan.dataDir} {dim (${plural(restored.files, 'file')}, ${mv.bytesOf(restored.bytes)})}`)
  } else {
    const variables = await revealed(plan, plan.held)
    const env = mv.planEnvWrite({ variables, current: plan.current })
    if (env.unwritable.length) throw new Error(`${env.unwritable.join(', ')} hold a line break, which an env file cannot carry — change the Variable first`)
    const owner = ownerOf(plan)
    await bc.basecamp(plan.entry.url, plan.entry.key, `/apps/${encodeURIComponent(plan.app.id)}`, { method: 'DELETE' })
    stopped = true
    echo(chalk`  {green ✓} {dim App '${plan.app.name}' soft-deleted — restorable from the Trash}`)
    for (const f of plan.fronts) {
      await bc.basecamp(plan.entry.url, plan.entry.key, `/apps/${encodeURIComponent(f.id)}`, { method: 'DELETE' })
      echo(chalk`  {green ✓} {dim static App '${f.name}' (${f.hosts.join(', ')}) soft-deleted with it}`)
    }
    const still = await basecampStillRoutes(plan)
    if (still?.length) log.warn(`Basecamp's routes still hold ${[...new Set(still.flatMap(s => s.hosts))].join(', ')} on ${plan.api.host} (${still.map(s => s.id).join(', ')}) — fli deploy will refuse until they go`)
    const left = await leaving(plan.boxHost, plan.dataDir)
    await mv.streamTar({
      from: rootPipeOn(plan.boxHost, mv.tarOutScript(plan.dataDir)),
      to:   rootPipeOn(plan.api.host, mv.tarInScript({ dir: plan.files.dbDir, overwrite: flag.overwrite, owner })),
    })
    const landed = mv.parseTreeStat(await bc.asRootOn(plan.api.host, mv.treeStatScript(plan.files.dbDir), 'read the size of the copy'))
    checkCounts(left, landed, `${plan.files.dbDir} on ${plan.api.host}`)
    echo(chalk`  {green ✓} {dim database →} ${plan.files.dbDir} {dim (${plural(landed.files, 'file')}, ${mv.bytesOf(landed.bytes)})}`)
    await bc.asRootOn(plan.api.host, mv.writeFilesScript({
      envFile: plan.files.envFile, secretsDir: plan.files.secretsDir, text: env.text,
      encryptionKey: env.encryptionKey, owner, token: `FLI_EOF_${hex()}`,
    }), 'write the env file and key')
    echo(chalk`  {green ✓} {dim ${plural(env.added.length + env.replaced.length, 'key')} → ${plan.files.envFile}${env.encryptionKey ? `, ENCRYPTION_KEY → ${plan.files.secretsDir}/ENCRYPTION_KEY` : ''}}`)
  }
} catch (err) {
  log.error(err.message)
  const note = mv.failureNote({ to: plan.to, stopped, dbDir: plan.files.dbDir, host: plan.api.host })
  if (note) log.warn(note)
  $.config.abort = true
  return
}

echo('')
echo.lines(mv.nextSteps({ to: plan.to, flag }).map((line, i) => i ? chalk.bold(`  ${line}`) : chalk`  {yellow →} ${line}`))
echo('')
```
