---
title: 03-build-web
description: Build web on the server and create versioned release
optional: true
skip: "!$.config.doWeb"
---

```js
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
// --frozen-lockfile whenever a lock travelled in GENERATED_DIR. A resolve on the
// server would produce a tree the lockfile never described; a manifest vendor.js
// rewrote has no lock that matches, so it installs as the image does. The
// shipped tree's own lock goes first: the image never copies it, and frozen
// against the rewritten manifest it refuses, so vite is never installed (FJS-3587).
installOnBox(machine, $, src, log)

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
// `webBuildEnv` asserts the commit is a sha, since it is interpolated into a
// command line.
const { webBuildEnv, envPrefix } = await import(new URL('file://' + global.fliRoot + '/core/release-build.js'))

// ─── Where the API is ─────────────────────────────────────────────────────────
//
// Under `deploy.api.domain` the page and the API are two origins, and the only
// way the bundle learns the second is at build time: `FRONTIER_PUBLIC_API_URL`, which the
// web surface's sierra.config.js reads for junction.url. Taken from the same
// declaration the route is written from, so the two cannot name different
// hosts. Graded as a hostname before it reaches the target's shell.
const { edgeNames, apiOrigin, widgetsOrigin, EdgeError } =
  await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
// The widget origin is baked too (FJS-D2034): the embed snippet a web page shows
// names it, and a hostname pasted into the app's .env drifts from the route.
let origin, widgets
try {
  const names = edgeNames(deployConf)
  origin  = apiOrigin(names)
  widgets = widgetsOrigin(names)
}
catch (e) {
  if (!(e instanceof EdgeError)) throw e
  log.error(e.message)
  $.config.abort = true
  return
}

log.info(origin ? `Building web on server, calling the API at ${origin}...` : 'Building web on server...')
machine.run(`${envPrefix(webBuildEnv({ commit, apiOrigin: origin, widgetsOrigin: widgets }))} ${buildCmd}`, { cwd: buildCwd })

// A build that never inlined FRONTIER_PUBLIC_API_URL ships a bundle calling its own
// origin, where nothing proxies /api/ any more. Asked of the output, because
// the web build is the app's and may not be Sierra's.
if (origin) {
  const carried = machine.capture(`grep -rl --include='*.js' -F '${origin}' ${src}/web/dist 2>/dev/null | head -1 || true`)
  if (!String(carried ?? '').trim()) {
    log.error(`The web build does not contain ${origin}. Sierra inlines FRONTIER_PUBLIC_API_URL into the page when its config sets junction.url;`)
    log.error(`a build that is not Sierra's has to put FRONTIER_PUBLIC_ in its envPrefix and read import.meta.env.FRONTIER_PUBLIC_API_URL itself.`)
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

// ─── Merge previous release assets, prune old releases ───────────────────────
// SPA clients cache their HTML and keep requesting old content-hashed assets after
// a deploy; `mergeAndPrune` carries the last keep_releases-1 releases' assets
// forward, and keeps that many releases on disk for rollback.
const assetDir = deployConf.web?.assets_dir ?? 'assets'
mergeAndPrune(machine, { releasesRoot: `${serverPath}/releases`, releaseDir, assetDir, keep: keepReleases })
log.info(`Merged the assets of the last ${keepReleases - 1} release(s) from ${assetDir}/ (stale client protection)`)

$.config.releaseDir = releaseDir
log.done(`Web release ready → releases/${commit} (keeping ${keepReleases})`)
```
