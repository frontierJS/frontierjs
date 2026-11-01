// publish-hosts.js — where a published version is held, asked.
//
// A release ships to one or both of two hosts (`FJS-D1613`): the GitHub Release
// named for the package's tag, which is what the package host serves, and npm,
// the public registry. `ws:pub` asks both before a bump so a version in flight
// is finished rather than skipped, and the GUI's publish walk asks the same
// question beside the registry column. One reader per host, here, because two
// implementations of *does the host hold it* drift the first time one learns
// about a renamed asset and the other does not.
//
// Each reader answers true, false, or NULL where the host could not say. The
// null is kept apart from false on purpose: a guess of *held* bumps over a
// version nobody installed and a guess of *not* republishes one.

import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tarballStem } from './vendor.js'

export const DESTINATIONS = ['npm', 'tarballs']

// Unset on the command line means the release host alone (`FJS-D1613`). The
// GUI leaves the default unsaid in argv because it trusts this to be `ws:pub`'s
// default too, so it is spelled once.
export const DEFAULT_TO = ['tarballs']

// `<name>@<version>`. A monorepo shares one tag namespace, so a tag has to name
// the package: nine members sitting at 0.1.0 all want `v0.1.1` otherwise, and
// only the first one gets it.
export const releaseTag = (name, version) => `${name}@${version}`

// The path mirrors the release path, so the host is one redirect rule and no
// code (`FJS-D1620`, core/package-host-rule.json).
export const packageHostUrl = (name, version) =>
  `https://packages.frontierjs.com/${releaseTag(name, version)}/${tarballStem(name)}-${version}.tgz`

const run = (cmd, args, cwd) => new Promise(done =>
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => done({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })))

/**
 * The readers, bound to the repo `gh` runs in. `gh` finds the GitHub repo from
 * the cwd's remote, so a cwd outside the checkout asks about nothing.
 */
export function hosts(repo) {
  return {
    npm: async (name, version) => {
      const { err, stdout, stderr } = await run('npm', ['view', `${name}@${version}`, 'version'])
      return err ? (/\bE404\b/.test(stderr) ? false : null) : Boolean(stdout.trim())
    },
    // The asset by its packed name, not the release alone: a release whose
    // upload failed exists with nothing in it.
    tarballs: async (name, version) => {
      const { err, stdout, stderr } = await run('gh', ['release', 'view', releaseTag(name, version), '--json', 'assets', '--jq', '.assets[].name'], repo)
      if (err) return /release not found/i.test(stderr) ? false : null
      return stdout.split('\n').includes(`${tarballStem(name)}-${version}.tgz`)
    },
  }
}

/**
 * Does the remote hold this tag: true, false, or NULL where it could not
 * answer. A tag in the local clone proves nothing about what is public, and the
 * two read as one only until a push is refused.
 */
export async function remoteHasTag(repo, tag) {
  const { err, stdout } = await run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], repo)
  return err ? null : stdout.trim().length > 0
}

// ─── a fresh app, from each host the run shipped to ──────────────────────────
// The release gate cannot grade a scaffold installed from npm or the package
// host: 01 raises the scaffold pins to versions no host holds until the run
// publishes them (`FJS-D1726`). So the published framework is graded after the
// publish, by installing into an app that has none of this tree's links.

// The `--source` a scaffold installs from, per destination.
export const FRESH_APP_SOURCE = { tarballs: 'url', npm: 'npm' }

/**
 * The installs a run owes: one per destination it actually shipped to, and only
 * when a shipped package is one a scaffold pins. A release of `fli` alone
 * changes nothing a fresh app installs, and installing anyway would grade
 * versions this run did not touch.
 *
 * `uploaded` and `published` are `<name>@<version>` lists (the release host and
 * npm); `pinned` is the set of package names a scaffold pins.
 */
export function freshAppChecks({ uploaded = [], published = [], pinned }) {
  const names   = (list) => list.map(entry => entry.slice(0, entry.lastIndexOf('@')))
  const touches = (list) => names(list).some(name => pinned.has(name))
  const shipped = { tarballs: uploaded, npm: published }
  return DESTINATIONS
    .filter(host => touches(shipped[host]))
    .map(host => ({ host, source: FRESH_APP_SOURCE[host] }))
}

/**
 * Shipped packages the fresh app installed at some other version. A release
 * without `@frontierjs/cli` leaves the scaffold's pins where they were, so the
 * app installs the previous versions and its green says nothing about what
 * this run shipped.
 *
 * `shipped` is a `<name>@<version>` list; `installed` is `{ name: version }`.
 */
export function pinsBehind(shipped = [], installed = {}) {
  return shipped
    .map(entry => ({ name: entry.slice(0, entry.lastIndexOf('@')), shipped: entry.slice(entry.lastIndexOf('@') + 1) }))
    .filter(({ name, shipped }) => name in installed && installed[name] !== shipped)
    .map(p => ({ ...p, installed: installed[p.name] }))
}

// `--no-install`: the install is run by installFreshApp so its exit status is
// read, where `fli new` turns a failed install into a warning and exits 0.
export const freshAppArgs = (name, from) =>
  ['new', name, '--yes', '--no-auth', '--no-git', '--no-deploy', '--no-install', '--source', from]

const tail = (text, lines = 12) => text.trim().split('\n').slice(-lines).join('\n')

/**
 * Scaffold an app from `from` (`url` or `npm`) into a throwaway directory and
 * `bun install` it with a cache of its own: bun keys a tarball by name and
 * version, so a warm cache would answer for a host that no longer holds the
 * file. Every `@frontierjs` dependency the manifest names has to land as a real
 * directory. Returns `{ ok, step, detail }`; the directory is removed either way.
 *
 * `fli` is the path of the cli's `bin/fli.js`.
 */
export function installFreshApp({ from, fli, timeoutMs = 300_000, base = tmpdir() }) {
  const work = mkdtempSync(join(base, 'fjs-fresh-'))
  const app  = join(work, 'freshapp')
  const run  = (args, cwd) => spawnSync('bun', args, { cwd, encoding: 'utf8', timeout: timeoutMs })
  const fail = (step, r) => ({ ok: false, step, detail: tail(`${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}`) })

  try {
    const made = run([fli, ...freshAppArgs('freshapp', from)], work)
    if (made.status !== 0 || !existsSync(app)) return fail('fli new', made)

    const installed = run(['install', '--cache-dir', join(work, '.bun-cache')], app)
    if (installed.status !== 0) return fail('bun install', installed)

    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
    const wanted   = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(name => name.startsWith('@frontierjs/'))
    if (!wanted.length) return { ok: false, step: 'fli new', detail: 'the scaffold declared no @frontierjs dependency' }

    const absent = wanted.filter(name => !existsSync(join(app, 'node_modules', name, 'package.json')))
    if (absent.length) return { ok: false, step: 'bun install', detail: `installed without ${absent.join(', ')}` }
    const versions = Object.fromEntries(wanted.map(name =>
      [name, JSON.parse(readFileSync(join(app, 'node_modules', name, 'package.json'), 'utf8')).version]))
    return { ok: true, step: 'bun install', detail: `${wanted.length} @frontierjs package(s)`, versions }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
