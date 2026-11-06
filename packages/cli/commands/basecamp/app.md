---
title: basecamp:app
description: Make this app an App in Basecamp — a project, an environment of the target's tier and a container App placed on a server — and store BASECAMP_APP_ID in its .env; with BASECAMP_APP_ID set, add another environment's App to the project
effects: creates a project (when BASECAMP_APP_ID is unset), an environment and an App in Basecamp and places the App on a server; writes BASECAMP_APP_ID to the app's .env when it was unset
examples:
  - fli basecamp:app
  - fli basecamp:app --production
  - fli basecamp:app --stage
  - fli basecamp:app --name thod --server ops1
  - fli basecamp:app --dry
  - fli basecamp:app --basecamp ops
flags:
  production:
    type: boolean
    description: Make the production App (the default is development, the stage branch makes staging)
    defaultValue: false
  stage:
    type: boolean
    description: Make the staging App
    defaultValue: false
  name:
    type: string
    description: The project's and the App's name (default the app's package.json name, else its directory)
    defaultValue: ''
  server:
    type: string
    description: The Basecamp server to place the App on, by id, slug or name (default the one online server; asked at a terminal when there are several)
    defaultValue: ''
  basecamp:
    type: string
    description: The Basecamp to call, by its name in basecamps.json (default the one holding BASECAMP_APP_ID when it is set, asked of each entry; else the only one, and with several none named is refused with the names)
    defaultValue: ''
  file:
    char: f
    type: string
    description: The env file BASECAMP_APP_ID is written to
    defaultValue: '.env'
---

<script>
// The online Basecamp server the App is placed on: the one named, the only one,
// or the one picked at a terminal.
const pickServer = async ({ origin, key, flag, name, tty, chalk }) => {
  const servers = (await basecampAll(origin, key, '/servers')).filter(s => s.status === 'online')
  if (flag.server) {
    const named = servers.find(s => [s.id, s.slug, s.name].includes(flag.server))
    if (!named) throw new Error(`no online server '${flag.server}' — online: ${servers.map(s => s.slug).join(', ') || 'none'}`)
    return named
  }
  if (servers.length === 1) return servers[0]
  if (!servers.length) throw new Error('Basecamp has no online server to place the App on — add one in Basecamp first')
  if (process.stdin.isTTY && servers.length <= 9) {
    const picks = Object.fromEntries(servers.map((s, i) => [String(i + 1), `${s.name}${s.ipAddress ? chalk.dim(` ${s.ipAddress}`) : ''}`]))
    return servers[Number(await tty.keys(chalk`{cyan ?} {bold Which server runs ${name}?}`, picks)) - 1]
  }
  throw new Error(`${servers.length} servers are online — pass --server ${servers.map(s => s.slug).join('|')}`)
}
</script>

The step before an app's first `fli deploy` through Basecamp: the App row it
releases onto. The target is `fli deploy`'s (`--production`, `--stage`, a
stage/staging branch, else development), and the environment is named for its
tier. Run in the app's directory with no `BASECAMP_APP_ID`, this makes three
rows and one placement — a project named for the app, the target's environment,
and a container App in it, placed on an online server — then writes the App's id
to the app's `.env` as `BASECAMP_APP_ID`. With that set, `fli deploy` is `fli
basecamp:deploy`.

**With `BASECAMP_APP_ID` set, it adds a target to the project** (`FJS-D1966`):
the key names any App of the project, and this makes the target's environment
(when the project lacks it) and a bare container App in it with the anchor's
slug and name, placed on a server. `BASECAMP_APP_ID` stays as it was, since
`fli deploy` resolves the target's App from it (`FJS-D1965`); the new App's id
is printed. A tier that already holds an App of that slug is refused.

**The App is made bare on purpose**: no port, no volume, no Variables, no
Domain. `basecamp:deploy` completes it on every run, setting whatever is
missing from what the app declares — the port off `PORT`, the `/db` volume, the
health check, `ENCRYPTION_KEY`, the Domain and the static App for `web/`
(`FJS-D1599`). Setting them here would put a second owner beside `releasePlan`.

A name a project in the workspace already holds as its slug is refused (with no
`BASECAMP_APP_ID`), as is a tier the project already holds the App in: a second
run never makes a second App. A write that fails afterward archives what this
run made — the project, which takes its environment and App with it, or the App
and the environment added to an existing project.

The origin and key are the Basecamp's entry in `basecamps.json`, chosen by
`--basecamp` as `basecamp:deploy` chooses them, and the key needs `projects:write`, `environments:write`,
`apps:write` and `servers:read`.

```js
const { existsSync, readFileSync, writeFileSync } = await import('fs')
const { basename, resolve } = await import('path')
const { setEnvLine } = await import(resolve(global.fliRoot, 'core/global-env.js'))
const { resolveTarget, TIERS } = await import(resolve(global.fliRoot, 'core/deploy-target.js'))

const root = $.paths.root
const anchorId = process.env.BASECAMP_APP_ID
const target = await reachFor(flag.basecamp, anchorId, log)
if (!target) return
const { url: origin, apiKey: key } = target
const envPath = resolve(root, flag.file)
const tier = TIERS[resolveTarget(flag, $.git)]

