---
title: 08-snapshot
description: All of it written down, and committed
---

## The whole surface, in one file

Three mechanisms are now in play across two models, and none of them is visible
in any service file. `fli test:access` writes them all down:

```console
fli test:access
```

`db/access.snapshot.md` is a committed artefact. CI reruns the generator and
fails a stale one — so a gate that moved is a **diff a reviewer reads**, not a
production refusal somebody discovers.

Its sibling is worth knowing about now that you have moved one: `fli test:access
--from <ref>` grades what a branch did to who may do what, and
`fli release:check` asks whether the release still serving and the one starting
can share a database.

```js
if (!await narrate($)) return

$.config.__step = 8

if (!needs($, ['appDir'], { from: '01-app' })) return

$.exec({ command: `${$.fli} test:access`, cwd: $.config.appDir })

const snap = join($.config.appDir, 'db', 'access.snapshot.md')

if (!await must($, probe.fileExists({ path: snap, name: 'db/access.snapshot.md' }), {
  likely:    'test:access did not write it — its output is above',
  reproduce: `cd ${$.config.appDir} && fli test:access`,
})) return

// Each of the three edits, read back out of the artefact. A snapshot that is
// merely PRESENT says nothing — this is the file people diff instead of reading
// the schema, so what has to hold is that it agrees with the schema.
for (const [needle, what] of [
  [/`Note`.*\|\s*4 USER/,                       'the raised read gate is in it'],
  [/allow \*\*read\*\* — `authorId == auth\(\)\.id`/, 'the row policy is in it'],
  [/`Note` \| `done` \|.*isAdmin/,              'the field policy is in it'],
]) {
  if (!await must($, probe.fileContains({ path: snap, needle, name: what }), {
    likely:    'the snapshot was written before the schema change, or the format moved',
    reproduce: `cat ${snap}`,
  })) return
}
```
