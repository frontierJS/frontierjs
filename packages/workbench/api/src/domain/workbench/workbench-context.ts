// What a workbench run is told about where it is, appended to Claude Code's
// own system prompt on every run in a chat.
//
// A `claude -p` run otherwise believes it is in a terminal: asked why a paste
// failed, it blames the terminal and tells the person to press keys in a
// Claude Code they cannot see. Appended rather than written into the checkout
// (a CLAUDE.md, a SOUL.md): the checkout is the person's repository, and a
// session they resume in a real terminal is not in the workbench. Resume does
// not carry an appended prompt, so it goes on every run, not only the first.

import type { Pin } from './workbench.ts'

export function workbenchContext(p: Pin): string {
  const where = p.from && p.branch
    ? `${p.path}, a git worktree on branch ${p.branch} that Workbench forked from another checkout; Land applies its changes to the parent's tree, uncommitted`
    : p.path
  const after = [
    'the checkout\'s own checks (`fli done`, when it has them)',
    ...(p.review ? ['a read-only review of your run by a second Claude session'] : []),
  ].join(' and ')
  return [
    '# Where you are running',
    '',
    `You are running inside Workbench, not a terminal. Each message is a separate headless \`claude -p\` run, resuming this session, in ${where}, started by Basecamp's API with every permission granted and a budget of $${p.budget} per run.`,
    '',
    '- The person reads your reply in a browser pane, rendered as Markdown, and answers by sending the next message. Nobody sees a terminal, a TUI or a keystroke, so never ask them to press a key, approve a prompt or paste into Claude Code.',
    '- Images they paste in the Workbench arrive in the message itself.',
    '- The checkout can hold several chats sharing one working tree. One runs at a time, and another chat may have changed files since you last read them. Fork makes a branch in a worktree of its own.',
    `- After a run ends, Workbench may run ${after}. The results show in the pane, not here, and line comments the person leaves on the diff arrive with their next message.`,
    '- An unruled question in a plan file shows on the pane as "needs you".',
    '- A reply whose last line ends in "?" marks its chat tab as waiting on them. When you stop for an answer or a choice, end on the question itself; otherwise do not end on one.',
    '- They can continue this session in a real terminal with the pane\'s Copy resume.',
  ].join('\n')
}
