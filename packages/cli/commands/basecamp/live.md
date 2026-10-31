---
title: basecamp:live
description: Why a Basecamp App is not live — its release, its machine, then each hostname's zone, DNS and HTTPS — and with --retry, Caddy asked for the certificate now
effects: with --retry, reloads Caddy on every machine serving the App; otherwise reads only
examples:
  - fli basecamp:live
  - fli basecamp:live --app <app-id>
  - fli basecamp:live --retry
flags:
  app:
    type: string
    description: The Basecamp App — its id, from the App's page (default is BASECAMP_APP_ID)
  url:
    type: string
    description: Basecamp's API origin (default is BASECAMP_URL, then the local dev API)
  retry:
    type: boolean
    description: Reload Caddy on the App's machines first, so a certificate waiting out its backoff is asked for now
    defaultValue: false
---

The App page's live check on a command line: the same chain, from the same
`liveCheck`, stopping at the first failure. DNS is asked of public resolvers
and HTTPS is a request from Basecamp, not from this machine.

`--retry` is for the hour after a DNS record was fixed by hand. Caddy backs
off between certificate attempts — up to twenty minutes — and nothing Basecamp
pushes changes its config enough to reload. The flag reloads it, forced, on
every machine serving the App, and the check is rerun until HTTPS answers or
about twenty seconds pass (`FJS-D1715`). Let's Encrypt refuses a hostname after
five failed validations in an hour, so retry once the DNS step passes, not
before.

The key needs `apps:read`, and `apps:write` with a standing that may place an
App for `--retry`. Settings are read as `basecamp:deploy` reads them.

<script>
const mark = (chalk, status) =>
  status === 'pass' ? chalk.green('✓') : status === 'fail' ? chalk.red('✗') : status === 'warn' ? chalk.yellow('!') : chalk.dim('·')

const title = (chalk, status) =>
  status === 'live' ? chalk.green('Live') : status === 'warn' ? chalk.yellow('Reachable, with warnings') : chalk.red('Not live')

const stepLine = (chalk, s, indent = '  ') =>
  chalk`${indent}${mark(chalk, s.status)} {bold ${s.label.padEnd(13)}} {dim ${s.detail}}`

const hostBlock = (chalk, h) => [
  chalk`  {bold.cyan ${h.hostname}}`,
  ...(h.redirectTo ? [chalk`    {dim redirects to ${h.redirectTo}}`] : h.steps.map(s => stepLine(chalk, s, '    '))),
]
</script>

```js
const key = process.env.BASECAMP_API_KEY
if (!key) { log.error('needs BASECAMP_API_KEY — a key issued at /api-keys/ in the Basecamp workspace the app is in'); process.exitCode = 1; return }
const origin = (flag.url || process.env.BASECAMP_URL || LOCAL_BASECAMP).replace(/\/+$/, '')
const appId  = flag.app || process.env.BASECAMP_APP_ID
if (!appId) { log.error("needs --app or BASECAMP_APP_ID — the App's id, from its page in Basecamp"); process.exitCode = 1; return }

const path = `/apps/${encodeURIComponent(appId)}`
if (flag.dry) { log.dry(flag.retry ? `reload Caddy on the machines serving ${appId}, then check it` : `check ${appId}`); return }

const out   = await basecamp(origin, key, path, { method: 'POST', headers: { 'x-service-method': flag.retry ? 'retryLive' : 'liveCheck' }, body: {} })
const check = flag.retry ? out.check : out

if (flag.retry) {
  echo(chalk`  {dim Caddy reloaded on} ${out.reloaded.join(', ')}`)
  echo.lines(out.failed.map(f => chalk`  {yellow !} {dim not reloaded on} ${f.server}{dim : ${f.error}}`))
}
echo(`\n  ${title(chalk, check.status)}\n`)
echo.lines(check.steps.map(s => stepLine(chalk, s)))
for (const h of check.hosts) { echo(''); echo.lines(hostBlock(chalk, h)) }
if (!check.hosts.length) echo(chalk`\n  {dim This App has no domain, so there is no name to check.}`)
echo('')

if (check.status === 'down') process.exitCode = 1
```
