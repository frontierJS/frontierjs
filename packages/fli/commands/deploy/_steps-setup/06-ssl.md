---
title: 06-ssl
description: Verify SSL certificates exist on the server
optional: true
skip: "!context.config.sslCert"
---

```js
if (context.config.abort) return

const { host, sslCert, sslKey } = context.config

log.info('Checking SSL certificates...')

let certOk = false
let keyOk  = false

try {
  context.exec({ command: `ssh ${host} "[ -f ${sslCert} ]"` })
  certOk = true
  log.success(`  cert: ${sslCert} ✓`)
} catch {
  log.warn(`  cert: ${sslCert} — NOT FOUND`)
}

try {
  context.exec({ command: `ssh ${host} "[ -f ${sslKey} ]"` })
  keyOk = true
  log.success(`  key:  ${sslKey} ✓`)
} catch {
  log.warn(`  key:  ${sslKey} — NOT FOUND`)
}

if (!certOk || !keyOk) {
  log.warn('SSL certs missing — nginx will fail to start until they are in place')
  log.info('For Cloudflare origin certs:')
  log.info('  1. Cloudflare → your domain → SSL/TLS → Origin Server → Create Certificate')
  log.info(`  2. Save the cert to: ${sslCert}`)
  log.info(`  3. Save the key to:  ${sslKey}`)
}
```
