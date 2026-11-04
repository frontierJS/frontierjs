// desktop/sidecar/launcher.ts — the entry of the API sidecar the desktop shell
// starts (FJS-D1815), written by `fli make:desktop --sidecar`. The portable
// launcher of IDEAS/portable-install.md with what a Tauri sidecar needs and
// nothing it does not: no web/ server (the shell serves the screens), no
// Chrome, no Worker, no owner command.
//
// The shell passes everything by environment:
//   FJS_SIDECAR_APP      the app's own files (the bundle's resources/app)
//   DATABASE_URL         <app data>/app.db — jobs.db lands beside it
//   AUDIT_PATH           <app data>/audit.db
//   STORAGE_ROOT         <app data>/storage
//   ENCRYPTION_KEY_FILE  <app data>/encryption.key, made on first run
//   FRONTIER_PORT_BE     the free 127.0.0.1 port the shell picked
//   FJS_SIDECAR_LIFELINE=1  stop when stdin closes (a SIGTERM to itself, so the
//                        app's graceful shutdown runs): the shell holds the
//                        other end, so a shell that dies by any means, SIGKILL
//                        included, takes the API with it
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bundled } from './bundled.ts'

void bundled

const compiled = import.meta.dir.startsWith('/$bunfs')
const appDir = process.env.FJS_SIDECAR_APP ?? join(compiled ? dirname(process.execPath) : import.meta.dir, 'app')
if (!existsSync(join(appDir, 'api', 'index.ts'))) {
  console.error(`__SLUG__-api: no API at ${appDir}/api/index.ts — FJS_SIDECAR_APP names the app's files.`)
  process.exit(1)
}
process.chdir(appDir)

if (process.env.FJS_SIDECAR_LIFELINE === '1') {
  // A signal to ourselves, not process.exit: junction's SIGTERM handler runs
  // app.stop() (sockets told 1012, jobs drained) and then exits. An exit here
  // skipped all of it whenever the person quit the app. Once: 'end' and 'close'
  // both fire, and a second signal would start a second stop().
  let leaving = false
  const leave = () => {
    if (leaving) return
    leaving = true
    process.kill(process.pid, 'SIGTERM')
  }
  process.stdin.on('end', leave)
  process.stdin.on('close', leave)
  process.stdin.resume()
}

// The key every encrypted column and session is signed with. A new key is
// every existing row unreadable, so it is made once and kept beside the data.
// Only made here: junction's defineEnv reads ENCRYPTION_KEY_FILE itself, and
// refuses it beside ENCRYPTION_KEY.
const keyFile = process.env.ENCRYPTION_KEY_FILE
if (keyFile && !existsSync(keyFile)) {
  mkdirSync(dirname(keyFile), { recursive: true })
  writeFileSync(keyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
}
for (const v of ['DATABASE_URL', 'AUDIT_PATH', 'STORAGE_ROOT']) {
  const p = process.env[v]
  if (p && p !== ':memory:') mkdirSync(v === 'STORAGE_ROOT' ? p : dirname(p), { recursive: true })
}
// The bundled packages were built with NODE_ENV inlined as production
// (make-sidecar.ts --define); the app's on-disk files read it here.
process.env.NODE_ENV ??= 'production'
const port = process.env.FRONTIER_PORT_BE ?? '8100'
process.env.FRONTIER_API_URL ??= `http://127.0.0.1:${port}`

// This machine only. Junction binds config.hostname, which defaults to 0.0.0.0
// and has no environment variable, and on a desktop 0.0.0.0 is every machine
// on the network.
const serve = Bun.serve
Bun.serve = ((opts: Parameters<typeof Bun.serve>[0]) =>
  serve({ ...opts, hostname: process.env.FJS_SIDECAR_HOST ?? '127.0.0.1' } as Parameters<typeof Bun.serve>[0])) as typeof Bun.serve

await import(join(appDir, 'api', 'index.ts'))
