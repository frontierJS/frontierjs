// pin-bump.js — a hosted pin, raised to the newest release that serves it.
//
// An app scaffolded with `--source url` pins each framework package to one
// tarball URL (`FJS-D1620`). There is no registry behind it, so no range and no
// `latest` to resolve against: a newer release is found by reading the repo's
// tags and only reaches the app when the URL in `package.json` is rewritten.
// `fli install --force` offers that and `--bump` takes it without asking.

import { execFile } from 'node:child_process'
import { compareVersions } from './doctor.js'
import { tarballStem } from './vendor.js'

export const RELEASE_REPO = 'https://github.com/frontierJS/frontierjs'

// Either spelling of one asset: the package host redirects to the release path,
// and a hand-edited manifest may point at GitHub directly. The prefix is kept
// on rewrite, so a pin stays on the host its author chose.
const HOSTED = /(https:\/\/(?:packages\.frontierjs\.com|github\.com\/frontierJS\/frontierjs\/releases\/download)\/)(@frontierjs\/[a-z0-9-]+)(?:@|%40)(\d+\.\d+\.\d+)\/[^"\s]+\.tgz/g

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides']

/** `{ name: version }` for every hosted pin in the manifest, overrides included. */
export function hostedPins(manifest) {
  const pins = {}
  for (const section of SECTIONS) {
    for (const spec of Object.values(manifest?.[section] ?? {})) {
      for (const [, , name, version] of String(spec).matchAll(HOSTED)) pins[name] = version
    }
  }
  return pins
}

/** `{ name: [versions, newest first] }` from `git ls-remote --tags` output. */
export function releasedVersions(lsRemote) {
  const out = {}
  for (const line of String(lsRemote).split('\n')) {
    const m = line.match(/refs\/tags\/(@frontierjs\/[a-z0-9-]+)@(\d+\.\d+\.\d+)$/)
    if (m) (out[m[1]] ??= []).push(m[2])
  }
  for (const list of Object.values(out)) list.sort((a, b) => compareVersions(b, a))
  return out
}

/**
 * The bumps owed: for each pin, the newest released version above it whose
 * tarball is served. A tag alone proves nothing — a release whose upload failed
 * exists with no asset, and a pin raised to it fails every install — so each
 * candidate is asked, newest first, until one answers.
 */
export async function bumpsOwed(pins, released, { served = assetServed } = {}) {
  const bumps = []
  for (const [name, from] of Object.entries(pins)) {
    for (const to of (released[name] ?? []).filter(v => compareVersions(v, from) > 0)) {
      if (await served(name, to)) { bumps.push({ name, from, to }); break }
    }
  }
  return bumps
}

/** The manifest's text with each bumped pin's URL rewritten in place. */
export function rewritePins(text, bumps) {
  const to = Object.fromEntries(bumps.map(b => [b.name, b.to]))
  return text.replace(HOSTED, (url, prefix, name) =>
    name in to ? `${prefix}${name}@${to[name]}/${tarballStem(name)}-${to[name]}.tgz` : url)
}

/** The release tags, as `git ls-remote` prints them. Throws where git cannot reach the repo. */
export const listReleaseTags = (repo = RELEASE_REPO) => new Promise((done, fail) =>
  execFile('git', ['ls-remote', '--tags', '--refs', repo, 'refs/tags/@frontierjs/*'], { timeout: 30_000 },
    (err, stdout) => err ? fail(err) : done(String(stdout))))

/** Does the release serve this version's tarball. */
export async function assetServed(name, version) {
  const url = `${RELEASE_REPO}/releases/download/${name}@${version}/${tarballStem(name)}-${version}.tgz`
  try { return (await fetch(url, { method: 'HEAD', redirect: 'follow' })).ok }
  catch { return false }
}
