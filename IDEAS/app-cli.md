---
id: app-cli
status: proposed
dated: 2026-09-24
---

# Idea — The app CLI: a terminal client derived from the agent surface

**Status: PROPOSED. Nothing in § *What is missing* is built.** Dated 2026-09-24. Do
not cite this file as behavior — see `VERIFYING.md`. The pieces § *What exists*
names were read off the tree on that date, not run.

---

## Trigger

[basecamp/basecamp-cli](https://github.com/basecamp/basecamp-cli) — a Go binary,
`basecamp <resource> <action>`, over the Basecamp API. What it ships: OAuth device
flow with a personal-token fallback and named profiles; styled output on a TTY,
`--json` as an `{ok, data, summary, breadcrumbs}` envelope and `--quiet` as the data
alone; errors carrying a stable `code` and a `retryable` flag; `doctor`; `--help
--agent`, which prints a command's JSON schema; and `mcp`, a stdio server over the
same commands. **Every command is written by hand**, and the breadcrumbs — the next
commands worth running — are too.

The question it raises is not *should FJS have a CLI* but *how much of that one an
FJS app already knows about itself.* Most of it, and the part it knows is the part
basecamp wrote by hand.

---

## What exists

**The projection that decides what a caller may call is shipped, and a CLI is that
projection spoken to a human.** `@frontierjs/mcp`'s `projectTools` answers, per
standing, which service methods are offered, each with its argument schema and the
rule that graded it. `mcpPlugin()` serves it over HTTP inside the running API.

| basecamp-cli | Already here | What it lacks |
| --- | --- | --- |
| `orders list/show/create/update/delete` | `svc.describe().methods`, projected as `orders.find` … | nothing |
| a custom verb (`cards done`) | a custom method, graded off `x-transitions` (`orders.void`) | nothing |
| flags, types, required, enums | each tool's input schema — `generateJsonSchema` at `audience: 'client'`, `x-values` | an argv reading of a JSON Schema (§ 1) |
| `--limit`, `--order-by` | `@frontierjs/toolbelt/directives`, the table the bridge reads | nothing — the CLI reads the same table |
| filters as flags | `@frontierjs/toolbelt/query` owns what a value means | nothing |
| commands you cannot run are absent | the projection is computed at the caller's standing | a *why* on the wire: `withheld` is in the projection, not in `tools/list` |
| login | `/auth/login` answers a Bearer token; an API key is a Bearer token through the same door (`auth/crypto.ts`) | a device flow — see § Open questions |
| `--json` envelope | the result envelope (`wrapResult`) | nothing |
| `code` + `retryable` | `toFrameworkError`, `retryable` in the schema | a mapping to exit codes |
| breadcrumbs | `transitionsAt()` (legal next moves), `buildRelations()` (where a row points) | a place to compute them (§ 3) |
| `--help --agent` | the tool's input schema, verbatim | nothing |
| `mcp` | `mcpPlugin()` — HTTP, mounted, not stdio, and `plugin.ts` says why | nothing |
| `doctor` | `/health` | nothing |
| table columns | `labelFieldInfo` | the model `$def` alongside the tool, or a column hint on it |

A zero-code baseline also exists and has not been tried: junction's `openapi`
plugin serves a document an OpenAPI-driven CLI such as restish can read. It would
answer *can a terminal reach this app*; it would not grade per standing, know a
move, or suggest the next one, which are the three things worth building.

---

## Measured

**`example`'s `tools/list` at three standings, 2026-09-25**, sorted by what the
argv half could do with each tool's input schema. A dated hand measurement and not
a gated one, for `FJS-773`'s reason; the relations are what carry over.

| Shape | Stranger | Shopper | Admin | What the CLI does with it |
| --- | --- | --- | --- | --- |
| every field is a flag | 15 | 61 | 141 | flags, nothing else |
| flags plus a JSON field | 0 | 11 | 19 | flags, and `--fields @file.json` for the one that is a `Json` column |
| `find` | 10 | 22 | 38 | **filters untyped** — see below |
| custom method, payload undescribed | 11 | 30 | 30 | `--data @file.json` only |
| `aggregate` | 8 | 8 | 12 | `--data @file.json` only |
| total | 44 | 132 | 240 | |

Nullable fields are `anyOf [T, null]` and take a flag, so they count as flags. At the
admin standing that is 160 of 240 tools driven by flags today, and 198 once `find`
is, which confirms the claim this file was written on. Three things came out of
reading the schemas, not the counts:

- **`find` was the gap, and it was the MCP projection's — closed 2026-09-25.**
  Its `query` was `{ type: 'object' }` with no properties and every directive
  was `{}`, so an agent reading `orders_find` could not see that `status` is a
  filter or that `limit` is a number either. `query` now lists the model's
  filterable columns, each as its type or an operator object, and the directives
  are typed off `DIRECTIVE_SCHEMAS` (`packages/mcp/CHANGES.md`).
- **Thirty custom methods describe no payload** — `carts.addLine`,
  `payments.start`, the `flows.*` set. That is `declared-method-contract.md`'s
  territory, not this file's. The CLI's `--data` fallback covers them, and each
  one a contract describes becomes flags without a CLI change.
- **`aggregate` answers `null` on purpose** (`projection.ts`: its spec is an
  allow-list, not a shape), the tool description says so, and the SDK's
  `{ properties: {} }` is the wire's placeholder for *no schema*. The CLI must read an
  empty `properties` as *undescribed*, not as *takes nothing*.

**`basecamp`'s `tools/list` at four standings, 2026-09-25** — the seed's owner
(also a system administrator), admin, developer and viewer, each sending
`x-workspace-id` for a workspace they belong to. Same sort, a little stricter: a
custom method counts as flags only when its `data` names every property as a
scalar.

| Shape | Viewer | Developer | Admin | Owner |
| --- | --- | --- | --- | --- |
| every field is a flag | 24 | 37 | 66 | 70 |
| flags plus a JSON field | 1 | 26 | 52 | 55 |
| `find` | 22 | 25 | 30 | 31 |
| custom method, payload undescribed | 91 | 106 | 112 | 112 |
| `aggregate` | 14 | 14 | 18 | 18 |
| total | 152 | 208 | 278 | 286 |

**It inverts example.** There the undescribed payloads were an eighth of the list; here
they are two fifths at every standing, because basecamp is verbs — `servers.provision`,
`deployments.rollback`, `workspaces.setMemberRole`. For this app the argv half is
worth less than `declared-method-contract.md`, and `--data` is the common case rather
than the fallback. Three more things came out of it:

- **The first measurement was wrong and the fix was the MCP projection's.** Without the
  workspace header every member graded 1; with it, admin, developer and viewer still
  saw one identical 109, because the plugin graded the session and the role is a claim
  the principal resolver adds. `standingOf` now asks through `app.withDb`
  (`packages/mcp/CHANGES.md`).
- **The tenant has to travel, as `FJS-D399` assumed.** A client naming no workspace
  holds no role — correct, and exactly what a CLI with no current workspace would
  offer. The header is basecamp's own spelling, read by `resolveWorkspaceId`.
- **Five services with no model are offered at every standing** — 29 tools, the hub's
  nine among them, refused `Not found` by their hooks when called (`FJS-1342`).

---

## What is missing

### 1. The runtime

**One program for every FJS app, deriving its commands when it starts** — a first
cut runs as of 2026-09-25 (`@frontierjs/mcp/client`'s `run()` and `bin.ts`, driven by
basecamp's `verify:mcp`), with profiles, the per-build cache, `cli/src/routes/`, `--await` and breadcrumbs — basecamp's `cli/` is the first surface and `verify:cli` its drive. It is an
MCP client of the app's own `/mcp`: `tools/list` becomes the command tree,
`tools/call` runs one. The pieces:

- **argv from a JSON Schema — built 2026-09-25**, `@frontierjs/mcp/client` until the
  package is named (`packages/mcp/CHANGES.md`). Scalars and enums are flags; a nested object or an
  array takes `--data @file.json` or `-` for stdin rather than an invented flag
  grammar. `--limit`/`--offset`/`--order-by`/`--select` come off the directives
  table and every other flag on `find` is a filter.
- **Output.** A table on a TTY, the envelope on `--json`, the data alone on
  `--quiet`. An unknown flag is refused by name, the same rule Invariant 10 applies
  at the bridge.
- **`--await` — built 2026-09-25**: the call is held open by `packages/mcp` until
  every job it dispatched is terminal, the jobs FOUND by the call's correlation id
  rather than declared on the method (`FJS-D406`, amending `FJS-D400`). A job that
  ends at `done` is not a domain end state: `servers.provision`'s job finishes at
  `installing`, and `online` arrives later from the heartbeat.
- **`cli/src/routes/`** for the commands the tool list cannot say — a composite or a
  local step. A route file adds or replaces one command; a route over a tool no
  longer offered is refused at start-up.
- **Exit codes** from the error's `code`, with `retryable` choosing between two of
  them, so a script can tell *try again* from *stop*.
- **A cache of the tool list — built 2026-09-25**, keyed by the app's `x-fjs-build` (`FJS-D160`), and none for an app that states no build. The
  server already states its build and a client already compares — a CLI whose cache
  outlived a deploy offers yesterday's commands and nothing says so.

### 2. Credentials and profiles

**Built 2026-09-25** (`packages/mcp/CHANGES.md`): a 0600 file rather than a keyring,
and `login` refuses a key the app reads as nobody by comparing tool lists, since a
Bearer junction cannot verify is a stranger rather than a 401.

A file under `~/.config/<app>/` (a keyring where there is one), one entry per
profile, each an origin, a token and — under `tenancy { strategy database }` — which
tenant the Host names. Under row tenancy the profile also holds the current
tenant, sent the way `cli/config/` says the app reads it (§ Open questions, the
tenant question). `login --api-key` and `login` with a password both land a Bearer
token and need nothing new server-side.

### 3. Breadcrumbs

After `orders get 5`, the moves the order's state allows at the caller's standing and
the rows it points at. **Both inputs are the Data realm's**, so this is derivable and
basecamp's are not. It belongs in the MCP result rather than the CLI, since an agent
reading `orders.get` is served by the same list — see § Open questions.

**Built** (`FJS-D398`'s build note): off the caller's projected tool list rather
than `transitionsAt()`, which is sierra's and grades the weaker number.

### Not proposed

Raw routes (they carry no input schema), file uploads (`attachments` needs
multipart), signed self-upgrade, and a styled TUI. Terminal rendering through Mesa
(`FJS-D38`) is the long answer to the last one and is not this file's.

---

## Decision rules

1. **Origin.** None new. The command tree is `tools/list`; a generated per-app
   client would be a second origin and is § Open questions' option B for that reason.
2. **Concept.** No noun. It is a fourth consumer of one service surface, beside the
   browser client, the MCP endpoint and `app.service()` — the *third client
   generator* `agent-surface.md` guessed at.
3. **Complexity.** The problem's: reading a JSON Schema as argv. Nested input is
   answered with a file rather than a flag grammar.
4. **Predictability.** A command is `<service> <method>`, the MCP tool name split on
   its dot, so an agent and a human type the same thing.
5. **Derived.** At start-up, except the commands a route file writes, each of which
   is written once and nowhere else.
6. **Owner.** `projectTools` owns *what may this standing call*; the CLI must never
   re-project, only read the endpoint. Breadcrumbs go to the same owner.
7. **Boundary.** MCP over HTTP with a Bearer header — named, and already driven by a
   real client in `verify:mcp`.
8. **Failure.** A withheld command reads as *unknown command*, which misleads; the
   answer is `withheld` on the wire, or a message that says *not offered at your
   standing, or does not exist*. A destructive method on a TTY asks, and `--yes`
   skips.
9. **Silence.** *The CLI offers what `tools/list` offers at this standing* — fails
   when the cache outlives a build, which the `x-fjs-build` key turns into a
   refetch. *A route overrides a tool that exists* — the start-up refusal. *`--await`
   waits for the job the call started* — fails when a method enqueues a job it does
   not declare, and `--await` returns at once in green; `none` until a check reads
   `ctx.enqueue` against `methods:`. *A command runs what its name says* — a drive over `example`, `none`
   until one exists.

**Adjudication:** *familiarity vs. precision* — the `<resource> <action>` shape is
stolen from the field; the words are the framework's own names, not kebab-cased
restatements of them (§ Open questions). *Batteries vs. smallness* — a severable
package that depends on an MCP client and the toolbelt, and on no framework package.

**Tier:** Assessment until built. What survives the build is a package `CLAUDE.md`
(Map); that a CLI is a SURFACE is `FJS-D397` (Register), and Invariant 3 is
amended when the first `cli/` is built.

---

## Open questions

- ~~**Derived at runtime, or generated per app?**~~ **Answered 2026-09-25 (`FJS-D396`): A — runtime: the program reads `/mcp` when it starts and caches by build. A file under `cli/src/routes/` adds a command the tool list does not carry, or replaces one it does, the way a file under `web/src/routes/` is a page; a route naming a tool the list no longer offers is refused at start-up by name.**
  - **A** — runtime: the program reads `/mcp` when it starts and caches by build.
    A file under `cli/src/routes/` adds a command the tool list does not carry, or
    replaces one it does, the way a file under `web/src/routes/` is a page; a route
    naming a tool the list no longer offers is refused at start-up by name.
  - **B** — generated: `fli make:cli` writes commands from the schema into the app,
    gated by a snapshot.
  - **Recommend A** — B is a second origin of the command tree, needs a snapshot to
    stay honest, and cannot grade per standing, since the standing is known only when
    somebody signs in. A's cost is a request at start-up, which the cache pays once
    per build. A route file is the only place its own command is written, so it
    restates nothing; the start-up refusal is what keeps an override from outliving
    the method it replaced.
- ~~**How does a person sign in?**~~ **Answered 2026-09-25 (`FJS-D402`): A — `login --api-key`: the key is issued from the app's own screens. Works today for every account, OAuth-only ones included.**
  - **A** — `login --api-key`: the key is issued from the app's own screens. Works
    today for every account, OAuth-only ones included.
  - **B** — `login` with email and password, answering a Bearer session. Works today
    for accounts with a password; a TOTP challenge needs a prompt.
  - **C** — a device flow (RFC 8628): a code shown in the terminal, approved on a
    screen. A new auth surface — a model, `/auth/device/*`, a page — so its own
    proposal and a ruling.
  - **Recommend A** — it needs nothing server-side and covers every account; B
    follows for the same reason, and C waits for an app whose users have no password
    and cannot be asked to handle a key.
- ~~**Is a CLI a surface?**~~ **Answered 2026-09-25 (`FJS-D397`): B — yes: `cli/` beside `api/` and `web/`, written by `fli make:cli`, laid out like `web/` — `cli/config/` (the binary's name, the origin, how a tenant travels), `cli/src/routes/` (hand-written commands, one file each, beside the derived ones), `cli/test/`, and a `bun build --compile` release — so an app can ship `shop orders find` to its own users.** Invariant 3's test is whether its config, its tests and
  its release are all different answers.
  - **A** — no: one generic program, `<bin> --origin <url> orders find`, and a
    profile remembers the origin.
  - **B** — yes: `cli/` beside `api/` and `web/`, written by `fli make:cli`, laid out
    like `web/` — `cli/config/` (the binary's name, the origin, how a tenant
    travels), `cli/src/routes/` (hand-written commands, one file each, beside the
    derived ones), `cli/test/`, and a `bun build --compile` release — so an app can
    ship `shop orders find` to its own users.
  - **Recommend A** — B's config is a name and a URL, which fails the test until an
    app actually releases a binary to people who are not its developers.
- ~~**Are commands spelled as the service names, or kebab-cased?**~~ **Answered 2026-09-25 (`FJS-D403`): A — verbatim, the MCP tool name.** `flowCredentials`
  on a command line is unusual; `flow-credentials` is a second name for one thing.
  - **A** — verbatim, the MCP tool name.
  - **B** — kebab-case, derived one way by `@frontierjs/toolbelt/inflect`.
  - **Recommend A** — the agent and the human then type one name, and the
    derivation in B is a translation with no owner yet.
- ~~**Do breadcrumbs belong to the MCP result?**~~ **Answered 2026-09-25 (`FJS-D398`): A — yes: `packages/mcp` computes them off `transitionsAt()` and `buildRelations()` at the caller's standing, and the CLI renders them.** An agent that has just read an order
  is served by the moves it now allows exactly as a human is.
  - **A** — yes: `packages/mcp` computes them off `transitionsAt()` and
    `buildRelations()` at the caller's standing, and the CLI renders them.
  - **B** — no: the CLI computes them, which needs the model's `$def` beside each
    tool, and the tool list does not carry it.
  - **Recommend A** — `projectTools` already owns *what may this standing call*,
    and *what may it call next* is the same question asked of one row; B puts a
    second projection in a client.
- ~~**Which tenant does a call act in?**~~ **Answered 2026-09-25 (`FJS-D399`): A — `cli/config/` names how the tenant travels (`tenant: { header: 'x-workspace-id' }`); a profile holds the current one, `--workspace <id>` overrides a single call, and `workspaces use <id>` switches it.** Under row tenancy a person belongs to several
  (basecamp: `membershipClaim`, and `resolveWorkspaceId` in `core/hooks.ts` reads
  `x-workspace-id`, then `?workspace_id`, then the user's default). The resolver is
  the app's own function, so a generic program cannot know the header.
  - **A** — `cli/config/` names how the tenant travels (`tenant: { header:
    'x-workspace-id' }`); a profile holds the current one, `--workspace <id>`
    overrides a single call, and `workspaces use <id>` switches it.
  - **B** — a key bound to one tenant picks it, and a person holds a key per
    workspace.
  - **Recommend A** — it needs the `cli/` config to exist, which the surface
    question gives it, and it costs one key per person rather than one per
    workspace. B arrives for free wherever an app's keys are tenant-scoped already.
- ~~**Who knows that a call started a job, and how to wait for it?**~~ **Answered 2026-09-25 (`FJS-D400`): B — the method: its `methods:` entry declares the job it dispatches, the result carries the handle, and `packages/mcp` holds the call open, reporting progress through MCP progress notifications, until the job is terminal. `--await` is the CLI's flag over that and nothing more.** `servers.provision`
  answers once the job is queued; `--await` waits until it finishes, which needs
  something to know which job and how to follow it.
  - **A** — the CLI: it spots a job id in the result and polls the jobs service.
  - **B** — the method: its `methods:` entry declares the job it dispatches, the
    result carries the handle, and `packages/mcp` holds the call open, reporting
    progress through MCP progress notifications, until the job is terminal.
    `--await` is the CLI's flag over that and nothing more.
  - **Recommend B** — A puts an app's conventions into a client and serves no agent;
    an agent calling `servers.provision` needs *wait until done* exactly as a human
    does, which is the breadcrumbs question's argument about the same owner.

- ~~**How is the tenant switch spelled?**~~ **Answered 2026-09-25 (`FJS-D405`): A — `use <tenant>`, the program's own verb, one spelling in every app.** `FJS-D399` wrote `workspaces use <id>`, and
  `workspaces` is basecamp's noun — a generic program cannot know an app's, and a
  local command named for a service shadows it. Built as `use <tenant>`.
  - **A** — `use <tenant>`, the program's own verb, one spelling in every app.
  - **B** — `cli/config/` names the noun (`tenant: { header, noun: 'workspaces' }`)
    and the command is `<noun> use <id>`, beside that service's own methods.
  - **Recommend A** — B puts a program verb inside an app's service namespace, where
    a `use` method on the service would be hidden, and costs a config key to say
    what `--workspace` already says; A amends `FJS-D399`'s example and nothing else.

## See also

- `agent-surface.md` — the projection this reads, and the *third client generator*
  question
- `command-surface.md` — `fli`'s own command surface, which is a different program
  for a different audience
- `bearer-access.md` — the other Bearer door
