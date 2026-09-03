---
title: 02-rollback-api
description: Restore _replaced container or select a previous image
skip: "!context.config.doApi"
---

```js
if (context.config.abort) return

const { host, serverPath, appId, deployConf } = context.config
const apiPort  = deployConf.api?.port ?? 3000
const dbPath   = deployConf.db?.path  ?? `${serverPath}/db`
const envFile  = deployConf.api?.env  ?? `${serverPath}/.env.production`
const container = `${appId}-api`
const replaced  = `${container}_replaced`
const machine   = machineFor(context, host, serverPath)

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

  const confirm = await question(`Roll back API to ${previous.tag} (${short(previous.id)})? (y/N) `)
  if (confirm.trim().toLowerCase() !== 'y') {
    log.info('API rollback cancelled')
    return
  }

  const runCmd = [
    `docker stop ${container} || true`,
    `docker rm   ${container} || true`,
    'docker run -d',
    `--name ${container}`,
    '--restart unless-stopped',
    `-p 127.0.0.1:${apiPort}:3000`,
    `--volume ${dbPath}:/db`,
    `--env-file ${envFile}`,
    // Same contract as 06-swap: the mapping targets 3000, so the app is told to
    // bind 3000 whatever the env file says.
    `--env PORT=3000`,
    `--env NODE_ENV=production`,
    // The same cap 06-swap applies. A rollback runs on the machine a failed
    // deploy just left, which is the least good moment to start an uncapped one.
    ...dockerLogArgs(deployConf),
    previousImage,
  ].join(' ')

  machine.run(runCmd, { dry: flag.dry })
  log.success(`API rolled back → ${previousImage}`)
}
```
