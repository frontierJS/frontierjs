---
title: 01-app
description: An app with screens, reused or built
---

## The screens you were already given

`fli scaffold Note` in lesson 1 wrote five files, and three of them were
screens: a list, a create page and an edit page. Nothing has opened them.

If an earlier lesson left an app in this workspace it is reused; otherwise it
is built here, the same three commands lesson 1 walks through.

```js
if (!await narrate(context)) return

context.config.__step = 1

// Asked before anything is built: no Chrome is a fact about the machine, and a
// lesson that scaffolded an app and then discovered it could not open one has
// wasted a minute to say so.
if (!haveChrome()) {
  log.warn(process.env.FJS_CHROME
    ? `$FJS_CHROME names ${process.env.FJS_CHROME} and there is no such binary`
    : 'no Chrome on this machine — this lesson needs one to open a page')
  log.info('')
  log.info('  install Chrome or Chromium, or point $FJS_CHROME at a binary')
  log.info('  every other lesson runs without it')
  log.info('')
  // `stop`, not `abort`: nothing failed. The lesson exits 0 and the journal
  // does not record a step that was never attempted.
  context.config.stop = true
  return
}

const dir = appDir(context)

if (!existsSync(join(dir, 'db', 'schema.lite'))) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

  log.info(`building an app with screens in it — ${dir}`)
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
  log.info(`reusing the app at ${dir}`)
}

context.config.appDir = dir

if (!await must(context, probe.fileExists({
  path: join(dir, 'web', 'src', 'routes', 'notes', 'create.mesa'),
  name: 'there is a create page to open',
}), {
  likely:    'the scaffold did not write the routes — its output is above',
  reproduce: `cd ${dir} && fli scaffold Note --fields "title:string body:text done:boolean"`,
})) return

remember(context, '01-app', { appDir: dir })
```
