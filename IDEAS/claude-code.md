---
id: claude-code
status: proposed
dated: 2026-10-31
---

# Claude Code in Basecamp — its configuration, context and spend on one screen

**Status: PROPOSED.** Dated 2026-10-31. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

A Basecamp screen over what Claude Code reads from `~/.claude/`: the plugins,
marketplaces, skills, agents, hooks and MCP servers it loads, what they cost the
context window, the sessions and tokens it has spent, and the settings it runs
with. It reads, and through the `claude` CLI or one file writer, it changes.
Every noun is Claude Code's own; this plan coins none.

The behavior reference is CLACOROO (`github.com/Maxymize/clacoroo`, `b7978f1`,
2026-10-16), an Electron app doing this on a desktop. **It is AGPL-3.0, so this
port is written from its behavior and never from its files**: read it to learn
what a screen does and which file Claude Code keeps a fact in, then write the
Basecamp version fresh. No file, function body or stylesheet is copied, and no
source file is open beside the one being written.

## The shape

- **A tab on `/workbench/`** (`FJS-D1708`), machine-wide where the pins are per
  checkout, so the tab says so in its heading. Behind `localMachineRefusal()` (`api/src/core/env.ts`;
  `LOCAL_MACHINE=1`, never under `NODE_ENV=production`) and at ADMINISTRATOR,
  like `services/workbench/workbench.service.ts`. A deployed Basecamp would read
  its server's `~/.claude`, which is nobody's.
- **A live scan is the truth.** Every read goes to the files at request time.
  `CLAUDE_CONFIG_DIR` is honored the way Claude Code honors it, else `~/.claude`.
  The scan has no model, and its resource is `createResource(…, { model: null })`
  as `resources/Workbench.mesa` is.
- **Basecamp's database holds only history**: a write's undo image (3.1), and
  the usage index (`FJS-D1714`, 2.3) — rebuildable from the transcripts still
  on disk, and the only record of those Claude Code has cleaned up. Every write
  lands in Basecamp's activity trail, so `/activity/` is the action log.
- **Readers are pure.** Text in, value out, no fs, the way
  `packages/cli/core/claude-usage.js` is — so a format Claude Code changes is a
  fixture away from a test (Phase 6), and a reader that cannot parse returns
  *unavailable*, never a wrong number.
- **The `claude` CLI is spawned from `domain/local/`**, beside `local-git.ts` and
  `local-ssh.ts`: argv only, `CLAUDE_BIN` from env, its output parsed in one
  place per command.
- **English only.** CLACOROO's Italian locale is not ported.
- **The default UI kit, first pass plain.** `@frontierjs/ui` components on
  `@frontierjs/css` tones. The goal is every behavior working, not a visual
  match: tables and cards over the kit, no heatmap art, no mascot, no tour.

## What is not ported

The auto-update check, the review and sponsor prompts, the feedback form, the
onboarding tour, native notifications, native file dialogs and "reveal in
folder", the DMG/NSIS builds, and the locale audit script. "Open in editor" is
a plain `vscode://file/<path>` link: the browser and the files are on one
machine, so it needs no API.

## Open questions

- ~~**Q1 — Where does the screen live?**~~ **Answered 2026-10-31 (`FJS-D1708`): B — a tab on `/workbench/`.**
  - **A** — `/claude/`, nav label *Claude Code*, under *Build* beside Workbench.
  - **B** — a tab on `/workbench/`.
  - **Recommend A** — the Workbench is per checkout and this is per machine; a
    tab would make a global thing look pinned.
- ~~**Q2 — Which projects are scanned for project-scope config?**~~ **Answered 2026-10-31 (`FJS-D1709`): C — both, pins first.** (`.claude/` in a
  checkout, `.mcp.json`, project `CLAUDE.md`)
  - **A** — the Workbench's pins.
  - **B** — every `cwd` found in the transcript history (`~/.claude/projects/*`).
  - **C** — both, pins first.
  - **Recommend C** — pins are the ones the operator cares about, and history
    finds the rest without a second list to keep.
