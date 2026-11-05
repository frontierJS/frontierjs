// ─── vendor.js — turn workspace sources into a shippable build context ───────
//
// An app developed against the framework's own sources depends on it by
// `link:@frontierjs/junction` (what `fli new --source local` writes) or by
// `workspace:*` (what a package inside the monorepo writes). Both resolve on the
// machine that made them and to nothing inside a Docker build, which fails five
// times over with `FileNotFound: failed linking dependency/workspace to
// node_modules` — FJS-241, and the reason `fli deploy:local` could not be run at
// all against the scaffold this repo produces by default.
//
// The answer is not to change what the app depends on. A `link:` spec is what
// makes an edit to a package visible with no reinstall, which is the whole point
// of developing against local sources; a `file:` tarball in the same place goes
// stale on the first save and says nothing. So the swap happens at BUILD time:
// `bun pm pack` each package into the app's own build context, and install from
// a rewritten copy of the manifest that points at the tarballs.
//
// A tarball is byte-for-byte what `npm publish` would upload, so the image runs
// the working tree rather than the registry — and it grades every package's
// `files:` field on the way past, because a source file missing from `files` is
// invisible in a workspace and fatal once installed.
//
// ── One engine, three callers ────────────────────────────────────────────────
//
// `fli deploy:vendor` is the command; `fli deploy:local` and the deploy
// pipeline's build step run it before they build; `packages/basecamp/deploy/build.mjs`
// runs it over the app whose whole purpose is to exercise the tree, and carried
// the only working implementation of it before this existed. Two implementations
// of one rule is how the scaffold and the dogfood app end up shipping different
// images from the same question, so this is the only copy. Zero dependencies,
// plain ESM, node or bun.
//
// ── Nothing to vendor is not nothing to do ───────────────────────────────────
//
// An app installing from npm has no linked spec, and this still writes the
// generated manifest — a verbatim copy — and the lockfile beside it. That is
// what lets ONE Dockerfile serve both source modes: a template with a branch in
// it is a template that is wrong for half the apps that copy it, and the source
// mode can change long after `fli make:deploy` ran once.

import { spawnSync }                                             from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync,
         readdirSync, mkdirSync, rmSync, realpathSync }           from 'node:fs'
import { join, resolve, dirname, relative }                       from 'node:path'
import { releasableMembers, memberByName }                    from './workspace-members.js'

// Where the generated build context lands, relative to the app root. The
// Dockerfile `fli make:deploy` writes names the same path, and the `file:` specs
// are written relative to the manifest — which sits at the image's /app — so the
// tarballs must be copied to the path they are named at.
// The Dockerfile a build uses, and whether it installs from here: one order
// for the laptop and the Outpost, owned by the Outpost (`FJS-D1560`).
export { chooseDockerfile, needsGenerated } from '@frontierjs/outpost/dockerfile'

export const GENERATED_DIR = 'deploy/generated'
export const VENDOR_DIR    = 'deploy/generated/vendor'
export const MANIFEST_FILE = 'deploy/generated/app-manifest.json'

const LINKED = /^(link:|workspace:)/

// A spec already pointing into the generated directory. It is OUTPUT — this
// module wrote it — and the directory is wiped on every run, so a manifest
// carrying one has to be re-derived rather than left naming a tarball that is
// about to stop existing. An app whose package.json has been replaced by the
// generated one is the case: it happens the moment somebody installs what the
// image installs, which is exactly what CI's scaffold phase does.
const alreadyVendored = (spec) => spec.startsWith(`file:./${VENDOR_DIR}/`)

// ─── linkedDeps ───────────────────────────────────────────────────────────────
// The dependency names this app cannot install from a registry. Both fields,
// because a build that runs the app's own `build:web` needs its devDependencies.

export function linkedDeps(manifest) {
  const out = []
  for (const field of ['dependencies', 'devDependencies'])
    for (const [name, spec] of Object.entries(manifest[field] ?? {}))
      if (typeof spec === 'string' && (LINKED.test(spec) || alreadyVendored(spec))) out.push(name)
  return [...new Set(out)]
}

// ─── resolvePackageSource ─────────────────────────────────────────────────────
// Where the sources those specs point at actually live: `{ dir, packages }`, the
// packages being `{ name, dir, private }` for every member the sources hold.
//
// A workspace dependency is packed from whichever member directory holds it
// (`FJS-D1559`), so a root is read through `workspace-members.js` and a package
// two levels down (`packages/conduits/conduit-x`) is found as readily as one at
// `packages/x`. `dir` is only what gets reported: `<root>/packages` for a root.
//
// Order matters and is not the obvious one. Walking up finds the workspace an
// app is standing IN, which is the only answer that is current — `bun install`
// resolves `workspace:*` to a COPY under node_modules/.bun/, so reading the
// install back would pack whatever the tree looked like at the last install.
// A `link:` app is usually outside any workspace, which is what the last
// candidate is for: `bun link` left a real symlink, and its target is the
// source, whose workspace root is the first ancestor holding `workspaces`.
//
// Every candidate is checked against the linked names rather than accepted for
// existing — a directory called `packages` is not evidence that it holds these.
// `$FJS_PACKAGES_DIR` stays a one-directory override: it lists that directory's
// children and nothing deeper.

