# Claude Code control protocol (stream-json)

What a host says to one long-lived `claude` process over stdin/stdout, as Claude Code 2.1.325 speaks it. `src/protocol.ts`, `src/permission.ts`, `src/catalog.ts` and `src/session.ts` speak it; `sessionArgv` (`src/argv.ts`) is the argv below. Every shape carries its source:

- **PROBED**: run against `claude` 2.1.325 on this machine (`~/.local/bin/claude`), model haiku, 2026-11-15.
- **SDK**: read from the Agent SDK bundled in the VS Code extension 2.1.325 (`~/.vscode/extensions/anthropic.claude-code-2.1.325-linux-x64/extension.js`, class `ProcessTransport` and class `Query`) or its webview (`webview/index.js`). The npm package is `@anthropic-ai/claude-agent-sdk` 0.3.325.
- **DOCS**: from the Agent SDK documentation only, not seen running.
- **RECORDED**: in `test/fixtures/chat-permission.jsonl` and `chat-question.jsonl`, both directions of a live chat (`test/record.ts`), replayed by `test/protocol.test.ts`.

Every frame is one JSON object on one line, terminated by `\n`, in both directions.

## Argv

```
claude -p --output-format stream-json --verbose --input-format stream-json
  --permission-prompt-tool stdio
  --include-partial-messages --include-hook-events
  --setting-sources user,project,local
  [--model <alias|id>] [--effort low|medium|high|xhigh|max]
  [--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions]
  [--resume <session-id> [--fork-session]] [--session-id <uuid>]
  [--replay-user-messages] [--add-dir <dir>]...
```

- **`--permission-prompt-tool stdio` is the flag that routes prompts to the host** (PROBED, SDK). `--permission-prompts host` exists and is the default, but alone it gives the host no channel: AskUserQuestion came back as `No such tool available` and the model was told questions are disabled (PROBED). The SDK pushes `--permission-prompt-tool=stdio` whenever a `canUseTool` callback is set.
- The SDK's argv has no `-p`; the probes used `-p` and it works. Whether the CLI needs it under stream-json input is unverified, so keep it.
- `--setting-sources` is pushed by the SDK only when the caller sets it; the extension passes `user,project,local` for a trusted folder and `user` otherwise (SDK). Hooks come from those settings files, so this flag is what turns hooks on. `--settings '<json>'` adds inline settings on top (PROBED: an inline `PreToolUse` hook ran).
- Env (SDK): the SDK sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` only if unset and deletes `NODE_OPTIONS`. A sidecar started from inside a Claude Code session inherits `CLAUDE_CODE_ENTRYPOINT=claude-vscode` and `CLAUDECODE`; the first probe reported `entrypoint: claude-vscode`. Set the entrypoint explicitly and drop `CLAUDECODE`.

## Host → CLI (stdin)

### User message (PROBED)

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<base64>"}},
  {"type":"text","text":"What color is this?"}]},
 "parent_tool_use_id":null,"session_id":""}
```

Content blocks are the Messages API's. An empty `session_id` is accepted. A pasted image is a base64 `image` block (PROBED: a 1×1 PNG was read correctly).

**A message sent mid-turn joins the running turn** (PROBED). It is held until the next tool boundary, then injected as a user message, and the turn ends with ONE `result` covering both. It does not start a second turn. With `--replay-user-messages` each user message is echoed back with `"isReplay":true` at the moment the CLI consumes it, which is the signal to move a queued bubble into the transcript. `interrupt` with `cancel_queued:true` drops messages not yet consumed, and `cancel_async_message` drops one by its uuid (SDK).

### Control requests

Envelope: `{"type":"control_request","request_id":"<host-chosen id>","request":{"subtype":…}}`. The answer is a `control_response` with the same `request_id`; answers arrive out of order (PROBED), so match on the id.

