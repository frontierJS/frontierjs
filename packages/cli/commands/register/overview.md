---
title: register:overview
description: How the registers are worked — the issue loop and the decision loop, each step with its command and today's count
examples:
  - fli register:overview
---

```js
const { existsSync, readFileSync } = await import('node:fs')
const { join }                     = await import('node:path')

const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))
const { rankNext }         = await import(resolve(global.fliRoot, 'core/next.js'))
const { openDecisions }    = await import(resolve(global.fliRoot, 'core/decisions.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? context.paths.root

const issues = rankNext(root)
const q      = openDecisions(root)

// The headless loops and their skills are this project's, not fli's, so a
// line naming one prints only where it exists.
let scripts = {}
try { scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {} } catch {}
const skill = (name) => existsSync(join(root, '.claude', 'skills', name, 'SKILL.md'))
const ways  = (name, loop) => [
  skill(name)   ? `/${name} in a Claude session` : null,
  scripts[loop] ? `bun run ${loop} (headless, one fresh session each)` : null,
].filter(Boolean).join(' · ')

// Color only decorates: piped, every line is the plain text the tests and a
// grep read, so the words and their spacing must not depend on it.
const amber = chalk.hex('#f5a623')
const RULE  = 78

const paint = (cmd) => cmd
  .replace(/(?<= )\([^)]*\)/g, m => chalk.dim(m))
  .replace(/\bfli [\w:-]+/g, m => amber.bold(m))
  .replace(/(^|· )(\/[\w-]+)/g, (_, pre, m) => pre + chalk.cyan.bold(m))
  .replace(/\bbun run [\w:-]+/g, m => chalk.cyan.bold(m))
  .replace(/ · /g, chalk.dim(' · '))

const tone = (v, hue) => (v ? hue.bold : chalk.dim)(String(v).padStart(4))

const row    = (count, what, cmd) => echo(`  ${count}  ${what.padEnd(30)} ${paint(cmd)}`)
const act    = (what, cmd)        => echo(`  ${chalk.dim('   ›')}  ${chalk.italic(what.padEnd(30))} ${paint(cmd)}`)
const header = (file, gist)       => {
  echo(`  ${chalk.bold(file)} ${chalk.dim(`— ${gist}`)}`)
  echo(`  ${chalk.dim('─'.repeat(RULE))}`)
}

echo('')
echo(`  ${amber.bold('fli register:overview')} ${chalk.dim('— two loops over three files')}`)
echo('')
header('ISSUES.md', 'what is wrong')
row(tone(issues.ready.length, chalk.green),  'ready to work, ranked',       'fli next  (--pkg <name>)')
row(tone(issues.blocked.length, chalk.red),  'waiting on a row or a ruling', 'listed under fli next — back by itself when that closes')
act('fix one',                   ways('fix-next', 'fix:loop') || 'by hand, then close it')
act('a choice met mid-fix',      'fli file --sev decision --blocks <id> … — the options go in a bullet naming the new id')
act('close it, with the proof',  'fli close <id> --how "…"')
act('found a new defect',        'fli find <terms> first — filed already? fli amend <id> --detail …')
act('not filed yet',               'fli file --sev S3 --area … --title … --detail …')
echo('')
header('Open questions', 'what is not settled (IDEAS papers, and ISSUES § Needs a decision)')
row(tone(q.open.length, chalk.yellow),     'open, no options yet',         ways('frame-next', 'frame:loop') || 'write **A** — … and **Recommend A** — why under the bullet')
row(tone(q.decidable.length, chalk.cyan),  'options written — pick one',   'fli decide  (Enter takes the recommendation)')
row(tone(q.settled.length, chalk.green),   'a ruling already answers it',  'fli decide  (y confirms)  ·  fli decide <id> --by <ruling>')
row(tone(q.ruled, chalk.dim),              'answered, struck in the paper', chalk.dim('the ruling is in DECISIONS.md — check it before relitigating'))
act('list them',                 'fli decisions  (--open for the unframed ones)')
echo('')
header('Across both', 'the registers as one picture')
act('both at once',              'fli register:atlas --open')
act('keep them honest',          'fli register:check')
echo('')

const start =
  q.settled.length + q.decidable.length ? `fli decide — ${q.settled.length + q.decidable.length} question(s) you can answer with one key`
  : issues.ready.length                 ? `fli next — ${issues.ready.length} row(s) ready`
  : q.open.length                       ? `${q.open.length} open question(s) need options before anyone can rule`
  : 'nothing open'
echo(`  ${chalk.bgHex('#f5a623').black.bold(' ▶ Start here: ')}${paint(start)}`)
echo('')
```

## The two loops

**An issue is closed by the register, not by whoever says it is fixed.**
`fli next` ranks what is open. A fix ends with `fli close <id> --how`, naming
what changed and how it was proven, and a row that never moved to § Closed was
not fixed, whatever the session reported. Where the project has the `fix-next`
skill, a Claude session carries one row from re-probe to closed. `bun run
fix:loop` runs that skill headless, one fresh session per row.

**A choice met mid-fix waits for its owner instead of being made.** The fix
files it with `fli file --sev decision --blocks <row>`, writes the options in a
bullet naming the new id (`IDEAS/owed-rulings.md` when no paper argues it), and
moves on; `fli next` sets the row aside. Answering the question with `fli
decide` closes it under that id, and the row comes back. `/fix-next --ask`
puts the choice to you in the session instead.

**An open question is ruled by its owner, and the framing is anyone's.** A
question starts OPEN: a bold lead in a paper's `## Open questions`. It becomes
DECIDABLE when lettered options and a recommendation are written under it:

    - **Omit encrypted columns from a view?** prose
      - **A** — omit them
      - **B** — expose the ciphertext
      - **Recommend A** — a view that leaks nothing is what a caller expects

The `frame-next` skill, or `bun run frame:loop` headless, writes those options
and never rules. `fli decide` with no id walks every question that can be
answered now: a letter picks, Enter takes the recommendation, and a pick
against it opens `$EDITOR` for the reason. A question whose recommendation
names a live ruling is SETTLED: confirming it strikes the question citing that
ruling and mints no new one.

The counts are read from the same files the commands write, so a number here
and the list its command prints always agree.
