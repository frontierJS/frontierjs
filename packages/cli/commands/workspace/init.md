---
title: workspace:init
description: Scaffold the outlaw monorepo root
alias: ws:init
examples:
  - fli ws:init
  - fli ws:init --dir ~/projects/outlaw
  - fli ws:init --dry
flags:
  dir:
    type: string
    description: Where to create the workspace (overrides $WORKSPACE_DIR)
    defaultValue: ''
---

<script>
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
</script>

Creates the **outlaw** monorepo root — the single directory that holds
all your `@frontierjs` packages. Run this once per machine.

## What gets created

- `packages/` — drop your repos here with `fli ws:add`
- `package.json` — private workspace root, `workspaces: ["packages/*"]`
- `.gitignore` — node_modules, .env, dist, .turbo

## After running

```
export WORKSPACE_DIR={{wsRoot}}
cd {{wsRoot}}
fli ws:add ~/projects/my-package
bun install
```

Set `WORKSPACE_DIR` in your `.env` once and you'll never be prompted again.

```js
let wsRoot = flag.dir
  ? flag.dir.trim().replace(/^~/, process.env.HOME || '')
  : await context.wsRoot()
if (!wsRoot) { log.error('No path provided'); return }

context.vars.wsRoot = wsRoot

if (existsSync(wsRoot) && existsSync(resolve(wsRoot, 'package.json'))) {
  log.warn(`Workspace already exists at ${wsRoot}`)
  log.info('Use `fli ws:add` to add packages to it')
  return
}

if (flag.dry) {
  context.printPlan()
  return
}

const pkgJson = {
  name: 'outlaw', private: true,
  workspaces: ['packages/*'],
  scripts: { test: 'bun test', dev: 'bun run dev' }
}
const gitignore = 'node_modules\n.DS_Store\n*.log\n.env\ndist\n.turbo\n'

mkdirSync(resolve(wsRoot, 'packages'), { recursive: true })
writeFileSync(resolve(wsRoot, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf8')
writeFileSync(resolve(wsRoot, '.gitignore'), gitignore, 'utf8')

log.success(`Workspace created at ${wsRoot}`)
```
