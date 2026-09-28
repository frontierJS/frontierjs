// ─── guarded-write.js — which tool calls WRITE a file decision-rules guards ──
//
// The policy of `.claude/hooks/guarded-write.mjs`. The hook it replaces matched
// a guarded path ANYWHERE in a Bash command, so `rg -n D4 DECISIONS.md` drew
// "Register write" as surely as a heredoc over it — and an alarm that rings on
// every read is one an agent learns to skip, which is the moment it rings on a
// write. So a Bash command counts only where a guarded path is a WRITE TARGET:
// a redirect, `tee`, an in-place editor, a move/copy/remove, a git verb that
// rewrites the tree, or an inline script that calls a file-writing API.
//
// The miss is a write spelled some other way; the Write and Edit tools, which
// every register edit is meant to go through, are graded by path and miss
// nothing.

/** Each guarded path and what the hook says in front of a write to it. */
export const GUARDED = [
  {
    path: /(^|\/)(DECISIONS\.md|IDEAS\/.+\.md)$/,
    context: 'Register write. Call the Skill tool with decision-rules before this edit lands.',
  },
  {
    path: /(^|\/)packages\/litestone\/src\/core\/(parser|catalog)\.js$/,
    context: 'Language surface. A new word in the .lite grammar or catalog is a coined noun — call the Skill tool with decision-rules before this edit lands.',
  },
]

const SEGMENT = /&&|\|\||[;|\n]/
const REDIRECT = /\d*>>?\s*(['"]?)([^\s'"&|;<>]+)\1/g
const WRITER_API = /\b(writeFileSync|writeFile|appendFileSync|appendFile|Bun\.write|write_text|createWriteStream)\b|\bopen\([^)]*['"][wax]\+?['"]/

// every argument is a target: a move empties its source, a remove is a write
const ALL_ARGS = new Set(['mv', 'rm', 'touch', 'truncate', 'tee', 'install', 'patch', 'unlink'])
// only the last argument is: `cp DECISIONS.md /tmp/x` reads the register
const LAST_ARG = new Set(['cp', 'ln', 'rsync'])
const GIT_WRITES = new Set(['checkout', 'restore', 'apply', 'rm', 'mv', 'am', 'reset', 'stash'])

const unquote = word => word.replace(/^(['"])(.*)\1$/, '$2')
const words = segment => (segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote)

/** The words of one simple command that name a file it writes. */
function segmentTargets(segment) {
  let argv = words(segment.replace(REDIRECT, ' '))
  while (argv.length && (/^\w+=/.test(argv[0]) || argv[0] === 'sudo' || argv[0] === 'command')) argv.shift()
  const [cmd, ...rest] = argv
  const args = rest.filter(w => !w.startsWith('-'))
  if (ALL_ARGS.has(cmd)) return args
  if (LAST_ARG.has(cmd)) return args.slice(-1)
  if ((cmd === 'sed' || cmd === 'perl') && rest.some(w => /^-[A-Za-z]*i/.test(w) || w === '--in-place')) return args
  if (cmd === 'awk' && /-i\s*inplace/.test(segment)) return args
  if (cmd === 'git' && GIT_WRITES.has(args[0])) return args.slice(1)
  return []
}

/** Every path `command` writes, as far as its spelling says. */
export function writeTargets(command) {
  const targets = [...command.matchAll(REDIRECT)].map(m => m[2])
  for (const segment of command.split(SEGMENT)) targets.push(...segmentTargets(segment))
  // an inline script's target is a string literal that is ONLY a path; one
  // named inside prose it is also writing is a mention, not the target
  if (WRITER_API.test(command)) targets.push(...[...command.matchAll(/(['"])([\w./-]+)\1/g)].map(m => m[2]))
  return targets
}

/** The context to add in front of this tool call, or null when it writes nothing guarded. */
export function guardedWrite({ tool_name, tool_input } = {}) {
  const targets =
    tool_name === 'Write' || tool_name === 'Edit' ? [tool_input?.file_path ?? '']
    : tool_name === 'Bash' ? writeTargets(String(tool_input?.command ?? ''))
    : []
  const hits = GUARDED.filter(g => targets.some(t => g.path.test(t)))
  return hits.length ? hits.map(g => g.context).join(' ') : null
}
