#!/usr/bin/env bun
// backfill-releases.mjs — give every version already on npm its GitHub Release.
//
// Under the release-host default (`FJS-D1613`) `ws:pub` asks the GitHub Release
// at each package's tag before it bumps, and a version npm holds with no release
// reads as in flight — `in-flight-moved`, since the tree has moved past every
// one of those tags. This is plan `IDEAS/package-host.md` § 1.5: one owner-run
// pass that fetches npm's OWN tarball (`npm pack <name>@<version>`, the bytes
// people installed, never a fresh pack of a tree that has moved) and uploads it
// as the release asset at the tag `ws:pub` would have created.
//
// Owner-run because `gh release create` is refused to a session. Prints what it
// would do by default; `--run` does it. `--only <substring>` narrows by name.
//
//   bun scripts/backfill-releases.mjs
//   bun scripts/backfill-releases.mjs --run
//   bun scripts/backfill-releases.mjs --run --only litestone

import { execFileSync }   from 'node:child_process'
import { mkdtempSync }    from 'node:fs'
import { tmpdir }         from 'node:os'
import { join, resolve }  from 'node:path'
import { fileURLToPath }  from 'node:url'

import { workspaceMembers }                     from '../packages/cli/core/publish-view.js'
import { hosts, releaseTag }                    from '../packages/cli/core/publish-hosts.js'
import { tarballStem }                          from '../packages/cli/core/vendor.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const run  = argv.includes('--run')
const only = argv[argv.indexOf('--only') + 1]
const sh   = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })).trim()

const held = hosts(root)
const dir  = mkdtempSync(join(tmpdir(), 'fjs-backfill-'))
const did  = { released: [], skipped: [] }

for (const m of workspaceMembers(root)) {
  if (m.private || (only && !m.name.includes(only))) continue
  const tag = releaseTag(m.name, m.version)

  // No tag at the current version is an ordinary first release, not a backfill.
  let sha
  try { sha = sh('git', ['rev-list', '-n1', tag]) } catch { did.skipped.push(`${tag}: no tag`); continue }

  const [onNpm, onRelease] = await Promise.all([held.npm(m.name, m.version), held.tarballs(m.name, m.version)])
  if (onRelease === true)  { did.skipped.push(`${tag}: release already holds the asset`); continue }
  if (onRelease === null)  { did.skipped.push(`${tag}: GitHub could not say — check gh auth status`); continue }
  if (onNpm !== true)      { did.skipped.push(`${tag}: ${onNpm === false ? 'not on npm, nothing to backfill from' : 'npm could not say'}`); continue }

  const tgz = join(dir, `${tarballStem(m.name)}-${m.version}.tgz`)
  const pack    = ['npm', ['pack', `${m.name}@${m.version}`, '--pack-destination', dir]]
  const release = ['gh', ['release', 'create', tag, tgz, '--latest=false', '--target', sha, '--title', tag, '--notes', `chore(release): ${tag} — backfilled from npm's tarball`]]

  console.log(`${run ? '→' : 'would'} ${tag}  (${sha.slice(0, 8)})`)
  console.log(`    ${pack[0]} ${pack[1].join(' ')}`)
  console.log(`    ${release[0]} ${release[1].join(' ')}`)
  if (!run) continue

  // npm names the file as `tarballStem` spells it; the asset name is what the
  // package host's redirect resolves to, so the name is asserted, not assumed.
  const packed = sh(...pack).split('\n').pop()
  if (join(dir, packed) !== tgz) { console.error(`    ✗ npm packed ${packed}, expected ${tgz}`); process.exit(1) }
  try { sh(...release, { stdio: ['ignore', 'pipe', 'inherit'] }); did.released.push(tag) }
  catch (err) { console.error(`    ✗ ${tag}: gh release create failed (${err.status})`); process.exit(1) }
}

console.log('')
for (const s of did.skipped) console.log(`  · ${s}`)
console.log(`\n${run ? 'released' : 'would release'} ${run ? did.released.length : '(dry)'} · skipped ${did.skipped.length}${run ? '' : '\n\nrun it: bun scripts/backfill-releases.mjs --run'}`)
