// ─── publish-view.js — publishing the workspace's packages, walked ───────────
//
// `fli ws:pub` is the whole release of the packages in one command: preflight,
// one bump, one commit with a tag per package, `bun publish` in dependency
// order, one push. It is right and it is a lot to hold in your head at the
// moment you run it, so `fli gui` walks it — the gates before it, a dry run
// that states the numbers, the run itself, and the registry read back after.
//
// **Nothing here re-derives the release.** Which packages are affected, the
// version each moves to, the publish order and every refusal are `ws:pub`'s,
// reached by running it with `--dry`; the registry is `ws:npm --json`. A
// second implementation is how the page would come to promise a version the
// command then does not publish.
//
// **Every option reaches argv through a check here.** `ws:pub` hands `--tag`
// and `--otp` to `execSync` as one string, so a value that is not exactly the
// shape below is refused rather than escaped — and a package is named by a
// member the workspace holds, never by text from the request.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync }                             from 'node:child_process'
import { join, resolve }                         from 'node:path'

import { spawnStep } from './release-view.js'

export const BUMPS = ['patch', 'minor', 'major', 'prerelease']

// A dist-tag and an OTP as `ws:pub` will paste them into a shell string.
const TAG_SHAPE = /^[a-z][a-z0-9-]{0,30}$/
const OTP_SHAPE = /^\d{6,8}$/

export const PUBLISH_STAGES = [
  { id: 'ready',   title: 'get ready' },
  { id: 'choose',  title: 'choose what goes out' },
  { id: 'publish', title: 'publish' },
  { id: 'after',   title: 'check it landed' },
  { id: 'recover', title: 'if it stops partway' },
]

// `run: 'pub'` steps are `ws:pub` with the options on the page; `bin` names a
// binary other than `fli`. A `gate` reads something the page already holds,
// and `note` is a step that runs nothing because the right move is a person's.
export const PUBLISH_STEPS = [
  { id: 'commit',   stage: 'ready',   gate: 'tree',
    title: 'commit what you mean to publish',
    why:   'npm packs the working directory, not the commit — ws:pub refuses a package with uncommitted files' },
  { id: 'ci',       stage: 'ready',   gate: 'ci',
    title: 'a full CI run passes',
    why:   'the release commit is pushed through the pre-push hook, after the packages are already on npm' },
  { id: 'snapshots', stage: 'ready',  argv: ['test:snapshots'], fix: ['test:snapshots', '--fix'],
    title: 'every committed snapshot matches its source',
    why:   'exports.snapshot.md is what the registry will be holding — fix reruns each generator; read the diff, then commit' },
  { id: 'whoami',   stage: 'ready',   bin: 'npm', argv: ['whoami'],
    title: 'npm knows who you are',
    why:   'bun publish reads npm\'s credentials — log in with `npm login` before a version is spent' },

  { id: 'changed',  stage: 'choose',  argv: ['ws:changed', '--verbose'],
    title: 'what changed since each release tag',
    why:   'only a package with commits since its own tag goes out unless you include the unchanged' },
  { id: 'registry', stage: 'choose',  gate: 'registry',
    title: 'what the registry holds now',
    why:   'each package\'s local version against npm — read from the registry when you press it' },
  { id: 'plan',     stage: 'choose',  run: 'pub', dry: true,
    title: 'the dry run — versions, order, refusals',
    why:   'ws:pub --dry: every version it would write and every reason it would refuse, spending nothing' },

  { id: 'publish',  stage: 'publish', run: 'pub',
    confirm: 'writes the versions, commits and tags them, publishes each to npm and pushes',
    title: 'publish',
    why:   'one bump, one release commit with a tag per package, bun publish in dependency order — a 2FA prompt per package prints its link in the console' },

  { id: 'verify',   stage: 'after',   gate: 'registry',
    title: 'the registry has the new versions',
    why:   'read the registry again — every package that went out should read level' },
  { id: 'push',     stage: 'after',   bin: 'git', argv: ['push', 'origin', 'HEAD', '--tags'],
    confirm: 'pushes the release commit and its tags', button: 'push',
    title: 'push, if you held it back',
    why:   'only when "push when done" was off — the release commit and tags are local until this' },

  { id: 'partial',  stage: 'recover', gate: 'note',
    title: 'a run that published some and not others',
    why:   'the console names what DID publish — those versions are on npm for good. Re-running bumps again and skips a version; reset the release commit and its tags, then publish again with "finish a partial run" on' },
]

// ─── the workspace ───────────────────────────────────────────────────────────