export function resolvePackageSource(appRoot, names) {
  const expandHome = (p) => p.replace(/^~/, process.env.HOME || '')
  const candidates = []

  for (const root of workspaceRootsAbove(resolve(appRoot))) candidates.push(() => sourceOfRoot(root, names))

  if (process.env.FJS_PACKAGES_DIR) {
    const dir = resolve(expandHome(process.env.FJS_PACKAGES_DIR))
    candidates.push(() => sourceOfDir(dir))
  }
  if (process.env.WORKSPACE_DIR) {
    const root = resolve(expandHome(process.env.WORKSPACE_DIR))
    candidates.push(() => sourceOfRoot(root, names) ?? sourceOfDir(join(root, 'packages')))
  }

  for (const name of names) {
    const linked = join(appRoot, 'node_modules', name)
    if (!existsSync(join(linked, 'package.json'))) continue
    // The member's own directory: a scoped name is two segments under
    // node_modules, so the symlink is at the leaf and the realpath is the source.
    let real
    try { real = realpathSync(linked) } catch { continue }
    const [root] = workspaceRootsAbove(dirname(real))
    candidates.push(() => (root && sourceOfRoot(root, names)) ?? sourceOfDir(dirname(real)))
  }

  for (const candidate of candidates) {
    const source = candidate()
    if (source?.packages.some(p => names.includes(p.name))) return source
  }
  return null
}

/** Every ancestor of `dir` (itself included) whose package.json has `workspaces`, nearest first. */
function workspaceRootsAbove(dir) {
  const out = []
  for (; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) out.push(dir)
      } catch { /* an unreadable manifest is not a workspace root */ }
    }
    if (dirname(dir) === dir) break
  }
  return out
}

// The releasable members, plus any member a linked name points at that lives
// outside `packages/` -- a dependency is packed from wherever it sits.
function sourceOfRoot(root, names) {
  const found = new Map()
  const add   = (m) => { if (m.manifest.name && !found.has(m.dir)) found.set(m.dir, { name: m.manifest.name, dir: m.dir, private: !!m.manifest.private }) }
  for (const m of releasableMembers(root)) add(m)
  for (const name of names) { const m = memberByName(root, name); if (m) add(m) }
  return found.size ? { dir: join(root, 'packages'), packages: [...found.values()] } : null
}

function sourceOfDir(dir) {
  return existsSync(dir) ? { dir, packages: namesIn(dir) } : null
}

// ─── namesIn ──────────────────────────────────────────────────────────────────
// Every named package in a directory of packages, `private` ones flagged: a
// private package is packed only when the app links it by name.

function namesIn(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const manifestPath = join(dir, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (!manifest.name) continue
    out.push({ name: manifest.name, dir: join(dir, entry), private: !!manifest.private })
  }
  return out
}

const scopeOf  = (name) => (name.startsWith('@') ? name.slice(0, name.indexOf('/')) : null)
const escapeRe = (s)    => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `@scope/x` → `scope-x`: the tarball's name, and the path segment a hosted
 *  copy is fetched by. */
export const tarballStem = (name) => name.replace('@', '').replace('/', '-')

// ─── packPackage ──────────────────────────────────────────────────────────────
// One pack for every destination — the build context here, npm and the release
// asset in `ws:publish`. Two packs of one package agree only while the tree
// holds still, so a copy that must be byte-equal to another is the same file.
//
// bun, not npm: npm ships a `workspace:*` spec verbatim and no registry resolves
// it; bun's packer rewrites it to the sibling's version.
//
// The tarball name is READ off the directory rather than predicted from the
// version: a package whose version moved mid-run still resolves. The digit is
// load-bearing — `frontierjs-css-` is a prefix of `frontierjs-css-kit-1.0.0`,
// so a plain prefix test hands one package another's tarball in readdir order.
export function packPackage({ name, dir, destination }) {
  mkdirSync(destination, { recursive: true })
  const r = spawnSync('bun', ['pm', 'pack', '--destination', destination], {
    cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe',
  })
  if (r.status !== 0)
    throw new Error(`bun pm pack failed for ${name}\n${[r.stdout, r.stderr].filter(Boolean).join('\n')}`)
  const match = new RegExp(`^${escapeRe(tarballStem(name))}-\\d.*\\.tgz$`)
  const file  = readdirSync(destination).filter(f => match.test(f))
    .sort((a, b) => statSync(join(destination, b)).mtimeMs - statSync(join(destination, a)).mtimeMs)[0]
  if (!file) throw new Error(`packed ${name} but no tarball landed in ${destination}`)
  return { file, path: join(destination, file) }
}

