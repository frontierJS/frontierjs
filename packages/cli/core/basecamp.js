// core/basecamp.js — talking to a Basecamp: its API from this side as a key's
// owner, and the one enrollment command a box runs to join its fleet.
// `basecamp:app`, `basecamp:deploy`, `outpost:install` and `deploy`'s
// `08b-outpost` step share these, so a box cannot be enrolled two ways; an
// enrolled box's Outpost is read here for `outpost:status`, an app's
// archive is fetched for the `db:` verbs and Basecamp's own for
// `basecamp:backup`, and each machine's stored grade for `basecamp:posture`.

import { execSync, spawnSync }      from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { configDir, dataDir }          from './paths.js'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileValue }                from '@frontierjs/toolbelt/env'
import { chalk }                    from './color.js'
import { ageOf }                    from './cloud.js'
import { createMachine, pipeCommand, shQuote } from './machine.js'
import { TIERS }                    from './deploy-target.js'

/** One call to Basecamp's API, answering the body, or throwing with what Basecamp said. */
export async function basecamp(origin, key, path, { method = 'GET', body, headers = {} } = {}) {
  let res
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    throw Object.assign(new Error(`could not reach Basecamp at ${origin}: ${err.message}`), { unreachable: true })
  }
  // A path the proxy does not route reaches the SPA's file server: a GET
  // answers index.html with 200, a write a bare 405 that reads as a method bug.
  if (res.headers.get('content-type')?.includes('text/html'))
    throw Object.assign(new Error(`Basecamp answered ${method} ${path} with HTML (${res.status}), not the API — is ${path} a path its proxy routes?`), { status: res.status })
  const answer = await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(`Basecamp refused ${method} ${path} (${res.status}): ${answer?.message ?? answer?.error ?? res.statusText}`), { status: res.status })
  return answer?.data ?? answer
}

// Basecamp refuses a `$limit` above its maximum page rather than capping it.
const PAGE = 100

/** Every row a list path answers, a page at a time: a lookup that reads only
 *  the first page misses the row it is looking for once a workspace outgrows it. */
