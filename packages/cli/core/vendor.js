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
import { existsSync, readFileSync, writeFileSync, copyFileSync,
         readdirSync, mkdirSync, rmSync, realpathSync }           from 'node:fs'
import { join, resolve, dirname }                                 from 'node:path'

// Where the generated build context lands, relative to the app root. The
// Dockerfile `fli make:deploy` writes names the same path, and the `file:` specs
// are written relative to the manifest — which sits at the image's /app — so the
// tarballs must be copied to the path they are named at.
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

// ─── resolvePackagesDir ───────────────────────────────────────────────────────
// Where the sources those specs point at actually live.
//
// Order matters and is not the obvious one. Walking up finds the workspace an
// app is standing IN, which is the only answer that is current — `bun install`
// resolves `workspace:*` to a COPY under node_modules/.bun/, so reading the
// install back would pack whatever the tree looked like at the last install.
// A `link:` app is usually outside any workspace, which is what the last
// candidate is for: `bun link` left a real symlink, and its target is the
// source.
//
// Every candidate is checked against the linked names rather than accepted for
// existing — a directory called `packages` is not evidence that it holds these.

export function resolvePackagesDir(appRoot, names) {
  const expandHome = (p) => p.replace(/^~/, process.env.HOME || '')
  const candidates = []

  for (let dir = resolve(appRoot); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces)
          candidates.push(join(dir, 'packages'))
      } catch { /* an unreadable manifest is not a workspace root */ }
    }
    if (dirname(dir) === dir) break
  }

  if (process.env.FJS_PACKAGES_DIR) candidates.push(resolve(expandHome(process.env.FJS_PACKAGES_DIR)))
  if (process.env.WORKSPACE_DIR)    candidates.push(resolve(expandHome(process.env.WORKSPACE_DIR), 'packages'))

  for (const name of names) {
    const linked = join(appRoot, 'node_modules', name)
    if (!existsSync(join(linked, 'package.json'))) continue
    // The package's own directory; its parent is the packages dir. A scoped name
    // is two segments under node_modules, so the symlink is at the leaf and the
    // realpath is the source directory itself.
    try { candidates.push(dirname(realpathSync(linked))) } catch { /* not resolvable */ }
  }

  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    if (namesIn(dir).some(p => names.includes(p.name))) return dir
  }
  return null
}

// ─── namesIn ──────────────────────────────────────────────────────────────────
// Every publishable package in a directory of packages: a readable manifest, a
// name, and not `private`.

function namesIn(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const manifestPath = join(dir, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (manifest.private || !manifest.name) continue
    out.push({ name: manifest.name, dir: join(dir, entry) })
  }
  return out
}

const scopeOf  = (name) => (name.startsWith('@') ? name.slice(0, name.indexOf('/')) : null)
const escapeRe = (s)    => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

  const packagesDir = given ? resolve(given) : resolvePackagesDir(root, names)
  if (!packagesDir)
    throw new Error(
      `cannot find the sources for ${names.join(', ')} — ` +
      'set $FJS_PACKAGES_DIR, or scaffold with --source npm')
  out.packagesDir = packagesDir

  // Every publishable package sharing a scope with a linked one, not only the
  // linked ones: `overrides` reaches the packages' own dependencies on each
  // other, and an override for a package that was not packed resolves from npm
  // and quietly mixes a published sierra into a local mesa. Packing the rest
  // costs a second and proves each still packs at all.
  const scopes  = new Set(names.map(scopeOf).filter(Boolean))
  const targets = namesIn(packagesDir).filter(p => names.includes(p.name) || scopes.has(scopeOf(p.name)))

  for (const { name, dir } of targets) {
    const r = spawnSync('bun', ['pm', 'pack', '--destination', vendor], {
      cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe',
    })
    if (r.status !== 0)
      throw new Error(`bun pm pack failed for ${name}\n${[r.stdout, r.stderr].filter(Boolean).join('\n')}`)
    out.packed.push(name)
  }

  // The tarball name is READ off the directory rather than predicted from the
  // version: a package whose version moved mid-run still resolves. The digit is
  // load-bearing — `frontierjs-css-` is a prefix of `frontierjs-css-kit-1.0.0`,
  // so a plain prefix test hands one package another's tarball in readdir order.
  const files  = readdirSync(vendor)
  const packed = {}
  for (const { name } of targets) {
    const stem  = name.replace('@', '').replace('/', '-')   // @scope/x → scope-x
    const match = new RegExp(`^${escapeRe(stem)}-\\d.*\\.tgz$`)
    const file  = files.find(f => match.test(f))
    if (!file) throw new Error(`packed ${name} but no tarball landed in ${VENDOR_DIR}`)
    packed[name] = `file:./${VENDOR_DIR}/${file}`
  }

  for (const field of ['dependencies', 'devDependencies']) {
    if (!manifest[field]) continue
    for (const dep of Object.keys(manifest[field]))
      if (packed[dep]) { manifest[field][dep] = packed[dep]; out.vendored.push(dep) }
  }
  manifest.overrides = { ...manifest.overrides, ...packed }

  writeManifest(out.manifestPath, transform ? transform(manifest) : manifest)
  log(`  · packed ${out.packed.length} package(s), ${out.vendored.length} dependenc(ies) now point at the tree`)
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
