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

import { execFile } from 'node:child_process'
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
