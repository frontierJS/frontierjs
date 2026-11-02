---
title: 04-verify-assets
description: Fetch each uploaded release asset through packages.frontierjs.com and compare it to the tarball shipped, then install a fresh app from each host the run shipped to
---

<script>
import { createHash }   from 'crypto'
import { readFileSync } from 'fs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// The derived URL is the release path under the package host (`FJS-D1620`):
// a redirect rule nothing in this run wrote, so this is the only place that
// notices the rule, the release and the tarball no longer agreeing. Compared
// against the file step 02 uploaded, never a fresh pack: a tree that moved
// after the bump packs to different bytes (package-host.md 0.1).
async function checkAsset({ name, newVersion, tarball }, url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} from ${res.url}`)
  const got  = sha256(new Uint8Array(await res.arrayBuffer()))
  const want = sha256(readFileSync(tarball))
  if (got !== want) throw new Error(`sha256 ${got.slice(0, 12)}… where the upload was ${want.slice(0, 12)}…`)
}

// What the run shipped to a host. A dry run ships nothing, so it names what the
// real one would: a package goes where it is missing, else wherever `--to` says.
function shippedTo(host, { released, uploaded = [], published = [], to, missing }, dry) {
  if (!dry) return host === 'npm' ? published : uploaded
  return released
    .filter(({ name }) => (missing?.[name] ?? to).includes(host))
    .map(({ name, newVersion }) => `${name}@${newVersion}`)
}
</script>

```js
const config = $.config
if (!config.released?.length) return

const { freshAppChecks, installFreshApp, pinsBehind, REGISTRY_LAG } = await import(new URL('file://' + global.fliRoot + '/core/publish-hosts.js'))
const { FJS_PACKAGES, APP_DEV_DEPS, FJS_TRANSITIVE } = await import(new URL('file://' + global.fliRoot + '/core/app-config.js'))

// Step 01 raises the scaffold pins to versions no host holds until this run has
// published them, so the published framework cannot be graded before the tag
// (`FJS-D1726`). It is graded here: an app scaffolded and installed from each
// host the run reached, with nothing of this tree linked in. A scaffold pins a
// fixed set of packages, and a release that touched none of them changes
// nothing a fresh app installs.
const pinned = new Set(Object.keys({ ...FJS_PACKAGES, ...APP_DEV_DEPS, ...FJS_TRANSITIVE }))
const owed   = freshAppChecks({
  uploaded:  shippedTo('tarballs', config, flag.dry),
  published: shippedTo('npm', config, flag.dry),
  pinned,
})

const bad    = flag.dry ? [] : await assetsNotServed()
const failed = installFreshApps()

if (bad.length)    throw new Error(`${bad.length} asset(s) not served as uploaded: ${bad.join(', ')} — the release shipped; the package host does not answer with it`)
if (failed.length) throw new Error(`a fresh app did not install from ${failed.join(' + ')} — the release shipped; the host does not give an app what it published`)

async function assetsNotServed() {
  const shipped = new Set(config.uploaded ?? [])
  const bad = []
  for (const asset of config.released) {
    const { name, newVersion } = asset
    if (!shipped.has(`${name}@${newVersion}`)) continue
    const url = config.packageHostUrl(name, newVersion)
    try {
      await checkAsset(asset, url)
      echo(chalk`  {green ✓} ${url}`)
    } catch (err) {
      bad.push(name)
      log.error(`  ✗ ${name}@${newVersion}: ${url}: ${err.message}`)
    }
  }
  return bad
}

function installFreshApps() {
  const fli    = global.fliRoot + '/bin/fli.js'
  const failed = []
  for (const { host, source } of owed) {
    const from = host === 'npm' ? 'npm' : 'packages.frontierjs.com'
    if (flag.dry) { log.dry(`  Would scaffold a fresh app with --source ${source} and bun install it from ${from}`); continue }

    const settle = REGISTRY_LAG[source]?.settleMs ?? 0
    echo(chalk`  {dim fresh app from ${from} (--source ${source})${settle ? `, after ${settle / 1000}s for the registry to serve it` : ''}…}`)
    const got = installFreshApp({ from: source, fli })
    if (got.ok) {
      echo(chalk`  {green ✓} fresh app installed from ${from} {dim · ${got.detail}}`)
      const behind = pinsBehind(shippedTo(host, config, false), got.versions)
      echo.lines(behind.map(b => chalk`    {yellow pins behind} ${b.name} installed ${b.installed}, this run shipped ${b.shipped} {dim — release @frontierjs/cli with it to move the scaffold}`))
      continue
    }

    failed.push(from)
    log.error(`  ✗ fresh app from ${from} failed at ${got.step}:\n${got.detail}`)
  }
  return failed
}
```
