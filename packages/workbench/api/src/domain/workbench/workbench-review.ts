// src/domain/workbench/workbench-review.ts — what the reviewer session is told.
//
// The words only: `askArgv()` in `@frontierjs/claude` starts
// the read-only session. This is here and not in `cli` because the workbench
// is the one caller.
//
// The workbench's reviewer: a fresh read-only session over what a work run
// left in the tree. Fresh, because a reviewer that resumes the builder's
// session grades the change by the builder's own account of it.
export const REVIEW_RULES = [
  'You are reviewing a change another Claude Code session just made in this checkout. You are read-only: Read, Grep, Glob, and git, rg and ls in Bash.',
  'The change is the working tree against HEAD: run `git diff HEAD` and `git status --short`, and read an untracked file whole. Another session may share this tree, so a change unrelated to the request is not this change.',
  'Look for correctness bugs: a wrong condition, a missed case, a broken caller, a test that cannot fail. Skip style. Each finding is `file:line` and one or two sentences on what goes wrong and when.',
  'Reply with the findings, most severe first, or the one line "No findings." when there are none. The reply goes back to the builder as its next message, so write it to them.',
].join('\n\n')

/** The reviewer's prompt: the rules, then what the builder was asked to do. */
export function reviewPrompt({ request = '' }: { request?: string } = {}): string {
  const asked = String(request).trim()
  return [REVIEW_RULES, asked ? `The builder was asked:\n\n${asked.slice(0, 4000)}` : null].filter(Boolean).join('\n\n')
}
