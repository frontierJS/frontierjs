// src/domain/local/local-claude.ts — the operator's own `claude`, as Workbench starts it.
//
// The subcommands are `@frontierjs/claude`'s (`claudeAuthStatus`, `runClaude`,
// `readMcpList`, `readDoctor`). What stays Workbench's is which binary and which
// environment: `CLAUDE_BIN`, and this process's env with every variable Workbench
// declares stripped, so its own keys never reach a child process.

import { childEnv } from '@frontierjs/junction'
import type { Program } from '@frontierjs/claude'
import { env } from '../../core/env.ts'

export const claudeProgram = (): Program => ({ bin: env.CLAUDE_BIN, env: childEnv(env) })
