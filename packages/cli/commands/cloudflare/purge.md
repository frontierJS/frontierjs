---
title: cloudflare:purge
description: Purge Cloudflare cache — everything or specific URLs
alias: cf:purge
examples:
  - fli cf:purge --zone example.com
  - fli cf:purge --zone example.com --urls "https://example.com/page,https://example.com/other"
  - fli cf:purge --zone example.com --dry
flags:
  zone:
    char: z
    type: string
    description: Zone name or ID (defaults to CLOUDFLARE_DEFAULT_ZONE)
    defaultValue: ''
  urls:
    char: u
    type: string
    description: Comma-separated list of URLs to purge (omit to purge everything)
    defaultValue: ''
  profile:
    type: string
    description: cf profile to run as (default CLOUDFLARE_API_TOKEN, else cf's active login)
---

Purges the Cloudflare cache for a zone. Without `--urls` it purges everything.
With `--urls` it purges only those specific URLs (up to 30 at a time).

```js
const { profileFor, findZone, purge } = await import(new URL('file://' + global.fliRoot + '/core/cloudflare.js'))
const profile = profileFor(flag.profile)
if (!flag.zone) { log.error('No zone — use --zone or set CLOUDFLARE_DEFAULT_ZONE'); return }
const zone = await findZone(profile, flag.zone)
if (!zone) { log.error(`No zone this login reaches owns ${flag.zone}`); return }

if (flag.urls) {
  const urls = flag.urls.split(',').map(u => u.trim()).filter(Boolean)
  log.info(`Purging ${urls.length} URL(s) from ${zone.name}`)
  for (const url of urls) log.info(`  ${url}`)
  if (flag.dry) { log.dry('Would purge: ' + urls.join(', ')); return }
  // Cloudflare max 30 URLs per request
  const chunks = []
  for (let i = 0; i < urls.length; i += 30) chunks.push(urls.slice(i, i + 30))
  for (const chunk of chunks) await purge(profile, zone.id, { files: chunk })
  log.success(`Purged ${urls.length} URL(s)`)
} else {
  log.info(`Purging ALL cache for ${zone.name}`)
  if (flag.dry) { log.dry('Would purge all cache'); return }
  await purge(profile, zone.id, { purge_everything: true })
  log.success('Cache purged')
}
```
