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
// `<name>@<version>`. A monorepo shares one tag namespace, so a tag has to name
// the package: nine members sitting at 0.1.0 all want `v0.1.1` otherwise, and
// only the first one gets it.
const releaseTag = (name, version) => `${name}@${version}`

// ─── releaseSubject ───────────────────────────────────────────────────────────
// Commit subject for a release. Names the packages while that stays readable,
// falls back to a count — a sixteen-package subject line is unreadable in every
// git UI there is, and the tags carry the detail anyway.
const releaseSubject = (released) => released.length <= 3
  ? `chore(release): ${released.map(r => releaseTag(r.name, r.newVersion)).join(', ')}`
  : `chore(release): ${released.length} packages`

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
- **ws:pub** `<bump>` — bump, publish to npm, push
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
