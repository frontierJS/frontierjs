---
title: 05-nginx
description: Generate and write nginx config for this app
---

```js
if (context.config.abort) return

const { host, serverPath, appId, edge, apiPort } = context.config

// The pause guard and the page it serves come from `core/pause.js`, which is
// also what `deploy:pause` writes against and what `deploy:status` greps for.
// The server blocks come from `core/edge.js`, which also names the origin the
// web build inlines — one reader of the domains, or the vhost and the bundle
// disagree about where the API is.
const { DEFAULT_PAGE, pagePath, fliDir, vhostPath } =
  await import(new URL('file://' + global.fliRoot + '/core/pause.js'))
const { edgeVhost } =
  await import(new URL('file://' + global.fliRoot + '/core/edge.js'))

const nginxConf = edgeVhost({ appId, serverPath, apiPort, web: edge.web, api: edge.api }).trim()

// ─── Show the config ──────────────────────────────────────────────────────────
echo('\n' + nginxConf + '\n')

// ─── Write it to the server ───────────────────────────────────────────────────
const remotePath = vhostPath(appId)
const enabledPath = `/etc/nginx/sites-enabled/${appId}`

const answer = await question(`Write this config to ${host}:${remotePath}? (y/N) `)
if (answer.trim().toLowerCase() !== 'y') {
  log.info('Skipped — copy the config above to your server manually')
  return
}

// A QUOTED heredoc, and the quotes are the whole of it: nginx configs are made
// of `$host`, `$remote_addr` and `$proxy_add_x_forwarded_for`, and a shell that
// expands them writes `proxy_set_header Host ;` — a file that looks like a
// config and is one nginx refuses. `machine.run` pipes this to the target's own
// shell, so `'NGINXEOF'` is the only quoting between here and the file.
const machine = machineFor(context, host, context.config.serverPath)

machine.run(`sudo tee ${remotePath} > /dev/null << 'NGINXEOF'
${nginxConf}
NGINXEOF`)

// The page the guard serves. Written here rather than by `deploy:pause`, because
// a pause that had to write two files could put the guard in force with nothing
// behind it — nginx would answer its own 503 page, which says nothing to the
// person reading it. An app that wants its own overwrites this path.
machine.run(`mkdir -p ${fliDir(serverPath)}`)
machine.run(`cat > ${pagePath(serverPath)} << 'FLIPAGEEOF'
${DEFAULT_PAGE}FLIPAGEEOF`)

// Enable site if not already enabled
try {
  machine.run(`[ -L ${enabledPath} ] || sudo ln -s ${remotePath} ${enabledPath}`)
} catch {}

// Test config
try {
  machine.run('sudo nginx -t')
  log.success('nginx config written and validated')
  context.config.nginxWritten = true
} catch (err) {
  log.warn('nginx config written but validation failed: ' + err.message)
  log.info(`Review with: ${machine.local ? 'sudo nginx -t' : `ssh ${host} "sudo nginx -t"`}`)
}
```
