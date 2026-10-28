---
title: deploy:repl
description: The app:repl prompt inside the running API container on the server — the app booted as somebody, no fli on the box
examples:
  - fli deploy:repl --as dev@knight.works
  - fli deploy:repl -e 'db.workspace.count()' --as dev@knight.works
  - fli deploy:repl --production --as ops@shop.test --tenant flagship
flags:
  eval:
    char: e
    type: string
    description: Evaluate one line, print the answer as JSON on stdout, exit 1 if it throws — no prompt, no tty
    defaultValue: ''
  as:
    char: a
    type: string
    description: Stand as this person — an email, username, name or id in the @@auth model, or Model:value
    defaultValue: ''
  tenant:
    char: t
    type: string
    description: Whose database, under tenancy { strategy database }
    defaultValue: ''
  force:
    type: boolean
    description: Let sys write — the container runs under NODE_ENV=production
    defaultValue: false
  app:
    type: string
    description: The app module, as a path inside the container — without it, the one the committed app.snapshot.md names
    defaultValue: ''
  export:
    type: string
    description: Which export of the module is the app, when it has more than one
    defaultValue: ''
  production:
    type: boolean
    description: Target production server
    defaultValue: false
  stage:
    type: boolean
    description: Target staging server
    defaultValue: false
---

<script>
const { callArgv } = await import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))

// The serving API container and the machine it is on, or null once the
// refusal has printed why. A refusal exits 1; the repl's own status does not.
const servingContainer = async ($, flag, log) => {
  const refuse = (reason, ...ways) => {
    log.error(reason)
    for (const way of ways) log.info(way)
    $.config.abort = true
    return null
  }

  const head = await deployTargetFor($, flag, log)
  if (!head) return null

  const { deployConf, appId, resolved: { path, host } } = head
  const container = apiContainer(appId, deployConf)
  const machine   = machineFor($, host, path, deployConf.transport)

  if (!machine.reach()) return refuse(`Cannot reach ${host}`)
  try {
    machine.run(`docker inspect ${container} > /dev/null 2>&1`)
  } catch {
    return refuse(`Container '${container}' is not running on ${host}`,
      `Check status with: fli deploy:status${flag.production ? ' --production' : flag.stage ? ' --stage' : ''}`)
  }
  return { machine, container }
}
</script>

```js
const plan = callArgv($.paths.root, {
  app:         flag.app,
  exportName:  flag.export,
  as:          flag.as,
  tenant:      flag.tenant,
  code:        flag.eval,
  force:       flag.force,
  inContainer: true,
})
if (plan.error) {
  log.error(plan.error)
  $.config.abort = true
  return
}

const serving = await servingContainer($, flag, log)
if (!serving) return
const { machine, container } = serving

// Every word quoted for the box's shell, and the whole quoted again by
// `machine.tty` for ssh's: an `-e` line is full of `$`, quotes and parens.
const words = plan.argv.map(shQuote).join(' ')

// No pty under -e: docker refuses `-it` with no terminal on stdin, which is
// what a script has, and a pty would merge the standing into the answer.
// `-e USER` with no value copies the box's ssh login into the container, where
// the account is `root` for everyone — the trail files a `sys` write under it
// (`FJS-D1534`).
const run = flag.eval
  ? machine.tty(`docker exec -e USER ${container} ${words}`, { pty: false, stdio: ['ignore', 'inherit', 'inherit'], allowFailure: true })
  : machine.tty(`docker exec -e USER -it ${container} ${words}`, { allowFailure: true })

process.exitCode = run?.status ?? 0
```

## What it is

`fli app:repl` in the serving container: `docker exec` over ssh, the way
`deploy:run` reaches it, running the image's own `junction call` with
`app:repl`'s argv. The box needs nothing it does not already hold — the image
carries junction and litestone.

The names in scope, `.help`, `-e`'s contract and `--force` are `app:repl`'s,
and so is the gate: the booted app's own, with no `--gate` (`FJS-D1536`).
The container runs under `NODE_ENV=production`, so the prompt line opens with
`PRODUCTION` and a `sys` write needs `--force` (`FJS-D1533`).

**A second boot** (`FJS-D1535`): the prompt boots its own copy of the app in
the container, so a write it makes is not announced to the screens the
serving process holds open, and no plugin's `work()` runs.

**A `sys` write is filed under your ssh login on the box**, as `actorType:
'repl'` — never the `--as` standing, which is whose view you read
(`FJS-D1534`).

**`--app` is a path in the container**, from its WORKDIR — the app root, where
the image copies `api/` and `db/`. Without it the module comes off the local
`app.snapshot.md` header, the same answer `app:call` reads; only the path
travels, so a module moved and not yet deployed says `no module` there.
