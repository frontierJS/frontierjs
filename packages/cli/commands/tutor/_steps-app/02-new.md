---
title: 02-new
description: Scaffold the app
---

## The app

`fli new` is the front door. It writes the tree, installs auth, generates two
keys, pushes the schema, scaffolds an example slice and runs `bun install` — the
things you would otherwise do one command at a time.

What lands is five directories and one file that matters more than the rest:

- **db/schema.lite** — the seed. Models, and the access rules on them.
- **api/** — services, autoloaded at boot
- **web/** — the file tree IS the route table
- **frontier.config.js** — where this app deploys to
- **.env** — generated, with real keys in it

Everything else in FrontierJS is derived from the first of those.

```js
narrate(context)

context.config.__step = 2

const dir = appDir(context)

// `--restart` begins the lesson again, and the app on disk is part of what the
// last run left: `fli new` refuses a directory that exists, so without this the
// restart fails at step 2 every time. Inside the workspace by construction —
// `appDir` joins the workspace to the app name and this removes nothing else.
if (existsSync(dir)) {
  if (!context.flag.restart) {
    log.error([
      `${dir} already exists, and this step is what creates it`,
      `    ${'likely'.padEnd(10)}an earlier run got this far and its journal has been lost or cleared`,
      `    ${'continue'.padEnd(10)}fli ${context.config.lesson} --workspace ${context.config.ws.dir} --restart`,
    ].join('\n'))
    context.config.abort = true
    return
  }
  log.info(`--restart: removing the app the last run made at ${dir}`)
  rmSync(dir, { recursive: true, force: true })
}

log.info(`scaffolding ${context.config.app} from --source ${context.config.source}`)

context.exec({
  command: `${context.fli} new ${context.config.app} --yes --auth --no-git --no-deploy --source ${context.config.source}`,
  cwd:     context.config.ws.dir,
})

for (const [path, what] of [
  ['db/schema.lite',  'the seed'],
  ['api/index.ts',    'the API entry'],
  ['package.json',    'the manifest'],
]) {
  if (!await must(context, probe.fileExists({ path: join(dir, path), name: `${path} — ${what}` }), {
    likely:    'fli new did not finish — its output is above',
    reproduce: `cd ${context.config.ws.dir} && fli new ${context.config.app} --yes --auth`,
  })) return
}

remember(context, '02-new', { appDir: dir })
```
