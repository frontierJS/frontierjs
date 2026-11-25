# @frontierjs/claude

**The local `claude` program (Claude Code), not the Messages API.** The Messages API is
`@frontierjs/conduit-anthropic` (`FJS-D2324`). This package starts the program a developer has
installed and reads its stream-json reply back.

Published to `packages.frontierjs.com` and released like `@frontierjs/cli` (`FJS-D2323`), so a
prototype depends on it directly.

## What it exports

| Export | What it is |
| ------ | ---------- |
| `askArgv(profile)` | the `claude -p` command line for one profile, below |
| `sessionArgv(opts)` | a long-lived chat a host drives over stdin: stream-json both ways, every prompt to the host (`--permission-prompt-tool stdio`) |
| `claudeDoor(opts)` | the one-answer door (`@frontierjs/toolbelt/ask`): a question in, a `Reply` out, never a throw; `mcpConfigOf(agent)` is the `--mcp-config` JSON it and the `agent` profile share |
| `runAsk(opts)` | starts one `askArgv` run detached in `root`, the prompt on stdin, and calls `onEvent` per drawn event (`onFrame` per raw line); takes the `work` profile; with `log` the child writes that file itself and outlives the caller, `onExit` hearing its code and signal; `{ error }` for a bad session id, effort or agent |
| `readAskEvent(line)` | one parsed stream-json line → `AskEvent[]` (`session`, `status`, `delta`, `text`, `tool`, `read`/`edit`/`write`, `landed`/`refused`, `result`) |
| `readImages(list)`, `askInput(prompt, images)` | pasted images checked, and the one stream-json message that carries them |
| `resumeCommand(root, session)` | the `cd … && claude --resume <id>` line for a terminal |
| `new Session(opts)` | one long-lived `sessionArgv` process in `cwd`: `send`, `stop`, `answer`, `setMode`/`setModel`/`setEffort`, `end`; every event to `onEvent` as a `SessionEvent`, a host's own card facts through `card` |
| `Protocol`, `LineReader` | the control channel with no process: frames in, the host's requests matched by id, `can_use_tool` held until answered |
| `decide`, `askCard`, `askSummary`, `denial` | a person's allow or deny as the `control_response` it becomes, and what a prompt's card shows |
| `initOf`, `commandsOf`, `mergeCommands`, `modelsOf`, `usageOf`, `MODES` | what `system/init`, the `initialize` answer and `get_context_usage` say a composer can offer |
| `agentCall`, `agentEventOf` | a subagent's call and its `system/task_*` frames as `agent*` events |
| `ASK_*`, `EDIT_TOOLS`, `EFFORTS`, `*_BUDGET_USD`, `IMAGE_TYPES`, `MAX_IMAGE(S)` | the profiles' fixed values |

## Reading Claude Code's own files

The one reader of each file Claude Code keeps — transcripts, the session list, its configuration and its login — so Workbench, Lathe, `fli git:history`, the loop scripts and Basecamp's usage index share one opinion of what a line means. None of them throws: a `Read<T>` is `{ ok: true, value }` or `{ ok: false, reason }`.

