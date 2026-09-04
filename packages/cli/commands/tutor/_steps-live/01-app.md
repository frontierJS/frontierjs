---
title: 01-app
description: An app with a model in it, reused or built
---

## An app to change

This lesson needs an app with a model of its own. If lesson 1 left one in this
workspace, it is reused; otherwise it is built here — the same three commands
lesson 1 walks through, run without commentary:

```console
fli new <app> --auth
fli scaffold Note --fields "title:string body:text done:boolean"
fli db:push
```

From here on the only thing that changes is `db/schema.lite`.

```js
if (!await narrate(context)) return

context.config.__step = 1

const dir = appDir(context)

// Reuse is by the FILE, not by the journal: `--tmp` gives a fresh workspace
// every run, and a person may also have deleted the app under a named one.
//
// And by what the model DECLARES. This lesson's headline is a publish that an
// anonymous socket receives because reads on Note are public — which stops
// being true the moment `tutor:access` has run in the same workspace and left a
// row policy on it. A policy filters a broadcast exactly as it filters a query,
// so the app is rebuilt rather than reused, and the message says which.
const noteBlock = (() => {
  try {
    const src = readFileSync(join(dir, 'db', 'schema.lite'), 'utf8')
    const at  = src.indexOf('model Note {')
    return at === -1 ? null : src.slice(at, src.indexOf('\n}', at))
  } catch { return null }
})()

const pristine = noteBlock !== null && !noteBlock.includes('@@allow') && !noteBlock.includes('@allow')
const built    = existsSync(join(dir, 'db', 'schema.lite')) && pristine

if (!built) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

  log.info(noteBlock && !pristine
    ? `the Note here carries a row policy, which filters a broadcast as well as a query — rebuilding ${dir}`
    : `building an app to watch — ${dir}`)
  context.exec({
    command: `${context.fli} new ${context.config.app} --yes --auth --no-git --no-deploy --source ${context.config.source}`,
    cwd:     context.config.ws.dir,
  })
  context.exec({
    command: `${context.fli} scaffold Note --fields "title:string body:text done:boolean"`,
    cwd:     dir,
  })
  context.exec({ command: `${context.fli} db:push`, cwd: dir })
} else {
  log.info(`reusing the app lesson 1 left at ${dir}`)
}

context.config.appDir = dir

if (!await must(context, probe.fileContains({
  path:   schemaFile(context),
  needle: /^model Note \{/m,
  name:   'the app has a Note model to watch',
}), {
  likely:    'the scaffold did not finish — its output is above',
  reproduce: `cd ${dir} && fli scaffold Note --fields "title:string body:text done:boolean"`,
})) return

remember(context, '01-app', { appDir: dir })
```
