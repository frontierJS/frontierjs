---
title: 01-app
description: An app to look at, reused or built
---

## Something to look at

These tools are about a running app, so this lesson needs one. If an earlier
lesson left an app in this workspace it is reused; otherwise it is built here,
with the same three commands lesson 1 walks through:

```console
fli new <app> --auth
fli scaffold Note --fields "title:string body:text done:boolean"
fli db:push
```

Nothing below depends on which of those two happened. That is the point of a
tool: it reads the app in front of it.

```js
if (!await narrate($)) return

$.config.__step = 1

const dir = appDir($)

// Reuse is by the FILE, not by the journal: `--tmp` gives a fresh workspace
// every run, and a person may also have deleted the app under a named one.
if (!existsSync(join(dir, 'db', 'schema.lite'))) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

  log.info(`building an app to look at — ${dir}`)
  $.exec({
    command: `${$.fli} new ${$.config.app} --yes --auth --no-git --no-deploy --source ${$.config.source}`,
    cwd:     $.config.ws.dir,
  })
  $.exec({
    command: `${$.fli} scaffold Note --fields "title:string body:text done:boolean"`,
    cwd:     dir,
  })
  $.exec({ command: `${$.fli} db:push`, cwd: dir })
} else {
  log.info(`reusing the app at ${dir}`)
}

$.config.appDir = dir

if (!await must($, probe.fileContains({
  path:   schemaFile($),
  needle: /^model Note \{/m,
  name:   'the app has a Note model',
}), {
  likely:    'the scaffold did not finish — its output is above',
  reproduce: `cd ${dir} && fli scaffold Note --fields "title:string body:text done:boolean"`,
})) return

remember($, '01-app', { appDir: dir })
```
