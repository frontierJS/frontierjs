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