- ~~**Q3 — Are stats over the transcripts scanned live, or indexed?**~~ **Answered 2026-10-31 (`FJS-D1714`): B — an index model in Basecamp's database, appended from each file's last read offset.**
  - **A** — scan every JSONL on each request.
  - **B** — an index model in Basecamp's database, appended from each file's
    last read offset.
  - **Recommend B** — 0.2 measured 21 s for a full parse and 6.4 s for the
    last 7 days, against a 1 s bar. Claude Code also deletes transcripts after
    `cleanupPeriodDays` (30 by default), so a live scan can never show more
    than a month and the index is the only place older spend survives. An
    append reads only new bytes (~13 MB an hour of active use here).
- ~~**Q4 — Is the Anthropic API key CLACOROO stores as `apiKeyHelper` ported?**~~ **Answered 2026-10-31 (`FJS-D1710`): A — not ported; Basecamp's `ANTHROPIC_API_KEY` env already covers its own runs.**
  - **A** — not ported; Basecamp's `ANTHROPIC_API_KEY` env already covers its
    own runs.
  - **B** — kept in the OS keychain as CLACOROO does.
  - **C** — a Basecamp `Secret` (`@encrypted`) with a helper script that asks
    the API.
  - **Recommend A** — it is the one feature that writes a credential Claude Code
    reads, and nothing else here needs it.
- ~~**Q5 — Are the quota bars ported?**~~ **Answered 2026-10-31 (`FJS-D1711`): A — port it, read-only, and never refresh the token (the refresh token rotates, so refreshing it signs out every running `claude`); a failed read shows *unavailable*.** They read
  `GET api.anthropic.com/api/oauth/usage` with the beta header
  `oauth-2025-04-20`: a private endpoint, read with the OAuth token Claude Code
  keeps.
  - **A** — port it, read-only, and never refresh the token (the refresh token
    rotates, so refreshing it signs out every running `claude`); a failed read
    shows *unavailable*.
  - **B** — skip it.
  - **Recommend A** — the bars are the reason people open this screen.

## Phase 0 — Groundwork

Goal: the inventory and the numbers that rule Q2–Q3, before any code.
Done when: § Inventory is filled and Q1–Q5 are ruled.

- [x] 0.1 Behavior inventory — one row per CLACOROO IPC handler in its
  `src/main.js`: what it reads or writes, which file or CLI call, and the
  Basecamp service method it becomes, or *not ported*. Written in our words.
  - Found four behaviors the steps lacked, now in them: the quota read's 429
    backoff (2.6), MCP disable as remove-and-stash (3.3), the permissions
    editor (3.4a), and the watcher ignoring its own writes (4.1).
- [x] 0.2 Measure this machine — the size of `~/.claude`, the count and bytes of
  transcript JSONL, and the time for one full parse with Bun. Rules Q3.
  - 2026-10-31, `~/.claude` 7.3 GB. Transcripts: 5,049 JSONL (729 subagent)
    in 131 project folders, 6.6 GB, largest 45.8 MB, oldest 2026-09-25.
    Walk and stat 103 ms. `tallySession` from `claude-usage.js` over files
    touched in the last 7 days: 1,009 files, 996 MB, 6.4 s; over all: 21 s at
    ~310 MB/s warm, 306 MB RSS. Growth: 14 files, 12.8 MB in the last hour.
- [x] 0.3 Rule Q1–Q5 through the question tool.

**Done 2026-10-31.** Every handler has a home or a reason, and Q1–Q5 are
`FJS-D1708`–`D1711` and `FJS-D1714`. The measurement moved Q3: 6.6 GB of
transcripts take 21 s to parse, and Claude Code's 30-day cleanup means only an
index keeps older spend.

## Phase 1 — Read the configuration

