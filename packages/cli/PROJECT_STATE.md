# FLI — Project State

**Version:** 0.1.6  
**Runtime:** node (the shipped shebang); re-invokes itself under whichever
runtime started the parent, which is bun for every test and CI call here  
**Package name:** `@frontierjs/cli` (global binary via `bun link`, command: `fli`)  
**Scope:** `@frontierjs`  
**Repo location:** `packages/cli` inside the FJS monorepo

---

## What FLI is

A modular CLI automation platform where every command is a plain `.md` file, compiled to JavaScript and run — drop a file, it is discovered by the next invocation. The same command files power two interfaces:

- **CLI** — `fli <command> [args] [flags]`
- **Web GUI** — `fli gui` → `http://localhost:8500`

---

## Where it stands

Working. ~210 commands (`fli list --json` is the count). Three deploy modes coexist: Docker/SSH/nginx (default when `frontier.config.js` has a `deploy` block), legacy CapRover, and `ksite:deploy`. Runtime is bun (`FJS-D593`).

## Test suite

One file per module under `core/` plus the deploy-pipeline layer (`plan`,
`journal`, `revert`, `machine`, `deploy-scripts`); see `package.json`'s `test`
script for the explicit list — it is not a glob, so a new file runs nowhere
until it is named there. Run: `bun run test`.

---

## Known issues — see `ISSUES.md`

Open defects for this package are filed there, one id each; nothing is open
unless it is there. Add a new item to `../../ISSUES.md`, not here.

## On the horizon

Whatever `ISSUES.md` and `IDEAS/` still carry against this package — check those.

## Reference (moved)

- Architecture, command anatomy, context object, workspace helpers, Web GUI, startup cost, registry cache, temp files, approach and tools → `docs/architecture.md`
- Deploy pipeline, `frontier.config.js` deploy block, deploy commands, new-Junction-app path → `docs/deploy.md`
- `.fli.json`, environment variables, port schema, dev setup → `docs/configuration.md`
