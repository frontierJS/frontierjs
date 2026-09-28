// test/guarded-write.test.js — core/guarded-write.js
//
// Both directions are pinned, because each one fails silently: a read that
// fires teaches the reader to skip the hint, and a write that does not fire is
// the edit decision-rules exists to catch.

import { test, expect, describe } from 'bun:test'
import { guardedWrite } from '../core/guarded-write.js'

const bash = command => guardedWrite({ tool_name: 'Bash', tool_input: { command } })
const REGISTER = /^Register write/
const LANGUAGE = /^Language surface/

describe('guardedWrite', () => {
  test('Write and Edit are graded by path', () => {
    expect(guardedWrite({ tool_name: 'Write', tool_input: { file_path: '/r/IDEAS/geo.md' } })).toMatch(REGISTER)
    expect(guardedWrite({ tool_name: 'Edit', tool_input: { file_path: '/r/DECISIONS.md' } })).toMatch(REGISTER)
    expect(guardedWrite({ tool_name: 'Edit', tool_input: { file_path: '/r/packages/litestone/src/core/parser.js' } })).toMatch(LANGUAGE)
    expect(guardedWrite({ tool_name: 'Edit', tool_input: { file_path: '/r/ISSUES.md' } })).toBeNull()
    expect(guardedWrite({ tool_name: 'Edit', tool_input: { file_path: '/r/NOT_DECISIONS.md.bak' } })).toBeNull()
  })

  test('a Bash command that only reads a guarded file is silent', () => {
    for (const command of [
      'rg -n "FJS-D4" DECISIONS.md',
      "sed -n '10,20p' IDEAS/geo.md | head",
      'cat DECISIONS.md DRIVES.md | wc -l',
      'rg -n status: IDEAS/ > /tmp/scratch/status.txt',
      'git diff DECISIONS.md 2>&1',
      'git log --oneline -- IDEAS/overview.md',
      'cp DECISIONS.md /tmp/scratch/d.md',
      'wc -l packages/litestone/src/core/parser.js',
      'awk \'/^## /\' IDEAS/overview.md',
      "python3 - <<'X'\nopen(p, 'w').write('see `DECISIONS.md` and IDEAS/geo.md for the ruling')\nX",
    ]) expect([command, bash(command)]).toEqual([command, null])
  })

  test('a Bash command that writes a guarded file fires', () => {
    for (const command of [
      "cat > IDEAS/new.md <<'EOF'\n---\nstatus: proposed\n---\nEOF",
      'echo row >> DECISIONS.md',
      'printf x | tee -a DECISIONS.md',
      "sed -i 's/partial/shipped/' IDEAS/geo.md",
      "perl -pi -e 's/a/b/' DECISIONS.md",
      'mv IDEAS/old.md IDEAS/archive/old.md',
      'rm IDEAS/withdrawn.md',
      'cp /tmp/scratch/d.md DECISIONS.md',
      'git checkout -- DECISIONS.md',
      "node -e \"require('fs').writeFileSync('IDEAS/x.md', s)\"",
    ]) expect([command, bash(command)]).toEqual([command, expect.stringMatching(REGISTER)])
    expect(bash("sed -i 's/@x/@y/' packages/litestone/src/core/catalog.js")).toMatch(LANGUAGE)
  })

  test('one write to both kinds names both', () => {
    const context = bash('touch DECISIONS.md packages/litestone/src/core/parser.js')
    expect(context).toMatch(REGISTER)
    expect(context).toMatch(/Language surface/)
  })

  test('another tool is silent', () => {
    expect(guardedWrite({ tool_name: 'Read', tool_input: { file_path: 'DECISIONS.md' } })).toBeNull()
    expect(guardedWrite()).toBeNull()
  })
})
