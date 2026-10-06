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
if (!await narrate($)) return

$.config.__step = 4

if (!needs($, ['appDir'], { from: '02-app' })) return

$.exec({ command: `${$.fli} release:check`, cwd: $.config.appDir })

if (!await must($, probe.fileExists({
  path: join($.config.appDir, 'db', 'release.snapshot.md'),
  name: 'db/release.snapshot.md',
}), {
  likely:    'release:check did not write a baseline — its output is above',
  reproduce: `cd ${$.config.appDir} && fli release:check`,
})) return
```
