---
title: 06-swap
description: Put the API onto the new image, stop-first or (deploy.swap startFirst, an expand) beside the old one — puts the old one back on failure; migrations run in entrypoint
skip: "!$.config.doApi"
---

```js
const { imageTag, appId, apiPort, deployConf, healthPath } = $.config
const { host, path: serverPath } = $.config.api
const { configurationSet } = await import(new URL('file://' + global.fliRoot + '/core/release.js'))

// The DIGEST where step 04 could read one, and the tag only as a fallback.
// Running the tag means running whatever currently answers to that name, and the
// name is not unique across servers or across rebuilds — which is the whole of
// what 2.3f is about. `imageAddress` is the tag when nothing could be read, and
// step 04 has already said so out loud.
const { container, replaced, healthy, none, untouched, unbound, reason, swap, swapReason, pivot, port } = await swapContainer($, {
  host,
  appId,
  container: apiContainer(appId, deployConf),
  image:     $.config.imageAddress ?? imageTag,
  apiPort,
  dbPath:     apiFiles(deployConf, serverPath).dbDir,
  envFile:    apiFiles(deployConf, serverPath).envFile,
  secretsDir: apiFiles(deployConf, serverPath).secretsDir,
  serverPath,
  // The same value `03-build-web` stamped into the bundle, so one deploy is one
  // build on both sides of the wire — the server states it, the browser compares.
  build:   $.config.commit,
  deployConf,
  corsOrigins: derivedOrigins($, deployConf),
  configuration: configurationSet(deployConf, $.config.target).values,
  healthPath,
  log,
  // The verdict `04c-journal` recorded on the transition, so the swap runs on
  // the answer the journal holds. Absent when the journal is off, and then the
  // swap asks for itself.
  pivot: $.config.pivot ?? null,
})

$.config.container = container
$.config.replaced  = replaced
$.config.livePort  = port

// The swap that ran, as Basecamp's Deployment row records it. `pivot` is the
// transition's own verdict, repeated so this row reads alone.
noteForJournal($, '06-swap', { swap, swapReason, pivot })
echo(swapReason ? chalk`  {dim swap}  ${swap} {dim — ${swapReason}}` : chalk`  {dim swap}  ${swap}`)

if (!healthy) {
  $.config.abort = true
  const after = none ? 'removed, nothing was serving before it' : untouched ? 'the previous release kept serving' : 'rolled back'
  throw new Error(unbound.length
    ? `${imageTag} opened ${unbound.join(', ')} outside the volume — ${after}`
    : /did not start/.test(reason ?? '')
      ? `${imageTag} did not start — ${after}`
      : `Health check failed for ${imageTag} — ${after}`)
}
log.done(`Container started → ${container}`)
```
