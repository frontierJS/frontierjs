/**
 * core/cloudflare.js — fli's one owner of the Cloudflare dialect, over `cf`.
 *
 * Every Cloudflare call fli makes is one spawn of Cloudflare's own CLI
 * (`FJS-D1469`); nothing here holds a credential or speaks HTTP. `cf` keeps the
 * login, fli keeps nothing, and the argv and JSON below are the only place the
 * shape of `cf` is known. Read against `cf` v0.15.0 — `IDEAS/cloudflare-dns.md`
 * § Measured is the record of what each verb answered.
 *
 * ── A profile is `cf`'s, or the env token ─────────────────────────────
 *
 * `profiles()` is the Accounts screen's first column (`FJS-D1468`): each `cf`
 * profile, plus one `token` entry when `CLOUDFLARE_API_TOKEN` is in the env
 * (`FJS-D1473`). `cf` lets that variable WIN over a login, `--profile`
 * included, so a profile spawns with it DELETED — otherwise a client's project
 * token silently answers for the person's own login.
 *
 * ── Shape ─────────────────────────────────────────────────────────────────
 *
 * Each verb answers the API object `cf` prints, unwrapped and untouched. A
 * list walks `--page` until a short one: zones default to 20 a page, and the
 * run that measured it got 20 of 21 back with no sign there was a 21st. A zone
 * is always passed by id, because a zone NAME with two accounts reachable is a
 * refusal in non-interactive mode; `findZone` turns a name into one here.
 *
 * Pages and Workers verbs take no `--account-id`, and with two accounts
 * reachable they refuse the same way, so their account rides the spawn as
 * `CLOUDFLARE_ACCOUNT_ID`. Pages lists cap at 10 a page — above that is a 400.
 *
 * ── Failure ───────────────────────────────────────────────────────────────
 *
 * A refusal throws `CloudflareError` carrying `cf`'s own words with the verb
 * named. `cf` draws them in a box on stderr; the box is stripped and the words
 * are not reworded — an unknown zone id reads as a 403 there, and a guess at
 * which one it was would be wrong half the time.
 */

export class CloudflareError extends Error {}

/** The variable `cf` reads a token from. fli's commands read the same one. */
export const TOKEN_ENV = 'CLOUDFLARE_API_TOKEN'

/** The variable `cf` picks an account from when a verb takes no `--account-id`. */
const ACCOUNT_ENV = 'CLOUDFLARE_ACCOUNT_ID'
const INSTALL = 'npm i -g cf'
const ZONE_PAGE = 50
const RECORD_PAGE = 1000
const PAGES_PAGE = 10
const WORKER_PAGE = 50
const ZONE_ID = /^[a-f0-9]{32}$/i

/**
 * The credential a command runs as: a named `cf` profile, else the env token,
 * else whichever login `cf` has active. `TOKEN_ENV` names the token row, and
 * is refused while unset — the spawn would otherwise answer as the login.
 */
export function profileFor(name) {
  if (name === TOKEN_ENV && !process.env[TOKEN_ENV]) throw new CloudflareError(`${TOKEN_ENV} is not set`)
  return name === TOKEN_ENV ? { kind: 'token', name }
    : name ? { kind: 'profile', name }
    : process.env[TOKEN_ENV] ? { kind: 'token', name: TOKEN_ENV }
    : { kind: 'none' }
}

/**
 * Where an account can come from: each `cf` profile, then the env token.
 * `{ kind: 'profile', name }` or `{ kind: 'token', name: TOKEN_ENV }`.
 */
export async function profiles() {
  const out = process.env[TOKEN_ENV] ? [{ kind: 'token', name: TOKEN_ENV }] : []
  const rows = await cf({ kind: 'none' }, 'auth list', [])
  return [...rows.map(p => ({ kind: 'profile', name: p.name })), ...out]
}

/** The accounts a profile reaches. */
export const accounts = (profile) => walk(profile, 'accounts list', [], ZONE_PAGE)

/**
 * The Accounts screen: each profile with the accounts it reaches, or `cf`'s
 * refusal in its place — one signed-out profile must not empty the screen.
 */