export async function basecampAll(origin, key, path) {
  const rows = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await basecamp(origin, key, `${path}${path.includes('?') ? '&' : '?'}$limit=${PAGE}&$offset=${offset}`)
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

/**
 * The App a deploy target releases onto. `BASECAMP_APP_ID` names any App of
 * the project (the anchor) and the target's App is the one with the
 * anchor's slug in the project's environment of the target's tier, so one key
 * serves dev, stage and production. The only place a target becomes an App.
 *
 * Refuses by name rather than falling back: a release that lands on another
 * environment's App is a production deploy by accident. Basecamp refuses a
 * `tier` filter on /environments with 400, so the tier is matched here.
 * Answers the full App row.
 *
 * @param {string} origin
 * @param {string} key
 * @param {string} anchorAppId  `BASECAMP_APP_ID`
 * @param {'dev'|'stage'|'production'} target  `resolveTarget`'s answer
 * @param {{ where?: string }} [opts]  how a 404 names the Basecamp (default its origin)
 */
export async function resolveBasecampApp(origin, key, anchorAppId, target, { where = origin } = {}) {
  const tier = TIERS[target]
  if (!tier) throw new Error(`'${target}' is no deploy target — one of ${Object.keys(TIERS).join(', ')}`)
  const anchor = await basecamp(origin, key, `/apps/${encodeURIComponent(anchorAppId)}`).catch(err => {
    // A rebuilt Basecamp keeps no App the old one issued, and its 404 alone reads as a typo.
    if (err.status === 404) throw new Error(`BASECAMP_APP_ID ${anchorAppId} is no App on ${where} — take it out of .env and run fli basecamp:app`)
    throw err
  })
  if (anchor.environment?.tier === tier) return anchor

  const slug      = anchor.slug
  const projectId = anchor.environment?.projectId
  const hint      = `run fli basecamp:app${target === 'stage' ? ' --stage' : target === 'production' ? ' --production' : ''}`
  if (!projectId) throw new Error(`App '${anchor.name}' (${anchorAppId}) names no project, so its ${tier} App cannot be found — ${hint}`)
  const environment = (await basecampAll(origin, key, `/environments?projectId=${encodeURIComponent(projectId)}`)).find(e => e.tier === tier)
  if (!environment) throw new Error(`no ${tier} environment in project '${anchor.environment?.project?.name ?? projectId}' — ${hint}`)
  const sibling = (await basecampAll(origin, key, `/apps?environmentId=${encodeURIComponent(environment.id)}`)).find(a => a.slug === slug)
  if (!sibling) throw new Error(`no App '${slug}' in the ${tier} environment — ${hint}`)
  return basecamp(origin, key, `/apps/${encodeURIComponent(sibling.id)}`)
}

// A root login on a box with no sudo installed runs the same scripts through a
// function of that name.
export const SUDO = 'command -v sudo >/dev/null 2>&1 || sudo() { "$@"; }'

// The enrollment command Basecamp issued, run on the box. The command is
// written for a person with sudo. Its output is held, and a fresh image's
// first security pass is minutes of silence after this. Answers
// `{ outcome: 'installed' | 'failed', reason? }`.
export function installOutpost(machine, command, { host, log }) {
  log.info('Installing the Outpost — on a fresh box its security updates take several minutes')
  try {
    machine.run(`${SUDO}\n${command}`)
    log.done('Outpost installed — the box joins the fleet at its first heartbeat')
    return { outcome: 'installed' }
  } catch (err) {
    // The attributed message quotes the script, and the script holds a live
    // single-use token; the journal records what is logged here.
    const said = String(err.stdout ?? '').trim().split('\n').slice(-3).join(' · ')
    log.warn(`Outpost install failed on ${host}${said ? `: ${said}` : ''} — the Servers page issues a fresh command`)
    return { outcome: 'failed', reason: said || 'the install command failed' }
  }
}

// ─── A box's Outpost, read over ssh ──────────────────────────────────────────
//
// `outpost status` on the box, through the unit's own ExecStart, so the
// version that answers is the one serving. Under `env -i` because an Outpost
// that predates the entry ignores the word and starts serving, and with no
// OUTPOST_* in its environment it refuses at its config instead, so an old
// box answers `{ old }` and never a second Outpost.

const OUTPOST_UNIT  = '/etc/systemd/system/outpost.service'
const OUTPOST_UNITS = 'outpost.service caddy-api.service basecamp-litestream.service basecamp-firewall.service docker.service'
const CLEAN_ENV     = 'env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

const STATUS_SCRIPT = `${SUDO}
[ -f ${OUTPOST_UNIT} ] || { echo "no outpost.service on this box" >&2; exit 3; }
CMD=$(sed -n 's/^ExecStart=//p' ${OUTPOST_UNIT})
sudo ${CLEAN_ENV} timeout 120 $CMD status`

// What an old Outpost's box still says without it: the pinned version, the
// units and the unsigned /health. The port is the env file's, at either path
// an install has written.
const FALLBACK_SCRIPT = `${SUDO}
echo "pinned $(sed -n 's/.*@frontierjs\\/outpost@\\([^ ]*\\).*/\\1/p' ${OUTPOST_UNIT})"
for u in ${OUTPOST_UNITS}; do echo "unit $u $(systemctl is-active $u 2>/dev/null)"; done
PORT=$(sudo cat /etc/outpost/outpost.env /etc/basecamp/outpost.env 2>/dev/null | sed -n 's/^OUTPOST_PORT=//p' | head -1)
echo "health $(curl -sk --max-time 5 https://127.0.0.1:\${PORT:-8180}/health)"`

/** Answers `{ status }`, the box's own reading; `{ old, said }` for an
 *  Outpost without `status`; or `{ error }` where there is no Outpost. */
export function readOutpost(machine) {
  let out
  try { out = machine.capture(STATUS_SCRIPT) } catch (err) {
    // An old Outpost's refusal is bun's stack trace with its own sentence inside.
    const lines = String(err.stderr ?? '').trim().split('\n').filter(Boolean)
    const said  = lines.find(l => /\boutpost: /.test(l))?.replace(/^error: /, '') ?? lines.at(-1) ?? ''
    if (err.status === 3) return { error: said }
    return { old: fallbackOf(machine), said: /must be set/.test(said) ? null : said }
  }
  let status = null
  try { status = JSON.parse(out) } catch {}
  return status?.shape === 1 ? { status } : { old: fallbackOf(machine), said: `outpost status printed no reading this fli knows (shape ${status?.shape ?? 'none'})` }
}

function fallbackOf(machine) {
  const lines = machine.capture(FALLBACK_SCRIPT).split('\n')
  const value = (key) => lines.filter(l => l.startsWith(`${key} `)).map(l => l.slice(key.length + 1))
  let health = null
  try { health = JSON.parse(value('health')[0] ?? '') } catch {}
  return {
    pinned: value('pinned')[0] || null,
    units:  value('unit').map(l => { const [unit, active = ''] = l.split(' '); return { unit, active: active || 'unknown' } }),
    health,
  }
}

// ─── A machine's posture, as Basecamp graded it ───────────────────────────────
// `basecamp:posture` prints these and IDEAS/deploy-posture.md 4.2 reads them.
// `posture.ts` in Basecamp is the one grader: nothing here grades a control, and
// Basecamp grades staleness on the read, so an old report arrives as `unknown`.
// Basecamp's own box is `hub.hostPosture`, which only a system admin's key
// reaches (`FJS-D1751`); any other key reads that box as a fleet row, without
// its `hub.*` controls.

const postureCall = (origin, key, path, method) =>
  basecamp(origin, key, path, { method: 'POST', headers: { 'x-service-method': method }, body: {} })

async function hostPosture(origin, key) {
  try { return await postureCall(origin, key, '/hub', 'hostPosture') }
  catch (err) {
    if (/\(403\)/.test(err.message)) return null
    throw err
  }
}

/** Every machine in the key's workspace, worst first, as `{ servers }`. The
 *  host, when the key reaches it, carries `host: true` and its `hub.*` controls,
 *  and with no host row it is a row named for Basecamp with no `serverId`. */
export async function readPostures(origin, key) {
  const [{ servers }, host] = await Promise.all([
    postureCall(origin, key, '/serverPostures', 'fleet'),
    hostPosture(origin, key),
  ])
  if (!host) return { servers }
  const { enrolled, readings, ...view } = host
  const row = { ...view, serverName: view.serverName ?? 'Basecamp (not enrolled)', host: true }
  const at  = enrolled ? servers.findIndex(s => s.serverId === host.serverId) : -1
  return { servers: at < 0 ? [row, ...servers] : servers.map((s, i) => i === at ? { ...s, ...row } : s) }
}

/** One machine by id or name, with its readings, or null when the key's
 *  workspace has none of either. A Server's name is not unique, so a name two
 *  rows share is refused rather than answered with either one's grade. */
export async function readPosture(origin, key, server) {
  const { servers } = await readPostures(origin, key)
  const named = servers.filter(s => s.serverName === server && s.serverId)
  if (!servers.some(s => s.serverId === server) && named.length > 1)
    throw new Error(`${named.length} servers are named '${server}' — pass one's id: ${named.map(s => s.serverId).join(', ')}`)
  const row = servers.find(s => s.serverId === server) ?? named[0]
  if (!row?.serverId) return null
  if (row.host) return { ...await hostPosture(origin, key), host: true }
  return await postureCall(origin, key, `/serverPostures/${encodeURIComponent(row.serverId)}`, 'latest')
}

const SEVERITIES = ['high', 'medium', 'low']
const SEVERITY_TONE = { high: 'red', medium: 'yellow', low: 'dim' }

/** Failing controls by severity, `{ high: 2, low: 1 }`. */
export const failingBySeverity = (view) => {
  const out = {}
  for (const c of view.controls) if (c.ok === false) out[c.severity] = (out[c.severity] ?? 0) + 1
  return out
}

const reportAge = (view) =>
  !view.reported ? 'no report yet' : `report ${ageOf(view.at)} ago${view.stale ? ', stale' : ''}`

// A box with no report, or a stale one, is unknown, never ok: Basecamp keeps a
// replica control graded off the heartbeat, which can pass with nothing else read.
const verdictOf = (view) => {
  const failing = failingBySeverity(view)
  if (Object.keys(failing).length)
    return { mark: chalk.red('✗'), text: SEVERITIES.filter(s => failing[s]).map(s => chalk[SEVERITY_TONE[s]](`${failing[s]} ${s}`)).join(chalk.dim(' · ')) }
  if (!view.reported || view.stale) return { mark: chalk.yellow('?'), text: chalk.yellow('unknown') }
  if (view.unknown) return { mark: chalk.yellow('?'), text: chalk.yellow(`${view.unknown} unknown`) }
  return { mark: chalk.green('✓'), text: chalk.green('ok') }
}

/** `basecamp:posture`'s line per machine. Padded before it is painted: an
 *  escape code counts toward padEnd. */
export const postureLine = (view) => {
  const { mark, text } = verdictOf(view)
  const name = `${view.serverName}${view.host ? ' ⛺' : ''}`
  return `  ${mark} ${chalk.bold(name.padEnd(24))} ${text}  ${chalk.dim(reportAge(view))}`
}

const STATE_ORDER = (ok) => ok === false ? 0 : ok === 'unknown' ? 1 : 2

/** One machine's every control, failing first, each with its fix where it carries one. */
export const postureDetail = (view) => {
  const marks = { false: chalk.red('✗'), unknown: chalk.yellow('?'), true: chalk.green('✓') }
  const updates = view.readings?.updates
  return [
    `  ${chalk.bold(view.serverName)}${view.host ? chalk.dim("  ⛺ Basecamp's own box") : ''}  ${chalk.dim(reportAge(view))}`,
    ...(updates ? [chalk.dim(`  ${updates.pending ?? '?'} updates pending, ${updates.security ?? '?'} of them security`)] : []),
    '',
    ...[...view.controls].sort((a, b) => STATE_ORDER(a.ok) - STATE_ORDER(b.ok)).flatMap(c => [
      `  ${marks[String(c.ok)]} ${c.id.padEnd(26)} ${chalk.dim(c.severity.padEnd(6))} ${c.message}`,
      ...(c.fix ? [chalk.dim(`    ${''.padEnd(26)} ${''.padEnd(6)} fix: ${c.fix}`)] : []),
    ]),
  ]
}

// ─── An app's archive, fetched────────────────────────────────────────────────
// `db:download` and `db:import` fetch through this one (`FJS-D1717`). Only an archive in a bucket has a URL: no bytes cross the
// command port (`FJS-D1485`), so one kept on its machine is refused, never
// fetched some other way. The tar is flat — `./<name>.db` with its `-wal`
// beside it (IDEAS/app-archives.md 0.1).

/** Basecamp's `isRemote`: the archives a pre-signed GET reaches. */
const inBucket = (b) => b.status === 'success' && !!b.destinationId && !b.error && !!b.location

/** The newest archive of the app in a bucket, or one taken now and waited on. */
async function archiveRow(origin, key, appId, { take, dry, log, say }) {
  if (!take) {
    const rows = (await basecampAll(origin, key, `/app-backups?appId=${encodeURIComponent(appId)}&status=success`)).filter(inBucket)
    const newest = rows.sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt))[0]
    if (!newest) throw new Error(`App ${appId} has no archive in a bucket to fetch — take one with fli db:download --take, once the App has a backup destination`)
    return newest
  }
  const app = await basecamp(origin, key, `/apps/${encodeURIComponent(appId)}`)
  if (!app.backupDestinationId) throw new Error(`App ${app.name} has no backup destination, so an archive it takes stays on its machine — give it one on the App's page first`)
  // The machine the App page's Back up now picks.
  const placed = (app.placement ?? []).find(p => p.server?.status === 'online') ?? app.placement?.[0]
  if (!placed) throw new Error(`App ${app.name} is placed on no machine, so there is nothing to back up`)
  const machine = placed.server?.name ?? placed.serverId
  if (dry) { log.dry(`take a backup of ${app.name} on ${machine}, then fetch it`); return null }
  say(`Backing up ${app.name} on ${machine} — answered once the archive is in the bucket`)
  const row = await basecamp(origin, key, '/app-backups', {
    method: 'POST', headers: { 'x-service-method': 'take' },
    body: { appId: app.id, serverId: placed.serverId, destinationId: app.backupDestinationId },
  })
  if (row.status !== 'success') throw new Error(`The backup on ${machine} ${row.status}: ${row.error ?? 'no reason given'}`)
  if (!inBucket(row)) throw new Error(`The backup was taken but its upload failed, so it is kept on ${machine}: ${row.error}`)
  return row
}

