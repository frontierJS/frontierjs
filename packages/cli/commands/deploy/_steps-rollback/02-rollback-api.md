---
title: 02-rollback-api
description: Restore _replaced container or select a previous image
skip: "!$.config.doApi"
---

```js
const { host, serverPath, appId, deployConf } = $.config
const apiPort  = deployConf.api?.port ?? 3000
const { dbDir: dbPath, envFile, secretsDir } = apiFiles(deployConf, serverPath)
const container = apiContainer(appId, deployConf)
const replaced  = `${container}_replaced`
const machine   = machineFor($, host, serverPath)

// An absent container and an unreachable box both fail the probes below.
const lost = () => {
  if (machine.reach()) return false
  log.error(`Lost ${host} — API was not rolled back`)
  $.config.abort = true
  return true
}

// ─── Check for _replaced container first ─────────────────────────────────────
// Present if the last deploy failed health check or was manually interrupted.
let hasReplaced = false
try {
  machine.run(`docker inspect ${replaced} > /dev/null 2>&1`)
  hasReplaced = true
} catch {
  if (lost()) return
  hasReplaced = false
}

if (hasReplaced) {
  // Fast path — restore _replaced directly
  log.info(`Found ${replaced} — restoring...`)

  machine.run(`docker stop  ${container} || true
docker rm    ${container} || true
docker rename ${replaced} ${container}
docker start  ${container}`, { dry: flag.dry })
  log.done(`API restored → ${container} (from _replaced)`)

} else {
  // No _replaced — list available images for this app and let user choose
  log.info('No _replaced container found — checking available images...')

  // The ID is in the format because a tag is a NAME: two tags can point at one
  // image — a rebuild that produced identical layers, or a retag — so a
  // rollback chosen by tag can restore the very bytes it was trying to leave,
  // and nothing would say so (`IDEAS/deploy-plane.md` §2.3f).
  const { parseImageList, movesBytes, short } =
    await import(new URL('file://' + global.fliRoot + '/core/image.js'))

  let imageOutput = ''
  try {
    imageOutput = machine.capture(
      `docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' | grep '^${appId}:' | head -10`)
  } catch {
    if (lost()) return
    imageOutput = ''
  }

  const images = parseImageList(imageOutput)

  if (images.length < 2) {
    log.warn(`${host} holds ${images.length} image${images.length === 1 ? '' : 's'} of ${appId}, and a rollback needs two`)
    log.info('The previous image may have been removed by Cleanup or a prune; a build made here has no registry to come back from')
    log.info('Deploy the release you want again to rebuild it. The current container has not been touched')
    return
  }

  // images[0] is current, images[1] is previous
  const current  = images[0]
  const previous = images[1]
  // Addressed by ID, so what starts is the artefact that was chosen and not
  // whatever answers to that name by the time the command runs.
  const previousImage = previous.id

  log.info(`Current image:  ${current.tag}   ${short(current.id)}`)
  log.info(`Previous image: ${previous.tag}   ${short(previous.id)}`)

  if (!movesBytes(current, previous)) {
    log.warn('Both tags name the SAME image — this rollback would change nothing')
    log.info('The previous deploy produced identical bytes, or the tag was moved')
    return
  }

  const confirm = await tty.line(`Roll back API to ${previous.tag} (${short(previous.id)})? (y/N) `)
  if (confirm.trim().toLowerCase() !== 'y') {
    log.info('API rollback cancelled')
    return
  }

  // The function 06-swap and the revert call. A hand-written `docker run` here
  // had drifted to no secrets mount, so a rolled-back API came up without the
  // ENCRYPTION_KEY it reads from a file (`FJS-3476`).
  const { configurationSet } = await import(new URL('file://' + global.fliRoot + '/core/release.js'))
  const { healthy, restored } = await swapContainer($, {
    host,
    appId,
    container,
    image: previousImage,
    apiPort,
    dbPath,
    envFile,
    secretsDir,
    serverPath,
    deployConf,
    corsOrigins: derivedOrigins($, deployConf),
    configuration: configurationSet(deployConf, $.config.target).values,
    healthPath: deployConf.api?.health ?? '/health',
    log,
    undoing: true,
  })
  if (!healthy) {
    log.error(`Rollback to ${previous.tag} did not come up`)
    if (restored) log.warn('  The release that was serving is running again.')
    else          log.error('  Nothing is serving — restore by hand.')
    $.config.abort = true
    throw new Error(`Rollback failed health check for ${short(previousImage)}`)
  }
  log.done(`API rolled back → ${previousImage}`)
}
```
