---
title: 07-report
description: Final setup health report and next steps
---

```js
const { host, serverPath, appId, edge, edgeWritten } = $.config

log.done(`\nSetup complete for ${appId}`)
// Said again here because 01's line scrolls away under the installs, and a
// caller like basecamp:create runs a deploy after it.
if ($.config.fliSkipped) log.warn($.config.fliSkipped)
echo('')
// `fli basecamp:create` and `:install` point the DNS and deploy right after, so
// a checklist telling the person to do both reads as work left undone. They
// mark the box as Basecamp's host instead of an app's.
if (!$.flag['next-steps']) return

// A box that runs an app is in use: without the mark, fli basecamp:create
// takes it for one an earlier run left behind and refuses to buy.
if (!machineFor($, host, serverPath).local) {
  const ip = await boxAddress(host)
  if (ip) await markApp({ ip, log })
}

// ─── Checklist ────────────────────────────────────────────────────────────────
echo(chalk`{dim ─── }{bold Next steps}{dim  ${'─'.repeat(54)}}\n`)
// The instructions name the machine they would run on — on a local target an
// `ssh` line is advice that fails when taken.
const there = (cmd) => (machineFor($, host, serverPath).local ? cmd : `ssh -t ${host} "${cmd}"`)

const { envFile } = apiFiles($.config.deployConf, serverPath)
echo($.config.envSeeded
  ? chalk`{bold 1.} Your local .env.production was copied up — the server's copy is the one that counts now:`
  : chalk`{bold 1.} Populate production env vars on the server (or put them in a local .env.production and set up a fresh box):`)
echo(`   ${chalk.cyan(there(`vi ${envFile}`))}`)
echo('')
let n = 1

// 06-dns pointed these at Cloudflare; a domain it could not point stays here.
const unpointed = [edge.web.domain, edge.api.domain].filter(d => d && !($.config.dnsPointed ?? []).includes(d))
if (unpointed.length) {
  echo(chalk`{bold ${++n}.} Point DNS for ${unpointed.join(' and ')} at this server — Caddy fetches the certificate`)
  echo(chalk.dim(`   on the first request, and cannot before the name resolves here`))
  echo('')
}

if (!edgeWritten) {
  echo(chalk`{bold ${++n}.} Write the routes: {cyan fli deploy:setup} again, and answer y at step 5`)
  echo('')
}
echo(chalk`{bold ${++n}.} Run your first deploy:`)

echo(`   ${chalk.cyan(`fli deploy${$.config.target !== 'dev' ? ` --${$.config.target}` : ''}`)}`)
echo('')

if (edge.web.domain) {
  echo(chalk`   {dim App will be live at:} https://${edge.web.domain}`)
}
if (edge.api.domain) {
  echo(chalk`   {dim API will be live at:} https://${edge.api.domain} {dim — the web build names it. If the API}`)
  echo(chalk.dim(`   narrows its CORS origins, they must include https://${edge.web.domain ?? '<the web domain>'}`))
}

echo(chalk.dim('─'.repeat(69)))
```
