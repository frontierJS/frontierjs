---
title: 01-app
description: An app to look at, reused or built
---

## Something to look at

These tools are about a running app, so this lesson needs one. If an earlier
lesson left an app in this workspace it is reused; otherwise it is built here,
with lesson 1's commands — except that the model goes in as a **migration**
rather than a push, because step 2 asks `fli check` whether anything fails and
a model the migration history does not build is a finding:

```console
fli new <app> --auth
fli scaffold Note --fields "title:string body:text done:boolean"
fli db:migrate add_note
```

A reused app whose model was pushed gets the migration it lacks —
`fli db:migrate add_note --create-only`, then `fli db:baseline` to record it
as applied, because the table is already in the database.

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
  $.exec({ command: `${$.fli} db:migrate add_note`, cwd: dir })
} else {
  log.info(`reusing the app at ${dir}`)
  // Lesson 1 pushes, and step 2's check grades a schema the history does not
  // build. The file is written and recorded as applied, since the pushed
  // table is already there; both are no-ops over an app that migrated.
  $.exec({ command: `${$.fli} db:migrate add_note --create-only`, cwd: dir })
  $.exec({ command: `${$.fli} db:baseline`, cwd: dir })
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
