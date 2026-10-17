---
title: 03-build-web
description: Build web on the server and create versioned release
optional: true
skip: "!$.config.doWeb"
---

```js
if ($.config.abort) return

const { commit, deployConf } = $.config
const { host, path: serverPath } = $.config.web
const src          = `${serverPath}/src`
const keepReleases = deployConf.web?.keep_releases ?? 3
const releaseDir   = `${serverPath}/releases/${commit}`
const machine      = machineFor($, host, serverPath)

// ─── Install dependencies ─────────────────────────────────────────────────────
// 02-ship extracted a fresh tree with no node_modules, and vite resolves imports
// against whatever is on disk. The manifest is the GENERATED one, as in the
// image: a `workspace:` or `link:` spec resolves to nothing on this machine,
// and the tarballs beside the manifest are what it names instead.
//
// --frozen-lockfile whenever a lock travelled with it. A resolve on the server
// would produce a tree the lockfile never described; a manifest vendor.js
// rewrote has no lock that matches, so it installs as the image does.
log.info('Installing dependencies on server...')
machine.run(`cp ${GENERATED_DIR}/app-manifest.json package.json &&
  (cp ${GENERATED_DIR}/bun.lock* ./ 2>/dev/null || true) &&
  if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install; fi`, { cwd: src })

// ─── Build on server ──────────────────────────────────────────────────────────
// `build:web` where the app names one, because `build` may be more than the
// web: basecamp's also runs a schema drift check that reads litestone by
// workspace path, which exists on no server.
const { readFileSync } = await import('fs')
const scripts = JSON.parse(readFileSync(`${$.paths.root}/package.json`, 'utf8')).scripts ?? {}
const [buildCmd, buildCwd] = scripts['build:web'] ? ['bun run build:web', src] : ['bun run build', `${src}/web`]

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

// ─── Where the API is ─────────────────────────────────────────────────────────
//
// Under `deploy.api.domain` the page and the API are two origins, and the only
// way the bundle learns the second is at build time: `VITE_API_URL`, which the
// web surface's sierra.config.js reads for junction.url. Taken from the same
// declaration the route is written from, so the two cannot name different
// hosts. Graded as a hostname before it reaches the target's shell.
const { edgeNames, apiOrigin, EdgeError } =
  await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
let origin
try { origin = apiOrigin(edgeNames(deployConf)) }
catch (e) {
  if (!(e instanceof EdgeError)) throw e
  log.error(e.message)
  $.config.abort = true
  return
}

log.info(origin ? `Building web on server, calling the API at ${origin}...` : 'Building web on server...')
machine.run(`VITE_FJS_BUILD=${commit}${origin ? ` VITE_API_URL=${origin}` : ''} ${buildCmd}`, { cwd: buildCwd })

// A build that never inlined VITE_API_URL ships a bundle calling its own
// origin, where nothing proxies /api/ any more. Asked of the output, because
// the web build is the app's and may not be Sierra's.
if (origin) {
  const carried = machine.capture(`grep -rl --include='*.js' -F '${origin}' ${src}/web/dist 2>/dev/null | head -1 || true`)
  if (!String(carried ?? '').trim()) {
    log.error(`The web build does not contain ${origin}. Sierra inlines VITE_API_URL into the page when its config sets junction.url;`)
    log.error(`a build that is not Sierra's has to read import.meta.env.VITE_API_URL itself.`)
    $.config.abort = true
    return
  }
}

// ─── Copy the built page into versioned release dir ───────────────────────────
// Sierra writes `dist/client/`, a plain Vite build `dist/` — probed, because a
// release one level too deep has no index.html at its root and Caddy answers
// every request 404 while the deploy reports success.
//
// Built beside and moved in: a redeploy of the same commit finds the directory
// there, and `cp -a` into an existing one nests the copy inside it.
log.info(`Creating release → releases/${commit}`)
machine.run(`out=${src}/web/dist
[ -f "$out/index.html" ] || out="$out/client"
if [ ! -f "$out/index.html" ]; then echo "the web build wrote no index.html under ${src}/web/dist" >&2; exit 1; fi
rm -rf "${releaseDir}.next" && cp -a "$out" "${releaseDir}.next" && rm -rf "${releaseDir}" && mv "${releaseDir}.next" "${releaseDir}"`)

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

$.config.releaseDir = releaseDir
log.success(`Web release ready → releases/${commit} (keeping ${keepReleases})`)
```
