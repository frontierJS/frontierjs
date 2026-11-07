// ─── services.js — every account fli signs in to, and how ────────────────────
//
// `home.js` says WHAT fli keeps on disk; this says WHO it signs in to and by
// which door. A token in the global env, an entry in `basecamps.json` and the
// login of `gh` or `cf` are one question to a person -- "am I signed in to
// GitHub" -- answered in three places, and a screen that kept its own list of
// them would name a key the code no longer reads. So the key lists come off
// `requires:` (through `requiresOf`) and off `CLOUDS`; only a key the code alone
// reads (`VW_*`, `ANTHROPIC_API_KEY`) is written here, with its `writer`.
//
// The actions are never written: `commandsUsing` derives them from the command
// registry, so a new `github:` command appears under GitHub on its own.
//
// `servicesReport()` reads presence and NEVER a value. A probe (`gh auth
// status`, `npm whoami`) runs only when asked -- it shells out, may reach the
// network, and costs up to its timeout -- and its output is scrubbed of anything
// shaped like a token before a single character is kept: `gh auth status`
// prints the token's first characters, and a log or a page must never hold them.
//
// Zero dependencies beyond its neighbors, plain ESM, node or bun.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CLOUDS } from './cloud.js'
import { extractFrontmatter } from './compiler.js'
import { listGlobal } from './global-env.js'
import { entries as homeEntries, homeReport } from './home.js'
import { requiresOf } from './requires.js'

const ROOT = resolve(import.meta.dirname, '..')

// A frontmatter block read straight off the file: this module must not need the
// registry's globals (`global.fliRoot`), or a doctor test could not import it.
const requiresIn = (rel) => requiresOf(extractFrontmatter(readFileSync(join(ROOT, rel), 'utf8'), rel))
const keysIn     = (rel) => requiresIn(rel).map(r => r.key)
const pageOf     = (rel, key) => { const { url, note } = requiresIn(rel).find(r => r.key === key) ?? {}; return url ? { url, note } : undefined }

const env  = (keys, writer = null) => ({ kind: 'env', keys, ...(writer ? { writer } : {}) })
const file = (entry, path = null)  => ({ kind: 'file', entry, ...(path ? { path } : {}) })
const cli  = (bin, probe, login)   => ({ kind: 'cli', bin, probe, login })
const cloud = (id) => ({ signIn: env([CLOUDS[id].key]), vendor: { url: CLOUDS[id].url, note: CLOUDS[id].note } })

const GITHUB_MODULE = 'commands/github/_module.md'
const DNS_COMMAND   = 'commands/basecamp/dns.md'

/**
 * One row per service.
 *
 * - `signIn`     env keys, a `home.js` entry (or a path under the home), or a CLI and its probe
 * - `also`       optional env keys that tune or stand in for the login; never needed for `present`
 * - `namespaces` command-title prefixes that use it (`github`, or `workspace:publish`)
 * - `setup`      the `path#heading` that explains it, or null where no section does
 * - `vendor`     where a key is made, where the source names one
 */