/** `url` saved to `file`, answering the sha256 of the bytes as they arrived. */
async function fetchHashed(url, file, what) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${new URL(url).host} answered ${res.status} for ${what}`)
  const hasher = new Bun.CryptoHasher('sha256')
  const sink   = Bun.file(file).writer()
  for await (const chunk of res.body) { hasher.update(chunk); sink.write(chunk) }
  await sink.end()
  return hasher.digest('hex')
}

/** A tar whose every entry is a file at its top, as an archive's is. */
function flatEntries(file) {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${file} is not a tar.gz: ${r.stderr.trim()}`)
  const entries = r.stdout.split('\n').filter(e => e && e !== './')
  const deep = entries.find(e => e.replace(/^\.\//, '').includes('/') || e.startsWith('/') || e.includes('..'))
  if (deep) throw new Error(`${file} holds ${deep}, and an app's archive is a flat set of databases — not unpacked`)
  return entries.map(e => e.replace(/^\.\//, ''))
}

/**
 * Fetch an app's archive and unpack it into `out`, or `<dbDir>/backups/<stamp>/`
 * by the archive's own start time. The tar stays beside what it holds, since
 * it is the file an import takes back. `say` hears the wait a take is. Answers
 * `{ dir, file, files, row }`, or null on a dry run.
 */
export async function pullAppArchive({ origin, key, appId, take = false, dbDir, out, dry = false, log, say = () => {} }) {
  const row = await archiveRow(origin, key, appId, { take, dry, log, say })
  if (!row) return null
  const stamp = (row.startedAt ?? row.createdAt).replace(/[:.]/g, '-')
  const dir   = resolve(out ?? join(dbDir, 'backups', stamp))
  if (dry) { log.dry(`fetch the archive taken ${row.startedAt ?? row.createdAt} into ${dir}`); return null }

  const { url, name } = await basecamp(origin, key, `/app-backups/${encodeURIComponent(row.id)}`,
    { method: 'POST', headers: { 'x-service-method': 'download' }, body: {} })
  mkdirSync(dir, { recursive: true })
  const file = join(dir, basename(name))
  const got  = await fetchHashed(url, file, `the archive taken ${row.startedAt}`)
  if (row.sha256 && got !== row.sha256) {
    rmSync(file, { force: true })
    throw new Error(`the archive fetched hashes ${got}, not the ${row.sha256} Basecamp recorded — not unpacked`)
  }
  const files = flatEntries(file)
  const r = spawnSync('tar', ['-xzf', file, '-C', dir, '--no-same-owner'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`could not unpack ${file}: ${r.stderr.trim()}`)
  return { dir, file, files, row }
}

// ─── Basecamp's own archive, fetched ─────────────────────────────────────────
// `basecamp:backup` takes one through `hubBackups` and brings it to the laptop
// (`FJS-D1848`). The tar holds one directory, `basecamp-<stamp>/`, with
// `manifest.json` and every file it lists. An archive kept on the box is tarred
// as it is fetched, so it has no recorded sha256 of its own: the copy is graded
// against the manifest, which `/setup` will grade again.

const HUB_SETTLED = ['success', 'failed', 'timeout']

/** The hub's backup destination, null for the box's own disk. Refuses, marked
 *  `noHubApp`, for a Basecamp that is no machine of its own fleet, since `take`
 *  would answer 400 for it. */
async function hubDestination(origin, key) {
  // `find` answers a list even before the hub App exists, so a 404 from it is
  // `requireSystemAdmin`'s, where one from `current` is no settings saved yet.
  await basecamp(origin, key, '/hub-backups?$limit=1').catch(err => {
    if (err.status !== 404) throw err
    throw new Error("Basecamp answered 404 for /hub-backups: the key's holder is not a system admin — mint a key for the first admin with fli basecamp:key --as <email>")
  })
  const config = await basecamp(origin, key, '/hub-config', { method: 'POST', headers: { 'x-service-method': 'current' }, body: {} })
    .catch(err => { if (err.status === 404) return null; throw err })
  if (!config?.app) throw Object.assign(new Error(`Basecamp at ${origin} has no hub App, so it cannot back itself up — it was installed --no-outpost, or Use this Basecamp server was never pressed`), { noHubApp: true })
  return config.app.backupDestinationId ?? null
}

/** The row once `backup:run` has settled it. A job can retry, so the wait is
 *  its attempts, not one timeout. */
async function hubSettled(origin, key, id, { everyMs = 2_000, forMs = 40 * 60_000 } = {}) {
  for (const until = Date.now() + forMs; Date.now() < until; await Bun.sleep(everyMs)) {
    const row = await basecamp(origin, key, `/hub-backups/${encodeURIComponent(id)}`)
    if (HUB_SETTLED.includes(row.status)) return row
  }
  throw new Error(`backup ${id} had not settled after ${forMs / 60_000} minutes — its row on /hub/backups/ says where it is`)
}

/** The one directory a hub tar holds, refusing anything that would land outside it. */
function hubEntries(file) {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${file} is not a tar.gz: ${r.stderr.trim()}`)
  const entries = r.stdout.split('\n').filter(Boolean).map(e => e.replace(/^\.\//, ''))
  const top = entries[0]?.split('/')[0]
  const off = entries.find(e => e.startsWith('/') || e.split('/').includes('..') || e.split('/')[0] !== top)
  if (!top || off) throw new Error(`${file} holds ${off ?? 'nothing'}, and a hub archive is one basecamp-<stamp>/ directory — not unpacked`)
  return top
}

async function sha256File(path) {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest('hex')
}

/** Each file `manifest.json` lists that is missing or whose bytes differ, as a sentence. */
async function manifestMismatches(dir) {
  const path = join(dir, 'manifest.json')
  if (!existsSync(path)) return { manifest: null, off: ['the archive has no manifest.json'] }
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const off = []
  for (const f of manifest.files ?? []) {
    const at = join(dir, f.path)
    if (relative(dir, at).startsWith('..')) { off.push(`manifest.json names ${f.path}, outside the archive`); continue }
    if (!existsSync(at)) { off.push(`${f.path} is listed and missing`); continue }
    if (statSync(at).size !== f.bytes || await sha256File(at) !== f.sha256) off.push(`${f.path} does not match its sha256`)
  }
  return { manifest, off }
}

const hubWhere = (destinationId) => destinationId ? 'its backup destination' : 'its own disk, with no backup destination set'

/**
 * Take a hub backup and wait for Basecamp to settle it, leaving the archive
 * where Basecamp wrote it. Answers the `HubBackup` row; a backup that did not
 * succeed throws with Basecamp's reason. Workbench's Back up now is this alone.
 */
export async function takeHubBackup({ origin, key, log, say = () => {} }) {
  const destinationId = await hubDestination(origin, key)
  say(`Backing up Basecamp to ${hubWhere(destinationId)} — answered once the archive is written`)
  const queued = await basecamp(origin, key, '/hub-backups', { method: 'POST', headers: { 'x-service-method': 'take' }, body: { destinationId } })
  const row = await hubSettled(origin, key, queued.id)
  if (row.status !== 'success') throw new Error(`The backup ${row.status}: ${row.error ?? 'no reason given'}`)
  if (row.error) log.warn(`The backup was taken and kept on the box: ${row.error}`)
  return row
}

/**
 * Take a hub backup, wait for it, fetch it into `<out>/<stamp>/` and unpack it
 * there, graded against its manifest. Answers `{ dir, file, archive, manifest,
 * row }` — `archive` the unpacked `basecamp-<stamp>/` — or null on a dry run.
 */
export async function pullHubArchive({ origin, key, out, dry = false, log, say = () => {} }) {
  if (dry) {
    log.dry(`take a backup of Basecamp at ${origin} to ${hubWhere(await hubDestination(origin, key))}, then fetch it under ${out}`)
    return null
  }
  const row = await takeHubBackup({ origin, key, log, say })

  const { url, name } = await basecamp(origin, key, `/hub-backups/${encodeURIComponent(row.id)}`,
    { method: 'POST', headers: { 'x-service-method': 'download' }, body: {} })
  const dir  = resolve(out, (row.startedAt ?? row.createdAt).replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, basename(name))
  const got  = await fetchHashed(new URL(url, origin + '/').href, file, `the archive taken ${row.startedAt}`)
  if (row.sha256 && got !== row.sha256) {
    rmSync(file, { force: true })
    throw new Error(`the archive fetched hashes ${got}, not the ${row.sha256} Basecamp recorded — not unpacked`)
  }
  const top = hubEntries(file)
  const r = spawnSync('tar', ['-xzf', file, '-C', dir, '--no-same-owner'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`could not unpack ${file}: ${r.stderr.trim()}`)
  const archive = join(dir, top)
  const { manifest, off } = await manifestMismatches(archive)
  if (off.length) throw new Error(`the archive in ${dir} does not match its manifest: ${off.join('; ')}`)
  return { dir, file, archive, manifest, row }
}

// ─── Basecamp's own files, copied over ssh ───────────────────────────────────
// When the API cannot take a backup — it does not answer, or the Basecamp has
// no hub App — `basecamp:backup` copies the db directory and `.env.production`
// off the box itself. That is not an archive `/setup` takes: the files keep the
// box's own names (`basecamp.db`, not `main.db`) and carry no manifest, so
// `raw.json` marks the directory for restore to read first. The key is never
// beside them (`FJS-D1852`): one copied folder is not both halves.

/** Whether `pullHubArchive`'s refusal means the API cannot back Basecamp up at
 *  all, so the files are copied instead; an auth refusal is the caller's to fix. */
export const apiCannotBackUp = (err) => !!err.unreachable || !!err.noHubApp || err.status >= 500

/** Where a box's key copy lives: its own tree, not the backups'. */
export const keyDirOf = (server) =>
  join(configDir(), 'basecamp', server)

/** Where every box's backups land, one directory per box, never pruned (`FJS-D1851`). */
export const backupsRoot = () =>
  join(dataDir(), 'basecamp')

export const backupsOf = (server) => join(backupsRoot(), server)

const bytesUnder = (path) => {
  const s = statSync(path)
  return s.isDirectory() ? readdirSync(path).reduce((n, e) => n + bytesUnder(join(path, e)), 0) : s.size
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

/**
 * Every backup under one box's directory, oldest first, read from its marker
 * and never hashed: `{ name, dir, kind, takenAt, version, fingerprint, bytes }`,
 * `kind` being `archive`, `raw`, or `unreadable` for a directory with neither
 * marker — a download cut short — which is listed rather than hidden.
 */
export function localBackups(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    const at = join(dir, e.name)
    const raw = readJson(join(at, 'raw.json'))
    const top = raw ? null : readdirSync(at, { withFileTypes: true }).find(d => d.isDirectory() && existsSync(join(at, d.name, 'manifest.json')))
    const manifest = top ? readJson(join(at, top.name, 'manifest.json')) : null
    const marker = raw ?? manifest
    return {
      name: e.name, dir: at,
      kind: raw?.raw ? 'raw' : manifest ? 'archive' : 'unreadable',
      takenAt: marker?.takenAt ?? null,
      version: manifest?.basecamp ?? null,
      fingerprint: marker?.encryptionKeyFingerprint ?? null,
      bytes: bytesUnder(at),
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** The keys filed for `server` as fingerprint → file; each opens the backups taken under it. */
export function filedKeys(server) {
  const dir = keyDirOf(server)
  if (!existsSync(dir)) return new Map()
  return new Map(readdirSync(dir).filter(f => /^encryption(-[0-9a-f]+)?\.key$/.test(f))
    .map(f => [fileValue(readFileSync(join(dir, f), 'utf8')), join(dir, f)])
    .filter(([key]) => key).map(([key, path]) => [sha256Of(key), path]))
}

// Run as root because the db directory is the App's user's and the env file
// root's. `sqlite3 .backup` reads a database the API still writes as one
// moment; without sqlite3 the file and its -wal are copied, which is only
// whole when nothing writes. The box's `backups/` holds archives, not state.
const rawScript = ({ dbDir, envFile, secretsDir }) => `set -eu
db=${shQuote(dbDir)}; env=${shQuote(envFile)}; key=${shQuote(`${secretsDir}/ENCRYPTION_KEY`)}
[ -d "$db" ] || { echo "there is no database directory $db on $(hostname)" >&2; exit 3; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/db"; : > "$tmp/copied-with"
for f in "$db"/*.db; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$f" ".backup '$tmp/db/$n'"
    # A -wal or -shm root's sqlite3 made is one the App's user cannot open.
    chown --reference="$f" "$f-wal" "$f-shm" 2>/dev/null || true
    echo "$n sqlite3 .backup" >> "$tmp/copied-with"
  else
    cp "$f" "$tmp/db/"; [ ! -f "$f-wal" ] || cp "$f-wal" "$tmp/db/"
    echo "$n cp" >> "$tmp/copied-with"
  fi
done
[ ! -f "$env" ] || cp "$env" "$tmp/env"
[ ! -f "$key" ] || cp "$key" "$tmp/key"
(cd "$tmp" && find . -type f ! -name copied-with -exec sha256sum {} +) > "$tmp/sums"
tar -czf - -C "$tmp" .
`

const RAW_ENTRY = /^(db\/[^/]+\.db(-wal)?|env|key|sums|copied-with|db)$/

/** A raw tar's entries, refusing any but the names `rawScript` writes. */
function rawEntries(file) {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${file} is not a tar.gz: ${r.stderr.trim()}`)
  const entries = r.stdout.split('\n').map(e => e.replace(/^\.\/?/, '').replace(/\/$/, '')).filter(Boolean)
  const odd = entries.find(e => !RAW_ENTRY.test(e) || e.includes('..'))
  if (odd) throw new Error(`${file} holds ${odd}, which the copy does not write — not unpacked`)
  return entries
}

/** An env file with its ENCRYPTION_KEY lines taken out, and the key they held. */
function withoutKey(text) {
  let key = null
  const kept = text.split('\n').filter(line => {
    const m = line.match(/^\s*(?:export\s+)?ENCRYPTION_KEY\s*=\s*(.*)$/)
    if (!m) return true
    key = m[1].trim().replace(/^(['"])(.*)\1$/, '$2')
    return false
  })
  return { text: kept.join('\n'), key }
}

/** File the key under `keyDirOf(server)`, mode 600. A different key already
 *  there is kept, since older backups need it, and this one is named apart.
 *  Answers the path and whether that file already held this key. */
function fileKey(server, key, fingerprint) {
  const dir = keyDirOf(server)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let path = join(dir, 'encryption.key')
  if (existsSync(path) && fileValue(readFileSync(path, 'utf8')) !== key) path = join(dir, `encryption-${fingerprint.slice(0, 12)}.key`)
  const already = existsSync(path) && fileValue(readFileSync(path, 'utf8')) === key
  if (!already) writeFileSync(path, key + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return { path, already }
}

const sha256Of = (text) => new Bun.CryptoHasher('sha256').update(text).digest('hex')

// The key as the box keeps it: `secrets/ENCRYPTION_KEY` where the deploy wrote
// one, else the env file's line. Root reads both, as `rawScript` does.
const keyScript = ({ envFile, secretsDir }) => `set -eu
key=${shQuote(`${secretsDir}/ENCRYPTION_KEY`)}; env=${shQuote(envFile)}
if [ -f "$key" ]; then cat "$key"; elif [ -f "$env" ]; then grep -E '^[[:space:]]*(export[[:space:]]+)?ENCRYPTION_KEY[[:space:]]*=' "$env" | tail -n 1 | sed 's/^[^=]*=//'; fi
`

const AS_ROOT = 'if [ "$(id -u)" = 0 ]; then sh -s; else sudo -n sh -s; fi'

// ─── a call to a box ─────────────────────────────────────────────────────────
// A call that opens its own connection dies on the first sshd MaxStartups drop,
// and repeating it could run a script twice. So each one first opens the shared
// master, which `createMachine` retries (FJS-4072, FJS-4079).

const boxMachine = (host, identity = null) => createMachine({
  host,
  identity: identity && existsSync(identity) ? identity : null,
  exec: ({ command, describe, ...opts }) => execSync(command, { ...opts, encoding: 'utf8' }),
})

const spawnOnBox = (host, command, io) => {
  const machine = boxMachine(host)
  machine.ready()
  return Bun.spawn(['sh', '-c', pipeCommand(host, machine.kind, machine.local ? command : shQuote(command))], io)
}

/**
 * Run `script` on `dest`, answering `{ ok, out, said }` and never throwing:
 * `out` its stdout, `said` its stderr. `identity` is the key where it is not
 * one ssh offers by itself. With no master the script is not attempted, since
 * its own connection would carry no key.
 */
export function scriptOnBox(dest, script, { identity = null } = {}) {
  const machine = boxMachine(dest, identity)
  if (!machine.ready()) return { ok: false, out: '', said: `could not reach ${dest} over ssh` }
  try { return { ok: true, out: machine.capture(script), said: '' } }
  catch (err) { return { ok: false, out: String(err.stdout ?? '').trim(), said: String(err.stderr ?? '').trim() } }
}

/** Basecamp's ENCRYPTION_KEY read off `host` over ssh, or null where it keeps none. */
export async function readBoxKey({ host, envFile, secretsDir }) {
  const proc = spawnOnBox(host, AS_ROOT, {
    stdin: new Blob([keyScript({ envFile, secretsDir })]), stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`could not read the key on ${host} (exit ${code}): ${stderr.trim().split('\n').pop() || 'no reason given'}`)
  return fileValue(stdout.trim().replace(/^(['"])(.*)\1$/, '$2')) || null
}

export const KEY_COPIES = { f: 'file it', p: 'print it once', b: 'both' }

/**
 * Keep a copy of the key off the box the way the owner picked at this backup
 * (`FJS-D1852`): `how` is a `KEY_COPIES` key — the mode-600 file restore reads,
 * printed once for a password manager, or both. Answers `{ keyFile, already,
 * printed }`. The key is never written beside a backup.
 */
export function keepKey({ server, key, how, echo }) {
  const fingerprint = sha256Of(key)
  const kept = how === 'p' ? { path: null, already: false } : fileKey(server, key, fingerprint)
  if (how !== 'f') {
    echo(chalk`\n    {bold ENCRYPTION_KEY} {dim ${fingerprint.slice(0, 12)} — printed this once, for a password manager:}`)
    echo(`    ${key}\n`)
  }
  return { keyFile: kept.path, already: kept.already, printed: how !== 'f', fingerprint }
}

/** Tell Basecamp a copy of its key is off the box (`hubConfig.attestEscrow`).
 *  The caller checks first that the API runs the key just kept — an
 *  attestation of a key nobody holds grades `hub.key-escrowed` green for
 *  nothing — and an answer naming another key is still refused here. */
export async function attestKeyCopy({ origin, key, fingerprint }) {
  const row = await basecamp(origin, key, '/hub-config', { method: 'POST', headers: { 'x-service-method': 'attestEscrow' }, body: {} })
  if (row?.encryptionKeyFingerprint !== fingerprint)
    throw new Error(`Basecamp attested ${row?.encryptionKeyFingerprint?.slice(0, 12) ?? 'no key'}, not the ${fingerprint.slice(0, 12)} just kept`)
  return row
}

/**
 * Copy Basecamp's databases and env file off `host` over ssh into
 * `<out>/<stamp>-raw/`, each checked against the sha256 the box took. Answers
 * `{ dir, record, key }` — `record` being what `raw.json` holds, `key` the box's
 * ENCRYPTION_KEY for `keepKey`, never written here — or null on a dry run.
 */
export async function pullRawBackup({ server, host = server, dbDir, envFile, secretsDir, out, dry = false, log, say = () => {} }) {
  const takenAt = new Date().toISOString()
  const dir = resolve(out, `${takenAt.replace(/[:.]/g, '-')}-raw`)
  if (dry) { log.dry(`copy ${dbDir} and ${envFile} off ${host} over ssh into ${dir}`); return null }

  say(`Copying ${dbDir} and ${envFile} off ${host} over ssh`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tar = join(dir, 'raw.tar.gz')
  const proc = spawnOnBox(host, AS_ROOT, {
    stdin: new Blob([rawScript({ dbDir, envFile, secretsDir })]), stdout: Bun.file(tar), stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  try {
    if (code !== 0) throw new Error(`the copy on ${host} failed (exit ${code}): ${stderr.trim().split('\n').pop() || 'no reason given'}`)
    const entries = rawEntries(tar)
    const r = spawnSync('tar', ['-xzf', tar, '-C', dir, '--no-same-owner'], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`could not unpack ${tar}: ${r.stderr.trim()}`)

    const sums = Object.fromEntries(readFileSync(join(dir, 'sums'), 'utf8').split('\n').filter(Boolean)
      .map(line => line.match(/^([0-9a-f]{64})\s+\.\/(.+)$/)).filter(Boolean).map(m => [m[2], m[1]]))
    const off = []
    for (const e of entries.filter(e => e !== 'sums' && e !== 'copied-with' && e !== 'db'))
      if (await sha256File(join(dir, e)) !== sums[e]) off.push(e)
    if (off.length) throw new Error(`${off.join(', ')} did not arrive as the box hashed them — copy again`)
    if (!entries.some(e => e.startsWith('db/'))) throw new Error(`${dbDir} on ${host} holds no database`)

    let key = existsSync(join(dir, 'key')) ? fileValue(readFileSync(join(dir, 'key'), 'utf8')) ?? null : null
    if (existsSync(join(dir, 'env'))) {
      const env = withoutKey(readFileSync(join(dir, 'env'), 'utf8'))
      key ??= env.key
      writeFileSync(join(dir, '.env.production'), env.text, { mode: 0o600 })
    }
    const fingerprint = key ? sha256Of(key) : null

    const copiedWith = Object.fromEntries(readFileSync(join(dir, 'copied-with'), 'utf8').split('\n').filter(Boolean)
      .map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]))
    const kept = [...readdirSync(join(dir, 'db')).map(n => `db/${n}`), ...existsSync(join(dir, '.env.production')) ? ['.env.production'] : []].sort()
    const files = []
    for (const path of kept) files.push({ path, bytes: statSync(join(dir, path)).size, sha256: await sha256File(join(dir, path)) })
    const record = { raw: true, server, takenAt, dbDir, envFile, encryptionKeyFingerprint: fingerprint, copiedWith, files }
    writeFileSync(join(dir, 'raw.json'), JSON.stringify(record, null, 2) + '\n')
    return { dir, record, key }
  } catch (err) {
    // A half copy left in place would list as a backup beside the whole ones.
    rmSync(dir, { recursive: true, force: true })
    throw err
  } finally {
    for (const n of ['raw.tar.gz', 'sums', 'copied-with', 'env', 'key']) rmSync(join(dir, n), { force: true })
  }
}

// ─── Restore onto a fresh Basecamp ───────────────────────────────────────────
// `basecamp:restore` hands an archive from `pullHubArchive` to a Basecamp nobody
// has set up, the way `/setup`'s restore form does, after grading it on the
// laptop first: `/setup` grades it only on the new box, which in a reinstall is
// after the old one is gone. The box half is `POST /setup/restore` with the tar
// as the body, then a restart, which is when `restoreStaged` swaps it in.

const MANIFEST_FILE = 'manifest.json'
const ARCHIVE_TAR   = /^basecamp-.+\.tar\.gz$/

/**
 * The archive `from` names — a `<stamp>/` directory, the `basecamp-<stamp>/`
 * in it, or its `.tar.gz` — else the newest archive under `backupsOf(server)`.
 * Answers `{ dir, archive, tar, manifest }`; a raw copy is refused, since it
 * carries the box's file names and no manifest for `/setup` to check.
 */
export function pickArchive({ from, server }) {
  let dir = from ? resolve(from) : null
  if (!dir) {
    const newest = localBackups(backupsOf(server)).filter(b => b.kind === 'archive').at(-1)
    if (!newest) throw new Error(`no archive under ${backupsOf(server)} — fli basecamp:backup ${server} takes one, or pass --from`)
    dir = newest.dir
  }
  if (!existsSync(dir)) throw new Error(`${from} does not exist`)
  if (statSync(dir).isFile()) dir = dirname(dir)
  if (existsSync(join(dir, MANIFEST_FILE)) && existsSync(`${dir}.tar.gz`)) dir = dirname(dir)
  if (existsSync(join(dir, 'raw.json')))
    throw new Error(`${dir} is a raw copy, which /setup cannot take — it is put back by hand (packages/basecamp/docs/backups.md § 7, The hub, by hand)`)
  const tar = readdirSync(dir).find(f => ARCHIVE_TAR.test(f))
  if (!tar) throw new Error(`${dir} holds no basecamp-<stamp>.tar.gz — not a directory basecamp:backup wrote`)
  const archive = join(dir, tar.replace(/\.tar\.gz$/, ''))
  const manifest = existsSync(join(archive, MANIFEST_FILE)) ? JSON.parse(readFileSync(join(archive, MANIFEST_FILE), 'utf8')) : null
  if (!manifest) throw new Error(`${archive} is not unpacked beside its tar, so there is no manifest.json to check — not a directory basecamp:backup wrote`)
  return { dir, archive, tar: join(dir, tar), manifest }
}

/**
 * Grade an unpacked archive against this checkout's migrations under `keyFile`,
 * with Basecamp's own `check-archive.ts` run by path. Answers `{ ok, takenAt }`
 * or `{ refused: [...] }`; a script that could not answer throws.
 */
export async function checkArchive({ archive, keyFile, basecampRoot }) {
  const input = JSON.stringify({ dir: archive, keyFile, migrationsRoot: join(basecampRoot, 'db', 'migrations') })
  const proc = Bun.spawn([process.execPath, join(basecampRoot, 'api/src/domain/backup/check-archive.ts'), input],
    { cwd: basecampRoot, stdout: 'pipe', stderr: 'pipe' })
  const [, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const last = out.trim().split('\n').pop()
  let answer
  try { answer = JSON.parse(last) } catch { throw new Error(`check-archive.ts answered no verdict: ${(err.trim() || out.trim()).split('\n').pop() || 'nothing'}`) }
  if (answer.error) throw new Error(`check-archive.ts: ${answer.error}`)
  return answer
}

/** Run `script` on `host` as root, answering its stdout; a non-zero exit throws with its last stderr line. */
export async function asRootOn(host, script, what) {
  const proc = spawnOnBox(host, AS_ROOT, { stdin: new Blob([script]), stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`could not ${what} on ${host} (exit ${code}): ${err.trim().split('\n').pop() || 'no reason given'}`)
  return out
}

/** A curl on the box against its own API, since `/setup` is only ever asked from there. */
async function boxApi(host, port, path, { method = 'GET', body = null, type = null } = {}) {
  const curl = `curl -sS -w '\\n%{http_code}' -X ${method}${type ? ` -H 'content-type: ${type}'` : ''}${body ? ' --data-binary @-' : ''} http://localhost:${port}${path}`
  const proc = spawnOnBox(host, curl, { stdin: body ?? 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const [code, ...rest] = out.trimEnd().split('\n').reverse()
  const text = rest.reverse().join('\n')
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: Number(code) || 0, json, said: json?.message ?? (text.trim() || err.trim().split('\n').pop() || '') }
}

/** `/setup/probe` on the box, or why it did not answer. */
export async function probeBox({ host, port }) {
  const r = await boxApi(host, port, '/setup/probe')
  if (r.status !== 200) throw new Error(`Basecamp on ${host} did not answer /setup/probe (${r.status || 'no answer'}${r.said ? `: ${r.said}` : ''})`)
  return r.json
}

/**
 * Put `key` where the box's API reads it, `secrets/ENCRYPTION_KEY`, keeping the
 * file's owner and mode. A key in the env file instead is in the container's
 * environment from when it was made, which a restart does not change, so that
 * box is refused.
 */
export async function putBoxKey({ host, envFile, secretsDir, key }) {
  const at = `${secretsDir}/ENCRYPTION_KEY`
  await asRootOn(host, `set -eu
key=${shQuote(at)}; env=${shQuote(envFile)}
if [ ! -f "$key" ] && grep -qsE '^[[:space:]]*(export[[:space:]]+)?ENCRYPTION_KEY[[:space:]]*=' "$env"; then
  echo "the key is in $env, which a restart does not re-read; move it to $key and redeploy first" >&2; exit 3
fi
[ -d ${shQuote(secretsDir)} ] || { echo "there is no ${secretsDir} on $(hostname)" >&2; exit 3; }
tmp=$(mktemp ${shQuote(secretsDir)}/.key-XXXXXX)
printf '%s\\n' ${shQuote(key)} > "$tmp"
if [ -f "$key" ]; then chown --reference="$key" "$tmp"; chmod --reference="$key" "$tmp"; else chmod 400 "$tmp"; fi
mv "$tmp" "$key"
`, 'write the key')
}

/**
 * The key a reinstall carries, written where `deploy:setup` finds one and leaves
 * it: setup otherwise seeds the laptop's `.env.production` key, which is not the
 * one the archive or the old database was encrypted under.
 */
export async function seedBoxKey({ host, secretsDir, key }) {
  // The app directory is made here first on a purged box and setup keeps its
  // mode, so under umask 077 Caddy could not read the release and every page 403'd.
  await asRootOn(host, `set -eu
mkdir -p ${shQuote(dirname(secretsDir))}
umask 077
mkdir -p ${shQuote(secretsDir)}
tmp=$(mktemp ${shQuote(secretsDir)}/.key-XXXXXX)
printf '%s\\n' ${shQuote(key)} > "$tmp"
chmod 400 "$tmp"
mv "$tmp" ${shQuote(`${secretsDir}/ENCRYPTION_KEY`)}
`, 'place the key')
}

/**
 * Basecamp's API container and port on its box, `{ container, port }`, from its
 * deploy config in the checkout beside this cli — the reading `basecamp:restore`
 * makes, for a caller with no `global.fliRoot` (Workbench).
 */
export async function basecampApi() {
  const { apiContainer } = await import('./ports.js')
  const { deploy } = (await import(new URL('../../basecamp/frontier.config.js', import.meta.url).href)).default
  return { container: apiContainer(deploy.app_id, deploy), port: deploy.api.port }
}

/** Restart the API container, so it boots on the key or the archive just staged. */
export const restartApi = ({ host, container }) =>
  asRootOn(host, `set -eu\ndocker restart ${shQuote(container)} >/dev/null\n`, `restart ${container}`)

/** Wait for `/setup/probe` to answer after a restart, `until` it says what is wanted. */
export async function probeUntil({ host, port, until, everyMs = 2_000, forMs = 3 * 60_000 }) {
  let last = null
  for (const end = Date.now() + forMs; Date.now() < end; await Bun.sleep(everyMs)) {
    last = await probeBox({ host, port }).catch(err => err)
    if (!(last instanceof Error) && until(last)) return last
  }
  throw new Error(`Basecamp on ${host} had not come back after ${forMs / 60_000} minutes${last instanceof Error ? `: ${last.message}` : ''}`)
}

/** Send the tar to `POST /setup/restore`, which checks it and stages it for the next boot. */
export async function stageOnBox({ host, port, tar }) {
  const r = await boxApi(host, port, '/setup/restore', { method: 'POST', body: Bun.file(tar), type: 'application/gzip' })
  if (r.status === 202) return r.json
  const reasons = r.json?.reasons?.length ? r.json.reasons : [r.said || 'no reason given']
  throw new Error(`POST /setup/restore answered ${r.status || 'nothing'}: ${reasons.join('; ')}`)
}

/**
 * What the restored hub has found once it is back: each enrolled machine and
 * whether it has heartbeat since `takenAt` — a heartbeat newer than the
 * archive can only have landed on the restored hub, and the same key derives
 * the same signing key (`FJS-D1646`), so one at the same URL needs nothing —
 * the Apps whose replica the reconcile found, Basecamp's own, and the App
 * archives found newer than the hub's. Waits up to `forMs` for every machine;
 * the reconcile is a queued job that marks no end, so what it has not reached
 * by then is not here.
 */
export async function restoreFindings({ origin, key, takenAt, forMs = 90_000, everyMs = 5_000 }) {
  const since = Date.parse(takenAt)
  const beat = (s) => Date.parse(s.lastHeartbeatAt ?? '') > since
  let servers
  for (const end = Date.now() + forMs; ; await Bun.sleep(everyMs)) {
    servers = (await basecampAll(origin, key, '/servers')).filter(s => s.outpostVersion)
    if (servers.every(beat) || Date.now() >= end) break
  }
  // A key without hubConfig:read still reads the rest; the hub's own replica is then unknown.
  const hub  = await basecamp(origin, key, '/hub-config', { method: 'POST', headers: { 'x-service-method': 'current' }, body: {} }).catch(() => null)
  const apps = await basecampAll(origin, key, '/apps')
  const named = new Map(apps.map(a => [a.id, a.name]))
  return {
    machines:   servers.map(s => ({ name: s.name, beat: beat(s), lastHeartbeatAt: s.lastHeartbeatAt ?? null })),
    replicas:   apps.filter(a => a.replicaFoundAt).map(a => ({ name: a.name, syncedAt: a.replicaSyncedAt })),
    hubReplica: hub?.app?.replicaFoundAt ? { syncedAt: hub.app.replicaSyncedAt } : hub ? null : undefined,
    // appBackups.find refuses `kind` as a filter, so the found rows are picked here.
    archives:   (await basecampAll(origin, key, '/app-backups')).filter(r => r.kind === 'found')
      .map(r => ({ app: named.get(r.appId) ?? r.appId, location: r.location, status: r.status })),
  }
}