export const reachable = async () => Promise.all((await profiles()).map(async profile => {
  try {
    return { profile, accounts: await accounts(profile) }
  } catch (err) {
    if (!(err instanceof CloudflareError)) throw err
    return { profile, error: err.message }
  }
}))

/** An account's zones; with no account, every zone the profile reaches. */
export const zones = (profile, accountId) =>
  walk(profile, 'zones list', accountId ? ['--account-id', accountId] : [], ZONE_PAGE)

/**
 * The zone a host belongs to: the longest zone name it equals or ends in, so
 * `ops.client.example` lands in `client.example` whatever default zone is set.
 * A zone id passes through as it is. Null when no reachable zone owns it.
 */
export async function findZone(profile, host) {
  if (ZONE_ID.test(host)) return { id: host, name: host }
  const fqdn = host.toLowerCase().replace(/\.$/, '')
  return (await zones(profile))
    .filter(z => fqdn === z.name || fqdn.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0] ?? null
}

/** A zone's records, every page. */
export const records = (profile, zoneId) =>
  walk(profile, 'dns records list', ['-z', zoneId], RECORD_PAGE)

/** One record, as Cloudflare holds it now. */
export const record = (profile, zoneId, recordId) =>
  cf(profile, 'dns records get', [recordId, '-z', zoneId])

/**
 * Basecamp's edge connector marks the records it writes in `comment`, and the
 * two must read one spelling: the fleet word whole, or before a colon (`read()`
 * in `basecamp/api/src/providers/edge/cloudflare.ts`). A marked record is one
 * `domain:dns` puts back on its next sync.
 */
export const MARK = /^basecamp(:(domain|app):.+)?$/
export const marked = (comment) => typeof comment === 'string' && MARK.test(comment)

/** Create a record from a whole body; answers the record Cloudflare stored. */
export const createRecord = (profile, zoneId, body) =>
  cf(profile, 'dns records create', ['-z', zoneId, '--body', JSON.stringify(body)])

/** Patch a record — a key absent from `changes` is left as it is. */
export const updateRecord = (profile, zoneId, recordId, changes) =>
  cf(profile, 'dns records edit', [recordId, '-z', zoneId, '--body', JSON.stringify(changes)])

/** Delete a record. `--force` because the asking is the caller's, done before this. */
export const deleteRecord = (profile, zoneId, recordId) =>
  cf(profile, 'dns records delete', [recordId, '-z', zoneId, '--force'])

/** Purge a zone's cache: `{ purge_everything: true }` or `{ files: [...] }`. */
export const purge = (profile, zoneId, body) =>
  cf(profile, 'cache purge', ['-z', zoneId, '--body', JSON.stringify(body)])

// ─── Pages ────────────────────────────────────────────────────────────────

/** An account's Pages projects. */
export const pagesProjects = (profile, accountId) =>
  walk(profile, 'pages projects list', [], PAGES_PAGE, accountId)

/** Create a Pages project from a whole body; answers the project. */
export const createPagesProject = (profile, accountId, body) =>
  cf(profile, 'pages projects create', ['--body', JSON.stringify(body)], accountId)

/** A project's most recent deployments, newest first. */
export const pagesDeployments = (profile, accountId, project, count = PAGES_PAGE) =>
  cf(profile, 'pages projects deployments list', ['--project-name', project, '--per-page', String(count)], accountId)

/** Start a deployment of a git-connected project from its production branch. */
export const deployPages = (profile, accountId, project) =>
  cf(profile, 'pages projects deployments create', [project], accountId)

// ─── Workers ──────────────────────────────────────────────────────────────

/** An account's Workers. */
export const workers = (profile, accountId) =>
  walk(profile, 'workers list', [], WORKER_PAGE, accountId)

/** One Worker by id or name, with what references it (`references.domains`). */
export const worker = (profile, accountId, name) =>
  cf(profile, 'workers get', [name], accountId)

/**
 * The version serving a Worker's traffic — the first version of its latest
 * deployment — with its `bindings`. Null when it was never deployed. The newest
 * VERSION is not this one: an upload that was not deployed is newer.
 */