Goal: everything Claude Code loads, listed, with nothing written.
Done when: the screen's plugin, skill, agent, hook and MCP lists match
`claude plugins list` and `claude mcp list` on this machine, checked by hand
in a browser.

- [x] 1.1 `api/src/domain/claude/` — the pure readers: settings, installed
  plugins and their install paths, marketplaces, personal and plugin
  skills/agents/commands with their frontmatter health, plugin
  `hooks/hooks.json`, MCP config at every scope, and every `CLAUDE.md` Claude
  Code would load.
  - Six pure readers (`claude-read`, `-settings`, `-plugins`, `-items`,
    `-hooks`, `-mcp`) and one fs half, `claude-scan.ts`: `scanClaude({ pinPaths })`
    takes the pins as input, so it reads no Workbench state. The whole scan
    runs in about 90 ms and matches `claude plugins list` on this machine.
  - Claude Code's frontmatter parser is lenient, so it loads an unquoted `: `
    in a description. A block the toolbelt reader refuses is read again line by
    line, and the refusal is reported as the reader's.
  - A transcript's FIRST line often has no `cwd` (`last-prompt`, `mode`), so
    the head of up to 3 of the newest files is searched. 131 folders give 107
    projects, 38 of them gone.
  - A session started in `~` finds the config dir as its `.claude/`, which is
    skipped as a project layer so nothing counts twice.
- [x] 1.2 `services/claude/claude.service.ts` — the read methods over 1.1,
  refused like the Workbench's.
  - One read, `config`, at ADMINISTRATOR: the whole `ClaudeConfig` from
    `scanClaude`, the Workbench's pin paths as `pinPaths`. Called for real it
    answers 108 projects, 2 plugins, 102 skills/agents/commands, 8 hook
    groups and 2 MCP servers in about 110 ms; with `LOCAL_MACHINE` unset it is
    a 404 naming Claude Code.
  - `claude` joins `OFF_LIMITS` and `NOT_FOR_AGENTS` in `api-key/scopes.ts`
    beside `workbench`: hook commands and MCP server shapes are the operator's
    machine, and a key or an agent has no business reading them.
- [x] 1.3 `resources/Claude.mesa`, `components/ClaudeCode.mesa` and a *Claude Code* tab on
  `routes/workbench/` (`FJS-D1708`), its sections Overview · Plugins ·
  Marketplaces · Skills & agents · Hooks · MCP · Settings, each a kit table with
  search. No nav entry of its own; the Workbench's ⌘K row reaches it.
  - The resource is `Claude.mesa`, named for the `claude` service (Invariant 19).
    The page's two tabs are kit `Tabs`; Checkouts stays mounted while hidden so a
    pane's terminal survives, Claude Code is read on first open, `?tab=claude`
    opens it, and the Alt keys act only on Checkouts.
  - Driven in Chrome on a scratch database with the real pins: plugins match
    `claude plugins list` (basecamp on, cloudflare off), MCP shows `shop` (local)
    and `cloudflare` (plugin), 102 items, 65 hook handlers, 108 projects with 11
    from pins; search narrowed 102 to 1 and back, and no console errors.
- [ ] 1.4 Detail drawers — a skill or agent's markdown, a plugin's contents, a
  hook's full command, read-only.

## Phase 2 — Context, sessions and spend

Goal: what is always loaded, what was spent, and what is left.
Done when: the context estimate and the 7-day token total agree with
`/context` and `/stats` in a live `claude` session within 10%.

- [ ] 2.1 Context estimate — tokens per always-on part (system prompt, skill
  index, agents, memory files, MCP tool lists) against the window.
