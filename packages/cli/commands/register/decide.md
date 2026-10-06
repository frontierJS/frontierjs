---
title: register:decide
description: Rule on an open question — write the ruling to DECISIONS.md and strike the question in its paper; with no id, walk every question that can be answered now
alias: decide
examples:
  - fli decide
  - fli decide scoped-sql:encrypted-columns A --section "Access control"
  - fli decide scoped-sql:encrypted-columns B --section "Access control" --why "an operator reads ciphertext on purpose"
  - fli decide scoped-sql:cache-key --by FJS-D123 --why "the key is the view's name, which D123 fixes"
args:
  -
    name: id
    description: The question's id, as `fli decisions` prints it — absent, walk the queue one key per question
  -
    name: pick
    description: The option letter — absent with --by
flags:
  section:
    char: s
    type: string
    description: The DECISIONS.md section the ruling goes under
  why:
    char: w
    type: string
    description: The reason — required when the pick is not the recommendation, or --by names a ruling the recommendation does not
  by:
    char: b
    type: string
    description: An existing ruling that already answers the question — strikes it citing that id, and writes no new ruling
---

```js
const { decide, settle }  = await import(resolve(global.fliRoot, 'core/decide.js'))
const { rulingSections }  = await import(resolve(global.fliRoot, 'core/decisions.js'))

const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? $.paths.root

if (!arg.id) {
  if (!tty.interactive) {
    echo('\n  ✗ The walk asks one key per question and needs a terminal. Answer one with fli decide <id> <letter> --section "<section>".\n')
    process.exitCode = 1
    return
  }
  const { walk }  = await import(resolve(global.fliRoot, 'core/decide-walk.js'))
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join }   = await import('node:path')

  // $VISUAL before $EDITOR, the order git asks them in. A line jump is `+N`
  // for the editors that take one; any other opens the file at its top.
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
  const jumps  = /(^|\/)(n?vim?|vi|nano|emacs|micro|hx)(\s|$)/.test(editor)
  const open   = (file, line) => tty.aside(() => $.exec({ command: `${editor}${line && jumps ? ` +${line}` : ''} "${file}"`, allowFailure: true }))

  const edit = async (text) => {
    const dir  = mkdtempSync(join(tmpdir(), 'fli-why-'))
    const file = join(dir, 'WHY.md')
    try {
      writeFileSync(file, text)
      await open(file, 1)
      return readFileSync(file, 'utf8')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  await walk({ root, tty, echo, edit, view: (q) => open(join(root, q.file), q.line) })
  return
}

if (flag.by) {
  if (arg.pick) {
    echo(`\n  ✗ --by settles ${arg.id} with an existing ruling, so there is no letter to pick — drop ${arg.pick}\n`)
    process.exitCode = 1
    return
  }
  const out = settle({ root, id: arg.id, by: flag.by, why: flag.why ?? '' })
  echo('')
  if (!out.ok) {
    echo(`  ✗ ${out.reason}`)
    echo('')
    process.exitCode = 1
    return
  }
  echo(`  ✓ ${out.question} — answered by ${out.ruling}`)
  for (const f of out.files) echo(`    wrote ${f}`)
  echo('    register:check agrees with the result')
  echo('')
  return
}

if (!arg.pick) {
  echo(`\n  ✗ name the option letter, or --by <ruling> when a ruling already answers ${arg.id}\n`)
  process.exitCode = 1
  return
}

if (!flag.section) {
  echo('')
  echo('  --section is required. DECISIONS.md has:')
  for (const s of rulingSections(root)) echo(`    ${s}`)
  echo('')
  process.exitCode = 1
  return
}

const out = decide({ root, id: arg.id, pick: arg.pick, why: flag.why ?? '', section: flag.section })

echo('')
if (!out.ok) {
  echo(`  ✗ ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

echo(`  ✓ ${out.ruling} — ${out.question} → ${out.pick}`)
for (const f of out.files) echo(`    wrote ${f}`)
echo('    register:check agrees with the result')
echo('')
```

## What it writes

One act, two files: a ruling prepended to the named section of `DECISIONS.md`
under the next free `FJS-D` id, and the question struck in its paper with that
id beside the answer — the paper's own `~~**question**~~ **Answered …**`
convention. `register:check` runs over the result, and a write it finds a new
error in is put back and refused, so neither file is left half answered.

A pick that follows the paper's recommendation takes its reason from the
recommendation. A pick against it needs `--why`, because a ruling that
overrides the written argument without saying why is one nobody can reread.

With no id it walks the queue: every question an existing ruling settles, then
every one with options, one at a time. A key answers each — the option's
letter, Enter for the recommendation, `s` to skip, `v` to open the paper at the
question, Esc to stop. A pick against the recommendation opens `$VISUAL` or
`$EDITOR` for the reason; saving it empty goes back without ruling. The section
is picked by number, and Enter repeats the last one. Every answer is the same
`decide` or `--by` a typed command would be, refusals included. It needs a
terminal.

`--by <ruling>` is for a question an existing ruling already answers. It writes
the paper alone — the question struck with that ruling's id — and nothing to
`DECISIONS.md`, since a pick there would mint a second ruling saying what the
first one says. Options are not needed. The reason is the recommendation's when
it names the ruling, and `--why` otherwise. A withdrawn or superseded ruling is
refused, the second naming what replaced it.