| Subtype | Fields | Response | Source |
| --- | --- | --- | --- |
| `initialize` | optional `hooks`, `systemPrompt`, `appendSystemPrompt`, `agents`, `jsonSchema`, `sdkMcpServers` | `commands[{name,description,argumentHint}]`, `agents`, `models[{value,resolvedModel,displayName,supportsEffort,supportedEffortLevels,…}]`, `account`, `current_permission_mode`, `output_style`, `capabilities`, `pid`, `claude_code_version` | PROBED |
| `interrupt` | optional `cancel_queued:true` | `{still_queued:[…], cancelled?:[…]}` | PROBED (without the flag) |
| `set_permission_mode` | `mode` | `{mode}` plus a `system/status` frame carrying `permissionMode` | PROBED |
| `set_model` | `model` (alias or id) | `{model:"claude-haiku-5-5"}` resolved | PROBED |
| `set_max_thinking_tokens` | `max_thinking_tokens`, optional `thinking_display` | success, no body | PROBED (effect not checked) |
| `apply_flag_settings` | `settings` (a settings object) | success, no body | PROBED with `{effortLevel:"low"}`, and `{effortLevel:"max"}` on haiku was accepted too, mid-session (2026-11-15; effect not checked) |
| `get_context_usage` | none | `categories[{id,name,tokens,kind}]`, `totalTokens`, `maxTokens`, `percentage` | PROBED |
| `stop_task` | `task_id` | success | SDK |
| `rewind_files` | `user_message_id`, `dry_run` | per-file result | SDK |
| `cancel_async_message` | `message_uuid` | `{cancelled}` | SDK |

**The `initialize` answer's `models`** (PROBED 2026-11-19, `claude` 2.1.328): each entry is `{value, resolvedModel, displayName, supportsEffort, supportedEffortLevels}`, and `value` is what `--model` and `set_model` take, a `[1m]` suffix included.

| `value` | `resolvedModel` | `displayName` | `supportedEffortLevels` |
| --- | --- | --- | --- |
| `default` | `claude-opus-5-5` | `Default (recommended)` | `low`, `medium`, `high`, `xhigh`, `max` |
| `opus` | `claude-opus-5-5` | `Opus` | the same five |
| `claude-fable-5-2[1m]` | `claude-fable-5-2` | `Fable` | `low`, `medium`, `high`, `xhigh`, `max` |
| `sonnet` | `claude-sonnet-5-5` | `Sonnet` | `low`, `medium`, `high`, `xhigh`, `max` |
| `haiku` | `claude-haiku-5-5` | `Haiku` | `low`, `medium`, `high`, `xhigh`, `max` |

`modelsOf` (`src/catalog.ts`) reads this list for a picker: `default` left out because a picker has its own, and one model per family, the first listed. Before any `initialize`, `FALLBACK_MODELS` is the aliases `opus`, `sonnet` and `haiku`.

