---
title: 07-report
description: Final setup health report and next steps
---

```js
if (context.config.abort) return

const { host, serverPath, appId, edge, nginxWritten, deployConf } = context.config

log.success(`\nSetup complete for ${appId}`)
echo('')

// ─── Checklist ────────────────────────────────────────────────────────────────
echo('─── Next steps ──────────────────────────────────────────────────────')
echo('')
// The instructions name the machine they would run on — on a local target an
// `ssh` line is advice that fails when taken.
const there = (cmd) => (machineFor(context, host, serverPath).local ? cmd : `ssh ${host} "${cmd}"`)

echo(`1. Populate production env vars on the server:`)
echo(`   ${there(`nano ${serverPath}/.env.production`)}`)
echo('')
echo(`2. Make sure your SSL certs are in place (if using HTTPS)`)
echo('')

if (nginxWritten) {
  echo(`3. Reload nginx to activate the config:`)
  echo(`   ${there('sudo nginx -s reload')}`)
  echo('')
  echo(`4. Run your first deploy:`)
} else {
  echo(`3. Copy and install the nginx config shown in step 5 above`)
  echo('')
  echo(`4. Run your first deploy:`)
}

echo(`   fli deploy${context.config.target !== 'dev' ? ` --${context.config.target}` : ''}`)
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
