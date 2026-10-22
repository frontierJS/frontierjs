---
title: env:pull
description: Pull environment variables from a remote source into a local .env file
alias: epull
examples:
  - fli epull --from caprover
  - fli epull --from url --url https://my-secret-store.example.com/env
  - fli epull --from gist --gist-id abc123
  - fli epull --from ssh --server prod --path /srv/app/.env
  - fli epull --from caprover --app my-api --to .env.production
  - fli epull --from vaultwarden
  - fli epull --from vaultwarden --path .env.vault --to .env.production
  - fli epull --from send --url 'https://warden.example.com/#/send/<id>/<key>'
  - fli epull --dry
flags:
  from:
    char: f
    type: string
    choices: [caprover, url, gist, ssh, file, vaultwarden, send]
    description: Where the variables come from
    defaultValue: caprover
  to:
    char: t
    type: string
    description: Local destination file
    defaultValue: .env
  app:
    char: a
    type: string
    description: App name (for caprover source)
    defaultValue: ''
  server:
    char: s
    type: string
    description: SSH server alias (for ssh source) — reads from $PROD_SERVER etc
    defaultValue: prod
  path:
    char: p
    type: string
    description: 'The file read — ssh: the remote .env · file: the local source · vaultwarden: the refs (default .env.example)'
    defaultValue: ''
  url:
    char: u
    type: string
    description: 'URL to fetch env content from (url source) · the Send link (send source)'
    defaultValue: ''
  password:
    type: string
    description: The Send's password, when it has one (for send source)
    defaultValue: ''
  gist-id:
    type: string
    description: GitHub Gist ID (for gist source)
    defaultValue: ''
  merge:
    char: m
    type: boolean
    description: Merge into existing file instead of overwriting
    defaultValue: true
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

// Merge two env file strings — remote wins on conflicts, local-only keys preserved
const mergeEnv = (localContent, remoteContent) => {
  const parseKV = (content) => {
    const map = new Map()
    for (const line of content.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const idx = t.indexOf('=')
      if (idx === -1) continue
      map.set(t.slice(0, idx).trim(), line) // store full line to preserve formatting
    }
    return map
  }

  const localMap  = parseKV(localContent)
  const remoteMap = parseKV(remoteContent)

  const lines = localContent.split('\n').map(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    const idx = t.indexOf('=')
    if (idx === -1) return line
    const key = t.slice(0, idx).trim()
    if (remoteMap.has(key)) {
      const updated = remoteMap.get(key)
      remoteMap.delete(key) // mark as handled
      return updated
    }
    return line
  })

  // Append any remote-only keys that weren't in local
  if (remoteMap.size > 0) {
    lines.push('')
    lines.push('# ─── pulled from remote ─────────────────────────────')
    for (const line of remoteMap.values()) lines.push(line)
  }

  return lines.join('\n')
}

// ─── Source adapters ──────────────────────────────────────────────────────────

const pullFromUrl = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return await res.text()
}

const pullFromGist = async (gistId) => {
  const res  = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fli-cli' }
  })
  if (!res.ok) throw new Error(`GitHub API error ${res.status}`)
  const data = await res.json()
  // Find first file that looks like an env file
  const file = Object.values(data.files).find(f =>
    f.filename.startsWith('.env') || f.filename.endsWith('.env')
  )
  if (!file) throw new Error('No .env file found in gist')
  return file.content
}

const pullFromSsh = (env, server, remotePath) => {
  const serverAlias = server === 'prod' ? env.PROD_SERVER
    : server === 'stage' ? env.STAGE_SERVER
    : server === 'dev'   ? env.DEV_SERVER
    : server

  const serverPath = server === 'prod' ? env.PROD_SERVER_PATH
    : server === 'stage' ? env.STAGE_SERVER_PATH
    : env.DEV_SERVER_PATH

  if (!serverAlias) throw new Error(`Server alias "${server}" not configured in .env`)
  const path = remotePath || `${serverPath}/.env`
  return execSync(`ssh ${serverAlias} "cat ${path}"`, { encoding: 'utf8' })
}

