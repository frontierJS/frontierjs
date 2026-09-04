---
title: 07-journal
description: What the machine remembers
---

## The journal

```console
fli deploy:journal
```

The machine keeps a SQLite journal of its own — every transition, every step,
and which release is **serving**. That last word is precise: *serving* is the
last transition that SUCCEEDED, not the last transition. A failed deploy leaves
the previous release up, and a journal that called the attempted one serving
would be lying in exactly the situation somebody is reading it to get out of.

It is what makes the next two steps possible. A revert is not *run the previous
image*; it is *restore the pair the journal recorded* — a Release and the
environment generation it ran with.

```js
narrate(context)

context.config.__step = 7

if (!needs(context, ['appDir'], { from: '02-app' })) return

const out = sh('bun', [join(global.fliRoot, 'bin', 'fli.js'), 'deploy:journal'], { cwd: context.config.appDir })
log.info(out.stdout)

if (!await must(context, {
  ok:    /succeeded/.test(out.stdout) && /serving/.test(out.stdout),
  name:  'the journal on the machine records a serving transition',
  asked: 'a transition that succeeded, and a release marked serving',
  got:   out.code === 0 ? 'the journal has neither' : (out.stderr || `deploy:journal exited ${out.code}`),
}, {
  likely:    'the deploy swapped the container without opening a journal',
  reproduce: `cd ${context.config.appDir} && fli deploy:journal --steps`,
})) return
```