- [ ] 2.2 Sessions — list per project, and one transcript read folded into turns.
- [ ] 2.3 Stats — per day, per model and per project, over
  `packages/cli/core/claude-usage.js` (it already dedupes a streamed reply's
  repeated message id); extended there, not copied. Indexed (`FJS-D1714`):
  one row per assistant message, unique on its id, so a resumed session's
  repeats and a re-read file collapse; one row per transcript file holding
  the byte offset read to, re-read from 0 when the file shrank. An append
  reads from the offset; the first fill is the measured ~21 s, run as a job
  rather than in a request. The models go in by `bun run db:migrate <label>`
  (the lock, `FJS-D1660`, only freezes applied files); their gate is the
  Workbench's ADMINISTRATOR and settled with `data-hazards` there.
- [ ] 2.4 Pricing — one table with its source URL and the date it was read,
  for the dollar estimate. Shown as an estimate with that date.
- [ ] 2.5 Account — `claude auth status --json`: plan, email, org, auth method.
- [ ] 2.6 Quotas per Q5 — session (5h), weekly, and weekly Sonnet. The
  endpoint shares the account's rate limit with every running `claude`, so a
  429 stops reads for the longer of `Retry-After` and a 5→10→20→30 min step,
  serving the last good read marked stale; a forced refresh does not skip it.
- [ ] 2.7 What drives the limit — the share of 24h/7d spend per project, model
  and tool, from the same scan.

## Phase 3 — Writes

Goal: every change CLACOROO makes, made from Basecamp, and each one undoable.
Done when: a plugin toggled, a marketplace added, an MCP server removed and a
setting changed on the screen show up in `claude` and undo cleanly.

- [ ] 3.1 One writer — the single owner of a write under `~/.claude` or a
  project's `.claude/`. It stores the before image in Basecamp's database,
  `@encrypted`, because `settings.json` and MCP config carry env tokens; the
  activity row names the file and keys changed, never values (Invariant 7).
  It writes atomically. Undo replays the before image and is refused when the
  file's digest moved since the write — a running `claude` may have edited it.
- [ ] 3.2 Plugins and marketplaces through the `claude` CLI (enable, disable,
  install, update, uninstall; marketplace add, update, remove).
- [ ] 3.3 MCP servers — add, remove, enable, disable, clear auth. Claude Code
  has no disable for a user-added server, so disable is `claude mcp remove` with
  its config kept by 3.1 (`@encrypted` — env and headers carry tokens) and
  enable re-adds it; a local-scope server is removed from its project's cwd.
- [ ] 3.4 Settings editor — model, theme, language, thinking, effort, voice.
- [ ] 3.4a Permissions — the allow, ask and deny rules in `settings.json`, each
  checked as `Tool` or `Tool(specifier)`; an unknown tool and a broad allow
  warn rather than refuse.
- [ ] 3.5 Edit a skill, an agent or a `CLAUDE.md`; move one to the trash.

## Phase 4 — Live and health

Goal: the screen stays true while Claude Code changes the files under it.
Done when: a plugin toggled from a terminal redraws the open screen without a
reload.

- [ ] 4.1 A watcher on the config directory, and how the open screen hears it.
  Basecamp has no broadcast for a model-less change today (the Workbench polls),
  so this step starts with `bridge-index`: reuse the owner it names, or poll
  like the Workbench and add nothing.
- [ ] 4.2 MCP live status from `claude mcp list`, and a server's tool list by an
  MCP client handshake (stdio and HTTP).
- [ ] 4.3 Hook dependencies — the CLI tools a hook command needs, and which are
  missing on PATH.
- [ ] 4.4 Doctor — `claude doctor` parsed into findings, per project.

## Phase 5 — Beyond reading, after use

Goal: the behaviors that add a concept, built only once Phases 1–4 have been
used and still want them.
Done when: each step is either built and checked by hand or dropped with a
reason.

- [ ] 5.1 The terminal — `components/Terminal.mesa` and
  `plugins/workbench-terminal.ts` reused, with a cwd that can be any scanned
  project rather than only a pin; *Terminal login* runs `claude auth login`.