export const services = [
  { id: 'github', name: 'GitHub (REST)',
    signIn: env(keysIn(GITHUB_MODULE)), also: ['GITHUB_DEFAULT_ORG', 'GITHUB_DEFAULT_TEMPLATE'],
    namespaces: ['github', 'env:pull'], setup: `${GITHUB_MODULE}#Setup`,
    vendor: { url: 'https://github.com/settings/tokens', note: 'A classic token with repo scope' } },
  { id: 'github-cli', name: 'GitHub (gh)',
    signIn: cli('gh', ['gh', 'auth', 'status'], 'gh auth login'), also: [],
    namespaces: ['workspace:publish'], setup: null },
  { id: 'npm', name: 'npm',
    signIn: cli('npm', ['npm', 'whoami'], 'npm login'), also: [],
    namespaces: ['npm', 'workspace:publish'], setup: null },
  { id: 'digitalocean', name: CLOUDS.digitalocean.label, ...cloud('digitalocean'), also: [],
    namespaces: ['server', 'basecamp:create', 'basecamp:install', 'basecamp:reinstall'], setup: 'commands/server/_module.md#Setup' },
  { id: 'hetzner', name: CLOUDS.hetzner.label, ...cloud('hetzner'), also: [],
    namespaces: ['server', 'basecamp:create', 'basecamp:install', 'basecamp:reinstall'], setup: 'commands/server/_module.md#Setup' },
  { id: 'cloudflare', name: 'Cloudflare (cf)',
    signIn: cli('cf', ['cf', 'auth', 'whoami'], 'cf auth login'),
    also: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DEFAULT_ZONE'],
    namespaces: ['cloudflare'], setup: 'commands/cloudflare/_module.md#Setup' },
  { id: 'cloudflare-dns', name: 'Cloudflare (Basecamp DNS token)',
    signIn: env(keysIn(DNS_COMMAND)), also: [],
    namespaces: ['basecamp:dns', 'basecamp:create', 'basecamp:install', 'basecamp:open', 'basecamp:reinstall'],
    setup: 'commands/cloudflare/_module.md#Environment variables',
    vendor: pageOf(DNS_COMMAND, 'CLOUDFLARE_TOKEN') },
  { id: 'wrangler', name: 'Cloudflare (wrangler)',
    signIn: cli('wrangler', ['wrangler', 'whoami'], 'wrangler login'), also: ['CLOUDFLARE_API_TOKEN'],
    namespaces: ['workspace:post', 'site:deploy'], setup: null },
  { id: 'basecamp', name: 'Basecamp',
    signIn: file('config/basecamps.json'), also: [],
    namespaces: ['basecamp', 'outpost', 'deploy', 'db:download', 'env:push'], setup: 'commands/basecamp/_module.md#Setup' },
  { id: 'frontier', name: 'Frontier network',
    signIn: file('state/frontier'), also: [],
    namespaces: ['frontier', 'tell'], setup: null },
  { id: 'vaultwarden', name: 'Vaultwarden',
    signIn: env(['VW_URL', 'VW_PASSWORD'], 'commands/env/pull.md'), also: ['VW_CLIENT_ID', 'VW_CLIENT_SECRET', 'VW_EMAIL'],
    namespaces: ['env:pull', 'env:send'], setup: null },
  { id: 'anthropic', name: 'Anthropic',
    signIn: cli('claude', ['claude', 'auth', 'status'], 'claude auth login'), also: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    namespaces: ['ai'], setup: null },
  { id: 'ssh', name: 'ssh',
    signIn: file(null, '.ssh/config'), also: [],
    namespaces: ['utils:ssh'], setup: null },
]

/** Every env key a service names -- the sign-in keys and the optional ones. */
export const keysOf = (s) => [...(s.signIn.keys ?? []), ...(s.also ?? [])]

/** Every key a `requires:` in `commands/` or a `CLOUDS` row names; the test that none escapes the catalog reads this. */
export const knownKeys = () => new Set(services.flatMap(keysOf))

const titleOf = (c) => c.title ?? c.meta?.title ?? ''
const metaOf  = (c) => c.meta ?? c

/**
 * The commands that use a service, derived: every command whose own `requires:`
 * names one of its keys, or whose title sits under one of its `namespaces`.
 *
 * @param {object|string} service  a catalog row or its id
 * @param {Map|Array}     registry `buildRegistry()`, or the metas `uniqueCommands` answers
 * @returns {{ title: string, description: string }[]}
 */
export function commandsUsing(service, registry) {
  const s    = typeof service === 'string' ? services.find(x => x.id === service) : service
  if (!s) return []
  const keys = new Set(keysOf(s))
  const list = registry instanceof Map ? [...registry.values()] : registry
  const seen = new Set()
  const out  = []
  for (const c of list) {
    const title = titleOf(c)
    if (!title || seen.has(title) || title.startsWith('_')) continue
    const byNamespace = s.namespaces.some(n => title === n || title.startsWith(`${n}:`))
    const byKey       = requiresOf(metaOf(c)).some(r => keys.has(r.key))
    if (!byNamespace && !byKey) continue
    seen.add(title)
    out.push({ title, description: metaOf(c).description ?? '' })
  }
  return out.sort((a, b) => a.title.localeCompare(b.title))
}

// ─── probes ──────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT = 5000

/** The first `bin` on `env`'s PATH, or null. Resolved here so a test's PATH is the one searched. */
function whichIn(bin, env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const path = join(isAbsolute(dir) ? dir : resolve(dir), bin)
    try { if (statSync(path).isFile()) return path } catch {}
  }
  return null
}

