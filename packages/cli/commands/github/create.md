---
title: github:create
description: Create a new GitHub repository from a template
alias: gh:create
examples:
  - fli gh:create my-new-site
  - fli gh:create my-new-site --org frontierjs
  - fli gh:create my-new-site --template kobamisites/ksite --public
  - fli gh:create my-new-site --dry
args:
  -
    name: name
    description: Repository name
    required: true
flags:
  debug:
    type: boolean
    description: Show token and API diagnostic info
    defaultValue: false
  org:
    char: o
    type: string
    description: Owner (org or user). Defaults to $GITHUB_DEFAULT_ORG or your authenticated user
    defaultValue: ''
  template:
    char: t
    type: string
    description: Template repo in owner/repo format
    defaultValue: ''
  public:
    type: boolean
    description: Make the repository public (default is private)
    defaultValue: false
  description:
    char: d
    type: string
    description: Repository description
    defaultValue: ''
---

<script>
// githubApi — injected from github/_module.md

</script>

Creates a new GitHub repository from a template. The template defaults to
`kobamisites/ksite` but can be overridden per-run or via `GITHUB_DEFAULT_TEMPLATE`
in your `.env`. The repo is private by default.

## Requirements

- `GITHUB_TOKEN` in your `.env` (or the global fli env at `~/.config/fli/.env`)
- Token needs `repo` scope to create private repos

```js
const token = context.env.GITHUB_TOKEN
if (!token) {
  log.error('GITHUB_TOKEN is not set')
  log.info('Add it with:  fli eset GITHUB_TOKEN <your-token> --global')
  log.info('Or open the global env with:  fli config')
  return
}

// Resolve owner: --org flag → $GITHUB_DEFAULT_ORG → authenticated user
let owner = flag.org || context.env.GITHUB_DEFAULT_ORG || null
if (!owner) {
  log.info('Resolving authenticated GitHub user...')
  if (!flag.dry) {
    try { owner = await getAuthUser(token) }
    catch (err) { log.error(`Could not resolve GitHub user: ${err.message}`); return }
  } else {
    owner = '<your-github-user>'
  }
}

// Resolve template: --template flag → $GITHUB_DEFAULT_TEMPLATE → kobamisites/ksite
const template = flag.template || context.env.GITHUB_DEFAULT_TEMPLATE || 'kobamisites/ksite'
const [tmplOwner, tmplRepo] = template.split('/')
if (!tmplOwner || !tmplRepo) {
  log.error(`Invalid template format "${template}" — expected owner/repo`)
  return
}

const repoName    = arg.name
const fullName    = `${owner}/${repoName}`
const isPrivate   = !flag.public
const description = flag.description || ''

// ── Token diagnostic ─────────────────────────────────────────────────────────
if (flag.debug) {
  log.info(`Token:    ${token.slice(0,8)}...${token.slice(-4)}  (${token.startsWith('ghp_') ? 'classic' : token.startsWith('github_pat_') ? 'fine-grained' : 'unknown type'})`)
  try {
    const user = await githubApi(token, 'GET', '/user')
    log.info(`Auth as:  ${user.login}  (${user.type})`)
    const scopes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
    }).then(r => r.headers.get('x-oauth-scopes') || 'none listed')
    log.info(`Scopes:   ${scopes}`)
  } catch (err) {
    log.error(`Token check failed: ${err.message}`)
    return
  }
  try {
    const tmpl = await githubApi(token, 'GET', `/repos/${tmplOwner}/${tmplRepo}`)
    log.info(`Template: ${tmpl.full_name}  is_template=${tmpl.is_template}  private=${tmpl.private}`)
  } catch (err) {
    log.error(`Can't read template ${template}: ${err.message}`)
    log.info('Token may not have access to this repo')
    return
  }
  echo('')
}

log.info(`Creating repository:  ${fullName}`)
log.info(`Template:             ${template}`)
log.info(`Visibility:           ${isPrivate ? 'private' : 'public'}`)
if (description) log.info(`Description:          ${description}`)

if (flag.dry) return

try {
  const repo = await githubApi(token, 'POST', `/repos/${tmplOwner}/${tmplRepo}/generate`, {
    owner,
    name: repoName,
    description,
    private: isPrivate,
    include_all_branches: false,
  })

  log.success(`Repository created`)
  echo('')
  echo(`  ${repo.html_url}`)
  echo('')
  echo(`  Clone with:  git clone ${repo.clone_url}`)
  echo(`  Or run:      fli gh:clone ${owner}/${repoName}`)
} catch (err) {
  log.error(`Failed to create repository: ${err.message}`)
  if (err.message.includes('404') || err.message.includes('Not Found')) {
    log.info(`Check that ${template} exists and has "Template repository" enabled`)
    log.info('GitHub: repo Settings → check "Template repository"')
    log.info(`Or use --template owner/other-repo to specify a different template`)
  }
}
```
