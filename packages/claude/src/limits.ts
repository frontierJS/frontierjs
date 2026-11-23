// src/limits.ts — the profiles' fixed numbers and lists: tools, budgets,
// efforts, image limits.
//
// No `node:` import here and none may be added: these are plain values a page
// or a prompt module can name without pulling in the process runner.

export const ASK_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const
export const ASK_BASH  = ['git status:*', 'git diff:*', 'git log:*', 'git show:*', 'rg:*', 'ls:*'] as const

// A press is a question, not a work session; a loop that reads the whole tree
// stops here rather than on the account's limit.
export const ASK_BUDGET_USD = 2

export const EDIT_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'] as const

// The media types the API takes as an image block; anything else is refused there.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const MAX_IMAGES  = 5
export const MAX_IMAGE   = 5 * 1024 * 1024

// A work run builds rather than answers; the operator sets it per checkout.
export const WORK_BUDGET_USD = 10

// A draw writes one page in one reply; a run that loops has gone wrong.
export const DRAW_BUDGET_USD = 3

// How hard Claude thinks, as `--effort`. Thinking itself cannot be switched off
// here: on Opus 5.5 and Sonnet 5.5 `claude -p` keeps it on through
// `alwaysThinkingEnabled: false`, `MAX_THINKING_TOKENS=0` and
// `CLAUDE_CODE_DISABLE_THINKING=1` alike (measured, 2.1.296), so a thinking
// toggle would be a control that does nothing. Effort reaches every model.
export const EFFORTS    = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const ASK_EFFORT: Effort = 'high'

export type Effort = typeof EFFORTS[number]

export const isEffort = (value: unknown): value is Effort => (EFFORTS as readonly unknown[]).includes(value)
