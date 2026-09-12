---
title: 03-verify
description: Ask the edge what it now answers, rather than trusting the write
---

```js
if (context.config.abort) return

const { host, serverPath, apiPort, healthPath, pauseKind, edgeHost } = context.config
const machine = machineFor(context, host, serverPath)

// Asked from the target, through its own nginx, over the name the vhost is
// written for. `--resolve` on both ports rather than a Host header: with TLS
// configured the http side is a 301 and the name has to survive the redirect,
// and SNI has to match or the handshake picks the wrong certificate.
const name = edgeHost ?? 'localhost'
const edge = machine.capture(`curl -s -o /dev/null -w '%{http_code}' -k -L --max-time 10 \
  --resolve ${name}:80:127.0.0.1 --resolve ${name}:443:127.0.0.1 \
  http://${name}/ 2>/dev/null || echo 000`).trim()

if (pauseKind === 'pause') {
  if (edge !== '503') {
    // The write succeeded and the edge did not change its answer, which is the
    // one failure this command has: a file nothing reads is a pause nobody is in.
    log.error(`The edge answered ${edge} and not 503 — the pause is not in force`)
    log.info(`  the guard is in ${name}'s vhost and the file is written, so something else is answering for this app`)
    context.config.abort = true
    throw new Error(`pause did not take: the edge answered ${edge}`)
  }
  log.success(`The edge answers 503 → ${name}`)

  // Worth saying at the moment somebody has just taken the app down, rather than
  // in a document they will read afterwards: the container never stopped.
  log.info('')
  log.warn('  The app is still RUNNING. A pause stops callers, not the app —')
  log.warn('  jobs, crons and the outbox go on exactly as before.')
  log.info('')
  return
}

if (edge === '503') {
  log.error('The edge is still answering 503 — something other than this guard is refusing')
  context.config.abort = true
  throw new Error('unpause did not take: the edge still answers 503')
}
log.success(`The edge answers ${edge} → ${name}`)

// A second, independent claim. The container never stopped, so an app that is
// not healthy here was not healthy before the pause either — which is worth
// being told and is not a reason to leave the guard in place, since that would
// be an unpause somebody could only finish by hand.
const health = machine.capture(
  `curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:${apiPort}${healthPath} 2>/dev/null || echo 000`).trim()
if (health === '200') log.success(`Health answers 200 → ${healthPath}`)
else                  log.warn(`Health answers ${health} on ${healthPath} — the app was already unwell; the edge is serving anyway`)
```
