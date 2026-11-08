---
title: 02-ship
description: Ship the app's committed tree and its vendored dependencies to every machine
skip: "$.config.siteOnly"
---

```js
const { hosts, doApi, doWeb, doWidgets, deployConf } = $.config

// ─── Pushed from here, never pulled there ─────────────────────────────────────
// A pull needs the server to hold the repository and a key that reads it, and
// an app inside a bigger repository — basecamp in this monorepo — would put the
// whole of that repository on a production box to build one directory of it.
// What leaves is `stageRelease`'s tree: `git archive` of HEAD at the app's own
// directory, committed files only, so the tag below names exactly the bytes the
// box holds. `basecamp:deploy` stages the same tree (`FJS-D1968`).
const { execFileSync } = await import('child_process')
const { mkdtempSync, rmSync, realpathSync } = await import('fs')
const { join } = await import('path')
const { tmpdir } = await import('os')
const { stageRelease } = await import(new URL('file://' + global.fliRoot + '/core/release-build.js'))

// web/ and widgets/ are built on the box from the generated manifest, so either
// deploy ships it whatever the Dockerfile says.
let release
try {
  release = stageRelease({ appRoot: realpathSync($.paths.root), told: deployConf.api?.dockerfile, vendor: Boolean(doWeb || doWidgets), log })
} catch (e) {
  log.error(e.message)
  $.config.abort = true
  return
}
const { short: sha, dir, dockerfile, vendors } = release

if (doApi && !release.present) {
  log.error(`${sha} has no ${dockerfile} — commit it, or name one in deploy.api.dockerfile`)
  release.cleanup()
  $.config.abort = true
  return
}

const scratch = mkdtempSync(join(tmpdir(), 'fli-ship-'))
const archive = join(scratch, 'src.tar')
try {
  // deploy/generated/ travels by machine.sync below, which sends only what
  // changed; the tarballs in it are the heavy part of a release.
  execFileSync('tar', ['-cf', archive, `--exclude=./${GENERATED_DIR}`, '-C', dir, '.'])

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
    if (vendors) machine.sync(`${dir}/${GENERATED_DIR}`, `${src}/${GENERATED_DIR}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
  release.cleanup()
}

$.config.commit     = sha
$.config.imageTag   = `${$.config.appId}:${sha}`
$.config.dockerfile = dockerfile

log.done(`Shipped → ${sha}`)
```
