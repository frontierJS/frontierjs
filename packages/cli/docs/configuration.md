# FLI configuration and dev setup

### `.fli.json` (project root)

```json
{
  "routesDir":        "cli/src/routes",
  "defaultNamespace": "hello",
  "editor":           "code"
}
```

### Environment variables

```bash
# FLI behavior
FLI_PORT=5500              # Web GUI port
FLI_DEBUG=1                # Enable full stack traces (or pass --debug)
WORKSPACE_DIR=~/outlaw     # Workspace root (all ws-* commands)
ANTHROPIC_API_KEY=sk-...

# Project directories (override defaults)
WEB_DIR=web
API_DIR=api
DB_DIR=db
SITE_DIR=site
CLI_DIR=cli

# Server targets (env:pull --from ssh + utils:ssh)
DEV_SERVER, DEV_SERVER_PATH
STAGE_SERVER, STAGE_SERVER_PATH
PROD_SERVER, PROD_SERVER_PATH
```

### Port schema

`[ENV][CATEGORY][PROJECT][SERVICE]` 4-digit structure. ENV: 7=test, 8=dev, 9=prod — a project's. Global tooling has no project and so no env, and takes a 5 in that place: `5500`–`5509` whole: `5500` (gui), `5501` (project map, served), `5502` (studio), `5503` (junction devtools). An app `PROJECTS` does not name is project 0, and `fli dev` gives it a service digit of its own — remembered per app root in `~/.fli/sessions.lock`, under an O_EXCL guard.

## Dev setup

```bash
cd packages/cli
bun install
bun link          # makes `fli` available globally
fli gui           # Web GUI at http://localhost:5500
```

```bash
# Recommended .env additions
WORKSPACE_DIR=~/outlaw
ANTHROPIC_API_KEY=sk-...
```

---