| Export | What it is |
| ------ | ---------- |
| `readMessages(text, opts)` | a transcript's text, or a chunk of it, as one message per reply (streamed lines merged by id) with tokens, tools and skills, plus what the chunk says of the file (`cwd`, `title`, `firstPrompt`, `headless`); `consumed` is the bytes through the last newline |
| `foldTranscript(text)`, `readTranscript(path)` | a transcript as turns: prompt, reply text, each tool call as a name and one line, its result as a size, tokens; `readTranscript` refuses a path outside `<configDir>/projects/` |
| `listSessions(cwd, opts)` | the sessions that ran in `cwd`, newest first, headless runs and `held` ids left out |
| `findSession(cwd, id)` | one session `claude --resume` can pick up from `cwd`, or why not, by name |
| `peekSession(path)`, `titleOf(text)`, `encodeCwd(path)` | a transcript's head, a chat title, Claude Code's folder name for a directory |
| `readToolCalls(text)` | every tool call with its **input** and its result's **text**, plus the main thread's replies and first prompt: for a review of what sessions did, never a page, since inputs carry file bodies and tokens |
| `claudeConfigDir(opts)`, `read`, `unreadable`, `readJsonObject` | where the files live (`CLAUDE_CONFIG_DIR`, else `~/.claude`), the `Read` constructors, and JSON text as an object or why not |
| `scanClaude(opts)` | the whole configuration, read-only: `~/.claude`, `~/.claude.json` and each project's `.claude/` — settings layers merged, skills, agents, commands, hooks, MCP servers, plugins and marketplaces, memory files — each file's failure an issue on its entry; `allItems`, `allHooks`, `readListedFile`, `configRev`, `claudeJsonPath` read the result; `commandTools` and `expandMcpVars` are the two pure helpers a screen needs, and the parsers the scan stands on stay inside, none handing back a secret (`env` values, headers and `apiKeyHelper` stay behind) |
| `fetchUsage(opts)` | the claude.ai login's quota (`oauth/usage`): session, weekly and per-model meters, cached 60 s and stopped on a 429 |
| `contextFor(cwd)`, `countContext(m, key)` | what a session carries before the first word, from its newest transcript's request shape, counted by the API |
| `claudeAuthStatus(program)`, `runClaude(args, opts)`, `readMcpList`, `readDoctor` | the subcommands that answer about the program itself (`auth status`, `mcp list`, `doctor`) or change its configuration (`plugin`, `mcp add`); `program` is `{ bin, env }`, so a host strips its own secrets from the child's environment |

**The login token is read and never refreshed.** It sits in `<configDir>/.credentials.json`; refreshing it rotates the refresh token and signs out every running `claude`. An expired token is a refusal that says to run `claude`. `fli check`'s `claude-login-owned` fails a file outside this package that names the credentials file or the usage endpoint.

Whether a session is already a chat is each host's own check; `findSession` only says the transcript is resumable from `cwd`.

## The profiles

- **read-only** (the default) — `Read`, `Grep`, `Glob` and an allow-listed Bash (`bash` replaces the list), `dontAsk`, hooks off, no MCP, `$2` unless `budget` says otherwise.
- **edit** — `Edit`/`Write` scoped to one path, every settings source dropped, `dontAsk`.
- **work** — every tool, `bypassPermissions`, a budget, hooks off unless asked.
- **agent** — no built-in tool, one MCP server the caller names.
- **draw** — no tool, the system prompt replaced.

What each run SAYS is the caller's: `@frontierjs/cli`'s `core/{plan,edit,ask}-prompt.js` and the
Workbench's reviewer. This package holds no prompt, and a test fails when an export looks like one.

The control protocol a live chat speaks, measured frame by frame, is `docs/control-protocol.md`.

## The one-answer door

`claudeDoor(options)` answers `@frontierjs/toolbelt/ask`'s contract with the local `claude`: one
question, one `Reply`, never a throw, never a retry. It is a completion, not a session: no tool unless
`allow` names one, no hooks, no settings files, no MCP server but `agent`, no session kept unless
`persist` or `resume`, `dontAsk`. The prompt goes on stdin, and an agent's `headers` go in a 0600 file
that is removed afterwards, never argv. Every reply also carries `run: { session, turns, denials }`.
`forbidden` and `refused` are never produced: nothing local causes either.

```js
import { claudeDoor } from '@frontierjs/claude'
import { checkReply } from '@frontierjs/toolbelt/ask'

const door = claudeDoor({ model: 'haiku' })
const question = { prompt: 'What is 2+2?', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }
const reply = await door(question, { signal: AbortSignal.timeout(60_000) })
console.log(reply.ok ? reply.answer : reply.failure, checkReply(reply, question))
// { n: 4 } []
```
