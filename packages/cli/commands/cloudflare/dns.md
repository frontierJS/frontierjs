---
title: cloudflare:dns
description: List, add, update or delete DNS records for a zone
alias: cf:dns
examples:
  - fli cf:dns --zone example.com
  - fli cf:dns --zone example.com --type CNAME
  - fli cf:dns --zone example.com --add --type A --name @ --content 1.2.3.4
  - fli cf:dns --add --type A --name ops.example.com --content 1.2.3.4
  - fli cf:dns --zone example.com --delete <record-id>
  - fli cf:dns --zone example.com --update <record-id> --content 5.6.7.8
  - fli cf:dns --zone example.com --update <record-id> --no-proxied
  - fli cf:dns --zone example.com --profile client
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
    description: TTL in seconds (1 = auto, what a new record gets)
  proxied:
    type: boolean
    description: Cloudflare proxy, the orange cloud (a new record gets it off)
  priority:
    type: string
    description: Priority (MX/SRV records; a new one gets 10)
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
  profile:
    type: string
    description: cf profile to run as (default CLOUDFLARE_API_TOKEN, else cf's active login)
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

Full CRUD for DNS records. Without `--add`, `--update`, or `--delete` it lists
all records for the zone. Filter by type with `--type CNAME`.

A full hostname as `--name` names its own zone: `--add --name ops.example.com`
writes into the longest zone the login reaches that the name ends with, whatever
`--zone` or `CLOUDFLARE_DEFAULT_ZONE` says.

`--update` sends only the fields given, so `--update <id> --no-proxied` leaves
the content and TTL as they are.

```js
const TYPE_PAD = 6
const NAME_MAX = 40
const TYPE_TONE = { A: chalk.cyan, AAAA: chalk.cyan, CNAME: chalk.magenta, MX: chalk.yellow, TXT: chalk.green, NS: chalk.blue }
const PROXIED = chalk.hex('#f38020')
const { profileFor, findZone, records, createRecord, updateRecord, deleteRecord } =
  await import(new URL('file://' + global.fliRoot + '/core/cloudflare.js'))
const profile = profileFor(flag.profile)

// A default zone set for one client would otherwise put a hostname of another
// zone into it, where Cloudflare refuses it with a message about neither.
const fqdn = flag.name.toLowerCase().replace(/\.$/, '')
const named = flag.zone || process.env.CLOUDFLARE_DEFAULT_ZONE
const zone = (fqdn.includes('.') && await findZone(profile, fqdn))
  || (named && await findZone(profile, named))
if (!zone) {
  log.error(named ? `No zone this login reaches owns ${named}` : 'No zone — use --zone or set CLOUDFLARE_DEFAULT_ZONE')
  return
}

// ── DELETE ────────────────────────────────────────────────────────────────────
if (flag.delete) {
  log.info(`Deleting record ${flag.delete} from ${zone.name}`)
  if (flag.dry) { log.dry(`cf dns records delete ${flag.delete} -z ${zone.id}`); return }
  await deleteRecord(profile, zone.id, flag.delete)
  log.success('Record deleted')
  return
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
if (flag.update) {
  const changes = {}
  for (const key of ['type', 'name', 'content']) if (flag[key]) changes[key] = flag[key]
  if ('ttl' in flag) changes.ttl = Number(flag.ttl)
  if ('proxied' in flag) changes.proxied = flag.proxied
  if ('priority' in flag) changes.priority = Number(flag.priority)
  if (!Object.keys(changes).length) { log.error('Give at least one of --type, --name, --content, --ttl, --proxied, --priority'); return }
  log.info(`Updating record ${flag.update}`)
  if (flag.dry) { log.dry(`cf dns records edit ${flag.update} -z ${zone.id} --body '${JSON.stringify(changes)}'`); return }
  const updated = await updateRecord(profile, zone.id, flag.update, changes)
  log.success(`Updated: ${updated.type} ${updated.name} → ${updated.content}`)
  return
}

// ── ADD ───────────────────────────────────────────────────────────────────────
if (flag.add) {
  if (!flag.type || !flag.name || !flag.content) {
    log.error('--add requires --type, --name, and --content')
    return
  }
  const body = {
    type:    flag.type,
    name:    flag.name,
    content: flag.content,
    ttl:     'ttl' in flag ? Number(flag.ttl) : 1,
    proxied: flag.proxied ?? false,
    ...(flag.type === 'MX' || flag.type === 'SRV' ? { priority: Number(flag.priority ?? 10) } : {}),
  }
  log.info(`Adding ${flag.type} record: ${flag.name} → ${flag.content}`)
  if (flag.dry) { log.dry(`cf dns records create -z ${zone.id} --body '${JSON.stringify(body)}'`); return }
  const record = await createRecord(profile, zone.id, body)
  log.success(`Created: ${record.id}  ${record.type} ${record.name} → ${record.content}`)
  return
}

// ── LIST ──────────────────────────────────────────────────────────────────────
const type = flag.type.toUpperCase()
const rows = (await records(profile, zone.id)).filter(r => !type || r.type === type)

if (flag.json) { echo(JSON.stringify(rows, null, 2)); return }

// Names are written relative to the zone, the way `--name` takes them; the full
// name pushed the content column past the terminal and every row wrapped.
const short = (name) => name === zone.name ? '@'
  : name.endsWith('.' + zone.name) ? name.slice(0, -zone.name.length - 1) : name
const namePad = Math.min(NAME_MAX, Math.max(4, ...rows.map(r => short(r.name).length)))
const fit = (text, width) => text.length > width ? text.slice(0, width - 1) + '…' : text
// A DKIM TXT is hundreds of characters; past the edge it wraps into the next row.
const contentWidth = process.stdout.isTTY
  ? Math.max(20, process.stdout.columns - 2 - TYPE_PAD - 1 - namePad - 1 - 2)
  : Infinity

echo('')
echo(`  ${chalk.bold(zone.name)}  ${chalk.dim(`·  ${rows.length} record(s)${type ? `  (${type})` : ''}  ·  ${PROXIED('●')} proxied`)}\n`)
echo(chalk.dim(`  ${'TYPE'.padEnd(TYPE_PAD)} ${'NAME'.padEnd(namePad)}   CONTENT`))
for (const r of rows) {
  const tone = TYPE_TONE[r.type] ?? chalk.white
  const mark = r.proxied ? PROXIED('●') : ' '
  echo(`  ${tone(r.type.padEnd(TYPE_PAD))} ${fit(short(r.name), namePad).padEnd(namePad)} ${mark} ${fit(r.content, contentWidth)}`)
  echo(chalk.dim(`  ${' '.repeat(TYPE_PAD)} ${' '.repeat(namePad)}   ${r.id}`))
}
echo('')
```
