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
  - fli epull --dry
flags:
  from:
    char: f
    type: string
    description: "Source type: caprover | url | gist | ssh | file"
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
    description: Remote path to the .env file (for ssh source)
    defaultValue: ''
  url:
    char: u
    type: string
    description: URL to fetch env content from (for url source)
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
</script>

Pull environment variables from a remote source and merge them into a local `.env` file.

Supported sources:
- **`caprover`** — reads env vars from a CapRover app via API (requires `CAPROVER_URL` + `CAPROVER_TOKEN`)
- **`url`** — fetches raw env content from any HTTPS URL
- **`gist`** — fetches the first `.env` file from a GitHub Gist
- **`ssh`** — SSHes into a server and cats the remote `.env` file
- **`file`** — copies a local file (useful for syncing between env files)

By default, remote values win on conflicts and local-only keys are preserved (`--merge`).

```js
const destPath = resolve(context.paths.root, flag.to)

// ─── Fetch remote content ─────────────────────────────────────────────────────
log.info(`Pulling env from: ${flag.from}`)

let remoteContent
try {
  if (flag.from === 'url') {
    if (!flag.url) { log.error('--url is required for url source'); return }
    remoteContent = await pullFromUrl(flag.url)
  } else if (flag.from === 'gist') {
    if (!flag['gist-id']) { log.error('--gist-id is required for gist source'); return }
    remoteContent = await pullFromGist(flag['gist-id'])
  } else if (flag.from === 'ssh') {
    remoteContent = pullFromSsh(context.env, flag.server, flag.path)
  } else if (flag.from === 'caprover') {
    remoteContent = await pullFromCaprover(context.env, flag.app)
  } else if (flag.from === 'file') {
    if (!flag.path) { log.error('--path is required for file source'); return }
    const srcPath = resolve(context.paths.root, flag.path)
    if (!existsSync(srcPath)) { log.error(`File not found: ${srcPath}`); return }
    remoteContent = readFileSync(srcPath, 'utf8')
  } else {
    log.error(`Unknown source: ${flag.from}. Use: caprover | url | gist | ssh | file`)
    return
  }
} catch (err) {
  log.error(`Failed to pull from ${flag.from}: ${err.message}`)
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
