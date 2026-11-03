// core/basecamp.js — talking to a Basecamp: its API from this side as a key's
// owner, and the one enrollment command a box runs to join its fleet.
// `basecamp:app`, `basecamp:deploy`, `outpost:install` and `deploy`'s
// `08b-outpost` step share these, so a box cannot be enrolled two ways; an
// enrolled box's Outpost is read here for `outpost:status`, an app's
// archive is fetched for `basecamp:backup` and the `db:` verbs, and each
// machine's stored grade for `basecamp:posture`.

import { spawnSync }                from 'node:child_process'
import { mkdirSync, rmSync }        from 'node:fs'
import { basename, join, resolve }  from 'node:path'
import { chalk }                    from './color.js'
import { ageOf }                    from './cloud.js'

// The dev API's port in basecamp's own CLAUDE.md, as `fli ws:deps --push` has it.
export const LOCAL_BASECAMP = 'http://localhost:8120'

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
    throw new Error(`could not reach Basecamp at ${origin}: ${err.message}`)
  }
  // A path the proxy does not route reaches the SPA's file server: a GET
  // answers index.html with 200, a write a bare 405 that reads as a method bug.
  if (res.headers.get('content-type')?.includes('text/html'))
    throw new Error(`Basecamp answered ${method} ${path} with HTML (${res.status}), not the API — is ${path} a path its proxy routes?`)
  const answer = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Basecamp refused ${method} ${path} (${res.status}): ${answer?.message ?? answer?.error ?? res.statusText}`)
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
    log.success('Outpost installed — the box joins the fleet at its first heartbeat')
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
// `basecamp:backup`, `db:download` and `db:import` fetch through this one
// (`FJS-D1717`). Only an archive in a bucket has a URL: no bytes cross the
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
    if (!newest) throw new Error(`App ${appId} has no archive in a bucket to fetch — take one with fli basecamp:backup --take, once the App has a backup destination`)
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
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`the bucket answered ${res.status} for the archive taken ${row.startedAt}`)
  mkdirSync(dir, { recursive: true })
  const file   = join(dir, basename(name))
  const hasher = new Bun.CryptoHasher('sha256')
  const sink   = Bun.file(file).writer()
  for await (const chunk of res.body) { hasher.update(chunk); sink.write(chunk) }
  await sink.end()
  const got = hasher.digest('hex')
  if (row.sha256 && got !== row.sha256) {
    rmSync(file, { force: true })
    throw new Error(`the archive fetched hashes ${got}, not the ${row.sha256} Basecamp recorded — not unpacked`)
  }
  const files = flatEntries(file)
  const r = spawnSync('tar', ['-xzf', file, '-C', dir, '--no-same-owner'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`could not unpack ${file}: ${r.stderr.trim()}`)
  return { dir, file, files, row }
}
