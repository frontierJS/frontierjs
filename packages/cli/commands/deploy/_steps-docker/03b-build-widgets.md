---
title: 03b-build-widgets
description: Build widgets on the server and create a versioned release
optional: true
skip: "!$.config.doWidgets"
---

```js
const { commit, deployConf, host, serverPath } = $.config
const src          = `${serverPath}/src`
const widgetsPath  = widgetsPathOf(deployConf, serverPath)
const keepReleases = deployConf.widgets?.keep_releases ?? 3
const releaseDir   = `${widgetsPath}/releases/${commit}`
const building     = `${releaseDir}.next`
const machine      = machineFor($, host, serverPath)

const { widgetsBuildEnv, envPrefix } = await import(new URL('file://' + global.fliRoot + '/core/release-build.js'))
const { edgeNames, widgetsApiOrigin, EdgeError } = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))

// ─── Where the API is ─────────────────────────────────────────────────────────
// A widget runs on a stranger's page, so it has no origin of its own to call:
// the API's is baked, from the same declaration the routes are written from.
let origin
try { origin = widgetsApiOrigin(edgeNames(deployConf)) }
catch (e) {
  if (!(e instanceof EdgeError)) throw e
  log.error(e.message)
  $.config.abort = true
  return
}
if (!origin) {
  log.error('widgets/ bakes the API origin, and none is known: set deploy.web.domain or deploy.api.domain in frontier.config.js.')
  $.config.abort = true
  return
}

installOnBox(machine, $, src, log)

// ─── Build into a directory this step owns ────────────────────────────────────
// `sierra widgets --out-dir` (FJS-D2036), so nothing here asks Sierra where it
// wrote. A Sierra older than the flag builds into its own outDir and leaves this
// one empty, which is refused by name rather than released as an empty origin.
log.info(`Building widgets on server, calling the API at ${origin}...`)
machine.run(`rm -rf "${building}" && mkdir -p "${building}"`)
machine.run(`${envPrefix(widgetsBuildEnv({ commit, apiOrigin: origin }))} NODE_ENV=production bunx --bun sierra widgets --out-dir "${building}"`, { cwd: `${src}/widgets` })

if (!String(machine.capture(`ls "${building}" 2>/dev/null | grep '\\.js$' | head -1 || true`) ?? '').trim()) {
  log.error(`sierra widgets wrote no script to ${building} -- a Sierra older than --out-dir builds into its own outDir; move @frontierjs/sierra to a release that takes it.`)
  $.config.abort = true
  return
}

// A build that never inlined the API origin ships widgets calling nothing.
const carried = machine.capture(`grep -rl --include='*.js' -F '${origin}' "${building}" 2>/dev/null | head -1 || true`)
if (!String(carried ?? '').trim()) {
  log.error(`The widgets build does not contain ${origin}. Sierra inlines FRONTIER_PUBLIC_API_URL into a widget bundle; a build that is not Sierra's has to read it itself.`)
  $.config.abort = true
  return
}

// Moved in whole: a redeploy of the same commit finds the directory there, and a
// copy into an existing one would nest.
log.info(`Creating widgets release → releases/${commit}`)
machine.run(`rm -rf "${releaseDir}" && mv "${building}" "${releaseDir}"`)

mergeAndPrune(machine, { releasesRoot: `${widgetsPath}/releases`, releaseDir, keep: keepReleases })

$.config.widgetsReleaseDir = releaseDir
log.done(`Widgets release ready → releases/${commit} (keeping ${keepReleases})`)
```
