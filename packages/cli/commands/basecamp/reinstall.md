---
title: basecamp:reinstall
description: Back Basecamp up, retire it and install it again on its box — fresh, or restored from the backup just taken — with every question asked before anything changes
effects: takes a backup of Basecamp onto this machine and checks it; then retires Basecamp from its box, its database and env file with it, and installs it again — restored from that backup with --restore; with --purge also removes every container, Docker volume, Docker and Caddy on the box
confirm: human
examples:
  - fli basecamp:reinstall --plan
  - fli basecamp:reinstall yuma --fresh
  - fli basecamp:reinstall scratch --restore --yes
args:
  -
    name: server
    description: The box Basecamp runs on (default deploy.server in packages/basecamp/frontier.config.js)
flags:
  fresh:
    type: boolean
    description: Install an empty Basecamp; the backup is kept as insurance (asked at a terminal)
  restore:
    type: boolean
    description: Put the backup just taken onto the new install (asked at a terminal; what --yes takes)
  plan:
    type: boolean
    description: Read the box, ask, print the run and stop — nothing is backed up or changed
  yes:
    type: boolean
    description: Take every default without asking; still refuses everything the backup and its check refuse
  purge:
    type: boolean
    description: After the retire, also run the box's outpost-uninstall --purge — every other container on it and its volumes go, named first and confirmed by typing purge
  new-key:
    type: boolean
    description: Fresh mode only — install under a new ENCRYPTION_KEY, so the old Basecamp's encrypted values and older backups do not open on the new one
  domain:
    type: string
    description: The new install's hostname (default the one its basecamps.json entry files, else the one the box's env file names; the two disagreeing is refused)
    defaultValue: ''
  admin:
    type: string
    description: Fresh mode's first admin (asked at a terminal; ME from your global fli env otherwise)
    defaultValue: ''
  outpost:
    type: boolean
    description: Enroll the new install's box in its own fleet, so apps can run beside it (asked at a terminal)
    defaultValue: true
  basecamp:
    type: string
    description: The old Basecamp, by its name in basecamps.json, whose API takes the backup and later reads the restored hub; a fresh install files its new key under it too (default the entry named like <server>, else the only one; with several and none named, refused with the names)
    defaultValue: ''
---

`fli basecamp:backup`, `fli deploy:retire --production`, `fli basecamp:install`
and, in restore mode, `fli basecamp:restore`, as one run on one box. Every
question is asked first — the mode, the install's own, where the key's copy
goes — then the run is printed and confirmed once, by typing the box's name,
and goes unattended from there. `--plan` stops after printing it.

**Before asking anything** it reads what is there: this checkout's HEAD and
what is uncommitted under `packages/basecamp/` (a deploy ships HEAD, so an
uncommitted change is not installed), the commit Basecamp's container runs,
the hostname it answers at, every machine in its fleet with its last
heartbeat, the Apps and containers on its own box, and the box's Outpost
against the `OUTPOST_VERSION` HEAD installs. The fleet is read over ssh with
`fli deploy:repl`, so no API key is needed for it; a Basecamp that does not
answer there is named and the run goes on.

**A commit `fli deploy` would refuse stops the run here** (`FJS-D2040`): one no
remote holds or CI has not passed. The install deploys after the retire, so it
is asked before the box is touched, and `--plan` names each refusal.

**The hostname** is `--domain`, else the url of the `basecamps.json` entry the
run is for, else what the box's env file names. An entry and a box that disagree
stop the run before anything is asked: that file can be another Basecamp's name.

**Both modes back up first** (`FJS-D1849`). **Restore** round-trips through
the archive, checked on this machine against this checkout before the box is
touched, so every restore-mode reinstall is also a restore drill; a raw copy,
taken when the API cannot back up, is refused there, since `/setup` cannot
take one. **Fresh** keeps the archive as insurance and carries the old key
onto the new install (`FJS-D1853`); with no copy of that key off the box it
refuses, unless `--new-key` says the encrypted values go.