export async function activeVersion(profile, accountId, worker) {
  const { deployments = [] } = await cf(profile, 'workers deployments list', ['--worker', worker], accountId) ?? {}
  const id = deployments[0]?.versions?.[0]?.version_id
  return id ? cf(profile, 'workers versions get', [id, '--worker-id', worker], accountId) : null
}

// ─── Sign in ──────────────────────────────────────────────────────────────

/**
 * `cf auth login` as a device flow: `cf` prints a link and a code, and waits
 * up to five minutes for the person to approve it in a browser. Each line it
 * prints is `onEvent({ type: 'line', text })`, in its own words, and the link
 * is `{ type: 'link', url }` once, for the caller to open — `--no-browser`
 * because the spawn has no terminal, and a browser `cf` opens itself is one
 * the console cannot name. `done` answers `{ ok, error }`; `stop()` kills it.
 */
export function login({ onEvent }) {
  const { env } = spawnFor({ kind: 'none' })
  let proc
  try {
    proc = Bun.spawn(['cf', 'auth', 'login', '--no-browser'], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  } catch (err) {
    if (err?.code === 'ENOENT') throw new CloudflareError(`cf auth login: cf is not installed — ${INSTALL}`)
    throw err
  }
  let linked = false
  let said = ''
  const take = (line) => {
    const text = line.trim()
    if (!text) return
    onEvent({ type: 'line', text })
    if (!linked && /^https?:\/\/\S+$/.test(text)) {
      linked = true
      onEvent({ type: 'link', url: text })
    }
  }
  const lines = async (stream, keep) => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })
      if (keep) said += text
      buf += text
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        take(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    }
    take(buf)
  }
  const done = Promise.all([lines(proc.stdout, false), lines(proc.stderr, true), proc.exited])
    // The device text came through as lines; a refusal is the box after it.
    .then(([, , code]) => {
      if (code === 0) return { ok: true }
      const box = said.lastIndexOf('┌')
      return { ok: false, error: `cf auth login: ${(box >= 0 && unbox(said.slice(box))) || `exit ${code}`}` }
    })
  return { done, stop: () => proc.kill() }
}

async function walk(profile, verb, args, perPage, accountId) {
  const all = []
  for (let page = 1; ; page++) {
    const rows = await cf(profile, verb, [...args, '--per-page', String(perPage), '--page', String(page)], accountId)
    all.push(...rows)
    if (rows.length < perPage) return all
  }
}

/** The env and argv tail a profile spawns with. */
export function spawnFor(profile) {
  const env = { ...process.env }
  if (profile.kind === 'token') return { env, tail: [] }
  delete env[TOKEN_ENV]
  return { env, tail: profile.kind === 'profile' ? ['--profile', profile.name] : [] }
}

/** One spawn of `cf <verb> ...args`; a refusal names the verb, never the args. */
async function cf(profile, verb, args, accountId) {
  const { env, tail } = spawnFor(profile)
  if (accountId) env[ACCOUNT_ENV] = accountId
  const label = `cf ${verb}`
  let proc
  try {
    // `env:` is required: a Bun spawn hands the child the env the process
    // started with, so an unset token would still reach `cf` without it.
    proc = Bun.spawn(['cf', ...verb.split(' '), ...args, ...tail], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  } catch (err) {
    if (err?.code === 'ENOENT') throw new CloudflareError(`${label}: cf is not installed — ${INSTALL}`)
    throw err
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new CloudflareError(`${label}: ${unbox(stderr) || `exit ${code}`}`)
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new CloudflareError(`${label}: answered something that is not JSON — ${text.slice(0, 200)}`)
  }
}

/** `cf`'s stderr box to its words: the frame and the title line go, the hint stays. */
export function unbox(stderr) {
  const lines = stderr.split('\n').map(l => l.trimEnd())
  const words = []
  for (const line of lines) {
    if (/^\s*┌/.test(line) || /^\s*└/.test(line) || !line.trim()) continue
    words.push(line.replace(/^\s*│\s?/, '').replace(/^→\s*/, '').trim())
  }
  return words.join(' ').replace(/\s+/g, ' ').trim()
}
