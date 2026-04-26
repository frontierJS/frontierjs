---
title: cloudflare:dns
description: List, add, update or delete DNS records for a zone
alias: cf:dns
examples:
  - fli cf:dns --zone example.com
  - fli cf:dns --zone example.com --type CNAME
  - fli cf:dns --zone example.com --add --type A --name @ --content 1.2.3.4
  - fli cf:dns --zone example.com --delete <record-id>
  - fli cf:dns --zone example.com --update <record-id> --content 5.6.7.8
  - fli cf:dns --zone example.com --dry
flags:
  zone:
    char: z
    type: string
    description: Zone name or ID (defaults to CLOUDFLARE_DEFAULT_ZONE)
    defaultValue: ''
  type:
    type: string
    description: Filter or set record type (A, AAAA, CNAME, MX, TXT, NS, SRV…)
    defaultValue: ''
  name:
    type: string
    description: Record name (e.g. @ for root, www, mail)
    defaultValue: ''
  content:
    type: string
    description: Record value / content
    defaultValue: ''
  ttl:
    type: string
    description: TTL in seconds (1 = auto)
    defaultValue: '1'
  proxied:
    type: boolean
    description: Enable Cloudflare proxy (orange cloud)
    defaultValue: false
  priority:
    type: string
    description: Priority (MX/SRV records)
    defaultValue: '10'
  add:
    type: boolean
    description: Add a new DNS record
    defaultValue: false
  delete:
    type: string
    description: Delete record by ID
    defaultValue: ''
  update:
    type: string
    description: Update record by ID
    defaultValue: ''
  token:
    type: string
    description: Override CLOUDFLARE_TOKEN for this run
    defaultValue: ''
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

<script>
const TYPE_PAD = 8
const NAME_PAD = 35
</script>

Full CRUD for DNS records. Without `--add`, `--update`, or `--delete` it lists
all records for the zone. Filter by type with `--type CNAME`.

```js
const zoneId = await resolveZone(context, flag.zone)

// ── DELETE ────────────────────────────────────────────────────────────────────
if (flag.delete) {
  log.info(`Deleting record ${flag.delete} from ${flag.zone}`)
  if (flag.dry) { log.dry(`DELETE /zones/${zoneId}/dns_records/${flag.delete}`); return }
  await cfApi(context, 'DELETE', `/zones/${zoneId}/dns_records/${flag.delete}`)
  log.success('Record deleted')
  return
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
if (flag.update) {
  if (!flag.content && !flag.name) { log.error('Provide --content or --name to update'); return }
  const current = await cfApi(context, 'GET', `/zones/${zoneId}/dns_records/${flag.update}`)
  const payload = {
    type:    flag.type    || current.type,
    name:    flag.name    || current.name,
    content: flag.content || current.content,
    ttl:     parseInt(flag.ttl) || current.ttl,
    proxied: flag.proxied ?? current.proxied,
  }
  log.info(`Updating record ${flag.update}`)
  if (flag.dry) { log.dry(`PATCH ${JSON.stringify(payload)}`); return }
  const updated = await cfApi(context, 'PATCH', `/zones/${zoneId}/dns_records/${flag.update}`, payload)
  log.success(`Updated: ${updated.type} ${updated.name} → ${updated.content}`)
  return
}

// ── ADD ───────────────────────────────────────────────────────────────────────
if (flag.add) {
  if (!flag.type || !flag.name || !flag.content) {
    log.error('--add requires --type, --name, and --content')
    return
  }
  const payload = {
    type:     flag.type,
    name:     flag.name,
    content:  flag.content,
    ttl:      parseInt(flag.ttl) || 1,
    proxied:  flag.proxied || false,
    priority: flag.type === 'MX' || flag.type === 'SRV' ? parseInt(flag.priority) : undefined,
  }
  log.info(`Adding ${flag.type} record: ${flag.name} → ${flag.content}`)
  if (flag.dry) { log.dry(`POST ${JSON.stringify(payload)}`); return }
  const record = await cfApi(context, 'POST', `/zones/${zoneId}/dns_records`, payload)
  log.success(`Created: ${record.id}  ${record.type} ${record.name} → ${record.content}`)
  return
}

// ── LIST ──────────────────────────────────────────────────────────────────────
const qs = flag.type ? `?type=${flag.type}&per_page=100` : '?per_page=100'
const records = await cfApi(context, 'GET', `/zones/${zoneId}/dns_records${qs}`)

if (flag.json) { echo(JSON.stringify(records, null, 2)); return }

echo('')
echo(`  Zone: ${flag.zone || zoneId}  ·  ${records.length} record(s)${flag.type ? `  (${flag.type})` : ''}\n`)
echo(`  ${'TYPE'.padEnd(TYPE_PAD)} ${'NAME'.padEnd(NAME_PAD)} CONTENT`)
echo(`  ${'─'.repeat(TYPE_PAD)} ${'─'.repeat(NAME_PAD)} ${'─'.repeat(30)}`)
for (const r of records) {
  const proxy = r.proxied ? ' ⚡' : ''
  echo(`  ${r.type.padEnd(TYPE_PAD)} ${r.name.padEnd(NAME_PAD)} ${r.content}${proxy}`)
  echo(`  ${' '.repeat(TYPE_PAD)} ${' '.repeat(NAME_PAD)} ${r.id}`)
}
echo('')
```
