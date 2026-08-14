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
context.exec({
  command: `ssh ${host} "cd ${serverPath} && bun install --frozen-lockfile"`,
})

// ─── Build on server ──────────────────────────────────────────────────────────
// Code is already current from step 02 (git pull).
// Run bun build inside the web sub-directory.
log.info('Building web on server...')
context.exec({
  command: `ssh ${host} "cd ${serverPath}/web && bun run build"`,
})

// ─── Copy dist/ into versioned release dir ────────────────────────────────────
// cp -a preserves timestamps and handles symlinks correctly.
log.info(`Creating release → releases/${commit}`)
context.exec({
  command: `ssh ${host} "cp -a ${serverPath}/web/dist ${releaseDir}"`,
})

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
// Implementation: we write a small shell script to the server and run it.
// This avoids SSH quoting complexity — the script body can use any characters.
// cp -rn = recursive, no-overwrite.
const assetDir = deployConf.web?.assets_dir ?? 'assets'
const mergeScript = `#!/bin/sh
prev=$(ls -1dt ${serverPath}/releases/* 2>/dev/null | grep -v "${releaseDir}" | head -1)
if [ -n "$prev" ] && [ -d "$prev/${assetDir}" ]; then
  cp -rn "$prev/${assetDir}/." "${releaseDir}/${assetDir}/"  2>/dev/null || true
fi
`
const tmpScript = `/tmp/.fli-merge-assets-${commit}.sh`
const escapedScript = mergeScript.replace(/'/g, "'\\''")

context.exec({ command: `ssh ${host} "printf '%s' '${escapedScript}' > ${tmpScript} && chmod +x ${tmpScript} && ${tmpScript}; rm -f ${tmpScript}"` })
log.info(`Merged previous release assets from ${assetDir}/ (stale client protection)`)

// ─── Prune old releases ───────────────────────────────────────────────────────
// Keep the last N releases on disk for rollback and the asset merge window above.
const pruneCmd = `ls -1dt ${serverPath}/releases/* 2>/dev/null | tail -n +${keepReleases + 1} | xargs rm -rf --`
context.exec({ command: `ssh ${host} "${pruneCmd}"` })

context.config.releaseDir = releaseDir
log.success(`Web release ready → releases/${commit} (keeping ${keepReleases})`)
```
