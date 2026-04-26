---
title: github:clone
description: Clone a GitHub repository
alias: gh:clone
examples:
  - fli gh:clone kobamisites/my-site
  - fli gh:clone my-site
  - fli gh:clone kobamisites/my-site --dir ~/projects
  - fli gh:clone kobamisites/my-site --ws
  - fli gh:clone kobamisites/my-site --dry
args:
  -
    name: repo
    description: Repository in owner/repo format, or bare name using $GITHUB_DEFAULT_ORG
    required: true
flags:
  dir:
    type: string
    description: Directory to clone into (default — prompts to use cwd or enter a path)
    defaultValue: ''
  ws:
    type: boolean
    description: Clone into $WORKSPACE_DIR/packages/ and run fli ws:add
    defaultValue: false
---

<script>
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import { execSync } from 'child_process'

// githubApi — injected from github/_module.md
</script>

Clones a GitHub repository. If no `--dir` is given, asks whether to clone
into the current directory or prompts for a path.

Pass `--ws` to clone directly into your workspace `packages/` folder and
register it with `fli ws:add`.

## Requirements

- `GITHUB_TOKEN` in your `.env` or `~/.config/fli/.env`
- `git` installed and on PATH

```js
const token = context.env.GITHUB_TOKEN
if (!token) {
  log.error('GITHUB_TOKEN is not set')
  log.info('Add it with:  fli eset GITHUB_TOKEN <your-token> --global')
  log.info('Or open the global env with:  fli config')
  return
}

// Resolve owner/repo — bare name uses $GITHUB_DEFAULT_ORG
let repoArg = arg.repo
if (!repoArg.includes('/')) {
  const defaultOrg = context.env.GITHUB_DEFAULT_ORG
  if (!defaultOrg) {
    log.error(`No org in "${repoArg}" and GITHUB_DEFAULT_ORG is not set`)
    log.info('Use owner/repo format or set GITHUB_DEFAULT_ORG in your .env')
    return
  }
  repoArg = `${defaultOrg}/${repoArg}`
}

const [owner, repoName] = repoArg.split('/')

// Fetch repo info to confirm it exists and get clone URL
let repoData
if (!flag.dry) {
  try {
    repoData = await githubApi(token, 'GET', `/repos/${owner}/${repoName}`)
  } catch (err) {
    log.error(`Repository not found: ${owner}/${repoName}`)
    log.info(err.message)
    return
  }
}

const cloneUrl  = repoData?.clone_url  || `https://github.com/${owner}/${repoName}.git`
const sshUrl    = repoData?.ssh_url    || `git@github.com:${owner}/${repoName}.git`
const isPrivate = repoData?.private    ?? true

// Resolve destination directory
let destDir

if (flag.ws) {
  // --ws: clone into workspace packages/
  const wsRoot = await context.wsRoot()
  if (!wsRoot) { log.error('No workspace path provided'); return }
  destDir = resolve(wsRoot, 'packages', repoName)
} else if (flag.dir) {
  destDir = resolve(flag.dir.replace(/^~/, process.env.HOME || ''), repoName)
} else {
  // Ask: cwd or custom path?
  const cwd = process.cwd()
  const answer = await question(`Clone into current dir (${cwd})? [Y/n]: `)
  if (!answer.trim() || answer.trim().toLowerCase() === 'y') {
    destDir = resolve(cwd, repoName)
  } else {
    const customDir = await question('Enter path: ')
    destDir = resolve(customDir.trim().replace(/^~/, process.env.HOME || ''), repoName)
  }
}

log.info(`Cloning ${owner}/${repoName}${isPrivate ? ' (private)' : ''}`)
log.info(`Into: ${destDir}`)

if (existsSync(destDir)) {
  log.error(`Directory already exists: ${destDir}`)
  return
}

if (flag.dry) return

try {
  // Prefer SSH if ~/.ssh has a github key, otherwise use token-auth HTTPS
  const { existsSync: sshExists } = await import('fs')
  const { homedir: getHome } = await import('os')
  const sshDir = getHome() + '/.ssh'
  const hasSshKey = ['id_ed25519', 'id_rsa', 'id_ecdsa'].some(k =>
    sshExists(`${sshDir}/${k}`)
  )

  let useUrl
  if (hasSshKey) {
    useUrl = sshUrl
    log.info(`Using SSH`)
  } else {
    useUrl = cloneUrl.replace('https://', `https://oauth2:${token}@`)
    log.info(`Using HTTPS with token`)
  }

  execSync(`git clone ${useUrl} "${destDir}"`, { stdio: 'inherit' })
  log.success(`Cloned to ${destDir}`)

  if (flag.ws) {
    // Run ws:add to register it in the workspace
    log.info('Registering in workspace...')
    execSync(`node "${context.env.FLI_ROOT || ''}/bin/fli.js" ws:add "${destDir}"`, { stdio: 'inherit' })
  }

  echo('')
  echo(`  cd ${destDir}`)
} catch (err) {
  log.error(`Clone failed: ${err.message}`)
}
```