- [ ] 5.2 Scope — move a personal skill or a plugin from global to chosen
  projects (skills by symlink from a library folder, plugins by
  `enabledPlugins` per project), with preview and undo through 3.1.
- [ ] 5.3 Snapshot — export the configuration as one file, import it with a diff
  preview, apply through 3.1.

## Phase 6 — Settle

Goal: the readers pinned, once the owner calls the screen settled.
Done when: every reader in `domain/claude/` has a fixture test and the screen
has a drive in `bun run verify`.

- [ ] 6.1 A fixture per reader, recorded from this machine with values scrubbed:
  the file a format change breaks fails a test instead of drawing a wrong number.
- [ ] 6.2 A drive over a temp `CLAUDE_CONFIG_DIR`: list, toggle, undo.

## Inventory

CLACOROO's handlers at `b7978f1`, grouped by what they touch. *Becomes* is a
step here, or why not. Paths are under the config directory unless absolute.

**Configuration (reads)**

| Handler | What it does | Becomes |
| --- | --- | --- |
| `get-data` | The main load: `plugins/installed_plugins.json`, `blocklist.json`, `known_marketplaces.json`, `plugin-catalog-cache.json`, `settings.json`; each installed plugin's cache folder (skills, agents, commands, `hooks/hooks.json`); personal `skills/`, `agents/`, `commands/`; the same under each tracked project's `.claude/`. CLACOROO treats a plugin as off only on `false`; the CLI says off unless the merged `enabledPlugins[id]` is `true` (checked against `claude plugins list`), and the blocklist and catalog-cache files are absent on a current install | 1.1, 1.2 |
| `get-marketplace-detail` | One marketplace's full plugin list, installed or not, from `plugins/marketplaces/<name>/.claude-plugin/marketplace.json` (or the folder root) | 1.1 |
| `read-markdown-file` · `read-item-file` | A skill, agent or command file's text, only from a path the last load listed | 1.4 |
| `read-claude-md` | `CLAUDE.md` in the config dir or a tracked project's root | 1.4 |
| `hooks:refresh-deps` · `hooks:check-tool` | Clear the hook-tool cache; recheck one tool on PATH (polled after an install) | 4.3 |

**MCP**

| Handler | What it does | Becomes |
| --- | --- | --- |
| `get-mcp` | `claude mcp list` (a live health check, 2–5 s), plugin `.mcp.json` declarations, and `~/.claude.json` `projects[*].mcpServers` — the list misses project servers from another cwd, so those show unverified | 4.2 |
| `mcp:check-project` | `claude mcp list` run from a known project's cwd, its result kept per project | 4.2 |
| `mcp:list-tools` | A stdio server spawned, MCP handshake, `tools/list`, killed; HTTP/SSE and claude.ai servers refused (OAuth) | 4.2 |
| `mcp:add` | `claude mcp add --transport <t> [--scope] [-e K=V] [-H 'K: V'] <name> <target> [-- args]` | 3.3 |
| `mcp:remove` | `claude mcp remove <name> [-s user\|local]`, local from the project's cwd | 3.3 |
| `mcp:disable` · `mcp:enable` · `mcp:list-disabled` | Remove-and-stash, re-add from the stash, list the stash | 3.3 |
| `mcp:logout` | `claude mcp logout <id>` — the local OAuth credential only | 3.3 |
| `mcp:clear-auth-cache` | One entry out of `mcp-needs-auth-cache.json` | 3.3 |

**Plugins and marketplaces**

| Handler | What it does | Becomes |
| --- | --- | --- |
| `plugin-action` | `claude plugins <enable\|disable\|install\|update\|uninstall> <id>` | 3.2 |
| `marketplace-action` | `claude plugins marketplace add <source>` (`user/repo`, git URL or local path) · `update\|remove <name>` | 3.2 |
| `validate-plugin` | `claude plugins validate <dir>` | 3.2 |

**Context, sessions and spend**

