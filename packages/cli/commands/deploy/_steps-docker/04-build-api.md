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

// ─── Which bytes did that produce? ───────────────────────────────────────────
// `${appId}:${shortSha}` is a NAME, and two servers at the same commit hold two
// images with the same name and different bytes — stage and production
// reporting one version while running different code, with nothing comparing
// them (`IDEAS/deploy-plane.md` §2.3f). So the image is asked what it is, and
// the answer is carried through the rest of the pipeline.
//
// `stdio: 'pipe'`, not `capture: true` — the latter is not an execSync option
// and leaves the output on the terminal while returning null (`FJS-537`).
const { imageIdentity, describeIdentity, addressOf } =
  await import(new URL('file://' + global.fliRoot + '/core/image.js'))

let identity = null
try {
  const raw = context.exec({
    command: `ssh ${host} "docker image inspect ${imageTag} --format '{{json .}}'"`,
    stdio:   'pipe',
  })
  identity = imageIdentity(JSON.parse(String(raw ?? '').trim()))
} catch {
  // A build that cannot be inspected is not a build that failed — the deploy
  // continues by tag, and says so, because a missing digest is a weaker claim
  // rather than a broken pipeline.
  identity = null
}

context.config.imageIdentity = identity
context.config.imageAddress  = addressOf(identity, imageTag).address

log.success(`Image built → ${imageTag}`)
log.info(`  bytes: ${describeIdentity(identity)}`)
if (!identity) log.warn('  no digest — this deploy cannot say which bytes it ran')
```
