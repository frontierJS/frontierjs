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

// ─── Check for _replaced container first ─────────────────────────────────────
// Present if the last deploy failed health check or was manually interrupted.
let hasReplaced = false
try {
  context.exec({
    command: `ssh ${host} "docker inspect ${replaced} > /dev/null 2>&1"`,
  })
  hasReplaced = true
} catch {
  hasReplaced = false
}

if (hasReplaced) {
  // Fast path — restore _replaced directly
  log.info(`Found ${replaced} — restoring...`)

  const restoreCmd = `
    docker stop  ${container}  || true;
    docker rm    ${container}  || true;
    docker rename ${replaced} ${container};
    docker start  ${container}
  `.trim().replace(/\n\s*/g, '; ')

  context.exec({ command: `ssh ${host} "${restoreCmd}"`, dry: flag.dry })
  log.success(`API restored → ${container} (from _replaced)`)

} else {
  // No _replaced — list available images for this app and let user choose
  log.info('No _replaced container found — checking available images...')

  let imageOutput = ''
  try {
    const result = context.exec({
      command: `ssh ${host} "docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | grep '^${appId}:' | head -10"`,
      stdio: 'pipe',
    })
    imageOutput = result?.toString('utf8').trim() ?? ''
  } catch {
    imageOutput = ''
  }

  const images = imageOutput.split('\n').filter(Boolean)

  if (images.length < 2) {
    log.warn('No previous image found to roll back to')
    log.info('The current container has not been replaced — nothing to roll back')
    return
  }

  // images[0] is current, images[1] is previous
  const previousImage = images[1].split(' ')[0]
  const currentImage  = images[0].split(' ')[0]

  log.info(`Current image:  ${currentImage}`)
  log.info(`Previous image: ${previousImage}`)

  const confirm = await question(`Roll back API to ${previousImage}? (y/N) `)
  if (confirm.trim().toLowerCase() !== 'y') {
    log.info('API rollback cancelled')
    return
  }

  const runCmd = [
    'docker stop',  container, '|| true;',
    'docker rm',    container, '|| true;',
    'docker run -d',
    `--name ${container}`,
    '--restart unless-stopped',
    `-p 127.0.0.1:${apiPort}:3000`,
    `--volume ${dbPath}:/db`,
    `--env-file ${envFile}`,
    `--env NODE_ENV=production`,
    previousImage,
  ].join(' ')

  context.exec({ command: `ssh ${host} "${runCmd}"`, dry: flag.dry })
  log.success(`API rolled back → ${previousImage}`)
}
```
