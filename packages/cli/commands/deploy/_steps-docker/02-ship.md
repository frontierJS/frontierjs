---
title: 02-ship
description: Ship the app's committed tree and its vendored dependencies to every machine
skip: "$.config.siteOnly"
---

```js
const { hosts } = $.config

// ─── Pushed from here, never pulled there ─────────────────────────────────────
// A pull needs the server to hold the repository and a key that reads it, and
// an app inside a bigger repository — basecamp in this monorepo — would put the
// whole of that repository on a production box to build one directory of it.
// What leaves is `git archive` of HEAD at the app's own directory: one commit,
// committed files only, so the tag below names exactly the bytes the box holds.
const { execFileSync } = await import('child_process')
const { mkdtempSync, rmSync, realpathSync } = await import('fs')
const { join, relative } = await import('path')
const { tmpdir } = await import('os')

const appRoot = realpathSync($.paths.root)
const git = (...args) => execFileSync('git', args, { cwd: appRoot, encoding: 'utf8' }).trim()

let top, sha
try {
  top = git('rev-parse', '--show-toplevel')
  sha = git('rev-parse', '--short', 'HEAD')
} catch {
  log.error(`${appRoot} is not inside a git repository with a commit — the deploy ships a commit`)
  $.config.abort = true
  return
}
const appRel = relative(realpathSync(top), appRoot)

// An edit not yet committed is not in what ships, and saying so is the
// difference between a deploy that ignored it and one that seemed to.
const dirty = git('status', '--porcelain', '--', '.').split('\n').filter(Boolean)
if (dirty.length) {
  log.warn(`${dirty.length} uncommitted change(s) under ${appRel || 'the app'} are not shipped — the deploy is ${sha} as committed:`)
  for (const line of dirty.slice(0, 8)) log.warn(`  ${line}`)
  if (dirty.length > 8) log.warn(`  …and ${dirty.length - 8} more`)
}

// deploy/generated/ is git-ignored and made here: the manifest the box installs
// from, with every `link:`/`workspace:` dependency packed beside it — a
// workspace that exists on this machine and nowhere on the server (FJS-241).
log.info('Vendoring dependencies...')
vendorApp(appRoot, log)

const scratch = mkdtempSync(join(tmpdir(), 'fli-ship-'))
const archive = join(scratch, 'src.tar')
try {
  execFileSync('git', ['archive', '--format=tar', '-o', archive, appRel ? `HEAD:${appRel}` : 'HEAD'], { cwd: top })

  // Extracted beside the old tree and swapped in, so a file deleted in the
  // commit is gone on the box and a failed extract leaves the old tree whole.
  for (const h of hosts) {
    const machine = machineFor($, h.host, h.path)
    const src = `${h.path}/src`
    log.info(`Shipping ${sha} → ${machine.describe()}:${src}`)
    machine.send(archive, `${h.path}/.fli-src.tar`)
    machine.run(`rm -rf ${src}.next && mkdir -p ${src}.next &&
      tar -xf ${h.path}/.fli-src.tar -C ${src}.next &&
      rm -f ${h.path}/.fli-src.tar &&
      rm -rf ${src} && mv ${src}.next ${src}`)
    machine.sync(`${appRoot}/${GENERATED_DIR}`, `${src}/${GENERATED_DIR}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

$.config.commit   = sha
$.config.imageTag = `${$.config.appId}:${sha}`

log.success(`Shipped → ${sha}`)
```