**Then it runs, unattended.** `fli deploy:retire --production` takes the old
Basecamp off, with the bare Outpost uninstall, so the apps beside it keep
running; `--purge` takes them too. The key the new install boots on goes into
the box's `secrets/ENCRYPTION_KEY` before `deploy:setup`, which leaves a key it
finds there: the old one, the archive's in restore mode, or with `--new-key` one
made here and kept off the box the way the backup kept the old. The install is
`fli basecamp:install`'s. Restore mode then puts the archive on it and enrolls
the box in the restored fleet again, whose row would otherwise answer that it
heard the box before.

**After**, fresh mode mints an API key for the new admin and files it in `basecamps.json` under that entry's name (the box's, when no `--basecamp` names another), drops the entry's `scopedKey` (a key on the old database, the run key on a `runs: true` entry, `FJS-D2031`), keeps the
install's Cloudflare token as the new Basecamp's provider key with the zone
picked for app records (`FJS-D1855`), and prints the old Basecamp's App ids, as
a `BASECAMP_APP_ID` still naming one is stale (`FJS-D1854`). Restore mode's
filed key opens the restored hub again, which then reports the
machines it hears. Both print the setup checklist as the new Basecamp answers it.

<script>
const { spawnSync }    = await import('node:child_process')
const { randomBytes }  = await import('node:crypto')

// One expression: `-e` answers undefined for an arrow function with a block body (FJS-3999).
const FLEET = `Promise.all([` +
  `sys.hubConfig.findFirst({ where: { id: 'hub' }, select: { appId: true } }), ` +
  `sys.server.findMany({ select: { id: true, name: true, ipAddress: true, outpostVersion: true, lastHeartbeatAt: true } }), ` +
  `sys.app.findMany({ select: { id: true, name: true, slug: true } }), ` +
  `sys.appServer.findMany({ select: { appId: true, serverId: true, replicaIndex: true } })` +
  `]).then(([hub, servers, apps, placements]) => ({ hubAppId: hub?.appId ?? null, servers, apps, placements }))`

/** The fleet as the old Basecamp holds it, with the box it runs on picked out
 *  the way `hostServer` picks it: the hub App's first placement. */
const fleetOf = ({ hubAppId, servers, apps, placements }) => {
  const hostId = placements.filter(p => p.appId === hubAppId).sort((a, b) => a.replicaIndex - b.replicaIndex)[0]?.serverId ?? null
  const here = new Set(placements.filter(p => p.serverId === hostId && p.appId !== hubAppId).map(p => p.appId))
  return {
    servers: servers.map(s => ({ ...s, host: s.id === hostId })),
    host:    servers.find(s => s.id === hostId) ?? null,
    apps:    apps.filter(a => a.id !== hubAppId),
    onBox:   apps.filter(a => here.has(a.id)),
  }
}

// Root reads all three: the image's tags, the env file and docker's list.
const boxScript = ({ container, envFile }) => `set -u
img=$(docker inspect -f '{{.Image}}' ${container} 2>/dev/null || true)
[ -z "$img" ] || echo "tags=$(docker image inspect -f '{{join .RepoTags " "}}' "$img" 2>/dev/null || true)"
echo "url=$(grep -E '^FRONTIER_APP_URL=' ${envFile} 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
docker ps --format 'ctr={{.Names}}|{{.Label "fjs.app"}}|{{.Label "fjs.app.slug"}}' 2>/dev/null || true
`

/** What runs on the box: the commit Basecamp's image was tagged with by
 *  `02-ship`, the hostname its env file names, and every other container. */
