---
title: 04-site
description: One command, and the app has a public surface
---

## The surface

```console
fli make:site
```

That writes `site/` — its own Vite config on its own port, its own routes, its
own tests, its own `deploy/`. It is a **peer** of `api/` and `web/`, and the
reason is worth two sentences because it looks like over-organisation until it
bites.

A Vite root is one output directory, and `vite build` empties `outDir` before it
writes. A static site folded into `web/` therefore lands inside the SPA's
`dist/` — and the next SPA build deletes it, with nothing said. Everything else
about the split is a preference; that one is a defect.

The line that matters in `site/config/sierra.config.js` is this:

```text
db: '../api/src/core/db.ts',
```

That is the client the build taps while a `load()` runs. Without it Sierra
cannot say what a page published, and refuses to emit any page that read
anything.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app  = context.config.appDir
const site = join(app, 'site')

if (!existsSync(join(site, 'config', 'sierra.config.js'))) {
  context.exec({ command: `${context.fli} make:site`, cwd: app })
}

for (const [path, what] of [
  ['site/config/sierra.config.js', 'the target'],
  ['site/config/vite.config.js',   'the Vite root'],
  ['site/src/routes/index.mesa',   'a first page'],
]) {
  if (!await must(context, probe.fileExists({ path: join(app, path), name: `${path} — ${what}` }), {
    likely:    'fli make:site stopped part way — its output is above',
    reproduce: `cd ${app} && fli make:site`,
  })) return
}

// The publish check is the whole of the next two steps, and it is off unless
// this line is there — a site with no `db:` refuses every page that reads
// anything, which is a different failure and would be blamed on the page.
if (!await must(context, probe.fileContains({
  path:   join(site, 'config', 'sierra.config.js'),
  needle: "db: '../api/src/core/db.ts'",
  name:   'the build knows which client to tap',
}), {
  likely: 'this app has no api/ surface, so make:site had nothing to point at',
})) return

remember(context, '04-site', { siteDir: site })
```
