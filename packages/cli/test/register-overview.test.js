// register-overview.test.js — `fli register:overview` names only what exists.
//
// The overview is a map to the other register commands, typed by hand, so a
// renamed command or flag would leave it pointing at nothing with no error
// anywhere. Every `fli <name> --flag` it prints is resolved here against the
// command files themselves, and its counts against the readers they come from.

import { describe, test, expect } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { openDecisions } from '../core/decisions.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FLI  = resolve(ROOT, 'bin/fli.js')
const CMDS = join(ROOT, 'commands', 'register')

// name or alias → its flag names, read off each command's frontmatter.
function registerCommands() {
  const out = new Map()
  for (const file of readdirSync(CMDS).filter(f => f.endsWith('.md') && !f.startsWith('_'))) {
    const front = readFileSync(join(CMDS, file), 'utf8').split('---')[1]
    const flags = [...(front.split(/^flags:$/m)[1] ?? '').matchAll(/^  ([\w-]+):$/gm)].map(m => m[1])
    const name  = file.replace(/\.md$/, '')
    out.set(`register:${name}`, flags)
    const alias = front.match(/^alias:\s*(\S+)/m)?.[1]
    if (alias) out.set(alias, flags)
  }
  return out
}

function fixture({ loops }) {
  const root = mkdtempSync(join(tmpdir(), 'fli-overview-'))
  const pkg  = { registers: { prefix: 'FJS' }, ...(loops ? { scripts: { 'fix:loop': 'bun x.mjs' } } : {}) }
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
  if (loops) {
    mkdirSync(join(root, '.claude', 'skills', 'fix-next'), { recursive: true })
    writeFileSync(join(root, '.claude', 'skills', 'fix-next', 'SKILL.md'), '---\nname: fix-next\n---\n')
  }
  mkdirSync(join(root, 'IDEAS'))
  writeFileSync(join(root, 'ISSUES.md'), '## Needs a decision\n\n| Id | Area | Question | Detail |\n| --- | --- | --- | --- |\n')
  writeFileSync(join(root, 'DECISIONS.md'), '# Decisions\n\n## Access control\n\n### <a id="fjs-d03"></a>2026-08-01 · `FJS-D03` — a view is not a model.\n\nBody.\n')
  writeFileSync(join(root, 'IDEAS', 'views.md'), [
    '---', 'id: views', 'status: proposed', '---', '', '## Open questions', '',
    '- **Omit encrypted columns?** Prose.', '  - **A** — omit', '  - **B** — expose', '  - **Recommend A** — leaks nothing',
    '- **Is a view a model?** Asked.', '  - **A** — no', '  - **Recommend A** — FJS-D03 settles it',
    '- **Does the cache key grow?** Unmeasured.', '',
  ].join('\n'))
  const run = () => execSync(`"${process.execPath}" "${FLI}" register:overview`, { cwd: root, encoding: 'utf8' })
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('fli register:overview', () => {
  test('every command and flag it names is a real register command and flag', () => {
    const { run, cleanup } = fixture({ loops: true })
    try {
      const known = registerCommands()
      const named = [...run().matchAll(/\bfli ([\w:-]+)((?: +(?:<[^>]+>|--[\w-]+(?: "[^"]*"| (?!fli)[^\s-·(]\S*)?))*)/g)]
      expect(named.length).toBeGreaterThan(6)
      for (const [, cmd, rest] of named) {
        expect(known.has(cmd) ? cmd : `unknown: ${cmd}`).toBe(cmd)
        for (const [, flag] of rest.matchAll(/--([\w-]+)/g)) {
          expect(known.get(cmd).includes(flag) ? flag : `${cmd} has no --${flag}`).toBe(flag)
        }
      }
    } finally { cleanup() }
  })

  test('the counts are the readers’ counts, and Start here names the walk while something can be answered', () => {
    const { root, run, cleanup } = fixture({ loops: true })
    try {
      const out = run()
      const q   = openDecisions(root)
      expect(q.decidable.length).toBe(1)
      expect(q.settled.length).toBe(1)
      expect(out).toMatch(/^\s+1\s+options written/m)
      expect(out).toMatch(/^\s+1\s+a ruling already answers it/m)
      expect(out).toMatch(/^\s+1\s+open, no options yet/m)
      expect(out).toContain('Start here: fli decide — 2 question(s)')
    } finally { cleanup() }
  })

  test('a loop or skill is named only where the project has it', () => {
    const withLoops = fixture({ loops: true })
    const bare      = fixture({ loops: false })
    try {
      const a = withLoops.run()
      expect(a).toContain('/fix-next in a Claude session · bun run fix:loop')
      expect(a).not.toContain('frame:loop')
      expect(a).toContain('write **A** — … and **Recommend A** — why under the bullet')

      const b = bare.run()
      expect(b).not.toContain('fix-next')
      expect(b).toContain('by hand, then close it')
    } finally { withLoops.cleanup(); bare.cleanup() }
  })
})
