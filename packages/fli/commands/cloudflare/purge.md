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
  token:
    type: string
    description: Override CLOUDFLARE_TOKEN for this run
    defaultValue: ''
---

Purges the Cloudflare cache for a zone. Without `--urls` it purges everything.
With `--urls` it purges only those specific URLs (up to 30 at a time).

```js
const zoneId = await resolveZone(context, flag.zone)

if (flag.urls) {
  const urls = flag.urls.split(',').map(u => u.trim()).filter(Boolean)
  log.info(`Purging ${urls.length} URL(s) from ${flag.zone || zoneId}`)
  for (const url of urls) log.info(`  ${url}`)
  if (flag.dry) { log.dry('Would purge: ' + urls.join(', ')); return }
  // Cloudflare max 30 URLs per request
  const chunks = []
  for (let i = 0; i < urls.length; i += 30) chunks.push(urls.slice(i, i + 30))
  for (const chunk of chunks) {
    await cfApi(context, 'POST', `/zones/${zoneId}/purge_cache`, { files: chunk })
  }
  log.success(`Purged ${urls.length} URL(s)`)
} else {
  log.info(`Purging ALL cache for ${flag.zone || zoneId}`)
  if (flag.dry) { log.dry('Would purge all cache'); return }
  await cfApi(context, 'POST', `/zones/${zoneId}/purge_cache`, { purge_everything: true })
  log.success('Cache purged')
}
```
