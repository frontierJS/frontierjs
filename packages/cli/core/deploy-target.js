// ─── deploy-target.js — where a deploy target lives ──────────────────────────
//
// The target, the ssh destination and the files on it, read off the deploy
// block. `deploy:*` reaches these through its `_module.md` and `env:push`
// imports them, so a key pushed for `dev` lands in the file the deploy's env
// check reads for `dev` — one answer, not a second resolution in another
// namespace.

// The scaffold's `deploy.server`. It is a real domain, so a command that would
// ssh to it refuses instead: `ssh your-server.com` is somebody else's box.
export const PLACEHOLDER_SERVER = 'your-server.com'

// ─── resolveTarget ────────────────────────────────────────────────────────────
// Resolves the deploy target from flags and git branch.
// Priority: --production > --stage > branch name > dev
//
// Usage in any deploy command:
//   const target = resolveTarget(flag, $.git)
export const resolveTarget = (flag, git) => {
  if (flag.production) return 'production'
  const branch = git?.branch?.() ?? ''
  if (flag.stage || ['stage', 'staging'].includes(branch)) return 'stage'
  return 'dev'
}

// ─── sshHost ──────────────────────────────────────────────────────────────────
// What `ssh` is handed. With no user stated it is the bare server, so an alias in
// ~/.ssh/config supplies User, Port, IdentityFile and ProxyJump; a stated user
// is prefixed, and wins over the alias's own.
export const sshHost = (user, server) => user ? `${user}@${server}` : server

// ─── resolveDeployConf ────────────────────────────────────────────────────────
// Extracts the resolved server/user/path for a given target from the deploy
// block, applying per-target overrides over the top-level values.
//
// Returns null if the required fields are missing — callers should check and
// set $.config.abort = true before returning.
//
// `abort` is a REFUSAL and fails the command: the runtime exits non-zero on it
// even when nothing threw, which is what stops a refusal reading as success
// (`FJS-589`). A deliberate early exit that SUCCEEDED — `--plan` prints a plan
// and stops — sets `$.config.stop` instead. Both skip every later step;
// they differ only in the outcome, and `abort` is the fail-closed default.
//
// Usage:
//   const conf = resolveDeployConf(deployConf, target)
//   if (!conf) { log.error('...'); $.config.abort = true; return }
export const resolveDeployConf = (deployConf, target) => {
  if (!deployConf?.server) return null
  const targetConf = deployConf[target] ?? {}
  const server = targetConf.server ?? deployConf.server
  const user   = targetConf.user   ?? deployConf.user ?? null
  const path   = targetConf.path   ?? deployConf.path
  if (!server || !path) return null
  return { server, user, path, host: sshHost(user, server) }
}

// ─── resolveSide ──────────────────────────────────────────────────────────────
// The same resolution, per SIDE — 'api' or 'web' — so the two halves of an app
// can live on different machines. A split is the ordinary shape once the API is
// its own origin (api.myapp.com), and the transport already assumes nothing
// about co-location: the browser client takes an absolute url and /ws is
// registered beneath the router, so it never carries apiPrefix either.
//
// Most specific wins, and a side that says nothing inherits the shared value —
// so an unsplit config keeps behaving exactly as it did:
//
//   deploy[target][side]  →  deploy[side]  →  deploy[target]  →  deploy
//
// `deploy.web` already carries domain/keep_releases/ssl and `deploy.api` carries
// port/health/dockerfile, so server/user/path join blocks that exist rather than
// introducing a shape.
//
// Returns null when the side cannot be resolved; callers abort by name.
export const resolveSide = (deployConf, target, side) => {
  if (!deployConf) return null
  const t     = deployConf[target] ?? {}
  const ts    = t[side] ?? {}
  const s     = deployConf[side] ?? {}
  const server = ts.server ?? s.server ?? t.server ?? deployConf.server
  const user   = ts.user   ?? s.user   ?? t.user   ?? deployConf.user ?? null
  const path   = ts.path   ?? s.path   ?? t.path   ?? deployConf.path
  if (!server || !path) return null
  return { server, user, path, host: sshHost(user, server) }
}

// The API's database directory, env file and secrets directory on the target.
// The swap mounts them, setup creates them, and the box's Outpost grades their
// modes, so a default restated in one step would grade a different path from the
// one mounted.
export const apiFiles = (deployConf, serverPath) => ({
  dbDir:      deployConf?.db?.path ?? `${serverPath}/db`,
  envFile:    deployConf?.api?.env ?? `${serverPath}/.env.production`,
  secretsDir: `${serverPath}/secrets`,
})
