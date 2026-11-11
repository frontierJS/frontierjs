// ─── basecamp-key.js — an API key minted inside a running Basecamp ───────────
//
// Basecamp refuses to let a key mint a key, so the browser's way is a password,
// a second factor and the API keys screen. This is the other way: the app booted
// in a repl, and `api-keys.create` called AS an owner, so the service's own mint
// runs — scopes checked, the credential issued by auth, the row and its trail
// entry written. Shared by `fli basecamp:key`, `basecamp:create`'s first key and
// Workbench's Basecamps screen, so the three cannot mint differently.
//
// `where` names the Basecamp:
//   { server }      `deploy:repl` — ssh to that box and `docker exec` into the
//                   serving API container. Reaching the box is the proof of
//                   standing a password would have been.
//   {}              the same, at the box packages/basecamp's frontier.config.js names.
//   { local: true } `app:repl` — the dev Basecamp (`DEV_BASECAMP`) has no Host
//                   and no container; its app boots in-process over this
//                   checkout's dev database, so no ssh is involved.
// Both run in the packages/basecamp checkout beside this package, never through
// a global `fli`: the answer is the child's stdout alone, the boot's chatter its
// stderr — held, and shown only when it fails. Async, so Workbench's server is
// not frozen for the seconds a boot takes.

import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'

const FLI      = fileURLToPath(new URL('../bin/fli.js', import.meta.url))
const BASECAMP = fileURLToPath(new URL('../../basecamp/', import.meta.url))

const replArgv = (code, { server, local = false, as, tenant } = {}) => [
  FLI, local ? 'app:repl' : 'deploy:repl', '-e', code,
  ...(as ? ['--as', as] : []),
  ...(tenant ? ['--tenant', tenant] : []),
  ...(server && !local ? ['--server', server] : []),
]

/** One line evaluated in Basecamp's repl, answered as parsed JSON. Throws with
 *  the last lines of the child's stderr when it exits non-zero. */
export function replLine(code, where = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, replArgv(code, where), { cwd: BASECAMP, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let out = '', err = ''
    child.stdout.setEncoding('utf8').on('data', d => { out += d })
    child.stderr.setEncoding('utf8').on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', (status) => {
      const verb = where.local ? 'app:repl' : 'deploy:repl'
      if (status !== 0) {
        const said = err.trim().split('\n').filter(l => !l.startsWith('{"level"')).slice(-4).join('\n')
        return reject(new Error(`${verb} exited ${status ?? 'on a signal'}${said ? `:\n${said}` : ''}`))
      }
      try { resolve(JSON.parse(out)) }
      catch { reject(new Error(`${verb} answered something that is not JSON: ${out.trim().slice(0, 200)}`)) }
    })
  })
}

/** Who may hold a key: a person, not a bot, who is an owner or admin of a
 *  workspace that still exists — a deleted one leaves its member rows behind,
 *  and they would read as a second seat. A `sys` read, so it needs no --force.
 *  Answers `[{ email, role, workspaceId, workspace }]`. */
export async function holders(where = {}) {
  const rows = await replLine(`sys.workspaceMember.findMany({ where: { role: { in: ['owner', 'admin'] } }, select: { role: true, workspaceId: true, workspace: { select: { name: true } }, user: { select: { email: true, kind: true } } } })`, where)
  return rows
    .filter(m => m.user?.kind === 'user' && m.workspace)
    .map(m => ({ email: m.user.email, role: m.role, workspaceId: m.workspaceId, workspace: m.workspace.name }))
}

/** The service's own create, called as `holder` in their workspace. `key` is
 *  `{ name, scopes, expiresIn }`. Answers what the service answered — `token`
 *  and `tokenHint` among it — or `{ error }`. */
export async function mint(key, holder, where = {}) {
  const made = await replLine(`call('api-keys.create', ${JSON.stringify(key)})`, { ...where, as: holder.email, tenant: holder.workspaceId })
  return typeof made?.token === 'string'
    ? made
    : { error: 'Basecamp made the key but answered no token — revoke it on the API keys screen' }
}

/** The name a key gets in the API keys list when none is given: this machine and the minute. */
export const keyName = () =>
  `fli ${hostname()} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