/** `packages/*` with a manifest — the members `ws:pub` reads, and nothing else. */
export function workspaceMembers(root) {
  const dir = join(root, 'packages')
  if (!existsSync(dir)) return []
  const out = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    try {
      const pkg = JSON.parse(readFileSync(join(dir, d.name, 'package.json'), 'utf8'))
      if (pkg.name) out.push({ name: pkg.name, folder: d.name, version: pkg.version ?? null, private: Boolean(pkg.private) })
    } catch { /* not a member */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function fli(fliRoot, cwd, argv, timeout = 60_000) {
  const r = spawnSync(process.execPath, [resolve(fliRoot, 'bin/fli.js'), ...argv], {
    cwd, timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  return { ok: r.status === 0 && !r.error, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

function jsonArray(text) {
  const i = text.indexOf('['), j = text.lastIndexOf(']')
  if (i < 0 || j < i) return null
  try { return JSON.parse(text.slice(i, j + 1)) } catch { return null }
}

/**
 * Every member with what the page needs to choose — version, private, and
 * whether it has commits since its own tag (`ws:changed --json`, local git).
 * `available: false` where there is nothing to publish from.
 */
export function publishLocal({ root, fliRoot }) {
  const members = workspaceMembers(root)
  if (!members.some(m => !m.private)) return { available: false, packages: [] }

  const changed = jsonArray(fli(fliRoot, root, ['ws:changed', '--json']).stdout) ?? []
  const byName  = new Map(changed.map(c => [c.name, c]))
  return {
    available: true,
    packages: members.map(m => {
      const c = byName.get(m.name)
      return {
        ...m,
        affected: c ? Boolean(c.affected) : null,
        commits:  c ? (c.commits?.length ?? 0) : null,
        lastTag:  c?.lastTag || null,
        dirty:    c ? Boolean(c.dirty) : null,
      }
    }),
  }
}

/** The registry, read — `ws:npm --json`. A press, because it asks npm. */
export function publishRegistry({ root, fliRoot, tag = 'latest' }) {
  if (!TAG_SHAPE.test(String(tag))) return { ok: false, error: `not a dist-tag: ${JSON.stringify(String(tag).slice(0, 40))}` }
  const r = fli(fliRoot, root, ['ws:npm', '--json', '--tag', tag], 90_000)
  const rows = jsonArray(r.stdout)
  if (!rows) return { ok: false, error: (r.stdout + '\n' + r.stderr).trim().split('\n').filter(Boolean).pop() ?? 'ws:npm answered nothing' }
  return { ok: true, at: Date.now(), packages: rows.map(p => ({ name: p.name, local: p.local, remote: p.remote ?? null, status: p.status, error: p.error ?? null })) }
}

// ─── the steps ───────────────────────────────────────────────────────────────

export function describePublish() {
  return {
    stages: PUBLISH_STAGES,
    steps:  PUBLISH_STEPS.map(({ argv, fix, ...s }) => ({
      ...s,
      command: s.run === 'pub' ? `fli ws:pub${s.dry ? ' --dry' : ''}` : argv ? `${s.bin ?? 'fli'} ${argv.join(' ')}` : null,
      fixCommand: fix ? `fli ${fix.join(' ')}` : null,
    })),
  }
}

/**
 * `ws:pub`'s argv from the page's options, or `{ error }` naming the one that
 * is not allowed. `packages` empty means "what ws:pub would pick", so no
 * `--filter` at all; otherwise each name must be a member and must match no
 * OTHER member, since `--filter` matches by substring.
 */
export function pubArgv(opts = {}, members = [], { dry = false } = {}) {
  const bump = String(opts.bump ?? 'patch')
  if (!BUMPS.includes(bump)) return { error: `not a bump: ${JSON.stringify(bump.slice(0, 20))}` }
  const tag = String(opts.tag ?? 'latest')
  if (!TAG_SHAPE.test(tag)) return { error: `not a dist-tag: ${JSON.stringify(tag.slice(0, 40))}` }
  const otp = String(opts.otp ?? '')
  if (otp && !OTP_SHAPE.test(otp)) return { error: 'a one-time password is 6 to 8 digits' }

  const argv = ['ws:pub', bump]
  for (const name of Array.isArray(opts.packages) ? opts.packages : []) {
    const m = members.find(x => x.name === name)
    if (!m) return { error: `no package in this workspace called ${JSON.stringify(String(name).slice(0, 60))}` }
    const also = members.filter(x => x !== m && (x.name.includes(name) || x.folder.includes(name)))
    if (also.length) return { error: `--filter ${name} would also select ${also.map(x => x.name).join(', ')}` }
    argv.push('--filter', name)
  }
  if (tag !== 'latest')      argv.push('--tag', tag)
  if (opts.all)              argv.push('--all')
  if (opts.tolerate)         argv.push('--tolerate-republish')
  if (opts.push === false)   argv.push('--no-push')
  if (dry)                   argv.push('--dry')
  else if (otp)              argv.push('--otp', otp)
  return { argv }
}

export function runPublishStep({ root, fliRoot, id, opts = {}, fix = false, approved = false, onLine }) {
  const step = PUBLISH_STEPS.find(s => s.id === id)
  if (!step || !(step.argv || step.run)) return { error: `unknown step: ${JSON.stringify(String(id).slice(0, 40))}` }
  if (fix && !step.fix)          return { error: `${step.id} has no fix` }
  if (step.confirm && !approved) return { error: `${step.id} ${step.confirm} — it needs approving` }

  let argv = fix ? step.fix : step.argv
  if (step.run === 'pub') {
    const built = pubArgv(opts, workspaceMembers(root), { dry: Boolean(step.dry) })
    if (built.error) return built
    argv = built.argv
  }
  const bin = step.bin ?? 'fli'
  const { child, done } = spawnStep({ fliRoot, cwd: root, argv, bin, onLine })
  return { child, argv, display: displayArgv(bin, argv), cwd: '.', done }
}

/** What the console shows — the password is the one argument nobody should find in a scrollback. */
export function displayArgv(bin, argv) {
  return `${bin} ${argv.map((a, i) => argv[i - 1] === '--otp' ? '••••••' : a).join(' ')}`
}
