---
title: 04-verify-assets
description: Fetch each uploaded release asset through packages.frontierjs.com and compare it to the tarball shipped
skip: "flag.dry"
---

<script>
import { createHash }   from 'crypto'
import { readFileSync } from 'fs'
</script>

```js
const { released, uploaded, packageHostUrl } = $.config
if (!uploaded?.length) return

// The derived URL is the release path under the package host (`FJS-D1620`):
// a redirect rule nothing in this run wrote, so this is the only place that
// notices the rule, the release and the tarball no longer agreeing. Compared
// against the file step 02 uploaded, never a fresh pack: a tree that moved
// after the bump packs to different bytes (package-host.md 0.1).
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const shipped = new Set(uploaded)
const bad = []

for (const { name, newVersion, tarball } of released) {
  if (!shipped.has(`${name}@${newVersion}`)) continue
  const url = packageHostUrl(name, newVersion)
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`${res.status} from ${res.url}`)
    const got  = sha256(new Uint8Array(await res.arrayBuffer()))
    const want = sha256(readFileSync(tarball))
    if (got !== want) throw new Error(`sha256 ${got.slice(0, 12)}… where the upload was ${want.slice(0, 12)}…`)
    log.success(`  ✓ ${url}`)
  } catch (err) {
    bad.push(name)
    log.error(`  ✗ ${name}@${newVersion}: ${url}: ${err.message}`)
  }
}

if (bad.length) throw new Error(`${bad.length} asset(s) not served as uploaded: ${bad.join(', ')} — the release shipped; the package host does not answer with it`)
```
