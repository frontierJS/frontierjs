// ─── outline-hint.mjs — the PreToolUse gate in front of a wide read ─────────
//
// A Read with no limit, a bare `cat`, or a wide `sed -n` window on a long file
// is refused with the file's outline; a narrow window on a very long one gets
// the hint. A read a command answers in a line — an `rg` over a register, any
// read of a plan, an `rg` for one identifier over the tree — gets that
// command named beside it (`FJS-3461`). Which calls count, the thresholds and
// every text are in `packages/cli/core/outline.js`, where they are tested;
// this file counts lines.
//
// Registered twice: by this project, and with `--global` by the user's settings
// so every other project gets it. A project carrying its own copy answers for
// itself, or the refusal arrives twice.
//
// It must never break a session: every failure, and a file with no outline,
// exits 0 with nothing printed.

import { existsSync, readFileSync }  from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const say  = out => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }))

try {
  const project = process.env.CLAUDE_PROJECT_DIR
  if (process.argv.includes('--global') && project && existsSync(join(project, '.claude', 'hooks', 'outline-hint.mjs'))) process.exit(0)
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const { wideRead, readVerdict, readRefusal, outlineHint, outlineFile, renderOutline, hintedRead, readHint } =
    await import(pathToFileURL(join(REPO, 'packages', 'cli', 'core', 'outline.js')).href)
  const read   = wideRead(input)
  const hinted = hintedRead(input)
  const road   = hinted ? readHint(hinted) : null
  if (!read) { if (road) say({ additionalContext: road }); process.exit(0) }
  const file = isAbsolute(read.path) ? read.path : join(input.cwd || project || process.cwd(), read.path)
  if (!existsSync(file)) process.exit(0)
  let lines = 0
  for (const byte of readFileSync(file)) if (byte === 10) lines++
  const verdict = readVerdict(read, lines)
  const got = verdict ? await outlineFile(file) : null
  const outlined = got && !got.refused && got.rows.length > 0
  if (verdict === 'deny' && outlined) say({ permissionDecision: 'deny', permissionDecisionReason: [readRefusal(read.path, lines, renderOutline(got.rows)), road].filter(Boolean).join('\n') })
  else {
    const context = [verdict === 'hint' && outlined ? outlineHint(read.path, lines) : null, road].filter(Boolean).join('\n')
    if (context) say({ additionalContext: context })
  }
} catch {}
