---
title: cloudflare:pages
description: List, create and manage Cloudflare Pages projects
alias: cf:pages
examples:
  - fli cf:pages
  - fli cf:pages --create my-site --repo kobamisites/my-site
  - fli cf:pages --status my-site
  - fli cf:pages --deploy my-site
  - fli cf:pages --json
flags:
  account:
    type: string
    description: Account ID (defaults to CLOUDFLARE_ACCOUNT_ID)
    defaultValue: ''
  create:
    type: string
    description: Create a new Pages project with this name
    defaultValue: ''
  repo:
    type: string
    description: GitHub repo for new project in owner/repo format
    defaultValue: ''
  branch:
    type: string
    description: Production branch (default main)
    defaultValue: 'main'
  status:
    type: string
    description: Show deployment status for a project
    defaultValue: ''
  deploy:
    type: string
    description: Trigger a new deployment for a project
    defaultValue: ''
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

<script>
const accountId = (context) => context.flag.account || process.env.CLOUDFLARE_ACCOUNT_ID
</script>

Manage Cloudflare Pages projects — list, create, check deployments, and
trigger new deploys. Requires a token with **Cloudflare Pages / Edit** scope.

```js
const acct = accountId(context)
if (!acct) { log.error('No account ID — set CLOUDFLARE_ACCOUNT_ID or use --account'); return }

// ── CREATE ────────────────────────────────────────────────────────────────────
if (flag.create) {
  if (!flag.repo) { log.error('--create requires --repo owner/repo'); return }
  const [owner, repo] = flag.repo.split('/')
  const payload = {
    name:              flag.create,
    production_branch: flag.branch,
    source: {
      type:   'github',
      config: { owner, repo_name: repo, production_branch: flag.branch },
    },
  }
  log.info(`Creating Pages project: ${flag.create}`)
  log.info(`Repo:   ${flag.repo}  ·  branch: ${flag.branch}`)
  if (flag.dry) { log.dry(`POST /accounts/${acct}/pages/projects`); return }
  const project = await cfApi(context, 'POST', `/accounts/${acct}/pages/projects`, payload)
  log.success(`Created: ${project.name}`)
  echo(`  subdomain: ${project.subdomain}`)
  echo(`  dashboard: https://dash.cloudflare.com/${acct}/pages/view/${project.name}`)
  return
}

// ── DEPLOY ────────────────────────────────────────────────────────────────────
if (flag.deploy) {
  log.info(`Triggering deployment for: ${flag.deploy}`)
  if (flag.dry) { log.dry(`POST /accounts/${acct}/pages/projects/${flag.deploy}/deployments`); return }
  const deployment = await cfApi(context, 'POST', `/accounts/${acct}/pages/projects/${flag.deploy}/deployments`)
  log.success(`Deployment triggered: ${deployment.id}`)
  echo(`  url:    ${deployment.url || 'pending…'}`)
  echo(`  status: ${deployment.latest_stage?.name || 'queued'}`)
  return
}

// ── STATUS ────────────────────────────────────────────────────────────────────
if (flag.status) {
  const deployments = await cfApi(context, 'GET', `/accounts/${acct}/pages/projects/${flag.status}/deployments?per_page=5`)
  echo('')
  echo(`  ${flag.status} — last ${deployments.length} deployments\n`)
  for (const d of deployments) {
    const ts     = new Date(d.created_on).toLocaleString()
    const status = d.latest_stage?.status || 'unknown'
    const icon   = status === 'success' ? '✓' : status === 'failure' ? '✗' : '~'
    echo(`  ${icon}  ${d.id.slice(0, 8)}  ${status.padEnd(10)} ${ts}`)
    echo(`       ${d.url || ''}`)
  }
  echo('')
  return
}

// ── LIST ──────────────────────────────────────────────────────────────────────
const projects = await cfApi(context, 'GET', `/accounts/${acct}/pages/projects?per_page=50`)
if (flag.json) { echo(JSON.stringify(projects, null, 2)); return }

echo('')
echo(`  ${projects.length} Pages project(s)\n`)
for (const p of projects) {
  const latest = p.latest_deployment
  const status = latest?.latest_stage?.status || 'no deployments'
  const icon   = status === 'success' ? '✓' : status === 'failure' ? '✗' : '·'
  echo(`  ${icon}  ${p.name.padEnd(35)} ${p.subdomain}`)
  if (latest) {
    echo(`       last deploy: ${new Date(latest.created_on).toLocaleString()}  ·  ${status}`)
  }
}
echo('')
```
