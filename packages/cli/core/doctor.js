// ─── doctor.js — can this MACHINE run fli ─────────────────────────────────────
//
// The sibling question to `checks.js`, and it stays a separate one: that engine
// grades the PROJECT against the rules this framework publishes, and this one
// grades the machine the commands are about to run on. A binary that is not
// installed is not an architecture finding, and a model named in the plural is
// not something `apt` can fix.
//
// ── Why it is a module ──────────────────────────────────────────────────────
//
// It was a hundred lines inside `commands/fli/doctor.md`, interleaved with the
// `echo` calls that printed it — so the only way to ask the question was to run
// the command and read a terminal. `fli gui`'s front page is the second caller
// and could not have one, which is the same shape `checks.js` and `proofs.js`
// are already in: an engine that answers, and a renderer that prints.
//
// ── The seams ───────────────────────────────────────────────────────────────
//
// `has`, `env` and `home` are injected for the reason `@frontierjs/outpost`
// injects its runner: a suite that asks the real machine asserts whatever that
// machine happens to have, so it can only ever assert the shape. With them a
// missing `docker` and a present one are both a test.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { existsSync, statSync } from 'node:fs'
import { basecampsPath, readBasecamps, sshHosts } from './basecamps.js'
import { requiresOf }                 from './requires.js'
import { badProfileName, esetHint, globalEnvPath, listGlobal, listProfile, profileNames, profilePath } from './global-env.js'
import { homeReport, holdsOf, exposed } from './home.js'
import { servicesReport } from './services.js'
import { execSync }     from 'node:child_process'
import { join }         from 'node:path'
import { MIN_CF }       from './cloudflare.js'
import { homedir }      from 'node:os'

// ─── what a machine needs ─────────────────────────────────────────────────────
//
// `required` is the distinction that matters: without bun nothing here runs at
// all, and without docker only `deploy:` does. Reporting both as failures is
// how a person learns to ignore the report.

// The bun floor is a VERSION and not a presence, which is the one thing a
// `which` cannot answer. Every published package here declares the same floor in
// `engines`, and a package manager's engine check is advisory — bun installs and
// runs an app whose floor it does not meet, so the feature the floor was raised
// for fails at the call site instead, reporting itself as missing rather than as
// a stale runtime.
export const MIN_BUN = '1.4.0'

export const BINARIES = [
  { name: 'bun',     required: true,  hint: 'https://bun.sh', min: MIN_BUN, upgrade: 'bun upgrade' },
  { name: 'git',     required: true,  hint: 'sudo apt install git' },
  { name: 'sqlite3', required: false, hint: 'sudo apt install sqlite3  (needed for db: commands)' },
  { name: 'zip',     required: false, hint: 'sudo apt install zip  (needed for utils:pack)' },
  { name: 'ssh',     required: false, hint: 'sudo apt install openssh-client' },
  { name: 'rsync',   required: false, hint: 'sudo apt install rsync  (needed for deploy:)' },
  { name: 'docker',  required: false, hint: 'https://docs.docker.com/engine/install/' },
  { name: 'cf',      required: false, hint: 'npm i -g cf  (needed for :dns and cloudflare:)', min: MIN_CF, upgrade: 'npm i -g cf@latest' },
]

/**
 * Compare two dotted versions. Numeric segments only — a prerelease tag
 * (`1.4.0-canary.3`) is TRUNCATED rather than ordered, because ordering it right
 * is semver's hardest corner and being wrong here refuses a machine that works.
 *
 * @returns {-1|0|1} -1 when `a` is older than `b`
 */
