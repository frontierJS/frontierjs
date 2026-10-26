---
title: 02-rollback-api
description: Restore _replaced container or select a previous image
skip: "!$.config.doApi"
---

```js
if ($.config.abort) return

const { host, serverPath, appId, deployConf } = $.config
const apiPort  = deployConf.api?.port ?? 3000
const { dbDir: dbPath, envFile, secretsDir } = apiFiles(deployConf, serverPath)
const container = apiContainer(appId, deployConf)
const replaced  = `${container}_replaced`
const machine   = machineFor($, host, serverPath)

// ─── Check for _replaced container first ─────────────────────────────────────
// Present if the last deploy failed health check or was manually interrupted.
let hasReplaced = false
try {
  machine.run(`docker inspect ${replaced} > /dev/null 2>&1`)
  hasReplaced = true
} catch {
  hasReplaced = false
}

if (hasReplaced) {
  // Fast path — restore _replaced directly
  log.info(`Found ${replaced} — restoring...`)

  machine.run(`docker stop  ${container} || true
docker rm    ${container} || true
docker rename ${replaced} ${container}
docker start  ${container}`, { dry: flag.dry })
  log.success(`API restored → ${container} (from _replaced)`)

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
    imageOutput = ''
  }

  const images = parseImageList(imageOutput)

  if (images.length < 2) {
    log.warn('No previous image found to roll back to')
    log.info('The current container has not been replaced — nothing to roll back')
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
  swapContainer($, {
    host,
    appId,
    container,
    image: previousImage,
    apiPort,
    dbPath,
    envFile,
    secretsDir,
    deployConf,
    corsOrigins: derivedOrigins($, deployConf),
    configuration: configurationSet(deployConf, $.config.target).values,
    log,
  })

  const { healthy, restored } = await healthOrRestore($, {
    host, container, replaced, apiPort, healthPath: deployConf.api?.health ?? '/health', log,
  })
  if (!healthy) {
    log.error(`Rollback to ${previous.tag} did not come up`)
    if (restored) log.warn('  The release that was serving is running again.')
    else          log.error('  Nothing is serving — restore by hand.')
    $.config.abort = true
    throw new Error(`Rollback failed health check for ${short(previousImage)}`)
  }

  // A `_replaced` left behind is restored by the next rollback's fast path, and
  // the next deploy's rename onto that name fails.
  machine.run(`if docker inspect ${replaced} > /dev/null 2>&1; then
  docker stop ${replaced} || true
  docker rm   ${replaced}
fi`)
  log.success(`API rolled back → ${previousImage}`)
}
```
