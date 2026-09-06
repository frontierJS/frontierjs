---
title: 01-app
description: An app with a model in it, reused or built
---

## An app to check

This lesson needs an app with a schema that declares something worth checking.
If an earlier lesson left one in this workspace it is reused; otherwise it is
built here, with the same three commands lesson 1 walks through:

```console
fli new <app> --auth
fli scaffold Note --fields "title:string body:text done:boolean"
fli db:push
```

That is already a schema with gates on five models, a row policy, two field
policies, `@guarded` and `@encrypted` columns and a handful of validators —
none of which anybody typed for this lesson. The checks below are about that.

```js
if (!await narrate(context)) return

context.config.__step = 1

const dir = appDir(context)

// Reuse is by the FILE, not by the journal: `--tmp` gives a fresh workspace
// every run, and a person may also have deleted the app under a named one.
if (!existsSync(join(dir, 'db', 'schema.lite'))) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

  log.info(`building an app to check — ${dir}`)
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

if (!await must(context, probe.fileContains({
  path:   schemaFile(context),
  needle: /^model Note \{/m,
  name:   'the app has a Note model to check',
}), {
  likely:    'the scaffold did not finish — its output is above',
  reproduce: `cd ${dir} && fli scaffold Note --fields "title:string body:text done:boolean"`,
})) return

// Every step here builds a database from the schema, and the schema declares
// @encrypted columns — so a key is not optional and the failure without one is
// at createTestEnv rather than at the assertion.
if (!await must(context, probe.fileContains({
  path:   join(dir, '.env'),
  needle: /^[ \t]*ENCRYPTION_KEY[ \t]*=[ \t]*\S/m,
  name:   '.env carries an ENCRYPTION_KEY',
}), {
  likely: 'fli auth:install generates one — run it, or add the variable by hand',
})) return

remember(context, '01-app', { appDir: dir })
```
