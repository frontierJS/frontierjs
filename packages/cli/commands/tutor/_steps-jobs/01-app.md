---
title: 01-app
description: An app with a queue in it, reused or built
---

## An app with a queue

This lesson needs `@frontierjs/caravan` in the app. If the workspace already
holds one that has it, it is reused; otherwise the app is built here with the
package included:

```console
fli new <app> --auth --with caravan
fli scaffold Note --fields "title:string body:text done:boolean"
fli db:push
```

`--with` names the extra `@frontierjs` packages an app starts with. It adds the
dependency and says so in the README — the wiring is the next step, and it is
two lines rather than a template, because where a queue's database lives and
which directory holds the jobs are decisions an app makes once.

```js
if (!await narrate(context)) return

context.config.__step = 1

const dir = appDir(context)

const pkgJson = join(dir, 'package.json')
const hasCaravan = (() => {
  try { return Boolean(JSON.parse(readFileSync(pkgJson, 'utf8')).dependencies?.['@frontierjs/caravan']) }
  catch { return false }
})()

// Reuse is by the FILE and by the DEPENDENCY. An app left by an earlier lesson
// has no queue in it, and adding one afterwards is a `bun link` dance under
// --source local that the scaffold already does correctly — so the app is
// rebuilt rather than patched, and the message says so rather than a directory
// quietly disappearing.
const built = existsSync(join(dir, 'db', 'schema.lite')) && hasCaravan

if (!built) {
  if (existsSync(dir)) {
    log.info(existsSync(join(dir, 'db', 'schema.lite'))
      ? `the app here has no queue in it — rebuilding ${dir} with @frontierjs/caravan`
      : `building an app with a queue — ${dir}`)
    rmSync(dir, { recursive: true, force: true })
  }

  context.exec({
    command: `${context.fli} new ${context.config.app} --yes --auth --with caravan --no-git --no-deploy --source ${context.config.source}`,
    cwd:     context.config.ws.dir,
  })
  context.exec({
    command: `${context.fli} scaffold Note --fields "title:string body:text done:boolean"`,
    cwd:     dir,
  })
  context.exec({ command: `${context.fli} db:push`, cwd: dir })
} else {
  log.info(`reusing the app at ${dir}`)
}

context.config.appDir = dir

if (!await must(context, probe.fileContains({
  path:   pkgJson,
  needle: '@frontierjs/caravan',
  name:   'the app depends on @frontierjs/caravan',
}), {
  likely:    'the scaffold did not finish — its output is above',
  reproduce: `cd ${context.config.ws.dir} && fli new ${context.config.app} --yes --auth --with caravan`,
})) return

if (!await must(context, probe.fileContains({
  path:   schemaFile(context),
  needle: /^model Note \{/m,
  name:   'the app has a Note model to work on',
}), {
  likely: 'fli scaffold stopped part way — its output is above',
})) return

remember(context, '01-app', { appDir: dir })
```
