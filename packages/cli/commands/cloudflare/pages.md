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
    description: Account ID (defaults to CLOUDFLARE_ACCOUNT_ID; needed when the login reaches more than one)
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
  profile:
    type: string
    description: cf profile to run as (default CLOUDFLARE_API_TOKEN, else cf's active login)
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

Manage Cloudflare Pages projects — list, create, check deployments, and
trigger new deploys. Requires a login with **Cloudflare Pages / Edit**.

```js
const { profileFor, pagesProjects, createPagesProject, pagesDeployments, deployPages } =
  await import(new URL('file://' + global.fliRoot + '/core/cloudflare.js'))
const profile = profileFor(flag.profile)
const acct = flag.account || undefined

// ── CREATE ────────────────────────────────────────────────────────────────────
if (flag.create) {
  if (!flag.repo) { log.error('--create requires --repo owner/repo'); return }
  const [owner, repo] = flag.repo.split('/')
  const body = {
    name:              flag.create,
    production_branch: flag.branch,
    source: {
      type:   'github',
      config: { owner, repo_name: repo, production_branch: flag.branch },
    },
  }
  log.info(`Creating Pages project: ${flag.create}`)
  log.info(`Repo:   ${flag.repo}  ·  branch: ${flag.branch}`)
  if (flag.dry) { log.dry(`cf pages projects create --body '${JSON.stringify(body)}'`); return }
  const project = await createPagesProject(profile, acct, body)
  log.success(`Created: ${project.name}`)
  echo(`  ${chalk.dim('subdomain:')} ${project.subdomain}`)
  if (acct) echo(`  ${chalk.dim('dashboard:')} https://dash.cloudflare.com/${acct}/pages/view/${project.name}`)
  return
}

// ── DEPLOY ────────────────────────────────────────────────────────────────────
if (flag.deploy) {
  log.info(`Triggering deployment for: ${flag.deploy}`)
  if (flag.dry) { log.dry(`cf pages projects deployments create ${flag.deploy}`); return }
  const deployment = await deployPages(profile, acct, flag.deploy)
  log.success(`Deployment triggered: ${deployment.id}`)
  echo(`  ${chalk.dim('url:   ')} ${deployment.url || 'pending…'}`)
  echo(`  ${chalk.dim('status:')} ${deployment.latest_stage?.name || 'queued'}`)
  return
}

// ── STATUS ────────────────────────────────────────────────────────────────────
if (flag.status) {
  const deployments = await pagesDeployments(profile, acct, flag.status, 5)
  echo('')
  echo(`  ${chalk.bold(flag.status)}  ${chalk.dim(`·  last ${deployments.length} deployment(s)  ·  ✓ success  ✗ failure  ~ other`)}\n`)
  for (const d of deployments) {
    const ts     = new Date(d.created_on).toLocaleString()
    const status = d.latest_stage?.status || 'unknown'
    const tone   = status === 'success' ? chalk.green : status === 'failure' ? chalk.red : chalk.yellow
    const icon   = status === 'success' ? '✓' : status === 'failure' ? '✗' : '~'
    echo(`  ${tone(icon)}  ${d.id.slice(0, 8)}  ${tone(status.padEnd(10))} ${chalk.dim(ts)}`)
    echo(`       ${chalk.dim(d.url || '')}`)
  }
  echo('')
  return
}

// ── LIST ──────────────────────────────────────────────────────────────────────
const projects = await pagesProjects(profile, acct)
if (flag.json) { echo(JSON.stringify(projects, null, 2)); return }

echo('')
echo(`  ${chalk.bold('Pages')}  ${chalk.dim(`·  ${projects.length} project(s)  ·  ✓ last deploy succeeded  ✗ failed  · none`)}\n`)
for (const p of projects) {
  const latest = p.latest_deployment
  const status = latest?.latest_stage?.status || 'no deployments'
  const tone   = status === 'success' ? chalk.green : status === 'failure' ? chalk.red : chalk.dim
  const icon   = status === 'success' ? '✓' : status === 'failure' ? '✗' : '·'
  echo(`  ${tone(icon)}  ${p.name.padEnd(35)} ${chalk.dim(p.subdomain)}`)
  if (latest) {
    echo(`       ${chalk.dim(`last deploy: ${new Date(latest.created_on).toLocaleString()}  ·  ${status}`)}`)
  }
}
echo('')
```
