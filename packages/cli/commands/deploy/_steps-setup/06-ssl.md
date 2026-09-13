---
title: 06-ssl
description: Verify SSL certificates exist on the server
optional: true
skip: "!(context.config.edge?.web.sslCert || context.config.edge?.api.sslCert)"
---

```js
if (context.config.abort) return

const { host, edge } = context.config
const machine = machineFor(context, host, context.config.serverPath)

log.info('Checking SSL certificates...')

// Per side: an API on its own domain is its own server block and presents its
// own certificate, so a web cert in place says nothing about the API's.
for (const [side, { domain, sslCert, sslKey }] of Object.entries(edge)) {
  if (!sslCert) continue
  const label = domain ?? side

  const present = (path) => {
    try { machine.run(`[ -f ${path} ]`); return true } catch { return false }
  }
  const certOk = present(sslCert)
  const keyOk  = present(sslKey)

  if (certOk) log.success(`  ${label} cert: ${sslCert} ✓`)
  else        log.warn(`  ${label} cert: ${sslCert} — NOT FOUND`)
  if (keyOk)  log.success(`  ${label} key:  ${sslKey} ✓`)
  else        log.warn(`  ${label} key:  ${sslKey} — NOT FOUND`)

  if (!certOk || !keyOk) {
    log.warn(`SSL certs for ${label} missing — nginx will fail to start until they are in place`)
    log.info('For Cloudflare origin certs:')
    log.info(`  1. Cloudflare → ${label} → SSL/TLS → Origin Server → Create Certificate`)
    log.info(`  2. Save the cert to: ${sslCert}`)
    log.info(`  3. Save the key to:  ${sslKey}`)
  }
}
```
