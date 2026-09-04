---
title: 09-build
description: The production build, and the one thing that makes it real
---

## The build

`bun run build` builds the web app. What it leaves is `web/dist/client/`, and
what is asserted is not that the command exited 0 — it is that
`index.html` **carries a script tag**.

That is a real distinction rather than a careful one. A build can succeed and
ship a blank page: Vite injects the bundle at the first textual match for the
body tag, so a `<body` mentioned inside a comment earlier in the file takes the
injection and the page loads no JavaScript at all. The HTML looks right, the
build is green, and nothing runs.

```js
narrate(context)

context.config.__step = 9

if (!needs(context, ['appDir'], { from: '02-new' })) return

context.exec({ command: 'bun run build', cwd: context.config.appDir })

const index = join(context.config.appDir, 'web', 'dist', 'client', 'index.html')

if (!await must(context, probe.fileExists({ path: index, name: 'web/dist/client/index.html' }), {
  likely:    'the build failed — its output is above',
  reproduce: `cd ${context.config.appDir} && bun run build`,
})) return

if (!await must(context, probe.fileContains({
  path:   index,
  needle: /<script[^>]+src="[^"]+\.js"/,
  name:   'the built page loads its bundle',
}), {
  likely:    'the injection went somewhere else — look for a <body mentioned in a comment above the real tag',
  reproduce: `grep -o '<script[^>]*>' ${index}`,
})) return
```
