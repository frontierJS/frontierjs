---
title: 00-preflight
description: Every reason this release must not go to npm, before a version is spent
---

<script>
import { resolve } from 'path'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
</script>

```js
const { planned, members } = $.config
if (!planned?.length) return

const { dirtyPackages, peerDrift, publishOrder, publishRefusals, formatRefusals } =
  await import(new URL('file://' + global.fliRoot + '/core/publish-preflight.js'))

const dirty  = dirtyPackages(planned.map(p => ({ name: p.pkg.name, dir: p.dir })),
                             (name, dir) => $.git.pkgState(name, dir))
const drift  = peerDrift((members ?? []).map(m => ({ name: m.pkg.name, pkg: m.pkg })), planned.map(p => ({ name: p.pkg.name, newVersion: p.newVersion })))
const sorted = publishOrder(planned.map(p => ({ ...p, name: p.pkg.name })))

// The website's list of packages it holds back, read where it lives. Absent
// outside this workspace, where there is no site to fall behind.
let heldBack = []
const siteData = resolve($.config.wsRoot ?? '', 'website/site/content/data/packages.js')
if (existsSync(siteData)) {
  const { HELD_BACK = {} } = await import('file://' + siteData)
  heldBack = planned.filter(p => p.pkg.name in HELD_BACK).map(p => ({ name: p.pkg.name, reason: HELD_BACK[p.pkg.name] }))
}

const refusals = publishRefusals({
  dirty, drift, cycles: sorted.cycles, heldBack,
  force: { dirty: flag['allow-dirty'], peers: flag['allow-peer-drift'] },
})

if (refusals.length) for (const line of formatRefusals(refusals)) log.info(line)

if (refusals.some(r => !r.note)) {
  // `abort`, not a throw: the runtime exits non-zero, skips the rest and still
  // runs any teardown, and nothing has been versioned yet — so the recovery is
  // to fix what is named and run the same command again.
  $.config.abort = true
  $.config.prompts?.close()
  return
}

// Whether npm knows who you are, asked BEFORE a version is spent. bun reads
// npm's own credentials, and without them the refusal arrives from the registry
// after the commit and the tags are written.
//
// On a terminal the answer is a fresh `npm login`, every run. An npm login
// session lasts two hours, so `npm whoami` passes a session with minutes left
// and it lapses between the first publish and the twentieth; logging in here
// starts the full window before the first 2FA prompt. A piped run cannot open
// a browser, so it keeps the refusal.
if (!flag.dry) {
  const whoami = () => {
    try { return String(execSync('npm whoami', { stdio: ['ignore', 'pipe', 'ignore'] })).trim() }
    catch { return '' }
  }
  if (tty.interactive) {
    log.info('  npm sessions last two hours — logging in fresh')
    try { execSync('npm login --auth-type=web', { stdio: 'inherit' }) }
    catch { /* the whoami below is the verdict */ }
  }
  const who = whoami()
  if (!who) {
    log.error('  ✗  npm-auth')
    log.error('      npm does not know who you are — `bun publish` reads npm\'s credentials')
    log.error('      Run `npm login --auth-type=web` and start again')
    $.config.abort = true
    $.config.prompts?.close()
    return
  }
  log.info(`  npm: ${who}`)
}

// The order is the product of this step even when nothing refused. A dependency
// published second resolves for nobody in the window between the two.
$.config.planned = sorted.order

// The last stop before a version is spent. Asked HERE rather than at the end of
// the command file because the refusals above are the thing being approved, and
// the note-only ones — a peer range that could not be decided — are exactly the
// kind a person reads and then chooses to accept.
const { interactive, prompts } = $.config
if (interactive && !flag.dry && !$.config.resume) {
  const names = sorted.order.map(p => p.pkg.name.replace('@frontierjs/', '')).join(' → ')
  echo('')
  log.info(`  Next: write ${sorted.order.length} version(s), refresh the lockfile, commit and tag.`)
  log.info(`  Publish order: ${names}`)
  if (!await prompts.confirm('  Version and commit now?', { default: true })) {
    log.info('  Stopped — nothing versioned, nothing published')
    prompts.close()
    $.config.abort = true
    return
  }
}

if (!refusals.length) {
  const names = sorted.order.map(p => p.pkg.name.replace('@frontierjs/', '')).join(' → ')
  log.success(`  preflight clear — ${planned.length} package(s), publishing ${names}`)
}
```