// ─── Who the App is: the anchor's, or this app's ───────────────────────────
let anchor = null
let name, slug
if (anchorId) {
  if (flag.name) throw new Error(`--name names a new project, and BASECAMP_APP_ID ${anchorId} says the project is there — the ${tier} App takes the project's name`)
  anchor = await basecamp(origin, key, `/apps/${encodeURIComponent(anchorId)}`).catch(err => {
    if (err.status === 404) throw new Error(`BASECAMP_APP_ID ${anchorId} is no App on ${target.name} — take it out of .env to make a new project`)
    throw err
  })
  if (!anchor.environment?.projectId) throw new Error(`App '${anchor.name}' (${anchorId}) names no project`)
  ;({ name, slug } = anchor)
} else {
  const pkg = existsSync(resolve(root, 'package.json')) ? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) : {}
  name = (flag.name || String(pkg.name ?? '').replace(/^@[^/]+\//, '') || basename(root)).trim()
  slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) throw new Error(`'${name}' makes no slug — pass --name`)
}

// ─── What is there already ─────────────────────────────────────────────────
let environment = null
if (anchor) {
  const projectId = anchor.environment.projectId
  environment = (await basecampAll(origin, key, `/environments?projectId=${encodeURIComponent(projectId)}`)).find(e => e.tier === tier) ?? null
  const held = environment && (await basecampAll(origin, key, `/apps?environmentId=${encodeURIComponent(environment.id)}`)).find(a => a.slug === slug)
  if (held) throw new Error(`the ${tier} environment already holds App '${slug}' (${held.id}) — fli deploy${tier === 'production' ? ' --production' : tier === 'staging' ? ' --stage' : ''} releases it`)
} else {
  const projects = await basecampAll(origin, key, '/projects')
  if (projects.some(p => p.slug === slug))
    throw new Error(`a project '${slug}' is already in this workspace — pass --name for another, or put its App's id in ${flag.file} as BASECAMP_APP_ID`)
}

const server = await pickServer({ origin, key, flag, name, tty, chalk })

const plan = [
  ...(anchor ? [] : [`Project '${name}' (${slug})`]),
  ...(environment ? [] : [`Environment '${tier}' in ${anchor ? `project '${anchor.environment?.project?.name ?? anchor.environment.projectId}'` : 'it'}`]),
  `Container App '${name}' in ${environment ? `the ${tier} environment` : 'that'}, placed on ${server.name}`,
]
if (flag.dry) {
  for (const line of plan) log.dry(`Would make ${line} on ${origin}`)
  log.dry(anchor ? `BASECAMP_APP_ID stays ${anchorId}` : `Would set BASECAMP_APP_ID to its id in ${flag.file}`)
  return
}

// ─── The rows, in the order each needs the one before ──────────────────────
const project = anchor ? null : await basecamp(origin, key, '/projects', { method: 'POST', body: { name, slug } })
let madeEnvironment = null
let app
try {
  if (!environment) environment = madeEnvironment = await basecamp(origin, key, '/environments', { method: 'POST', body: {
    projectId: project?.id ?? anchor.environment.projectId, name: tier, slug: tier, tier,
  } })
  app = await basecamp(origin, key, '/apps', { method: 'POST', body: {
    environmentId: environment.id, name, slug, kind: 'container',
  } })
  await basecamp(origin, key, `/apps/${encodeURIComponent(app.id)}`, {
    method: 'POST', headers: { 'x-service-method': 'place' }, body: { serverId: server.id },
  })
} catch (err) {
  // Archived, not left half-made, so the next run meets no slug it already
  // holds. A new project's soft delete cascades to its environment and App; in
  // an existing project only the rows this run made go, the App with its
  // environment when that is new too.
  const archive = project
    ? { path: `/projects/${encodeURIComponent(project.id)}`, said: `project '${slug}'` }
    : { path: madeEnvironment ? `/environments/${encodeURIComponent(madeEnvironment.id)}` : app ? `/apps/${encodeURIComponent(app.id)}` : null,
        said: `${madeEnvironment ? 'environment' : 'App'} '${tier}'` }
  if (archive.path) await basecamp(origin, key, archive.path, { method: 'DELETE' })
    .then(() => log.warn(`Archived ${archive.said} — nothing is left half-made`))
    .catch(e => log.warn(`${archive.said} is half-made and was not archived: ${e.message}`))
  throw err
}
log.done(`Made App '${name}' (${app.id}) in the ${tier} environment${project ? ` of project '${slug}'` : ''}, placed on ${server.name}`)

if (anchor) {
  log.info(`BASECAMP_APP_ID stays ${anchorId} — fli deploy${tier === 'production' ? ' --production' : tier === 'staging' ? ' --stage' : ''} resolves this App from it`)
  return
}
writeFileSync(envPath, existsSync(envPath)
  ? setEnvLine(readFileSync(envPath, 'utf8'), 'BASECAMP_APP_ID', app.id)
  : `BASECAMP_APP_ID=${app.id}\n`, 'utf8')
log.done(`Set BASECAMP_APP_ID in ${flag.file}`)
log.info('Next: fli deploy --dry shows the first release\'s setup, and fli deploy applies it and releases')
```
