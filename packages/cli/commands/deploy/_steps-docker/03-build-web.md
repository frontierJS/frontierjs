---
title: 03-build-web
description: Build web on the server and create versioned release
optional: true
skip: "!context.config.doWeb"
---

```js
if (context.config.abort) return

const { commit, deployConf } = context.config
const { host, path: serverPath } = context.config.web
const keepReleases = deployConf.web?.keep_releases ?? 3
const releaseDir   = `${serverPath}/releases/${commit}`
const machine      = machineFor(context, host, serverPath)

// ─── Install dependencies ─────────────────────────────────────────────────────
// Step 02 pulled new source but not new node_modules, and vite resolves imports
// against whatever is on disk — so a deploy that adds a dependency either builds
// against the previous tree or dies mid-build, with the deploy lock already held.
// The API side never had this problem: its Dockerfile installs inside the image.
//
// --frozen-lockfile is the point of the step, not a flag on it. A resolve on the
// server would produce a tree the lockfile never described and nothing downstream
// could tell you it had happened.
log.info('Installing dependencies on server...')
machine.run('bun install --frozen-lockfile', { cwd: serverPath })

// ─── Build on server ──────────────────────────────────────────────────────────
// Code is already current from step 02 (git pull).
// Run bun build inside the web sub-directory.
// ─── The build's own identity ─────────────────────────────────────────────────
//
// A deploy replaces the code under browsers that are already running, and until
// this nothing identified which build one of them was holding. `VITE_FJS_BUILD`
// is inlined by vite at build time and reaches the client, which compares it
// against what the server states on every response (`FJS-D160`).
//
// The env goes in the SCRIPT rather than in the exec options: the script is
// piped to the TARGET's shell, so an env option here would set the operator's.
// The value is a commit sha, and it is asserted to be one rather than trusted —
// it is interpolated into a command line, and Invariant 8's reasoning applies to
// a shell exactly as it does to SQL.
if (!/^[0-9a-fA-F]{7,64}$/.test(String(commit)))
  throw new Error(`refusing to build: the commit "${commit}" is not a sha`)

log.info('Building web on server...')
machine.run(`VITE_FJS_BUILD=${commit} bun run build`, { cwd: `${serverPath}/web` })

// ─── Copy dist/ into versioned release dir ────────────────────────────────────
// cp -a preserves timestamps and handles symlinks correctly.
log.info(`Creating release → releases/${commit}`)
machine.run(`cp -a ${serverPath}/web/dist ${releaseDir}`)

// ─── Merge previous release assets ───────────────────────────────────────────
// SPA clients cache their HTML and keep requesting old content-hashed assets
// (e.g. app-x9y8z7.js) after a deploy. Those files no longer exist in the new
// release → 404s until the client reloads.
//
// Fix: copy any asset files from the previous release that are NOT already
// present in the new one. Because Bun uses content-hash filenames, there are
// zero collisions — new files always win, old-but-still-referenced files survive.
//
// Safety window: clients running stale HTML are covered for keep_releases
// deploys. After that the old assets are pruned — the right tradeoff.
//
// cp -rn = recursive, no-overwrite. `$prev` and the quotes below are the
// target's — `machine.run` pipes the script to its shell, so nothing here needs
// escaping and a temp file on the server would buy nothing.
const assetDir = deployConf.web?.assets_dir ?? 'assets'

machine.run(`prev=$(ls -1dt ${serverPath}/releases/* 2>/dev/null | grep -v "${releaseDir}" | head -1)
if [ -n "$prev" ] && [ -d "$prev/${assetDir}" ]; then
  cp -rn "$prev/${assetDir}/." "${releaseDir}/${assetDir}/" 2>/dev/null || true
fi`)
log.info(`Merged previous release assets from ${assetDir}/ (stale client protection)`)

// ─── Prune old releases ───────────────────────────────────────────────────────
// Keep the last N releases on disk for rollback and the asset merge window above.
machine.run(`ls -1dt ${serverPath}/releases/* 2>/dev/null | tail -n +${keepReleases + 1} | xargs rm -rf --`)

context.config.releaseDir = releaseDir
log.success(`Web release ready → releases/${commit} (keeping ${keepReleases})`)
```
