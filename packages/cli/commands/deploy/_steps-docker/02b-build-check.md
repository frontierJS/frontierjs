---
title: 02b-build-check
description: Refuse a build that would bake configuration into the image
skip: "!$.config.doApi || $.config.deployConf.api?.buildCheck === false"
---

```js
// The BUILDER's context, not the target's — that is the tree `docker build`
// reads, and under a declared `deploy.builder` they are different machines.
const { host, path: deployRoot } = $.config.builder ?? $.config.api
const serverPath = `${deployRoot}/src`
const dockerfile = $.config.deployConf.api?.dockerfile ?? 'deploy/Dockerfile'

const { gather, inspectBuild, refuses, summarize, renderFinding, CONTEXT_FIND } =
  await import(new URL('file://' + global.fliRoot + '/core/build-check.js'))

// ─── Why this reads the SERVER and not the working tree ──────────────────────
// The context is what 02-ship extracted plus deploy/generated/, which is not
// the working tree: an uncommitted file is absent there and present here. The
// deploy root's `.env.production` sits above the context and cannot be in it;
// a `.env.*` committed into the app can.
const machine = machineFor($, host, serverPath)
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
  // A warning's paragraph is behind --verbose; a refusal's is what to do next.
  const [say, explain] = f.level === 'error' ? [log.error, log.info] : [log.warn, log.detail]
  say(`  ${head}`)
  explain(`    ${detail}`)
  explain(`    ${fix}`)
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
log.info('  A Release promotes one artefact between environments and changes only its configuration.')
log.info('  Set deploy.api.buildCheck = false in frontier.config.js to deploy anyway.')
$.config.abort = true
```
