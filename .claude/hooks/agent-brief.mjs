// ─── agent-brief.mjs — the PreToolUse rewrite in front of a subagent ────────
//
// The user's Delegation rules say every brief names a stop point, says "do not
// spawn agents", and keeps judgment calls on the main thread. A brief written
// in a hurry drops them, and a subagent without a stop point ran 180 turns.
// This appends them to every Agent prompt so no brief depends on remembering.
//
// Agents that never touch the tree are left alone. A prompt already carrying
// the marker is left alone, so a brief that quotes the rules is not doubled.
//
// It must never break a session: every failure exits 0 with nothing printed.

import { readFileSync } from 'node:fs'

const MARKER = 'Rules for this brief (appended by .claude/hooks/agent-brief.mjs)'
const EXEMPT = new Set(['claude-code-guide', 'statusline-setup'])

const RULES = `

---
${MARKER}:
- Do not spawn agents.
- Stop at about 40 tool calls. Report what is done and what is left, finished or not.
- A judgment call is not yours to make: you cannot ask the owner. Report the fork with its options and a recommendation, then stop that line of work.
- Report what you ran and what it printed. The main thread verifies; a summary alone is not proof.
- FrontierJS: load the realm skill for what you touch (data-hazards, api-hazards, ui-hazards). cd into a package and run its own script. Search a tree with rg.
`

try {
  const input  = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const brief  = input.tool_input ?? {}
  const prompt = brief.prompt
  if (typeof prompt === 'string' && !EXEMPT.has(brief.subagent_type) && !prompt.includes(MARKER)) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...brief, prompt: prompt + RULES } } }))
  }
} catch {}