export function compareVersions(a, b) {
  const parts = (v) => String(v).split('-')[0].split('.').map(s => parseInt(s, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/** What version a binary reports, or null. The default probe; injected in tests. */
export function binVersion(cmd) {
  try {
    const out = execSync(`${cmd} --version`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  } catch { return null }
}

/** Is this binary on PATH. The default probe; injected in tests. */
export function onPath(cmd) {
  try { execSync(`which ${cmd}`, { stdio: 'pipe' }); return true }
  catch { return false }
}

// ─── the index of Basecamps ───────────────────────────────────────────────────
//
// `basecamps.json` holds admin keys, so a file anyone else can read leaks them,
// and an entry whose ssh Host is not in `~/.ssh/config` makes every ssh-backed
// verb (`backup`, `restore`, `reinstall`) fail at the connection instead of at a
// sentence naming the entry. Both are warnings: the machine runs fli either way.

/** A mode row per secret entry that exists. `chmod 600` is the fix for a file and for a directory alike: nobody but the owner reads a key. */
function secretRows(report) {
  return Object.values(report.roots).flatMap(r => r.entries)
    .filter(e => e.secret && e.present)
    .map(e => {
      const ok = !exposed(parseInt(e.mode, 8))
      return { label: `${e.root}/${e.name}`, ok, level: ok ? 'ok' : 'warn', hint: `mode ${e.mode}, it holds keys  \u2192  chmod 600 ${e.path}`, path: e.path }
    })
}

/**
 * The profile in use and where it was named, then each profile file: its mode,
 * and any key the global file sets as well. Under `FJS-D1944` the global file
 * stays the fallback, so a key in both is one a project without `FLI_PROFILE`
 * spends from the global file without a word — the overlap is said, not refused.
 * A FLI_PROFILE line in either kind of file is said too: it reads as a default
 * and is ignored (`FJS-D1943`).
 */
function profileRows(profile, home) {
  const used = profile?.name
    ? { label: 'in use', ok: !profile.refusal, detail: `${profile.name}  (named by the ${profile.source === 'shell' ? 'shell' : "project's .env"})`, hint: profile.refusal }
    : { label: 'in use', ok: true, detail: 'none  (FLI_PROFILE unset: the global env alone)' }
  const rows = [used]

  const globalKeys = listGlobal({ home })
  if (globalKeys.some(e => e.key === 'FLI_PROFILE'))
    rows.push({ label: 'global env', ok: false, hint: `FLI_PROFILE here selects nothing: a profile is named by the project's .env or the shell  \u2192  remove it from ${globalEnvPath(home)}`, path: globalEnvPath(home) })

  const global = new Set(globalKeys.filter(e => e.value).map(e => e.key))
  for (const name of profileNames({ home })) {
    const file = profilePath(name, home)
    if (listProfile(name, { home }).some(e => e.key === 'FLI_PROFILE'))
      rows.push({ label: name, ok: false, hint: `FLI_PROFILE here selects nothing: a profile is named by the project's .env or the shell  \u2192  remove it from ${file}`, path: file })
    const mode = statSync(file).mode & 0o777
    if (exposed(mode)) rows.push({ label: name, ok: false, hint: `mode ${mode.toString(8)}, it holds keys  \u2192  chmod 600 ${file}`, path: file })
    const both = [...new Set(listProfile(name, { home }).filter(e => e.value && global.has(e.key)).map(e => e.key))]
    if (both.length) rows.push({ label: name, ok: false, hint: `${both.join(', ')} also in the global env, which a project with no profile spends  \u2192  remove it from ${globalEnvPath(home)} unless that is meant`, path: file })
    if (!exposed(mode) && !both.length) rows.push({ label: name, ok: true, path: file })
  }
  return rows.map(r => ({ ...r, level: r.ok ? 'ok' : r.label === 'in use' ? 'error' : 'warn' }))
}

function basecampRows(home) {
  const file = basecampsPath(home)
  if (!existsSync(file)) return []
  const rows = []
  let all
  try { all = readBasecamps({ home }) } catch (err) { rows.push({ label: 'basecamps.json', ok: false, hint: err.message, path: file }) }
  const hosts = sshHosts(home ?? homedir())
  for (const [name, entry] of Object.entries(all ?? {})) {
    // Every Workbench verb on this entry spawns fli under its profile, and that refuses at the first line when the file is gone.
    if (entry.profile) {
      const bad = badProfileName(entry.profile)
      const ok  = !bad && existsSync(profilePath(entry.profile, home))
      rows.push({ label: `${name} profile`, ok, hint: bad ?? `names profile '${entry.profile}', which has no file  \u2192  fli profile:create ${entry.profile}, or drop "profile" from its entry`, path: file })
    }
    if (!entry.host) continue
    rows.push({ label: name, ok: hosts.has(entry.host), hint: `no 'Host ${entry.host}' in ~/.ssh/config  \u2192  fli basecamp:create writes it, or add the block by hand`, path: file })
  }
  return rows.map(r => ({ ...r, level: r.ok ? 'ok' : 'warn' }))
}

/**
 * What this machine can and cannot do.
 *
 * @param {object}   o
 * @param {string}   o.root       the project root — where a `.env` would be
 * @param {string}   o.fliRoot    this package
 * @param {Array}    o.modules    `[{ ns, requires: string[] }]` — the namespaces
 *                                that declare env vars, read by the caller off
 *                                the registry, because a registry needs globals
 *                                this module must not depend on
 * @param {Function} o.has        binary probe
 * @param {Function} o.versionOf   version probe, for the binaries declaring a `min`
 * @param {object}   o.env        environment
 * @param {string}   o.home       home directory; absent, every root follows its XDG variable
 * @param {boolean}  o.probe      run each external login's probe (`gh auth status`, `npm whoami`); off by default, they shell out
 * @param {object}   o.profile    `loadFliEnv`'s answer — the profile in use and who named it
 */
export function diagnose({ root, fliRoot, modules = [], has = onPath, versionOf = binVersion, env = process.env, home, probe = false, profile = null } = {}) {
  const globalEnv = globalEnvPath(home)

  const system = BINARIES.map(b => {
    const present = has(b.name)
    if (!present) return { ...b, ok: false, present, version: null, level: b.required ? 'error' : 'warn' }
    if (!b.min)   return { ...b, ok: true,  present, version: null, level: 'ok' }

    // A version this probe could not READ is not a version that is too old: a
    // binary whose `--version` we cannot parse still runs, and failing it here
    // would block a working machine on the probe's own blind spot.
    const version = versionOf(b.name)
    const stale   = version !== null && compareVersions(version, b.min) < 0
    return {
      ...b,
      ok:      !stale,
      present, version,
      level:   stale ? (b.required ? 'error' : 'warn') : 'ok',
      hint:    stale ? `${version} is below ${b.min}  \u2192  ${b.upgrade ?? b.hint}` : b.hint,
      status:  stale ? `found ${version}, needs >=${b.min}` : version ? `found ${version}` : 'found',
    }
  })

  const config = [
    { label: 'global env',   ok: existsSync(globalEnv),  hint: `run: fli config  to create ${globalEnv}`, path: globalEnv },
    { label: 'project .env', ok: existsSync(join(root, '.env')), hint: 'no .env in project root', path: join(root, '.env') },
    { label: 'fli root',     ok: Boolean(fliRoot) && existsSync(fliRoot), hint: String(fliRoot), path: fliRoot ?? null },
    // A missing project `.env` is ordinary — most projects have none — so it is
    // reported and never failed. Only `fli root` can be an error: without it
    // this installation cannot resolve its own commands.
  ].map(c => ({ ...c, level: c.ok ? 'ok' : c.label === 'fli root' ? 'error' : 'warn' }))

  const namespaces = []
  for (const mod of modules) {
    for (const key of mod.requires ?? []) {
      const ok = Boolean(env[key])
      namespaces.push({ ns: mod.ns, key, ok, level: ok ? 'ok' : 'error', fix: esetHint(key, env.FLI_PROFILE) })
    }
  }

  const basecamps = basecampRows(home)
  const profiles  = profileRows(profile, home)

  // Printed, never counted: a root that does not exist yet is not a fault.
  const found = homeReport({ home })
  const roots = Object.entries(found.roots).map(([name, r]) => ({ name, path: r.path, holds: holdsOf(name).join(', ') }))

  const secrets = secretRows(found)

  // Warn, never error, and outside `all`: a laptop that never deploys to
  // Hetzner is not broken, and counting every unused service would read as a
  // failure on every machine. A probe that fails on a present login is the
  // same warning with a different hint.
  const services = servicesReport({ home, probe, env }).map(s => {
    const failedProbe = s.probe && !s.probe.ok
    const ok = s.present && !failedProbe
    return { ...s, ok, level: ok ? 'ok' : 'warn' }
  })

  const all    = [...system, ...config, ...namespaces, ...profiles, ...basecamps, ...secrets]
  const failed = all.filter(c => !c.ok)

  return {
    system, config, namespaces, profiles, basecamps, secrets, services, roots,
    checks:  all.length,
    failed:  failed.length,
    // *Nothing here is broken enough to stop you* is a different sentence from
    // *everything is present*, and a dashboard needs the first one: a machine
    // with no docker is a working machine for everything but `deploy:`.
    //
    // System and config ONLY. A missing `GITHUB_TOKEN` blocks `github:`
    // and nothing else, so counting it here would make almost every machine
    // read as unable to run fli — which is how a summary stops being read.
    blocked: [...system, ...config].filter(c => c.level === 'error').length,
    ok:      failed.length === 0,
  }
}

/**
 * The namespaces that declare `requires:`, off a built registry.
 *
 * Here rather than in the caller so both callers ask it the same way, and taking
 * the registry functions as arguments so this module keeps its promise not to
 * read a global.
 */
export function requiringModules({ commands, getModule }) {
  const out = []
  // A command's own `requires:` counts toward its namespace, or a namespace whose
  // keys are all per command (basecamp) drops out of the doctor.
  for (const ns of [...new Set(commands.map(c => c.title.split(':')[0]))]) {
    const own = commands.filter(c => c.title.split(':')[0] === ns).flatMap(c => requiresOf(c))
    const requires = [...new Set([...requiresOf(getModule(ns)?.meta), ...own].map(r => r.key))]
    if (requires.length) out.push({ ns, requires })
  }
  return out.sort((a, b) => a.ns.localeCompare(b.ns))
}
