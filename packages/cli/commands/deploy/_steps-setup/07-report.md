---
title: 07-report
description: Final setup health report and next steps
---

```js
if (context.config.abort) return

const { host, serverPath, appId, domain, nginxWritten, deployConf } = context.config

log.success(`\nSetup complete for ${appId}`)
echo('')

// ─── Checklist ────────────────────────────────────────────────────────────────
echo('─── Next steps ──────────────────────────────────────────────────────')
echo('')
echo(`1. Populate production env vars on the server:`)
echo(`   ssh ${host} "nano ${serverPath}/.env.production"`)
echo('')
echo(`2. Make sure your SSL certs are in place (if using HTTPS)`)
echo('')

if (nginxWritten) {
  echo(`3. Reload nginx to activate the config:`)
  echo(`   ssh ${host} "sudo nginx -s reload"`)
  echo('')
  echo(`4. Run your first deploy:`)
} else {
  echo(`3. Copy and install the nginx config shown in step 5 above`)
  echo('')
  echo(`4. Run your first deploy:`)
}

echo(`   fli deploy${context.config.target !== 'dev' ? ` --${context.config.target}` : ''}`)
echo('')

if (domain) {
  echo(`   App will be live at: https://${domain}`)
}

echo('─────────────────────────────────────────────────────────────────────')
```
