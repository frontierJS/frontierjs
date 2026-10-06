---
title: 07-report
description: Final setup health report and next steps
---

```js
if ($.config.abort) return

const { host, serverPath, appId, edge, edgeWritten } = $.config

log.success(`\nSetup complete for ${appId}`)
echo('')

// ─── Checklist ────────────────────────────────────────────────────────────────
echo('─── Next steps ──────────────────────────────────────────────────────')
echo('')
// The instructions name the machine they would run on — on a local target an
// `ssh` line is advice that fails when taken.
const there = (cmd) => (machineFor($, host, serverPath).local ? cmd : `ssh ${host} "${cmd}"`)

echo(`1. Populate production env vars on the server:`)
echo(`   ${there(`nano ${serverPath}/.env.production`)}`)
echo('')
echo(`2. Point DNS for each domain at this server — Caddy fetches the certificate`)
echo(`   on the first request, and cannot before the name resolves here`)
echo('')

if (!edgeWritten) {
  echo(`3. Write the routes: fli deploy:setup again, and answer y at step 5`)
  echo('')
}
echo(`${edgeWritten ? 3 : 4}. Run your first deploy:`)

echo(`   fli deploy${$.config.target !== 'dev' ? ` --${$.config.target}` : ''}`)
echo('')

if (edge.web.domain) {
  echo(`   App will be live at: https://${edge.web.domain}`)
}
if (edge.api.domain) {
  echo(`   API will be live at: https://${edge.api.domain} — the web build names it. If the API`)
  echo(`   narrows its CORS origins, they must include https://${edge.web.domain ?? '<the web domain>'}`)
}

echo('─────────────────────────────────────────────────────────────────────')
```
