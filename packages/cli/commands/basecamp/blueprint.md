---
title: basecamp:blueprint
description: Install a Basecamp catalog entry as an App — make it from the Blueprint, place it on a server, give it a Domain, and queue its release
effects: creates an App (and its project and production environment when missing), places it on a server, adds a Domain when --domain is given, and queues a deployment in Basecamp
examples:
  - fli basecamp:blueprint headscale --server yuma-test --domain hs.awe.dev --param HEADSCALE_SERVER_URL=https://hs.awe.dev
  - fli basecamp:blueprint ntfy --param NTFY_BASE_URL=https://ntfy.acme.com --param NTFY_AUTH_USERS=frontier:HASH:user
  - fli basecamp:blueprint headscale --dry --param HEADSCALE_SERVER_URL=https://hs.awe.dev
  - fli basecamp:blueprint postgres --environment <environment-id> --basecamp ops
args:
  -
    name: slug
    description: The catalog entry's slug, as the Blueprints page shows it
    required: true
flags:
  param:
    type: string
    multiple: true
    description: A parameter of the Blueprint as KEY=VALUE, repeated for each one; a required one left out is refused by Basecamp, and a generated one is minted
  server:
    type: string
    description: The Basecamp server to place the App on, by id, slug or name (default the one online server; asked at a terminal when there are several)
    defaultValue: ''
  domain:
    type: string
    description: The hostname to give the App as its Domain; without it the App has none
    defaultValue: ''
  environment:
    type: string
    description: The environment to make the App in, by id (default the production environment of a project named for the App, made when missing)
    defaultValue: ''
  name:
    type: string
    description: The App's name, and its project's when one is made (default the Blueprint's)
    defaultValue: ''
  basecamp:
    type: string
    description: The Basecamp to call, by its name in basecamps.json (default the only one, and with several none named is refused with the names)
    defaultValue: ''
---

<script>
// `--param KEY=VALUE` as the object `fromBlueprint` takes. A repeatable flag
// and not one flag per parameter, because the keys are each Blueprint's own
// and a command's flags are fixed before it knows which entry it installs.
const valuesOf = (given) => {
  const values = {}
  for (const pair of [given ?? []].flat()) {
    const at = String(pair).indexOf('=')
    if (at < 1) throw new Error(`--param wants KEY=VALUE, got '${pair}'`)
    values[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return values
}

// What the run will make, in the order it makes it. A value is never printed,
// since a parameter may be a secret.
const planOf = ({ blueprint, name, home, server, flag, values }) => [
  ...(home.environment ? [] : [`${home.project ? '' : `project '${name}' and `}its production environment`]),
  `App '${name}' from ${blueprint.name}${Object.keys(values).length ? ` with ${Object.keys(values).join(', ')}` : ''}`,
  `placement on ${server.name}`,
  ...(flag.domain ? [`Domain ${flag.domain}`] : []),
  'a queued release',
]

const reportOf = ({ made, server, origin, echo, chalk }) => echo.lines([
  chalk`  {green ✓} {bold ${made.app.name}} {dim (${made.app.id}) on ${server.name}}`,
  made.domain && chalk`  {dim Domain}     ${made.domain.hostname}`,
  chalk`  {dim Deployment} ${origin}/deployments/${made.release.id}/`,
  '',
])
</script>

What the Blueprints page does, for a terminal and a script: `fromBlueprint` copies
the catalog entry into an App (image, port, volume, health check and Variables,
with each parameter interpolated and a generated one minted), `place` puts it on a
server, `--domain` gives it a Domain, and a release is queued (`FJS-D2343`). It
does not wait for the release: the line it ends on is the deployment's page, which
shows the steps. Every entry has this verb, Headscale (`FJS-D2331`) among them.

The App lives in the production environment of a project named for it, which is
made when missing, or in the environment `--environment` names. A name an
environment already holds as an App's slug is refused, so a second run never makes
a second App. A step after the App exists that fails leaves the App, as the page
does, and the refusal names it and the step; finish it in Basecamp or archive the
App and run again.

`--param` is repeated once per parameter, since the keys belong to each Blueprint
and not to this command. A value on a command line is in the process list and the
shell history, so a secret the entry generates is better left out, and one it needs
from you is better set on the Blueprints page.

The origin and key are the Basecamp's entry in `basecamps.json`, chosen by
`--basecamp` as `basecamp:app` chooses them, and the key needs `blueprints:read`,
`projects:write`, `environments:write`, `apps:write`, `domains:write`,
`deployments:write` and `servers:read`.

```js
const slug = String(arg.slug ?? '').trim().toLowerCase()
const target = await reach(flag.basecamp, log)
if (!target) return
const { url: origin, apiKey: key } = target

const values    = valuesOf(flag.param)
const blueprint = await blueprintNamed(origin, key, slug)
const name      = (flag.name || blueprint.name).trim()
const home      = await homeFor({ origin, key, environment: flag.environment, slug: slugOf(name) })
const server    = await pickServer({ origin, key, flag, name, tty, chalk })

if (flag.dry) {
  for (const line of planOf({ blueprint, name, home, server, flag, values })) log.dry(`Would make ${line} on ${origin}`)
  return
}

const made = await installBlueprint({ origin, key, blueprint, home, name, values, serverId: server.id, hostname: flag.domain })
reportOf({ made, server, origin, echo, chalk })
```
