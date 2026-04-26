---
title: github:prs
description: List open pull requests for the current repo or a specified one
alias: gh:prs
examples:
  - fli gh:prs
  - fli gh:prs --repo kobamisites/my-site
  - fli gh:prs --all
  - fli gh:prs --json
flags:
  repo:
    char: r
    type: string
    description: Repository in owner/repo format (defaults to current git remote)
    defaultValue: ''
  all:
    char: a
    type: boolean
    description: Show all PRs including closed ones
    defaultValue: false
  token:
    type: string
    description: Override CLOUDFLARE_TOKEN for this run
    defaultValue: ''
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

Lists pull requests for a repo. Without `--repo` it reads the `origin`
remote from the current git directory and uses that.

```js
const token = context.env.GITHUB_TOKEN

// ── Resolve repo ─────────────────────────────────────────────────────────────
let repoArg = flag.repo
if (!repoArg) {
  // Parse from git remote: https://github.com/owner/repo.git or git@github.com:owner/repo.git
  const remote = context.git.remote()
  if (!remote) {
    log.error('No git remote found and --repo not specified')
    log.info('Run from inside a git repo or pass --repo owner/repo')
    return
  }
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)
  if (!match) {
    log.error(`Could not parse GitHub repo from remote: ${remote}`)
    log.info('Use --repo owner/repo to specify explicitly')
    return
  }
  repoArg = match[1]
}

const state = flag.all ? 'all' : 'open'
const prs   = await githubApi(token, 'GET', `/repos/${repoArg}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`)

if (flag.json) { echo(JSON.stringify(prs, null, 2)); return }

const icon = (pr) => {
  if (pr.state === 'closed' && pr.merged_at) return '↗'  // merged
  if (pr.state === 'closed')                 return '✗'  // closed unmerged
  if (pr.draft)                              return '○'  // draft
  return '●'                                             // open
}

echo('')
echo(`  ${repoArg}  ·  ${prs.length} ${state} PR${prs.length !== 1 ? 's' : ''}`)
echo('')

if (!prs.length) {
  log.info('No pull requests found')
  return
}

for (const pr of prs) {
  const updated = new Date(pr.updated_at).toLocaleDateString()
  const checks  = pr.head?.sha ? '' : ''
  echo(`  ${icon(pr)}  #${String(pr.number).padEnd(5)} ${pr.title}`)
  echo(`       ${pr.user.login}  ·  ${pr.head.ref} → ${pr.base.ref}  ·  updated ${updated}`)
  if (pr.body?.trim()) {
    const preview = pr.body.trim().split('\n')[0].slice(0, 72)
    echo(`       ${preview}${pr.body.length > 72 ? '…' : ''}`)
  }
  echo(`       ${pr.html_url}`)
  echo('')
}
```