const readBox = async ({ files, container }) => {
  const out = await asRootOn(files.host, boxScript({ container, envFile: files.envFile }), 'read the box')
  const said = (k) => out.split('\n').filter(l => l.startsWith(`${k}=`)).map(l => l.slice(k.length + 1))
  const sha = (said('tags')[0] ?? '').split(' ').map(t => t.split(':').pop()).find(t => /^[0-9a-f]{7,40}$/.test(t)) ?? null
  const others = said('ctr').map(l => l.split('|')).filter(([name]) => name !== container && name !== `${container}_replaced`)
  return {
    running:    !!said('tags').length,
    sha,
    hostname:   (said('url')[0] ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null,
    containers: others.map(([name, app, slug]) => ({ name, app: app || null, slug: slug || null })),
  }
}

/** 3.1: everything the questions and the plan stand on, read before either. */
const readOld = async ({ server, files, container }) => {
  const root = provisionScript().root
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim()
  const { OUTPOST_VERSION } = await import(root + 'api/src/providers/compute/enrollment.ts')
  const lastLine = (err) => err.message.split('\n').filter(Boolean).pop()
  return {
    head:    git('rev-parse', '--short', 'HEAD'),
    dirty:   git('status', '--porcelain', '--', '.').split('\n').filter(Boolean).length,
    outpost: OUTPOST_VERSION,
    box:     await readBox({ files, container }).catch(err => ({ error: lastLine(err) })),
    fleet:   await replLine(FLEET, { server }).then(fleetOf).catch(err => ({ error: lastLine(err) })),
  }
}

/** A container on the box that is not one of the old Basecamp's Apps, named as such. */
const containerRow = (c, fleet, chalk) => {
  const app = fleet.apps?.find(a => a.id === c.app)
  if (app) return chalk`${app.name} {dim — container} ${c.name}`
  const namesake = c.slug && fleet.apps?.find(a => a.slug === c.slug)
  return namesake
    ? chalk`{yellow ${c.slug}} {dim — container ${c.name} is App ${c.app?.slice(0, 8)}; this Basecamp's ${namesake.name} is ${namesake.id.slice(0, 8)}, so it was released by an earlier one}`
    : chalk`{yellow ${c.slug ?? c.name}} {dim — container ${c.name}, not an App this Basecamp knows}`
}

const machineRow = (s, chalk) =>
  chalk`${s.name}${s.host ? chalk` {dim (this box)}` : ''} {dim ${s.lastHeartbeatAt ? `heard ${ageOf(s.lastHeartbeatAt)} ago` : 'never heard'}}`

const oldRows = ({ head, dirty, outpost, box, fleet }, chalk) => {
  const row = (label, value) => `${chalk.dim(label.padEnd(10))} ${value}`
  const boxOf = fleet.host?.outpostVersion
  return [
    row('code', chalk`${head} {dim at HEAD}${dirty ? chalk` · {yellow ${plural(dirty, 'uncommitted change')} under packages/basecamp, not installed}` : ''}`),
    row('running', box.error ? chalk`{yellow unread} {dim — ${box.error}}`
      : !box.running ? chalk.yellow('no Basecamp container on the box')
      : box.sha ? (box.sha === head ? chalk`${box.sha} {dim — HEAD}` : box.sha) : chalk.yellow('an image with no commit tag')),
    row('hostname', box.hostname ?? chalk.dim('none in the env file')),
    row('outpost', !boxOf ? chalk`{dim none on the box ·} HEAD installs ${outpost}`
      : boxOf === outpost ? chalk`${boxOf} {dim — what HEAD installs}`
      : chalk`{yellow ${boxOf}} {dim on the box ·} HEAD installs ${outpost}`),
    ...fleet.error
      ? [row('fleet', chalk`{yellow unread} {dim — ${fleet.error}}`)]
      : fleet.servers.map((s, i) => row(i ? '' : 'fleet', machineRow(s, chalk))),
    ...(box.containers ?? []).length
      ? box.containers.map((c, i) => row(i ? '' : 'beside it', containerRow(c, fleet, chalk)))
      : [row('beside it', chalk.dim('nothing — Basecamp is the only container'))],
    !fleet.error && row('Apps', fleet.apps.length
      ? chalk`${plural(fleet.apps.length, 'App')} {dim — their ids are printed after the install (FJS-D1854)}`
      : chalk.dim('none besides Basecamp')),
  ]
}

const MODES = { r: 'restore — the backup back onto the new install', f: 'fresh — an empty Basecamp, the backup kept' }

/** 3.2: the mode, from a flag, a keypress, or restore under --yes. */
const pickMode = async ({ flag, asking, tty, chalk }) => {
  if (flag.fresh) return 'fresh'
  if (flag.restore || !asking) return 'restore'
  return await tty.keys(chalk`{cyan ?} {bold Reinstall how?}`, MODES) === 'f' ? 'fresh' : 'restore'
}

const runRows = ({ mode, head, how, newKey, purge, install, chalk }) => {
  const step = (n, name, what) => chalk`{cyan ${n}} {bold ${name.padEnd(8)}} ${what}`
  const restore = mode === 'restore'
  return [
    step(1, 'backup', chalk`an archive through the API, or the files over ssh when it cannot {dim · key copy:} ${KEY_COPIES[how]}`),
    restore && step(2, 'check', chalk`the archive against this checkout {dim — a refusal ends the run with the box untouched}`),
    step(restore ? 3 : 2, 'retire', chalk`fli deploy:retire --production {dim — container, routes, the bare Outpost uninstall,} {red database and env file}`),
    purge && chalk`    {red outpost-uninstall --purge} {dim — every other container, every volume, Docker and Caddy}`,
    step(restore ? 4 : 3, 'install', chalk`${head} {dim under} ${restore ? "the archive's key" : newKey ? chalk.yellow('a new key') : 'the old key'}`),
    ...installRows(install, chalk, restore).map(([label, value]) => chalk`    {dim ${label.padEnd(9)}} ${value}`),
    restore && step(5, 'restore', chalk`the archive onto the new install, then the box enrolled in its fleet again {dim — sign in as its admin}`),
    step(restore ? 6 : 4, 'after', restore
      ? chalk`the machines the restored hub hears {dim ·} the setup checklist`
      : chalk`API key filed {dim ·} the old App ids {dim ·} the setup checklist`),
  ]
}

/** --purge, before the run: every container it takes is named, and the word typed. */
const purgeAgreed = async ({ box, yes, tty, log, echo, chalk }) => {
  const held = (box.containers ?? []).map(c => c.name)
  echo(chalk`
  {red.bold --purge} {dim runs outpost-uninstall --purge after the retire — every Docker volume, Docker and Caddy go, and}`)
  echo.lines(held.length ? held.map(n => chalk`{red ✗} ${n}`) : [chalk.dim('no other container — Basecamp is the only one')], { indent: 4 })
  if (yes) return true
  const typed = (await tty.line(chalk`{cyan ?} {bold Type purge to remove them with Basecamp}\n  {cyan ›}`)).trim()
  if (typed === 'purge') return true
  log.error(`"${typed}" is not purge — nothing was changed`)
  return false
}

/** One typed confirmation, the box's name; --yes is the approval at a pipe. */
const confirmed = async ({ server, yes, tty, log, chalk }) => {
  if (yes) return true
  if (!tty.interactive) { log.error('Pass --yes to reinstall without a terminal to confirm on'); return false }
  const typed = (await tty.line(chalk`{cyan ?} {bold Type ${server} to back up, retire and reinstall Basecamp there}\n  {cyan ›}`)).trim()
  if (typed === server) return true
  log.error(`"${typed}" is not ${server} — nothing was changed`)
  return false
}

/** 3.3: the backup, and in restore mode the check 2.1 runs, both before the
 *  box is touched. Answers `{ taken, picked, keyFile }` — the last two in
 *  restore mode only — or null. */
const backUpFirst = async ({ server, mode, how, newKey, basecamp, tty, log, echo, chalk }) => {
  const taken = await takeBackup({ server, out: backupsOf(server), basecamp, how, tty, log, echo, chalk })
  if (!taken) { log.error('No backup, so nothing else ran — the box is as it was'); return null }
  if (mode === 'fresh') {
    if (taken.keyKept || newKey) return { taken }
    log.error(`No copy of ${server}'s ENCRYPTION_KEY is off the box, so a fresh install could not carry it — the box is as it was. Pass --new-key if its encrypted values may go`)
    return null
  }
  if (taken.kind !== 'archive') {
    log.error(`The API could not take an archive, and /setup cannot take a raw copy — the box is as it was. --fresh installs an empty Basecamp and keeps ${taken.dir}`)
    return null
  }
  try {
    const picked  = pickArchive({ from: taken.dir, server })
    const keyFile = keyFor(server, picked.manifest)
    return await checkHere({ picked, keyFile, log, echo, chalk }) ? { taken, picked, keyFile } : null
  } catch (err) { log.error(`${err.message} — the box is as it was`); return null }
}

/** The key the new install boots on (`FJS-D1853`). A new one is kept off the
 *  box before the retire, so a run that stops after it still has the copy. */
const keyToCarry = async ({ server, mode, kept, newKey, how, echo, chalk }) => {
  if (mode === 'restore') return (await Bun.file(kept.keyFile).text()).trim()
  if (!newKey) return kept.taken.key
  const key  = randomBytes(32).toString('hex')
  const made = keepKey({ server, key, how, echo })
  if (made.keyFile) echo(chalk`    {dim ·} {dim new key} ${made.fingerprint.slice(0, 12)} {dim filed in} ${made.keyFile}`)
  return key
}

/** Why `fli deploy` would refuse this commit. It runs after the retire, so a
 *  refusal met there leaves the box with no Basecamp (`FJS-D2040`). */
const deployRefusals = async () => {
  const { gateVerdict, readGateFacts } = await import(new URL('file://' + global.fliRoot + '/core/deploy-gate.js'))
  return gateVerdict(readGateFacts(provisionScript().root)).refusals
}

/** 3.4: the retire, as a child licensed by the typed confirmation, then --purge. */
const retire = async ({ server, purge, host, tty, log, echo, chalk }) => {
  if (await runFli(['deploy:retire', '--production', '--server', server, '--approved'], tty) !== 0) return false
  if (!purge) return true
  await asRootOn(host, `set -eu
[ -x /usr/local/sbin/outpost-uninstall ] || { echo "no outpost-uninstall on the box, so the other containers, Docker and Caddy were left" >&2; exit 3; }
/usr/local/sbin/outpost-uninstall --purge --yes >/dev/null
`, 'purge the box')
    .then(() => echo(chalk`  {green ✓} {bold Purged} {dim — the containers, volumes, Docker and Caddy; deploy:setup installs Docker and Caddy again}`))
    .catch(err => log.warn(`${err.message} — the install goes on`))
  return true
}

/** 3.6: Phase 2 onto the install just made, which already runs the archive's key. */
const restoreOnto = async ({ files, port, container, picked, key, log, echo, chalk }) => {
  const say = (line) => echo(chalk`  {dim ${line}}`)
  echo(chalk`\n  {bold Restoring the archive} {dim onto} ${files.host}`)
  if (!await emptyOnBox({ host: files.host, port, log, echo, chalk })) return false
  await boxRunsKey({ files, port, container, key, say, echo, chalk })
  const probe = await swapIn({ files, port, container, tar: picked.tar, say })
  echo(chalk`  {green ✓} {bold Restored the hub archived ${probe.restore_taken_at ?? picked.manifest.takenAt}} {dim — sign in as its admin}`)
  return true
}

// ─── After ────────────────────────────────────────────────────────────────────

/** One request to the new API from its own box. The key and the body travel in
 *  the script on ssh's stdin, never in an argv a process on either machine reads. */
const onBox = async ({ host, port, key, method = 'GET', path, body }) => {
  const out = await asRootOn(host, `set -eu
hdr=$(mktemp); trap 'rm -f "$hdr"' EXIT
cat > "$hdr" <<'FLI_HDR_EOF'
authorization: Bearer ${key}
content-type: application/json
FLI_HDR_EOF
curl -sS -w '\\n%{http_code}' -X ${method} -H @"$hdr" ${body ? '--data-binary @- ' : ''}http://localhost:${port}${path}${body ? ` <<'FLI_BODY_EOF'\n${JSON.stringify(body)}\nFLI_BODY_EOF` : ''}
`, `${method} ${path}`)
  const [code, ...rest] = out.trimEnd().split('\n').reverse()
  const answer = (() => { try { return JSON.parse(rest.reverse().join('\n')) } catch { return null } })()
  if (!/^2\d\d$/.test(code)) throw new Error(`${method} ${path} answered ${code || 'nothing'}${answer?.message ? `: ${answer.message}` : ''}`)
  return answer?.data ?? answer
}

/** Q4: the install's token as the new Basecamp's provider key, and the zone
 *  picked as its ingress, the two writes /secrets/ and /dns/ make. */
const keepEdge = async ({ host, port, key, ingress, log, echo, chalk }) => {
  const token = process.env.CLOUDFLARE_TOKEN
  if (!token) { log.warn('No CLOUDFLARE_TOKEN in this run — add it on /secrets/ and pick the zone on /dns/'); return }
  try {
    const secret = await onBox({ host, port, key, method: 'POST', path: '/secrets',
      body: { name: 'cloudflare', kind: 'providerKey', providerKind: 'cloudflare', data: token } })
    const [ws] = [await onBox({ host, port, key, path: '/workspaces' })].flat()
    await onBox({ host, port, key, method: 'PATCH', path: `/workspaces/${ws.id}`,
      body: { ingressSecretId: secret.id, ingressZoneId: ingress.zoneId, version: ws.version } })
    echo(chalk`  {green ✓} {bold Cloudflare kept as a provider key} {dim — app records go in} ${ingress.zoneName}`)
  } catch (err) { log.warn(`The Cloudflare token was not kept: ${err.message} — add it on /secrets/ and pick the zone on /dns/`) }
}

/** The old Basecamp's Apps, by id: a BASECAMP_APP_ID naming one is stale (`FJS-D1854`). */
const oldAppRows = (apps, chalk) => {
  const width = Math.max(...apps.map(a => a.name.length))
  return apps.map(a => chalk`${a.name.padEnd(width)}  {dim ${a.id}}`)
}

/** `infra.launch` as the new Basecamp answers it, read as `as`, or its first owner. */
const launchRows = async ({ server, as, chalk }) => {
  const all = await holders({ server })
  const holder = all.find(h => h.email === as) ?? all.find(h => h.email === process.env.ME) ?? all[0]
  if (!holder) throw new Error('the new Basecamp has no owner or admin to read it as')
  const state = await replLine(`call('infra.launch')`, { server, as: holder.email, tenant: holder.workspaceId })
  return {
    head:  chalk`{bold Setup checklist}  {dim ${state.done} of ${state.total} — what the first login shows}`,
    rows:  state.steps.map(s => s.done ? chalk`{green ✓} ${s.title} {dim — ${s.detail}}` : chalk`{yellow ·} ${s.title} {dim — ${s.detail}}`),
  }
}
</script>

```js
const server = String(arg.server ?? '').trim() || await deployServer()
if (!server) { log.error('Pass the box: fli basecamp:reinstall <server>, or set deploy.server in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }
const entryName = entryFor(flag.basecamp, server)
if (flag.fresh && flag.restore) { log.error('Pass one of --fresh and --restore'); process.exitCode = 1; return }

const files = await deployFiles(server)
const { container, port } = await basecampApi()
const asking = tty.interactive && !flag.yes

echo(chalk`\n  {bold fli basecamp:reinstall}  {dim Basecamp on} ${files.host}\n`)
const old = await readOld({ server, files, container })
echo.lines([...oldRows(old, chalk), ''], { indent: 2 })

const named = reinstallDomain({ domain: flag.domain, entry: readBasecamps()[entryName], box: old.box.hostname })
if (named.refusal) { log.error(`${named.refusal}. Nothing was changed`); process.exitCode = 1; return }

const mode = await pickMode({ flag, asking, tty, chalk })
if (mode === 'restore' && flag['new-key']) { log.error('--new-key is fresh mode only: a restored archive opens under the key it was taken with. Pass --fresh'); process.exitCode = 1; return }
const install = await askInstall({ flag: { ...flag, domain: named.domain }, dest: server, restore: mode === 'restore', edge: true, asking, tty, log, echo, chalk })
if (install.refusal) {
  log.error(`${install.refusal}. Nothing was changed`)
  if (install.rejected) await tokenHint({ echo, chalk })
  process.exitCode = 1
  return
}
const how = asking ? await howToKeep(tty, chalk) : 'f'
if (flag.purge && !await purgeAgreed({ box: old.box, yes: !asking || flag.plan, tty, log, echo, chalk })) { process.exitCode = 1; return }

echo(chalk`\n  {bold The run} {dim — ${mode}, on} ${files.host}`)
echo.lines([...runRows({ mode, head: old.head, how, newKey: flag['new-key'], purge: flag.purge, install, chalk }), ''], { indent: 4 })
const refusals = await deployRefusals()
echo.lines(refusals.map(r => chalk`{red ✗} {bold fli deploy would refuse:} ${r}`), { indent: 4 })
if (flag.plan) return
if (refusals.length) { log.error('The install would be refused after the retire. Nothing was changed'); process.exitCode = 1; return }
if (!await confirmed({ server, yes: flag.yes, tty, log, chalk })) { process.exitCode = 1; return }

const kept = await backUpFirst({ server, mode, how, newKey: flag['new-key'], basecamp: entryName, tty, log, echo, chalk })
if (!kept) { process.exitCode = 1; return }
const key = await keyToCarry({ server, mode, kept, newKey: flag['new-key'], how, echo, chalk })
const resume = mode === 'restore'
  ? `fli basecamp:install ${server}, then fli basecamp:restore ${server} --from ${kept.taken.dir}`
  : `fli basecamp:install ${server}`

echo(chalk`\n  {bold Retiring Basecamp} {dim on} ${files.host}`)
if (!await retire({ server, purge: flag.purge, host: files.host, tty, log, echo, chalk })) {
  log.error(`fli deploy:retire did not finish — the box is as it left it, and the backup is in ${kept.taken.dir}`)
  process.exitCode = 1
  return
}
await seedBoxKey({ host: files.host, secretsDir: files.secretsDir, key })
echo(chalk`  {green ✓} {bold ${mode === 'restore' ? "The archive's key" : flag['new-key'] ? 'The new key' : 'The old key'}} {dim is in} ${files.secretsDir}/ENCRYPTION_KEY {dim for deploy:setup to keep}\n`)

const ran = await runInstall(server, install, { restore: mode === 'restore', tty, log, echo, chalk })
process.exitCode = ran.code || process.exitCode
if (!ran.installed) { log.error(`The old Basecamp is retired and the new one is not installed. The backup is in ${kept.taken.dir}; once the failure is fixed: ${resume}`); return }

try {
  if (mode === 'restore') {
    if (!await restoreOnto({ files, port, container, picked: kept.picked, key, log, echo, chalk })) { process.exitCode = 1; return }
    if (install.outpost && !await joinFleet(server, install.domain, tty)) process.exitCode = 1
    await reportFindings({ basecamp: entryName, takenAt: kept.picked.manifest.takenAt, log, echo, chalk })
  } else {
    if (dropScopedKey(entryName || server)) echo`  {yellow !} {bold scoped key dropped} {dim — it was the old Basecamp's; mint a new one and file it as ${entryName || server}'s scopedKey}`
    const token = await adminKey({ dest: server, admin: install.admin, entry: { name: entryName || server, host: server.includes('@') ? undefined : server, domain: install.domain }, yes: async () => false, log, echo, chalk })
    if (!token) process.exitCode = 1
    if (token && install.ingress) await keepEdge({ host: files.host, port, key: token, ingress: install.ingress, log, echo, chalk })
    if (old.fleet.apps?.length) {
      echo(chalk`\n  {bold The old Basecamp's Apps} {dim — a BASECAMP_APP_ID naming one of these is stale (FJS-D1854)}`)
      echo.lines(oldAppRows(old.fleet.apps, chalk), { indent: 4 })
    }
  }
} catch (err) { log.error(err.message); process.exitCode = 1 }

const launch = await launchRows({ server, as: install.admin, chalk })
  .catch(err => { log.warn(`The setup checklist could not be read: ${err.message.split('\n')[0]}`); return null })
if (launch) {
  echo(`\n  ${launch.head}`)
  echo.lines([...launch.rows, ''], { indent: 4 })
}
echo(chalk`  {dim The backup this run took stays in} ${kept.taken.dir}\n`)
```
