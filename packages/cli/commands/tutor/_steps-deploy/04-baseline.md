---
title: 04-baseline
description: What a release IS, written down
---

## The release surface

```console
fli release:check
```

asks a deploy question before it is a migration question: **can the release
still serving and the release starting share one database?** *Expand* means
N-1 keeps working and the deploy can be taken back. *Contract* means it cannot,
and that deploy is the **pivot**, after which the only way is forward.

**Unknown counts as contract.** So an app with no `db/release.snapshot.md` has
no baseline to compare against, every change grades as a contract, and the
revert at the end of this lesson would be refused — correctly. Writing the
baseline now is what makes the rest of the lesson possible, which is a fair
picture of what it is for.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir'], { from: '02-app' })) return

context.exec({ command: `${context.fli} release:check`, cwd: context.config.appDir })

if (!await must(context, probe.fileExists({
  path: join(context.config.appDir, 'db', 'release.snapshot.md'),
  name: 'db/release.snapshot.md',
}), {
  likely:    'release:check did not write a baseline — its output is above',
  reproduce: `cd ${context.config.appDir} && fli release:check`,
})) return
```
