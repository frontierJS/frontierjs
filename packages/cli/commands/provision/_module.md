---
namespace: provision
description: Make the box Basecamp will run on, at DigitalOcean, and hand back how to SSH to it
requires:
  - DIGITALOCEAN_TOKEN
---

<script>
// ─── The Basecamp checkout ────────────────────────────────────────────────────
// The vendor's dialect is Basecamp's compute connector, run in place — never a
// copy here (FJS-D1253). Basecamp is private, so this needs the framework
// checkout fli runs from, the same as ring 0's `fli deploy` of Basecamp.
const provisionScript = () => {
  const root = new URL('../basecamp/', 'file://' + global.fliRoot + '/').pathname
  const script = root + 'api/src/core/provision-host.ts'
  return { root, script }
}

const runProvision = async (input) => {
  const { spawnSync }  = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { root, script } = provisionScript()
  if (!existsSync(script))
    return { error: `no Basecamp checkout at ${root}: fli provision runs from the framework repository` }

  const run = spawnSync('bun', [script, JSON.stringify(input)], {
    cwd: root, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const last = (run.stdout || '').trim().split('\n').pop()
  try { return JSON.parse(last) }
  catch { return { error: `provision-host.ts answered no JSON (exit ${run.status})` } }
}
</script>

## Setup

A DigitalOcean personal access token, in your global fli env.

- Make one: https://cloud.digitalocean.com/account/api/tokens/new
- **Full Access**, or **Custom Scopes**: `droplet` create/read/delete, `ssh_key` create/read, `tag` create, `regions` `sizes` `image` read
- **For Basecamp too** — the same token as a cloud account in Basecamp (Secrets, kind `provider_key`) — add `account` read: Basecamp's Verify reads `/v2/account`, and a token without it fails Verify though it provisions
- Store it: `fli eset DIGITALOCEAN_TOKEN <token> --global`
- The token is shown once; a project `.env` overrides it, for a client's own account

## What it makes

One droplet, tagged `basecamp`, carrying your SSH public key and nothing
else. `fli deploy:setup --auto-install` then installs what the box needs over
SSH, and `fli deploy` from `packages/basecamp` installs Basecamp on it.
