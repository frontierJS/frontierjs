---
title: 04-build-api
description: Build Docker image on the server
skip: "!context.config.doApi"
---

```js
if (context.config.abort) return

const { imageTag, deployConf } = context.config
const { host, path: serverPath } = context.config.api
const dockerfile = deployConf.api?.dockerfile ?? 'deploy/Dockerfile'

// ─── Vendor, here rather than on the server ───────────────────────────────────
// The Dockerfile installs from deploy/generated/, which is generated and
// git-ignored — so step 02's `git pull` cannot produce it and the build would
// fail on the COPY. It has to be written HERE for a second reason: an app
// depending on the framework by `link:`/`workspace:` is packed out of a
// workspace that exists on this machine and nowhere on the server (FJS-241).
log.info('Vendoring dependencies into the build context...')
vendorApp(context.paths.root, log)

// --delete, because a tarball left from a previous version is a spec nothing
// points at and megabytes in every layer that follows.
log.info(`Uploading build context → ${serverPath}/${GENERATED_DIR}`)
context.exec({
  command: `rsync -a --delete ${context.paths.root}/${GENERATED_DIR}/ ${host}:${serverPath}/${GENERATED_DIR}/`,
})

log.info(`Building image ${imageTag}...`)
context.exec({
  command: `ssh ${host} "cd ${serverPath} && docker build -t ${imageTag} -f ${dockerfile} ."`,
})

log.success(`Image built → ${imageTag}`)
```
