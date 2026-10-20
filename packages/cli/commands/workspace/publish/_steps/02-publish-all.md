---
title: 02-publish-all
description: Publish each package to npm
---

<script>
import { execSync } from 'child_process'
</script>

```js
const { released, tag, otp, interactive, prompts } = $.config
if (!released?.length) { log.info('Nothing to publish'); return }

const published = []
const failures  = []
const skipped   = []
let lapsed      = false

for (const { name, dir, newVersion } of released) {
  // npm's browser 2FA is per-publish, so a loop that does not stop opens an OTP
  // prompt for a package nobody is looking at — and the version is already
  // committed by now, so *not this one, not today* has to be answerable without
  // abandoning the run. The FIRST one always stops, which is where a person
  // gets their authenticator up; `--interactive` keeps stopping after that.
  // The first stop needs a terminal: `prompt.js` buffers a piped stdin to
  // `end`, so asking where nobody is typing hangs with no output. The flag
  // does not, because passing it IS somebody saying they are here.
  const first = !published.length && !failures.length && !skipped.length
  if ((interactive || (first && tty.interactive)) && !flag.dry) {
    echo('')
    if (first) log.info(`  ${released.length} publish(es) from here, each with its own npm 2FA prompt.`)
    log.info(`  Ready: ${name}@${newVersion}  →  npm (tag ${tag})`)
    if (!await prompts.confirm('  Publish it?', { default: true })) {
      // A skip is NOT a failure: the version and tag are already written, so
      // the next `ws:pub` finds it in flight and publishes it.
      skipped.push(`${name}@${newVersion}`)
      log.warn(`  · skipped ${name}@${newVersion}`)
      continue
    }
  }

  // bun, not npm: npm ships a `workspace:*` dependency spec verbatim, and no
  // registry can resolve one — the package installs nowhere. bun's packer
  // rewrites it to the sibling's version and drops devDependencies entirely.
  // Same --tag/--otp/--access flags.
  const parts = ['bun publish']
  if (tag !== 'latest') parts.push(`--tag ${tag}`)
  if (otp) parts.push(`--otp ${otp}`)

  log.info(`  Publishing ${name}@${newVersion}...`)

  if (flag.dry) { log.dry(`  Would run in ${dir}: ${parts.join(' ')}`); continue }

  try {
    execSync(parts.join(' '), { cwd: dir, stdio: 'inherit' })
    published.push(`${name}@${newVersion}`)
    log.success(`  ✓ ${name}@${newVersion}`)
  } catch (err) {
    failures.push(name)
    log.error(`  ✗ ${name}: ${err.message}`)
    // A lapsed session fails every package after this one too, so collecting
    // them buries the one cause under twenty copies. npm is asked rather than
    // bun's output read: the 2FA prompt needs bun's streams on the terminal.
    let who = ''
    try { who = String(execSync('npm whoami', { stdio: ['ignore', 'pipe', 'ignore'] })).trim() } catch {}
    if (!who) { lapsed = true; break }
  }
}

$.config.published = published

if (skipped.length) {
  log.warn(`  ${skipped.length} skipped: ${skipped.join(', ')}`)
  log.warn('  Each is versioned and tagged locally; `fli ws:pub` again publishes them')
}

if (failures.length) {
  // The commit and tags from step 01 are still local and nothing is pushed.
  // Re-running finishes the release: `ws:pub` asks the registry which tagged
  // versions it lacks and publishes those, without a second bump.
  if (published.length) log.warn(`  ${published.length} package(s) DID publish: ${published.join(', ')}`)
  if (lapsed) {
    const left = released.length - published.length - skipped.length
    log.error(`  npm auth lapsed — stopped with ${left} package(s) unpublished`)
    log.error('  Run `fli ws:pub` again: it logs in and finishes this release')
  } else {
    log.warn('  Fix the failure and run `fli ws:pub` again: it finishes this release rather than bumping')
  }
  throw new Error(`${lapsed ? 'npm auth lapsed' : `${failures.length} package(s) failed to publish: ${failures.join(', ')}`} — nothing pushed`)
}
```