// Anything shaped like a credential: a vendor prefix, or a long unbroken run.
// `gh auth status` prints `Token: gho_****` and a failing `cf` can echo a
// header; none of it is kept.
const TOKENISH = /\b(?:gh[pousr]_|github_pat_|sk-|npm_|xox[abp]-)[\w*-]*|\b[A-Za-z0-9_-]{32,}\b/g
export const scrub = (text) => String(text ?? '').replace(TOKENISH, '[redacted]')

const json = (text, field) => { try { return JSON.parse(text)?.[field] ?? null } catch { return null } }

// One reader per binary: what it prints differs, and what is wanted is only the
// name it is signed in as.
const WHO = {
  gh:       (t) => t.match(/Logged in to \S+ account (\S+)/)?.[1] ?? null,
  npm:      (t) => t.trim().split('\n')[0].trim() || null,
  cf:       (t) => json(t, 'email'),
  wrangler: (t) => t.match(/associated with the email (\S+?)\.?(?:\s|$)/)?.[1] ?? null,
  claude:   (t) => json(t, 'loggedIn') === true ? (json(t, 'email') ?? 'logged in') : null,
}

// `claude auth status` exits 0 signed out too, saying so in its JSON, and `gh`
// exits non-zero; a probe is `ok` only when the binary says so AND, where it
// can, names who.
const SIGNED_IN = {
  claude: (t) => json(t, 'loggedIn') === true,
}

/**
 * Run one service's probe. Never throws; a missing binary or a timeout is `ok: false`.
 *
 * @returns {{ ok: boolean, who: string|null, ms: number }}
 */
export function probeService(s, { env = process.env } = {}) {
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  if (s.signIn.kind !== 'cli') return { ok: false, who: null, ms: 0 }
  const [bin, ...args] = s.signIn.probe
  const path = whichIn(bin, env)
  if (!path) return { ok: false, who: null, ms: 0 }
  const run  = spawnSync(path, args, { env, encoding: 'utf8', timeout: PROBE_TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'] })
  // `gh auth status` writes to stderr on some versions; the scrubber covers both streams.
  const text = scrub(`${run.stdout ?? ''}\n${run.stderr ?? ''}`)
  const gate = SIGNED_IN[bin]
  const ok   = run.status === 0 && (gate ? gate(text) : true)
  return { ok, who: ok ? (WHO[bin]?.(text) ?? null) : null, ms: ms() }
}

// ─── presence ────────────────────────────────────────────────────────────────

/**
 * Per service: is its sign-in there, and -- only when `probe` is true or lists
 * its id -- does it still work and as whom.
 *
 * @param {object}  o
 * @param {string}  o.home    pins the roots, as `home.js` takes it
 * @param {boolean|string[]} o.probe
 * @param {object}  o.env     read for keys the global env lacks, and for PATH
 * @returns {{ id: string, name: string, kind: string, present: boolean, keys?: string[], probe?: object }[]}
 */
export function servicesReport({ home, probe = false, env = process.env } = {}) {
  const held   = new Set(listGlobal({ home }).filter(e => e.value).map(e => e.key))
  const have   = (key) => held.has(key) || Boolean(env[key])
  const disk   = homeReport({ home }).roots
  const onDisk = (entry) => {
    const [root, ...rest] = entry.split('/')
    return Boolean(disk[root]?.entries.find(e => e.name === rest.join('/') && e.present))
  }

  return services.map(s => {
    const { kind } = s.signIn
    const present =
      kind === 'env'  ? s.signIn.keys.every(have)
    : kind === 'file' ? (s.signIn.entry ? onDisk(s.signIn.entry) : existsSync(join(home ?? homedir(), s.signIn.path)))
    :                   Boolean(whichIn(s.signIn.bin, env))
    const row = { id: s.id, name: s.name, kind, present, ...(kind === 'env' ? { keys: s.signIn.keys } : {}) }
    const asked = probe === true || (Array.isArray(probe) && probe.includes(s.id))
    if (asked && kind === 'cli') row.probe = probeService(s, { env })
    return row
  })
}

// A catalog row naming a `home.js` entry that does not exist would read as
// "never signed in" forever; the test reads this to refuse it.
export const homeEntryNames = () => homeEntries.map(e => `${e.root}/${e.name}`)