// ─── withCheckout / packAtCommit ──────────────────────────────────────────────
// Work from a checkout of one commit, never the working tree: another session's
// edit landing mid-release would otherwise grade or ship bytes the tag does not
// hold.
//
//   withCheckout({ repo, sha, scratch }, tree => result)   (fn is synchronous)
//
// Installed before `fn` runs because a `prepack` build (css) and a CI run both
// need real dependencies. Removed before returning, whatever happened -- a
// leftover worktree holds its sha checked out and `git worktree add` at that
// path refuses the next run.
export function withCheckout({ repo, sha, scratch }, fn) {
  const tree = join(scratch, `tree-${sha.slice(0, 12)}`)
  const git  = (...args) => run('git', args, repo)
  git('worktree', 'add', '--detach', tree, sha)
  try {
    const frozen = ['bun.lock', 'bun.lockb'].some(f => existsSync(join(tree, f)))
    run('bun', frozen ? ['install', '--frozen-lockfile'] : ['install'], tree)
    return fn(tree)
  } finally {
    git('worktree', 'remove', '--force', tree)
  }
}

// A CI run in a checkout writes its record there, and the checkout is removed:
// without this the failure's assertion went with it, and the `detail:` line the
// run printed named .cache/ci-last.txt, which in the working tree is some
// earlier run (FJS-3934). `ci-runs/` is copied as it is; the summary lands as
// `ci-last-release.txt`, beside the working tree's `ci-last.txt` rather than
// over it. Returns the summary's path, or null when the run wrote none.
export function keepRunRecord(tree, cwd) {
  const runs = join(tree, '.cache', 'ci-runs')
  if (existsSync(runs)) {
    const to = join(cwd, '.cache', 'ci-runs')
    mkdirSync(to, { recursive: true })
    for (const f of readdirSync(runs)) copyFileSync(join(runs, f), join(to, f))
  }
  const last = join(tree, '.cache', 'ci-last.txt')
  if (!existsSync(last)) return null
  const kept = join(cwd, '.cache', 'ci-last-release.txt')
  mkdirSync(dirname(kept), { recursive: true })
  copyFileSync(last, kept)
  return kept
}