| Handler | What it does | Becomes |
| --- | --- | --- |
| `get-stats` | Claude Code's own `stats-cache.json` (which goes stale), session counts from the JSONL, top-20 projects by tokens, and the context breakdown | context → 2.1; the rest → 2.3, live |
| `get-live-stats` | Every transcript parsed into per-day and per-session totals with cost; all-time takes 2–3 s there, so cached 5 min | 2.3 |
| `get-sessions` · `read-session-transcript` | Session list from each file's head; one transcript folded | 2.2 |
| `get-usage-insights` | Share of cost-weighted use per project, model and tool for 24h or 7d, subagent transcripts included | 2.7 |
| `get-account` | `claude auth status --json` | 2.5 |
| `get-usage` | The private quota endpoint with the backoff in 2.6 | 2.6 |
| `account-logout` | `claude auth logout` | 5.1, beside *Terminal login* |

**Writes to files**

| Handler | What it does | Becomes |
| --- | --- | --- |
| `update-settings` | Shallow merge into `settings.json`; the settings and permissions screens both write through it | 3.4, 3.4a via 3.1 |
| `write-claude-md` | `CLAUDE.md` in the config dir or a tracked project | 3.5 via 3.1 |
| `write-markdown-file` · `write-item-file` | A listed skill, agent or command file; 500 KB cap, refused outside its root | 3.5 via 3.1 |
| `trash-item-file` | A personal or tracked-project skill, agent or command to the OS trash | 3.5 — a folder the writer owns, since a browser has no OS trash |

**Projects, scope and snapshot**

| Handler | What it does | Becomes |
| --- | --- | --- |
| `add-tracked-project` · `remove-tracked-project` · `doctor:add-project` | A folder list kept in CLACOROO's state, each watched | Workbench pins plus transcript history (`FJS-D1709`); no list of our own |
| `doctor:run` · `doctor:projects` | `claude doctor` from home and up to 8 tracked projects, parsed and merged | 4.4 |
| `scope:inventory` · `scope:last` · `scope:preview` · `scope:apply` · `scope:undo` | Global↔project moves with a plan hash, backups and a ledger | 5.2 |
| `export-snapshot` · `import-snapshot` · `apply-snapshot` | Installed plugins, disabled list and marketplaces as one file; import diffs, apply runs the CLI per row | 5.3 |

**Terminal**

| Handler | What it does | Becomes |
| --- | --- | --- |
| `pty:capabilities` · `pty:spawn` · `pty:input` · `pty:resize` · `pty:kill` · `pty:list` · `pty:cwd` | Tabs of node-pty shells over IPC | 5.1 — `workbench-terminal.ts`, one shell per socket |

**Not ported**

| Handler | Why |
| --- | --- |
| `apikey:status` · `apikey:test` · `apikey:testStored` · `apikey:activate` · `apikey:deactivate` · `apikey:reconfigure` | `FJS-D1710` |
| `get-activity-log` · `clear-activity-log` | Basecamp's activity trail is the log |
| `get-state` · `set-state` · `get-system-locale` | Window and UI preferences; English only |
| `check-updates` · `get-changelog` | The app's own release notes |
| `feedback:send` · `review:check` · `review:dismiss` · `review:star-clicked` · `review:submit` | The app's own prompts |
| `show-notification` · `confirm-dialog` · `pick-directory` | Native UI; the kit's Dialog and a path field |
| `open-external` · `open-plugin-path` · `open-directory` · `open-external-terminal` · `open-in-editor` · `reveal-item-file` | A link, or the path shown to copy (§ What is not ported) |
| `set-claude-bin` | `CLAUDE_BIN` in `core/env.ts` already |

**Beside the handlers**: the watcher polls `installed_plugins.json`,
`blocklist.json`, `known_marketplaces.json`, `settings.json` and the three item
folders, debounced 2 s, and skips a change whose hash matches its own last
write — 4.1 keeps that skip, or every save redraws the screen twice.
