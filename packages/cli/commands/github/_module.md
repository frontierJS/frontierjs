---
namespace: github
description: GitHub repository management via the REST API
requires:
  - GITHUB_TOKEN
defaults:
  flags:
    org:
      defaultValue: '${GITHUB_DEFAULT_ORG}'
---

<script>
const githubApi = async (token, method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) {
    const detail = data.errors ? '  ' + data.errors.map(e => e.message).join(', ') : ''
    throw new Error(`${res.status} ${data.message || 'Unknown error'}${detail}`)
  }
  return data
}

const getAuthUser = async (token) => {
  const data = await githubApi(token, 'GET', '/user')
  return data.login
}
</script>

## Setup

You need a GitHub Personal Access Token to use any `github:` command.

1. Go to **github.com → Settings → Developer settings → Personal access tokens**
2. Create a **classic token** with `repo` scope
3. Add it to your global fli env:

```
fli eset GITHUB_TOKEN ghp_xxxx --global
fli eset GITHUB_DEFAULT_ORG kobamisites --global
```

## Token types

- **Classic** (`ghp_`) — easiest, works immediately with `repo` scope
- **Fine-grained** (`github_pat_`) — more secure, but must explicitly grant access to each org

## Troubleshooting

If you're getting `404 Not Found` when creating repos from a template:

- Make sure the template repo has **"Template repository"** checked in its GitHub Settings
- Run `fli github:create <name> --debug` to diagnose token and template access

## Environment variables

- `GITHUB_TOKEN` — required for all github commands
- `GITHUB_DEFAULT_ORG` — default org for `--org` flag (e.g. `kobamisites`)
- `GITHUB_DEFAULT_TEMPLATE` — default template repo (e.g. `kobamisites/ksite`)