const pullFromCaprover = async (env, appName) => {
  const captain = env.CAPROVER_URL || env.DEV_CAPTAIN
  const token   = env.CAPROVER_TOKEN
  if (!captain) throw new Error('CAPROVER_URL or DEV_CAPTAIN not set in .env')
  if (!token)   throw new Error('CAPROVER_TOKEN not set in .env')
  if (!appName) throw new Error('--app is required for caprover source')

  const base = captain.replace(/\/$/, '')
  const res  = await fetch(`${base}/api/v2/user/apps/appData/${appName}`, {
    headers: { 'x-captain-auth': token }
  })
  if (!res.ok) throw new Error(`CapRover API error ${res.status}`)
  const data = await res.json()
  const vars = data?.data?.appDefinition?.envVars || []
  return vars.map(({ key, value }) => `${key}=${value}`).join('\n') + '\n'
}

// The vault user is the operator's, not the app's, so its keys usually sit in
// the global env (`fli eset VW_PASSWORD …`) rather than in the file being written.
// Only `KEY=vw://Item/field` lines are pulled: a plain value in the refs file is
// an example, and merging it would overwrite the local value it stands for.
const VW_REF = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"]?)vw:\/\/(.+)\2\s*$/

const pullFromVaultwarden = async (env, refsPath) => {
  if (!existsSync(refsPath)) throw new Error(`no refs file at ${refsPath} — lines like STRIPE_KEY=vw://Stripe/password`)
  const refs = readFileSync(refsPath, 'utf8').split('\n').map(l => l.trim().match(VW_REF)).filter(Boolean)
  if (!refs.length) throw new Error(`${refsPath} holds no KEY=vw://Item/field line`)
  const { openVault, dotenvLine } = await import(resolve(global.fliRoot, 'core/vaultwarden.js'))
  const vault = await openVault({
    url: env.VW_URL, clientId: env.VW_CLIENT_ID, clientSecret: env.VW_CLIENT_SECRET,
    email: env.VW_EMAIL, password: env.VW_PASSWORD,
  })
  const lines = []
  const missing = []
  const skipped = []
  for (const [, key, , ref] of refs) {
    const value = vault.get(ref)
    if (value === null) { missing.push(`${key} (vw://${ref})`); continue }
    const line = dotenvLine(key, value)
    if (line) lines.push(line)
    else skipped.push(key)
  }
  // A partial pull reads as a complete one in the file it writes.
  if (missing.length) throw new Error(`${vault.email} finds no value for ${missing.join(', ')}`)
  return { content: lines.join('\n') + '\n', skipped }
}

const pullFromSend = async (link, password) => {
  const { receiveSend } = await import(resolve(global.fliRoot, 'core/vaultwarden.js'))
  const { text } = await receiveSend(link, { password: password || null })
  return text.endsWith('\n') ? text : text + '\n'
}
</script>

Pull environment variables from a remote source and merge them into a local `.env` file.

Supported sources:
- **`caprover`** — reads env vars from a CapRover app via API (requires `CAPROVER_URL` + `CAPROVER_TOKEN`)
- **`url`** — fetches raw env content from any HTTPS URL
- **`gist`** — fetches the first `.env` file from a GitHub Gist
- **`ssh`** — SSHes into a server and cats the remote `.env` file
- **`file`** — copies a local file (useful for syncing between env files)
- **`vaultwarden`** — resolves each `KEY=vw://Item/field` line in `.env.example` (or `--path`) against a Vaultwarden/Bitwarden vault, decrypted in-process; other lines are ignored. `vw://Stripe` is the login's password, `vw://Stripe/username` a standard field, `vw://Stripe/STRIPE_KEY` a custom one, and an item name two items share is named by id. Logs in as `VW_URL` + `VW_CLIENT_ID`/`VW_CLIENT_SECRET` (or `VW_EMAIL`) + `VW_PASSWORD` — a dedicated vault user, read-only on what the app needs. A ref with no value refuses the whole pull; a value no `.env` spelling reads back the same under both fli and Bun (one holding `$`) is skipped and named, never written altered
- **`send`** — reads a Vaultwarden/Bitwarden text Send (`--url`, the link `fli env:send` prints), decrypted in-process with the key in the link's fragment; no vault login. **Every pull is one access, `--dry` included** — a Send capped at one read is spent by the first, whatever happens to the text after

