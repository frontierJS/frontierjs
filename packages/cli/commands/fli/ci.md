---
title: fli:ci
description: Run the workspace CI — every phase, or one named
alias: ci
mode: passthrough
examples:
  - fli ci
  - fli ci -- --help
  - fli ci --fast
  - fli ci --phase snapshots
  - fli ci --only litestone
---

<script>
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve, dirname } from 'path'
</script>

An alias. `scripts/ci.mjs` is the owner and this forwards its argv untouched,
so there is one flag set and one phase list, and a flag this file has never
heard of is refused by the runner rather than dropped here.

`fli ci -- --help` is the runner's own help — the phases, their tier, and every
flag, derived from the phase table so it cannot go stale. Bare `--help` is
answered by fli for every command before one loads, which is why the separator
is there and is the same one `bun run ci -- --only litestone` needs.

What it adds over the script is reach: `bun run ci` is a root script and only
answers from the root, while a phase is most often wanted from inside the
package that just went red.

An app scaffolded by `fli new` has no `scripts/ci.mjs`. Its gate is `bun run
check`, which is the same shape one tier down — a workflow that calls one thing
and a person who can call it too. Naming that is why this refuses rather than
reporting that it found nothing to run.

```js
// Walk up for the runner rather than asking `context.wsRoot()`, which prompts
// when it finds nothing — a prompt is the wrong answer to being in the wrong
// repo, and it hangs a CI job that got here by mistake.
let dir = process.cwd()
let runner = null
for (;;) {
  const candidate = resolve(dir, 'scripts/ci.mjs')
  if (existsSync(candidate)) { runner = candidate; break }
  const up = dirname(dir)
  if (up === dir) break
  dir = up
}

if (!runner) {
  log.error(
    'No scripts/ci.mjs above ' + process.cwd() + ' — this is the framework ' +
    'workspace\'s own CI and there is no workspace here.'
  )
  log.info('In an app, the whole gate is `bun run check` (fli check, lint, typecheck).')
  process.exitCode = 2
  return
}

// Everything after the command name, forwarded untouched. Parsing it here would
// put a second copy of the flag set in this file, which is the one thing the
// alias must not become — `--help` is the script's, and so is the refusal of a
// flag it does not know.
// `--dry` is fli's own and the runner would refuse it by name, which is the
// refusal working correctly on the wrong flag.
let forwarded = process.argv.slice(3).filter(a => a !== '--dry' && a !== '-d')
// `fli ci -- --help` is the way to reach the runner's own `--help`, because
// bootstrap answers `--help` for every command before one loads. The separator
// has done its job by the time we get here and the runner would refuse it.
if (forwarded[0] === '--') forwarded = forwarded.slice(1)

if (flag.dry) {
  log.dry(`node ${runner} ${forwarded.join(' ')}`.trim())
  return
}

const r = spawnSync(process.execPath, [runner, ...forwarded], {
  cwd: dirname(dirname(runner)),
  stdio: 'inherit',
  shell: false,
})

if (r.error) {
  log.error(`could not run ${runner}: ${r.error.message}`)
  process.exitCode = 2
  return
}

// The script's own exit code, unchanged. A wrapper that graded the run again
// would be a second verdict on one question.
process.exitCode = r.status ?? 1
```
