---
title: 02b-build-check
description: Refuse a build that would bake configuration into the image
skip: "!context.config.doApi || context.config.deployConf.api?.buildCheck === false"
---

```js
if (context.config.abort) return

// The BUILDER's context, not the target's — that is the tree `docker build`
// reads, and under a declared `deploy.builder` they are different machines.
const { host, path: serverPath } = context.config.builder ?? context.config.api
const dockerfile = context.config.deployConf.api?.dockerfile ?? 'deploy/Dockerfile'

const { gather, inspectBuild, refuses, summarize, renderFinding, CONTEXT_FIND } =
  await import(new URL('file://' + global.fliRoot + '/core/build-check.js'))

// ─── Why this reads the SERVER and not the working tree ──────────────────────
// The build context is the server's checkout, and the file most likely to be
// baked is the one thing that is NOT in git: `.env.production` sits at
// {serverPath}, which is the context root, so a check run against the local tree
// cannot see the case it exists for. It runs after 02-pull for the same reason —
// before the pull, the server's Dockerfile is the previous release's.
const machine = machineFor(context, host, serverPath)
const ask = (script) => {
  try { return machine.capture(script, { cwd: serverPath }) }
  catch { return null }
}

// An empty file and an absent one are different facts — an absent .dockerignore
// and an empty one happen to mean the same thing, an absent Dockerfile does not
// — so absence is reported by a sentinel rather than by an empty string.
const readRemote = (rel) => {
  const out = ask(`if [ -f ${rel} ]; then cat ${rel}; else echo __FLI_ABSENT__; fi`)
  if (out === null) return null
  return out.trim() === '__FLI_ABSENT__' ? null : out
}

const input = gather({
  dockerfile,
  read: readRemote,
  list: () => (ask(CONTEXT_FIND) ?? '').split('\n'),
})

if (input.missing) {
  log.warn(`Build check: ${dockerfile} not found on ${host} — skipping`)
  return
}

const findings = inspectBuild(input)

if (!findings.length) {
  log.success(`Build check: ${summarize(findings)}`)
  return
}

for (const f of findings) {
  const [head, detail, fix] = renderFinding(f)
  const say = f.level === 'error' ? log.error : log.warn
  say(`  ${head}`)
  log.info(`    ${detail}`)
  log.info(`    ${fix}`)
}

if (!refuses(findings)) {
  log.warn(`Build check: ${summarize(findings)}`)
  return
}

// A refusal here rather than after the build, because the failure is not that
// the image is broken — it will build, start and answer health. It is that the
// digest would describe one deployment rather than one artefact, which nothing
// downstream can detect and which `fli release:mint` would then record as fact.
log.error(`Build check: ${summarize(findings)} — refusing to build`)
log.info('')
log.info('  A Release promotes one artefact between environments and changes only its bindings.')
log.info('  Set deploy.api.buildCheck = false in frontier.config.js to deploy anyway.')
context.config.abort = true
```
