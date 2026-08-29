---
title: deploy:journal
description: Read the deploy journal on the target — what has been deployed, and how each attempt went
alias: journal
examples:
  - fli deploy:journal
  - fli deploy:journal --production
  - fli deploy:journal --steps
  - fli deploy:journal --transition deploy:shop:production:none:a1b2c3:1:1
flags:
  production:
    type: boolean
    description: Read the production target's journal
    defaultValue: false
  stage:
    type: boolean
    description: Read the stage target's journal
    defaultValue: false
  steps:
    type: boolean
    description: Show the steps of the most recent transition
    defaultValue: false
  transition:
    char: t
    type: string
    description: Show the steps of one transition by id
    defaultValue: ''
  limit:
    char: n
    type: number
    description: How many transitions to list
    defaultValue: 10
  json:
    char: j
    type: boolean
    description: Emit the rows as JSON
    defaultValue: false
---

```js
const target         = resolveTarget(flag, context.git)
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block in frontier.config.js — there is no target to read a journal from')
  return
}

const side = resolveSide(deployConf, target, 'api') ?? resolveSide(deployConf, target, 'web')
if (!side) {
  log.error(`Cannot resolve a server and path for target: ${target}`)
  return
}

const app = deployConf.app_id ?? deployConf.appId ?? deployConf.path?.split('/').pop()
const j   = await connectJournal(context, { host: side.host, serverPath: side.path, deployConf })

// No `open()` here, and that is deliberate: opening REFUSES a journal belonging
// to another app or another host, which is right for a writer and wrong for a
// reader. Being shown whose history a path holds is the answer to the question
// somebody typed this to ask.
const rows = await j.history({ app, environment: target, limit: flag.limit })

if (flag.json) {
  const one = flag.transition || rows[0]?.id
  console.log(JSON.stringify({
    transitions: rows,
    steps: one ? await j.stepsOf(one) : [],
  }, null, 2))
  return
}

console.log()
console.log(`  Journal — ${app} · ${target}`)
console.log(`  ${side.host}:${side.path}/.fli/deploy.db`)
console.log()

if (!rows.length) {
  console.log('  Nothing recorded. No deploy has run against this target since the journal existed.')
  console.log()
  return
}

const pad = (s, n) => String(s ?? '').padEnd(n)
const MARK = { succeeded: '✓', failed: '✗', running: '…', planned: '·' }

// Newest first, and the FIRST succeeded row is what is serving — which is not
// the first row: a failed deploy leaves the previous release up.
const serving = rows.find(r => r.status === 'succeeded')

for (const r of rows) {
  const here = r.id === serving?.id ? '  ← serving' : ''
  console.log(`  ${MARK[r.status] ?? '?'} ${pad(r.kind, 7)}${pad(r.releaseId, 14)}${pad(r.status, 10)}${pad(r.startedAt ?? '', 26)}${r.actor ?? ''}${here}`)
  if (r.crossesPivot) console.log(`    ${pad('', 7)}crossed the pivot — nothing before this can be restored`)
}

const which = flag.transition || (flag.steps ? rows[0]?.id : null)
if (which) {
  const steps = await j.stepsOf(which)
  console.log()
  console.log(`  Steps of ${which}`)
  console.log()
  for (const s of steps) {
    console.log(`    ${pad(s.ordinal, 4)}${pad(s.name, 24)}${pad(s.status, 11)}${s.durationMs != null ? `${s.durationMs}ms` : ''}`)
    if (s.output) console.log(`        ${pad('', 24)}${s.output.split('\n')[0].slice(0, 100)}`)
  }
}

console.log()
```


## What it reads

`{deploy.path}/.fli/deploy.db` on the target, through the same
`core/journal-runner.mjs` the deploy writes with — one connector, so a reader
cannot be pointed at a different file than the writer.

The journal is on the target because it records what happened on that host. Two
operators deploying from two laptops must not hold two answers to *what is
serving*, and a Release id is content-addressed, so N hosts' journals agree
without a central one.

## What serving means here

The `← serving` mark is on the most recent **succeeded** transition, which is not
the most recent transition. A failed deploy leaves the previous release up, and a
journal that called the attempted one *serving* would be lying in exactly the
situation somebody is reading it to get out of.

## The pivot

```
✗ deploy  a1b2c3d4e5f6  failed    2026-08-26T09:14:02.881Z  jordan
  deploy  crossed the pivot — nothing before this can be restored
```

That line is read off the transition, not recomputed. What matters afterwards is
the answer the operator was shown and agreed to, not the answer a classifier
gives once the schema has moved on.
