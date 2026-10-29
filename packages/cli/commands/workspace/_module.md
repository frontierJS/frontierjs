---
namespace: workspace
description: Monorepo commands — list, inspect, version and publish every package
---

<script>

// ─── bumpVersion ──────────────────────────────────────────────────────────────
// One definition of what `patch|minor|major|prerelease` means, shared by
// ws:version and ws:pub. `npm version` is not used for this: it also writes a
// commit and a `vX.Y.Z` tag into whatever repo it is run in, which in a
// single-repo monorepo means one commit per member and a tag name that says
// nothing about which package it belongs to.
const bumpVersion = (version, bump) => {
  const [major, minor, patch] = version.replace(/[^0-9.]/g, '').split('.').map(Number)
  if (bump === 'major')      return `${major + 1}.0.0`
  if (bump === 'minor')      return `${major}.${minor + 1}.0`
  if (bump === 'prerelease') return `${major}.${minor}.${patch}-pre.${Date.now()}`
  return `${major}.${minor}.${patch + 1}`  // patch
}

// ─── releaseTag ───────────────────────────────────────────────────────────────
// `<name>@<version>`, spelled once in `core/publish-hosts.js` because the GUI's
// publish walk asks the release host by the same tag.
const { releaseTag } = await import(new URL('file://' + global.fliRoot + '/core/publish-hosts.js'))

// ─── releaseSubject ───────────────────────────────────────────────────────────
// Commit subject for a release. Names the packages while that stays readable,
// falls back to a count — a sixteen-package subject line is unreadable in every
// git UI there is, and the tags carry the detail anyway.
const releaseSubject = (released) => released.length <= 3
  ? `chore(release): ${released.map(r => releaseTag(r.name, r.newVersion)).join(', ')}`
  : `chore(release): ${released.length} packages`

// ─── diffLines ────────────────────────────────────────────────────────────────
// The first 20 differing lines between a committed snapshot and a fresh one,
// the form every ws: snapshot command prints on a stale --check.
const diffLines = (was, now) => {
  const a = was.split('\n'), b = now.split('\n')
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    out.push(`    - ${a[i] ?? '(absent)'}`)
    out.push(`    + ${b[i] ?? '(absent)'}`)
    if (out.length >= 20) { out.push('    …'); break }
  }
  return out.join('\n')
}

</script>

## Overview

This list is plain rather than fenced: module prose has every fenced block
stripped out of it, because in a command file a fence IS the body. A ``` block
here renders as an empty heading.

- **ws:list** — every package and its version
- **ws:npm** — local version vs what is on the registry
- **ws:exports** — the committed published-surface snapshot: what each package
  ships, and whether every entry point it declares is inside that (`--check` in CI)
- **ws:status** — working-tree state per package
- **ws:changed** — what has moved since each package's own tag
- **ws:graph** — who depends on whom
- **ws:run** `<script>` — an npm script across all members
- **ws:exec** `"<cmd>"` — a shell command in every package dir
- **ws:version** `<bump>` — bump versions, commit and tag, no publish
- **ws:pub** `<bump>` — bump, publish to npm, push; `-i` walks it one package
  at a time, which is the pacing npm's browser 2FA needs
- **ws:clean** — delete build artifacts

## Where the workspace is

Resolved by walking up from the current directory for a `packages/` dir whose
parent declares `workspaces` (or is a git repo root). `$WORKSPACE_DIR` is
consulted only when that finds nothing, so a stale global default cannot
redirect a command run from inside a different monorepo.

## One repo or many

Both shapes are supported and the release commands detect which they are in.

**One repo** (this shape): versions are written, staged and committed once, with
one `<name>@<version>` tag per released package and a single push.

**Many repos** (`ws:add` moved separate checkouts into `packages/`): each package
gets its own commit, tag and push in its own repo.
