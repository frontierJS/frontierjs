---
title: basecamp:app
description: Make this app an App in Basecamp — a project, its production environment and a container App placed on a server — and store BASECAMP_APP_ID in its .env
effects: creates a project, an environment and an App in Basecamp and places the App on a server; writes BASECAMP_APP_ID to the app's .env
examples:
  - fli basecamp:app
  - fli basecamp:app --name thod --server ops1
  - fli basecamp:app --dry
  - BASECAMP_URL=https://basecamp.example.com fli basecamp:app
flags:
  name:
    type: string
    description: The project's and the App's name (default the app's package.json name, else its directory)
    defaultValue: ''
  server:
    type: string
    description: The Basecamp server to place the App on, by id, slug or name (default the one online server; asked at a terminal when there are several)
    defaultValue: ''
  url:
    type: string
    description: Basecamp's API origin (default is BASECAMP_URL, then the local dev API)
  file:
    char: f
    type: string
    description: The env file BASECAMP_APP_ID is written to
    defaultValue: '.env'
---

The step before an app's first `fli deploy` through Basecamp: the App row it
releases onto. Run in the app's directory, this makes three rows and one
placement — a project named for the app, its `production` environment, and a
container App in it, placed on an online server — then writes the App's id to
the app's `.env` as `BASECAMP_APP_ID`. With that set, `fli deploy` is `fli
basecamp:deploy`.

**The App is made bare on purpose**: no port, no volume, no Variables, no
Domain. `basecamp:deploy` completes it on every run, setting whatever is
missing from what the app declares — the port off `PORT`, the `/db` volume, the
health check, `ENCRYPTION_KEY`, the Domain and the static App for `web/`
(`FJS-D1599`). Setting them here would put a second owner beside `releasePlan`.

An app whose env already names a `BASECAMP_APP_ID` is refused, as is a name a
project in the workspace already holds as its slug: a second run never makes a
second App. A write that fails after the project is made archives the project,
which takes its environment and App with it.

The key is `BASECAMP_API_KEY`, read from the environment fli loads like
`basecamp:deploy`'s, and needs `projects:write`, `environments:write`,
`apps:write` and `servers:read`.

```js
const { existsSync, readFileSync, writeFileSync } = await import('fs')
const { basename, resolve } = await import('path')
const { setEnvLine } = await import(resolve(global.fliRoot, 'core/global-env.js'))

const root = $.paths.root
const key  = process.env.BASECAMP_API_KEY
if (!key) throw new Error('needs BASECAMP_API_KEY — a key issued at /api-keys/ in the Basecamp workspace the app goes in')
const origin  = (flag.url || process.env.BASECAMP_URL || LOCAL_BASECAMP).replace(/\/+$/, '')
const envPath = resolve(root, flag.file)

if (process.env.BASECAMP_APP_ID)
  throw new Error(`BASECAMP_APP_ID is already ${process.env.BASECAMP_APP_ID} — this app is an App in Basecamp; fli deploy releases it`)

const pkg  = existsSync(resolve(root, 'package.json')) ? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) : {}
const name = (flag.name || String(pkg.name ?? '').replace(/^@[^/]+\//, '') || basename(root)).trim()
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
if (!slug) throw new Error(`'${name}' makes no slug — pass --name`)

// ─── What is there already ─────────────────────────────────────────────────
const projects = await basecamp(origin, key, '/projects?$limit=100')
if (projects.some(p => p.slug === slug))
  throw new Error(`a project '${slug}' is already in this workspace — pass --name for another, or put its App's id in ${flag.file} as BASECAMP_APP_ID`)

const servers = (await basecamp(origin, key, '/servers?$limit=100')).filter(s => s.status === 'online')
let server
if (flag.server) {
  server = servers.find(s => [s.id, s.slug, s.name].includes(flag.server))
  if (!server) throw new Error(`no online server '${flag.server}' — online: ${servers.map(s => s.slug).join(', ') || 'none'}`)
} else if (servers.length === 1) {
  server = servers[0]
} else if (!servers.length) {
  throw new Error('Basecamp has no online server to place the App on — add one in Basecamp first')
} else if (process.stdin.isTTY && servers.length <= 9) {
  const picks = Object.fromEntries(servers.map((s, i) => [String(i + 1), `${s.name}${s.ipAddress ? chalk.dim(` ${s.ipAddress}`) : ''}`]))
  server = servers[Number(await tty.keys(chalk`{cyan ?} {bold Which server runs ${name}?}`, picks)) - 1]
} else {
  throw new Error(`${servers.length} servers are online — pass --server ${servers.map(s => s.slug).join('|')}`)
}

const plan = [
  `Project '${name}' (${slug})`,
  `Environment 'production' in it`,
  `Container App '${name}' in that, placed on ${server.name}`,
]
if (flag.dry) {
  for (const line of plan) log.dry(`Would make ${line} on ${origin}`)
  log.dry(`Would set BASECAMP_APP_ID to its id in ${flag.file}`)
  return
}

// ─── The rows, in the order each needs the one before ──────────────────────
const project = await basecamp(origin, key, '/projects', { method: 'POST', body: { name, slug } })
let app
try {
  const environment = await basecamp(origin, key, '/environments', { method: 'POST', body: {
    projectId: project.id, name: 'production', slug: 'production', tier: 'production',
  } })
  app = await basecamp(origin, key, '/apps', { method: 'POST', body: {
    environmentId: environment.id, name, slug, type: 'container',
  } })
  await basecamp(origin, key, `/apps/${encodeURIComponent(app.id)}`, {
    method: 'POST', headers: { 'x-service-method': 'place' }, body: { serverId: server.id },
  })
} catch (err) {
  // Archived, not left half-made: the project's soft delete cascades to its
  // environment and App, so the next run meets no slug it already holds.
  await basecamp(origin, key, `/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' })
    .then(() => log.warn(`Archived project '${slug}' — nothing is left half-made`))
    .catch(e => log.warn(`Project '${slug}' (${project.id}) is half-made and was not archived: ${e.message}`))
  throw err
}
log.success(`Made App '${name}' (${app.id}) in project '${slug}', placed on ${server.name}`)

writeFileSync(envPath, existsSync(envPath)
  ? setEnvLine(readFileSync(envPath, 'utf8'), 'BASECAMP_APP_ID', app.id)
  : `BASECAMP_APP_ID=${app.id}\n`, 'utf8')
log.success(`Set BASECAMP_APP_ID in ${flag.file}`)
log.info('Next: fli deploy --dry shows the first release\'s setup, and fli deploy applies it and releases')
```
