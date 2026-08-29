---
title: 04-build-api
description: Build Docker image on the server
skip: "!context.config.doApi"
---

```js
if (context.config.abort) return

const { imageTag, deployConf } = context.config
const { host, path: serverPath } = context.config.api

// Where the image is BUILT. Defaults to the api target, so an app that declares
// no `deploy.builder` behaves exactly as it did; declaring one builds there once
// and ships the bytes, which is the whole of *build once, promote a digest*
// (`IDEAS/deploy-plane.md` §2.3f). The record's own warning is why it is a
// declared machine rather than *this laptop*: building locally by default trades
// server drift for developer-machine drift, which is worse.
const builder     = context.config.builder ?? context.config.api
const dockerfile  = deployConf.api?.dockerfile ?? 'deploy/Dockerfile'
const machine     = machineFor(context, builder.host, builder.path)
const target      = machineFor(context, host, serverPath)
const buildPath   = builder.path

// ─── Vendor, here rather than on the server ───────────────────────────────────
// The Dockerfile installs from deploy/generated/, which is generated and
// git-ignored — so step 02's `git pull` cannot produce it and the build would
// fail on the COPY. It has to be written HERE for a second reason: an app
// depending on the framework by `link:`/`workspace:` is packed out of a
// workspace that exists on this machine and nowhere on the server (FJS-241).
log.info('Vendoring dependencies into the build context...')
vendorApp(context.paths.root, log)

log.info(`Uploading build context → ${builder.host}:${buildPath}/${GENERATED_DIR}`)
machine.sync(`${context.paths.root}/${GENERATED_DIR}`, `${buildPath}/${GENERATED_DIR}`)

log.info(`Building image ${imageTag} on ${machine.describe()}...`)
machine.run(`docker build -t ${imageTag} -f ${dockerfile} .`, { cwd: buildPath })

// ─── Which bytes did that produce? ───────────────────────────────────────────
// `${appId}:${shortSha}` is a NAME, and two servers at the same commit hold two
// images with the same name and different bytes — stage and production
// reporting one version while running different code, with nothing comparing
// them (`IDEAS/deploy-plane.md` §2.3f). So the image is asked what it is, and
// the answer is carried through the rest of the pipeline.
//
// The `{{json .}}` template reaches docker with its braces and quotes intact:
// `machine.capture` pipes the script to the target's shell, so no shell here
// ever parses it.
const { imageIdentity, describeIdentity, addressOf } =
  await import(new URL('file://' + global.fliRoot + '/core/image.js'))

let identity = null
try {
  const raw = machine.capture(`docker image inspect ${imageTag} --format '{{json .}}'`)
  identity = imageIdentity(JSON.parse(raw))
} catch {
  // A build that cannot be inspected is not a build that failed — the deploy
  // continues by tag, and says so, because a missing digest is a weaker claim
  // rather than a broken pipeline.
  identity = null
}

context.config.imageIdentity = identity
context.config.imageAddress  = addressOf(identity, imageTag).address

// The journal's record of WHICH BYTES this deploy built. It is BOTH now: a term
// of the Release id, because `04c-journal` opens the transition after this step
// runs, and a step output, because a revert needs a startable image and the id
// carries a hash of the digest rather than the digest itself.
//
// JSON, not a sentence: `fli deploy:revert` reads this back to find the image to
// start, and parsing prose is how a revert ends up running the wrong bytes. The
// reader falls back to text for a row an older fli wrote.
// ─── Ship the bytes, where the builder is not the target ─────────────────────
// `docker save | docker load`, which preserves the image ID — so the digest the
// Release names is the digest that starts. A no-op when the two are one daemon,
// which is every app that has declared no builder.
//
// The image is addressed by ID rather than tag: a tag on the builder is a name
// the target has never heard, and after a load the ID is what both ends agree on.
const shipped = machine.shipTo(target, context.config.imageAddress ?? imageTag)
if (shipped) log.success(`Image shipped → ${target.describe()}`)

noteForJournal(context, '04-build-api', {
  image: context.config.imageAddress ?? imageTag,
  tag:   imageTag,
  scope: identity?.scope ?? null,
  built: shipped ? machine.describe() : null,
})

log.success(`Image built → ${imageTag}`)
log.info(`  bytes: ${describeIdentity(identity)}`)
if (!identity) log.warn('  no digest — this deploy cannot say which bytes it ran')
```
