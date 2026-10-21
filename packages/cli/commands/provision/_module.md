---
namespace: provision
description: Make the box Basecamp will run on, at DigitalOcean, and hand back how to SSH to it
requires:
  - DIGITALOCEAN_TOKEN: https://cloud.digitalocean.com/account/api/tokens/new  Pick Full Access
---

<script>
// ─── The Basecamp checkout ────────────────────────────────────────────────────
// The vendor's dialect is Basecamp's compute connector, run in place — never a
// copy here (FJS-D1253). Basecamp is private, so this needs the framework
// checkout fli runs from, the same as ring 0's `fli deploy` of Basecamp.
const provisionScript = () => {
  const root = new URL('../basecamp/', 'file://' + global.fliRoot + '/').pathname
  return { root }
}

// `host-record.ts` beside it is the Cloudflare half, for `provision:dns`.
const runProvision = async (input, file = 'provision-host.ts', env = {}) => {
  const { spawnSync }  = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { root } = provisionScript()
  const script = root + 'api/src/core/' + file
  if (!existsSync(script))
    return { error: `no Basecamp checkout at ${root}: fli provision runs from the framework repository` }

  const run = spawnSync('bun', [script, JSON.stringify(input)], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const last = (run.stdout || '').trim().split('\n').pop()
  try { return JSON.parse(last) }
  catch { return { error: `${file} answered no JSON (exit ${run.status})` } }
}

// Basecamp's own hostname, the one `provision:dns` points at the box.
const webDomain = async () =>
  (await import(provisionScript().root + 'frontier.config.js')).default.deploy.web?.domain

// The token page and what to pick on it are the cloudflare namespace's, read
// off its module so the two commands cannot send a person to different pages.
const cloudflareToken = async ({ interactive, write = true, say }) => {
  if (process.env.CLOUDFLARE_TOKEN) return true
  const { resolve }                    = await import('node:path')
  const { loadModuleFile }             = await import(resolve(global.fliRoot, 'core/registry.js'))
  const { requiresOf, acquireMissing } = await import(resolve(global.fliRoot, 'core/requires.js'))
  const { meta } = loadModuleFile(resolve(global.fliRoot, 'commands/cloudflare/_module.md'))
  const left = await acquireMissing('cloudflare', requiresOf(meta).filter(r => r.key === 'CLOUDFLARE_TOKEN'), { interactive, write, say })
  return !left.length
}

// spawnSync hands the child the environment bun STARTED with, so a token
// pasted just now goes on the call itself.
const hostRecord = (input) => runProvision(input, 'host-record.ts', { CLOUDFLARE_TOKEN: process.env.CLOUDFLARE_TOKEN })

// One row of `provision:list`, and of the pick `provision:destroy` offers with no id.
const machineLine = (m) =>
  `${m.id}  ${m.status}  ${m.ip ?? 'no address yet'}  ${m.region ?? '-'}  `
  + (m.serverId ? `Basecamp server ${m.serverId} — destroy it in Basecamp` : 'unclaimed')

// ─── Ring 0 from here ─────────────────────────────────────────────────────────
// `fli deploy:setup` and `fli deploy` as child runs of this fli, in the Basecamp
// checkout, on this terminal. Not imported: each is a command with its own
// steps, journal and lock, and running it as a process is what keeps that so.
const runFli = async (argv) => {
  const { spawnSync } = await import('node:child_process')
  const { resolve }   = await import('node:path')
  const { root } = provisionScript()
  const r = spawnSync(process.execPath, [resolve(global.fliRoot, 'bin/fli.js'), ...argv],
    { cwd: root, stdio: 'inherit', env: process.env })
  return r.status ?? 1
}

// A droplet has an address before it has an sshd. BatchMode, so nothing here
// can wait on a password; accept-new records the host key once, so the ring 0
// runs after it meet a known host and ask nothing.
const waitForSsh = async (dest, { identity, timeoutMs = 240_000, everyMs = 5_000 } = {}) => {
  const { spawnSync }  = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new',
    ...(identity && existsSync(identity) ? ['-i', identity] : []), dest, 'true']
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (spawnSync('ssh', args, { stdio: 'ignore' }).status === 0) return true
    await new Promise(r => setTimeout(r, everyMs))
  }
  return false
}
</script>

## Setup

A DigitalOcean personal access token, in your global fli env. A first run at a
terminal walks you through it: it opens the page the token is made on, takes
the paste, stores it, and asks whether to install Basecamp on the box once it
is up.

- **Full Access**, or **Custom Scopes**: `droplet` create/read/delete, `ssh_key` create/read, `tag` create, `regions` `sizes` `image` read
- **For Basecamp too** — the same token as a cloud account in Basecamp (Secrets, kind `provider_key`) — add `account` read: Basecamp's Verify reads `/v2/account`, and a token without it fails Verify though it provisions
- Store it: `fli eset DIGITALOCEAN_TOKEN <token> --global` — a run with none leaves a placeholder line there
- The token is shown once; a project `.env` overrides it, for a client's own account

## What it makes

One droplet, tagged `basecamp`, carrying your SSH public key and nothing
else. `fli deploy:setup --auto-install` then installs what the box needs over
SSH, and `fli deploy` from `packages/basecamp` installs Basecamp on it.