//   { repo, sha, entries: [{ name, dir }], destination, scratch }
//     → [{ name, dir, file, path }]
export function packAtCommit({ repo, sha, entries, destination, scratch }) {
  return withCheckout({ repo, sha, scratch }, tree =>
    entries.map(e => ({ ...e, ...packPackage({ name: e.name, dir: join(tree, relative(repo, realpathSync(e.dir))), destination }) })))
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' })
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}\n${[r.stdout, r.stderr].filter(Boolean).join('\n')}`)
  return r.stdout.trim()
}

// ─── vendorWorkspacePackages ──────────────────────────────────────────────────
// Pack, rewrite, and leave both under <app>/deploy/generated/.
//
//   { appRoot, include?, packagesDir?, transform?, log? }
//     → { vendored, packed, packagesDir, manifestPath, lockfile }
//
// `include` names packages to vendor whatever their current spec says, for a
// caller that has decided the tree wins — CI's scaffold phase installs an app
// against the working tree on purpose, and the manifest it starts from names
// published versions.
//
// `packagesDir` names where the sources are, for a caller that already knows —
// again CI, whose app sits in a temp directory under no workspace and has not
// been installed yet, so neither the walk up nor the symlinks can answer.
//
// `transform` gets the rewritten manifest before it is written, for an app that
// needs to prune what the image runs. Throws on anything it cannot complete —
// a build context that is quietly half-vendored installs from npm for the half
// it missed, and an image running two trees at once does not have to fail.

export function vendorWorkspacePackages({ appRoot, include = [], packagesDir: given,
                                          transform, log = () => {} } = {}) {
  const root         = resolve(appRoot)
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`no package.json at ${root}`)

  const manifest  = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const names     = [...new Set([...linkedDeps(manifest), ...include])]
  const generated = join(root, GENERATED_DIR)
  const vendor    = join(root, VENDOR_DIR)

  rmSync(generated, { recursive: true, force: true })
  mkdirSync(vendor, { recursive: true })

  const out = { vendored: [], packed: [], packagesDir: null, manifestPath: join(root, MANIFEST_FILE), lockfile: null }

  if (names.length === 0) {
    // The lockfile travels only on this path. A rewritten manifest has no lock
    // that matches it, and `bun install --frozen-lockfile` refuses rather than
    // resolving — so the Dockerfile freezes when a lock is present and does not
    // when it is not, and the tarball specs are the stronger pin anyway.
    for (const lock of ['bun.lock', 'bun.lockb']) {
      if (!existsSync(join(root, lock))) continue
      copyFileSync(join(root, lock), join(generated, lock))
      out.lockfile = lock
      break
    }
    writeManifest(out.manifestPath, transform ? transform(manifest) : manifest)
    log(`  · nothing linked — manifest copied${out.lockfile ? ` with ${out.lockfile}` : ''}`)
    return out
  }

  const source = given ? sourceOfDir(resolve(given)) ?? { dir: resolve(given), packages: [] } : resolvePackageSource(root, names)
  if (!source)
    throw new Error(
      `cannot find the sources for ${names.join(', ')} — ` +
      'set $FJS_PACKAGES_DIR, or scaffold with --source npm')
  const packagesDir = source.dir
  out.packagesDir = packagesDir

  // Every publishable package sharing a scope with a linked one, not only the
  // linked ones: `overrides` reaches the packages' own dependencies on each
  // other, and an override for a package that was not packed resolves from npm
  // and quietly mixes a published sierra into a local mesa. Packing the rest
  // costs a second and proves each still packs at all.
  const scopes  = new Set(names.map(scopeOf).filter(Boolean))
  const targets = source.packages.filter(p => names.includes(p.name) || (!p.private && scopes.has(scopeOf(p.name))))
  const unfound = names.filter(n => !targets.some(t => t.name === n))
  if (unfound.length)
    throw new Error(`no package named ${unfound.join(', ')} in ${packagesDir} — the image would install it from nowhere`)

  const packed = {}
  for (const { name, dir } of targets) {
    const { file } = packPackage({ name, dir, destination: vendor })
    out.packed.push(name)
    packed[name] = `file:./${VENDOR_DIR}/${file}`
  }

  for (const field of ['dependencies', 'devDependencies']) {
    if (!manifest[field]) continue
    for (const dep of Object.keys(manifest[field]))
      if (packed[dep]) { manifest[field][dep] = packed[dep]; out.vendored.push(dep) }
  }
  manifest.overrides = { ...manifest.overrides, ...packed }

  writeManifest(out.manifestPath, transform ? transform(manifest) : manifest)
  log(`  · packed ${out.packed.length} package(s), ${out.vendored.length} ${out.vendored.length === 1 ? 'dependency' : 'dependencies'} now point at the tree`)
  return out
}

// NOT named package.json. Anything under a workspace's packages/* holding one is
// read as a member nobody installs or tests, and CI says so by name — for a file
// that exists only to be COPYed into an image. The Dockerfile gives it the name
// it needs, at the path it needs it.
function writeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
}

// ─── vendorApp ────────────────────────────────────────────────────────────────
// Write the build context the Dockerfile installs from: deploy/generated/, with
// a manifest and — for an app depending on the framework by `link:` or
// `workspace:` — a packed copy of every one of those packages beside it.
//
// Runs on every build whose Dockerfile installs from deploy/generated/ —
// `needsGenerated` is the test, and the Outpost's build asks the same one
// (`FJS-D1560`). With nothing linked it copies the manifest and the lockfile,
// which is what lets one Dockerfile serve both source modes; a condition on
// what package.json links would break the npm-source scaffold, whose template
// still copies the folder.
//
// It throws on anything it cannot finish. A half-vendored context installs the
// rest from npm and produces an image running two trees at once, which does not
// have to fail to be wrong.
//
// It does NOT prune devDependencies, and the reason is worth stating because
// pruning them looks free: the image builds nothing — it copies `api/` and
// `db/` and runs `db:migrate` then `start` — and **`bun install --production`
// resolves devDependencies anyway**, only skipping their install, so one dev
// tool that 404s fails an image that would never have run it. The `transform`
// hook can drop them; a manifest that no longer matches the lockfile beside it
// then fails `--frozen-lockfile` outright, which is the worse trade. An
// unresolvable devDependency is a publish problem and belongs upstream.
export const vendorApp = (root, log) => {
  const result = vendorWorkspacePackages({ appRoot: root, log: (m) => log.detail(m) })
  const n = result.vendored.length
  if (n) log.done(`Vendored ${n} workspace ${n === 1 ? 'dependency' : 'dependencies'} from ${result.packagesDir}`)
  return result
}
