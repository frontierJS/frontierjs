---
title: deploy:vendor
description: Write deploy/generated/ — the build context the Dockerfile installs from
examples:
  - fli deploy:vendor
  - fli deploy:vendor --dry
---

Writes `deploy/generated/`, which `deploy/Dockerfile` installs from rather than
from `package.json`. `fli deploy:local` and `fli deploy` both run it before they
build, so this command exists for the two cases where they cannot: a hand-run
`docker build`, and finding out what a build would install without running one.

An app scaffolded with `fli new --source local` depends on the framework by
`link:@frontierjs/junction` and four siblings, and an app inside the workspace
depends on it by `workspace:*`. Neither resolves inside a Docker build — the
install fails once per package with `FileNotFound: failed linking
dependency/workspace to node_modules`. So this packs each of those packages with
`bun pm pack` into `deploy/generated/vendor/` and writes
`deploy/generated/app-manifest.json` with the specs rewritten to point at the
tarballs, `overrides` included: the packages depend on each other, and a range
left alone resolves from npm and quietly mixes a published sierra into a local
mesa.

A tarball is what `npm publish` would upload, so the image runs the working tree
rather than the registry — and a source file missing from a package's `files:`
field, invisible in a workspace, becomes a broken install here rather than in
somebody else's `bun install`.

**With nothing linked it still runs**, and copies the manifest and the lockfile
unchanged. That is what lets one Dockerfile serve both source modes; the source
an app installs from can change long after `fli make:deploy` wrote its template
once.

Everything it writes is generated — `deploy/generated/` belongs in
`.gitignore`, and `fli new` puts it there.

```js
const { existsSync } = await import('fs')
const { resolve }    = await import('path')

const root = context.paths.root

if (!existsSync(resolve(root, 'package.json')))
  throw new Error(`No package.json at ${root} — run this from an app root`)

if (flag.dry) {
  const { linkedDeps } = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))
  const { readFileSync } = await import('fs')
  const linked = linkedDeps(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')))
  log.dry(`Would write ${GENERATED_DIR}/app-manifest.json`)
  if (linked.length) {
    log.dry(`Would pack ${linked.length} linked dependenc(ies) into ${GENERATED_DIR}/vendor:`)
    for (const name of linked) echo(`    ${name}`)
  } else {
    log.dry('Nothing linked — the manifest and the lockfile would be copied verbatim')
  }
  return
}

const result = vendorApp(root, log)

echo('')
if (result.vendored.length) {
  log.success(`${GENERATED_DIR}/ written — ${result.packed.length} tarball(s), ${result.vendored.length} spec(s) rewritten`)
  for (const name of result.vendored) echo(`    ${name}`)
} else {
  log.success(`${GENERATED_DIR}/ written — nothing linked, manifest copied verbatim`)
}
echo('')
log.info('Next:  fli deploy:local')
```