**There is no `set_effort`**: the CLI answered `{"subtype":"error","error":"Unsupported control request subtype: set_effort","error_code":"unsupported_request"}` (PROBED). Effort is `--effort` at spawn, or `apply_flag_settings` with `effortLevel` mid-session (the settings schema's enum stops at `xhigh`). The `models` list in the initialize response says which levels each model takes.

Initialize is sent first by the SDK and answered in about 0.6 s, before `system/init` (PROBED). Whether the CLI requires it is unverified; send it.

### Answering `can_use_tool`

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<the CLI's id>","response":<decision>}}
```

| Decision | Shape | Source |
| --- | --- | --- |
| Allow once | `{"behavior":"allow","updatedInput":<input>}` | PROBED |
| Allow, changed | `{"behavior":"allow","updatedInput":<edited input>}`; the edit runs as changed | SDK (webview accepts an Edit with the strings the user edited in the diff) |
| Allow always | `{"behavior":"allow","updatedInput":<input>,"updatedPermissions":[…]}`, the list being the request's `permission_suggestions` with `destination` set to `session`, `localSettings`, `projectSettings` or `userSettings` | SDK |
| Deny | `{"behavior":"deny","message":"why"}`; the model sees `message` as an error `tool_result` and the turn continues | PROBED |
| Deny and stop | `{"behavior":"deny","message":"why","interrupt":true}` ends the turn | SDK (not run) |

Always send `updatedInput`, even unchanged. A suggestion seen: `{"type":"setMode","mode":"acceptEdits","destination":"session"}` for a Write and an Edit (PROBED). For Bash `echo hi >> bash.txt` (PROBED 2026-11-15): `[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"echo hi *"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["/abs/project"],"destination":"session"}]`, with `blocked_path` naming the redirect's file. Sending both back as `updatedPermissions` was accepted: the rule was written to the project's `.claude/settings.local.json` (`"allow":["Bash(echo hi *)"]`), and **the same command still asked again** in the same turn, so neither update covers a redirect's write in `default` mode.

**A deny's `message` reaches the model verbatim** as `{"type":"tool_result","content":<message>,"is_error":true}` (PROBED 2026-11-15). Haiku read a bare note ("No. Do not edit anything. Reply with the word cherry and stop.") as a tool error that was not the person's decision and said so; say whose note it is in the message. A thrown error goes back as `{"subtype":"error","request_id":…,"error":"…"}` (SDK).

## CLI → host (stdout)

| Frame | What the host does with it | Source |
| --- | --- | --- |
| `system/init` | `session_id`, `model`, `permissionMode`, `tools`, `slash_commands` and `skills` (bare names, no leading `/`; `slash_commands` holds the skills too, and built-ins such as `context` but not `cost`; PROBED 2026-11-15), `agents`, `mcp_servers`, `cwd`, `claude_code_version`, `capabilities`. **Re-emitted at the start of every turn**, not once, and after the `initialize` answer, not before it (RECORDED); a host keys on what changed | PROBED, RECORDED |
| `system/ui_invalidate` | `event:"ui.render"`, before the `initialize` answer; nothing for a host to draw, read as no event | RECORDED |
| `system/status` | `status:"requesting"` while a request is in flight; `permissionMode` after a mode change | PROBED |
| `system/thinking_tokens` | `estimated_tokens` and `estimated_tokens_delta`, several per thinking block, for a "thinking…" counter; the `assistant` frame's `thinking` text itself comes back empty with a signature | PROBED, RECORDED |
| `system/hook_started`, `system/hook_response` | `hook_id`, `hook_name` (`PreToolUse:AskUserQuestion`), `hook_event`, then `stdout`, `stderr`, `exit_code`, `outcome`. Only with `--include-hook-events` | PROBED |
| `stream_event` | `event` is a raw Messages API SSE event (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`); text arrives as `text_delta`, tool input as `input_json_delta`. Only with `--include-partial-messages` | PROBED |
| `assistant` | the whole message per API call; `message.content` holds `text`, `thinking`, `tool_use`; `message.usage` is that call's usage | PROBED |
| `user` | a `tool_result` the CLI produced, with `tool_use_result` (structured result) and `tool_result_meta` (permission decision); a replayed host message (`isReplay:true`, after the turn's `system/init` and first `system/status`); or the synthetic `[Request interrupted by user]` text | PROBED, RECORDED |
| `result` | ends a turn: `subtype` (`success`, `error_during_execution`, …), `is_error`, `result` text, `session_id`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `terminal_reason`, `num_turns` | PROBED |
| `control_request` | `can_use_tool` (below); also `hook_callback` and `mcp_message`, which only arrive when the host registered SDK hooks or SDK MCP servers in `initialize` | PROBED / SDK |
| `control_cancel_request` | `{request_id}`: the CLI withdrew a pending request; take the card down and send nothing | SDK |
| `control_response` | the answer to a host request. With `--replay-user-messages` the CLI also echoes the host's own `can_use_tool` answer, byte for byte the frame the host wrote, after the next frame and before the tool's result; ignore ids the host did not issue | PROBED, RECORDED |
| `rate_limit_event`, `keep_alive` | plan utilization and reset time; liveness | PROBED / SDK |

### `can_use_tool` (PROBED)

```json
{"type":"control_request","request_id":"c8fa…","request":{"subtype":"can_use_tool",
 "tool_name":"Write","display_name":"Write","description":"probe.txt",
 "input":{"file_path":"/abs/probe.txt","content":"hi"},
 "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
 "tool_use_id":"toolu_01SP…"}}
```

Order on the wire: the `assistant` frame carrying the `tool_use`, then `PreToolUse` hook events, then `can_use_tool` (PROBED). Other optional fields: `blocked_path`, `decision_reason`, `title`, `agent_id` (set when a subagent asks), `requires_user_interaction` (SDK).

**A diff before the edit runs.** The request's `input` is the whole edit: Write is `{file_path, content}` (PROBED), Edit is `{file_path, old_string, new_string, replace_all}` (PROBED 2026-11-15, `replace_all:false` sent explicitly). Write and Edit requests also carry `server_policy_ask_only:true` (PROBED, meaning unchecked); Bash's `description` is the tool input's own `description`. The host reads the file, applies the edit in memory, shows the diff, and answers. The extension sends back the strings as the user left them in the diff, which is the Allow, changed row. An edit that never asks, under `acceptEdits` or an allow rule, shows only as the `tool_use` and its `tool_result`.

**AskUserQuestion** arrives as `can_use_tool` with `tool_name:"AskUserQuestion"`, `requires_user_interaction:true` and `input.questions[{question, header, multiSelect, options[{label, description}]}]` (PROBED). The answer is an allow whose `updatedInput` adds `answers`, keyed by question text:

```json
{"behavior":"allow","updatedInput":{"questions":[…],"answers":{"Which fruit do you prefer?":"Pear"}}}
```

The model then sees `Your questions have been answered: "Which fruit do you prefer?"="Pear"` (PROBED). For `multiSelect` the extension joins labels with `", "`, and Other puts the typed text in place of the label (SDK). A deny is a skipped question.

**ExitPlanMode** arrives as `can_use_tool` with `tool_name:"ExitPlanMode"`, `requires_user_interaction:true`, no `permission_suggestions`, and `input` `{plan, planFilePath}` (PROBED 2026-11-15; `planFilePath` is under `~/.claude/plans/`). Allow approves; paired with `updatedPermissions:[{type:"setMode",mode:"default",destination:"session"}]` the CLI emitted `system/status` with `permissionMode:"default"` straight after, and the model went on to implement (PROBED). AskUserQuestion likewise carries no `permission_suggestions`. Deny with a `message` keeps planning and hands the message back as feedback.

### Context meter

- `get_context_usage` gives `totalTokens`, `maxTokens` and `percentage` directly, and the category breakdown `/context` draws (PROBED). It answers mid-turn.
- Without a request: the last `assistant` frame's `usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`, over `result.modelUsage[<model>].contextWindow` (1,000,000 for haiku here).
- **`result.usage` is not fullness**: it sums every API call in the turn (PROBED: a two-call turn reported 41,341 created plus 38,328 read).

## Interrupt and Stop

`interrupt` stops the turn and keeps the process (PROBED). In order: the `control_response` `{still_queued:[]}`, the partial `assistant` message as streamed so far, a synthetic `user` frame `[Request interrupted by user]`, then a `result` with `subtype:"error_during_execution"`, `is_error:true`, `terminal_reason:"aborted_streaming"`. The next user message starts a new turn in the same process. A pending `can_use_tool` is withdrawn by `control_cancel_request` (SDK).

## Sessions

- The id is in `system/init` and every frame's `session_id`.
- `--resume <id>` reloads the transcript and **keeps the same id** on 2.1.325 (PROBED); the resumed model recalled the earlier answer. `--fork-session` gives a new id. `--session-id <uuid>` picks the id for a fresh session.
- A resume is a new process: switching chats is kill-and-resume, not a control request.

## Process lifetime

- Closing stdin after a `result` ends the process within half a second (PROBED). The exit code is 0 when the last result succeeded and 1 when it was an error, so an interrupt followed by close exits 1 (PROBED). Closing stdin mid-turn is unverified.
- The SDK's `close()` aborts its controller, which kills the child; it does not send a goodbye frame (SDK).
- The process is idle between turns and holds no API connection; one per open chat is the cost of the process, not of tokens.

## Traps

1. `--permission-prompts host` without `--permission-prompt-tool stdio` silently removes AskUserQuestion and the plan tools.
2. A mid-turn message does not get its own `result`; a host that counts results to pair them with sends hangs.
3. `system/init` repeats each turn; treat it as a refresh, not a new session.
4. Answers to control requests arrive out of order; key everything on `request_id`.
5. Effort cannot be set with a control request; use `apply_flag_settings` or respawn.
6. Inherited `CLAUDE_CODE_ENTRYPOINT`/`CLAUDECODE` from a parent Claude session mislabel the child.
7. Hooks on means this workspace's Stop hook runs `fli done` at the end of every turn (`src/argv.ts` says why a one-shot run turns them off).
8. The protocol is the CLI's, versioned with it: `capabilities` in `system/init` (`interrupt_cancel_queued_v1`, `ask_user_question_unanswered_v1`, …) is what to check before using a newer feature. These shapes are 2.1.325's.
9. A slash command sent as a user message (`/cost`, PROBED 2026-11-15) runs locally: an `assistant` frame with `model:"<synthetic>"` holding the command's text, then a `result` (`success`, `num_turns:0`, `total_cost_usd:0`), and **no `isReplay` echo** of the message.
