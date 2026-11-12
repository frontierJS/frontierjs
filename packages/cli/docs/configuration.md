# FLI configuration and dev setup

### `.fli.json` (project root)

```json
{
  "routesDir":        "cli/src/routes",
  "defaultNamespace": "hello"
}
```

### Environment variables

```bash
# FLI behavior
FLI_PORT=5500              # Web GUI port
FLI_DEBUG=1                # Enable full stack traces (or pass --debug)
WORKSPACE_DIR=~/outlaw     # Workspace root (all ws-* commands)

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

### Credentials

Every account fli signs in to, from `core/services.js`. A key goes in the global
env with `fli eset KEY value --global`; a login is made once with the tool's own
command. `fli doctor` lists each as present or absent and `fli doctor --probe`
asks the logins who they are signed in as. A test fails when this table and the
catalog disagree.

**Profiles — one client's keys per file.** A machine working for several
clients keeps each one's account keys in `~/.config/fli/profiles/<name>.env`
(`FJS-D1942`), made with `fli profile:create <name>` and filled with
`fli eset KEY value --profile <name>`, both at mode 600.
A project picks its profile with `FLI_PROFILE=<name>` in its own `.env`; the
shell's `FLI_PROFILE` overrides it, and `FLI_PROFILE=` names none for one
command (`FJS-D1943`). Variables load shell → project `.env` → profile →
global env, the first to name a key winning, and the global env stays the
fallback (`FJS-D1944`). There is no sticky "current profile": a
`FLI_PROFILE` in the global env or a profile selects nothing. A named profile
that is not `[a-z0-9-]+`, or has no file, refuses every command but the
`profile:` commands and the `eset --profile <name>` that creates it. `fli doctor` names the profile in use
and who named it, each profile file's mode, and any key set in both a profile
and the global env. `fli profiles` (`profile:list`) lists every profile with
its key names (never values), its mode, and the projects under `~/code`
(`--in <dir>`) whose `.env` names it; `fli profile:open [name]` opens one in
`$VISUAL`/`$EDITOR`. There is no current profile: `fli profile:use` refuses
and names `FLI_PROFILE`. A command that spends an account key — `deploy`,
`basecamp:deploy`, `ws:pub`, `ws:post`, `eset` — prints the profile, or
`profile none`, as its first line (`profileLine` in `core/utils.js`), so a
wrong client's keys are seen before they are spent.

| Service | Signs in with | Keys | Make one | Setup |
| --- | --- | --- | --- | --- |
| GitHub (REST) | env | `GITHUB_TOKEN`; optional `GITHUB_DEFAULT_ORG`, `GITHUB_DEFAULT_TEMPLATE` | https://github.com/settings/tokens | `commands/github/_module.md#Setup` |
| GitHub (gh) | `gh auth login` | | | |
| npm | `npm login` | | | |
| DigitalOcean | env | `DIGITALOCEAN_TOKEN` | https://cloud.digitalocean.com/account/api/tokens/new | `commands/server/_module.md#Setup` |
| Hetzner | env | `HETZNER_TOKEN` | https://console.hetzner.cloud/projects | `commands/server/_module.md#Setup` |
| Cloudflare (cf) | `cf auth login` | optional `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DEFAULT_ZONE` | | `commands/cloudflare/_module.md#Setup` |
| Cloudflare (Basecamp DNS token) | env | `CLOUDFLARE_TOKEN` | https://dash.cloudflare.com/profile/api-tokens | `commands/cloudflare/_module.md#Environment variables` |
| Cloudflare (wrangler) | `wrangler login` | optional `CLOUDFLARE_API_TOKEN` | | |
| Basecamp | file `config/basecamps.json` | | | `commands/basecamp/_module.md#Setup` |
| Frontier network | file `state/frontier` | | | |
| Vaultwarden | env | `VW_URL`, `VW_PASSWORD`; optional `VW_CLIENT_ID`, `VW_CLIENT_SECRET`, `VW_EMAIL` | | |
| Anthropic | `claude auth login` | optional `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | | |
| ssh | file `~/.ssh/config` | | | |

### Port schema

`[ENV][CATEGORY][PROJECT][SERVICE]` 4-digit structure. ENV: 7=test, 8=dev, 9=prod — a project's. Global tooling has no project and so no env, and takes a 5 in that place: `5500`–`5509` whole: `5500` (gui), `5502` (studio), `5503` (junction devtools). An app `PROJECTS` does not name is project 0, and `fli dev` gives it a service digit of its own — remembered per app root in `~/.fli/sessions.lock`, under an O_EXCL guard.

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
```

---
