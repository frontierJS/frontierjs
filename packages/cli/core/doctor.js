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
// Zero dependencies, plain ESM, node or bun — same rule as its neighbours.

import { existsSync }   from 'node:fs'
import { execSync }     from 'node:child_process'
import { join }         from 'node:path'
import { homedir }      from 'node:os'

// ─── what a machine needs ─────────────────────────────────────────────────────
//
// `required` is the distinction that matters: without bun nothing here runs at
// all, and without docker only `deploy:` does. Reporting both as failures is
// how a person learns to ignore the report.

export const BINARIES = [
  { name: 'bun',     required: true,  hint: 'https://bun.sh' },
  { name: 'git',     required: true,  hint: 'sudo apt install git' },
  { name: 'sqlite3', required: false, hint: 'sudo apt install sqlite3  (needed for db: commands)' },
  { name: 'zip',     required: false, hint: 'sudo apt install zip  (needed for utils:pack)' },
  { name: 'ssh',     required: false, hint: 'sudo apt install openssh-client' },
  { name: 'rsync',   required: false, hint: 'sudo apt install rsync  (needed for deploy:)' },
  { name: 'docker',  required: false, hint: 'https://docs.docker.com/engine/install/' },
]

/** Is this binary on PATH. The default probe; injected in tests. */
export function onPath(cmd) {
  try { execSync(`which ${cmd}`, { stdio: 'pipe' }); return true }
  catch { return false }
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
 * @param {object}   o.env        environment
 * @param {string}   o.home       home directory
 */
export function diagnose({ root, fliRoot, modules = [], has = onPath, env = process.env, home = homedir() } = {}) {
  const globalEnv = join(home, '.config', 'fli', '.env')

  const system = BINARIES.map(b => {
    const ok = has(b.name)
    return { ...b, ok, level: ok ? 'ok' : b.required ? 'error' : 'warn' }
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
      namespaces.push({ ns: mod.ns, key, ok, level: ok ? 'ok' : 'error', fix: `fli eset ${key} <value> --global` })
    }
  }

  const all    = [...system, ...config, ...namespaces]
  const failed = all.filter(c => !c.ok)

  return {
    system, config, namespaces,
    checks:  all.length,
    failed:  failed.length,
    // *Nothing here is broken enough to stop you* is a different sentence from
    // *everything is present*, and a dashboard needs the first one: a machine
    // with no docker is a working machine for everything but `deploy:`.
    //
    // System and config ONLY. A missing `CLOUDFLARE_TOKEN` blocks `cloudflare:`
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
  for (const ns of [...new Set(commands.map(c => c.title.split(':')[0]))]) {
    const requires = getModule(ns)?.meta?.requires
    if (requires?.length) out.push({ ns, requires })
  }
  return out.sort((a, b) => a.ns.localeCompare(b.ns))
}