By default, remote values win on conflicts and local-only keys are preserved (`--merge`).

```js
const destPath = resolve($.paths.root, flag.to)

// ─── Fetch remote content ─────────────────────────────────────────────────────
log.info(`Pulling env from: ${flag.from}`)

let remoteContent
try {
  if (flag.from === 'url') {
    if (!flag.url) { log.error('--url is required for url source'); process.exitCode = 1; return }
    remoteContent = await pullFromUrl(flag.url)
  } else if (flag.from === 'gist') {
    if (!flag['gist-id']) { log.error('--gist-id is required for gist source'); process.exitCode = 1; return }
    remoteContent = await pullFromGist(flag['gist-id'])
  } else if (flag.from === 'ssh') {
    remoteContent = pullFromSsh($.env, flag.server, flag.path)
  } else if (flag.from === 'caprover') {
    remoteContent = await pullFromCaprover($.env, flag.app)
  } else if (flag.from === 'vaultwarden') {
    const { loginNeeds }               = await import(resolve(global.fliRoot, 'core/vaultwarden.js'))
    const { acquireMissing, ttyPrompts } = await import(resolve(global.fliRoot, 'core/requires.js'))
    const needs = loginNeeds($.env)
    if (needs.length) {
      const left = await acquireMissing('env:pull --from vaultwarden', needs, {
        interactive: tty.interactive, write: !flag.dry, env: $.env,
        say: (t, level = 'error') => log[level](t), ...ttyPrompts(tty),
      })
      if (left.length) { process.exitCode = 1; return }
    }
    const pulled = await pullFromVaultwarden($.env, resolve($.paths.root, flag.path || '.env.example'))
    remoteContent = pulled.content
    if (pulled.skipped.length) log.warn(`Skipped, set by hand: ${pulled.skipped.join(', ')} — a value holding $ (or ' beside " or \\) has no .env spelling fli and Bun both read back unchanged`)
  } else if (flag.from === 'send') {
    if (!flag.url) { log.error('--url is required for send source'); process.exitCode = 1; return }
    remoteContent = await pullFromSend(flag.url, flag.password)
  } else if (flag.from === 'file') {
    if (!flag.path) { log.error('--path is required for file source'); process.exitCode = 1; return }
    const srcPath = resolve($.paths.root, flag.path)
    if (!existsSync(srcPath)) { log.error(`File not found: ${srcPath}`); process.exitCode = 1; return }
    remoteContent = readFileSync(srcPath, 'utf8')
  } else {
    log.error(`Unknown source: ${flag.from}. Use: caprover | url | gist | ssh | file | vaultwarden | send`)
    process.exitCode = 1
    return
  }
} catch (err) {
  log.error(`Failed to pull from ${flag.from}: ${err.message}`)
  process.exitCode = 1
  return
}

const remoteLines = remoteContent.trim().split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
log.info(`Received ${remoteLines.length} variable(s)`)

if (flag.dry) {
  log.dry(`Would write ${remoteLines.length} vars to ${destPath}`)
  echo('')
  echo(remoteContent.trim())
  return
}

// ─── Write or merge ───────────────────────────────────────────────────────────
let finalContent
if (flag.merge && existsSync(destPath)) {
  const local = readFileSync(destPath, 'utf8')
  finalContent = mergeEnv(local, remoteContent)
  log.info(`Merged with existing ${flag.to}`)
} else {
  finalContent = remoteContent
  if (existsSync(destPath)) log.warn(`Overwriting ${destPath}`)
}

writeFileSync(destPath, finalContent, 'utf8')
log.success(`Pulled ${remoteLines.length} var(s) → ${destPath}`)
```
