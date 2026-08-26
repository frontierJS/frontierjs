// docs.test.js — every `fli <command>` a reference doc names must resolve.
//
// The class this closes is the one `CLAUDE.md` has admitted for months: *the
// edges are aspirational — several documented commands do not do what the prose
// says, and three packages advertise commands that do not exist.* Prose is
// written beside a command and outlives the rename, and nothing reads prose.
//
// Its first run found four, and the sharpest was not in a doc at all: the
// message an EMPTY WORKSPACE prints told you to run `fli ws-init` and
// `fli ws-add`, and the aliases are `ws:init` and `ws:add`. The one moment the
// tool speaks to somebody who has nothing set up, it named two commands that do
// not exist.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir }                             from 'os'
import { join, dirname }          from 'path'
import { fileURLToPath }          from 'url'

import { checkDocCommands, builtinCommands, isReferenceDoc } from '../core/doc-commands.js'

const CLI  = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(CLI, '..', '..')

// An exception is a named entry with a reason — the rule this repo holds for an
// allowance anywhere else. Both of these are a doc naming a command that really
// does not exist, and the difference is what the sentence is DOING with it.
const ALLOWED = {
  'serve': 'commands/ksite/_module.md explains that `fli serve` was REMOVED — a sentence about a '
         + 'command that is gone has to name it, and that is the opposite of advertising it',
  'ksite:build': 'commands/ksite/serve.md tells you to run it and there is no build command in the '
               + 'ksite namespace. ksite is a separate static-site toolchain rather than FrontierJS '
               + '(root CLAUDE.md), and what that message should say is a question for whoever owns it',
}

async function registryNames() {
  global.fliRoot     = CLI
  global.projectRoot = REPO
  const { buildRegistry, uniqueCommands } = await import('../core/registry.js')
  const names = []
  for (const c of uniqueCommands(buildRegistry())) {
    names.push(c.title)
    if (c.alias) names.push(c.alias)
  }
  return names
}

describe('doc-commands', () => {
  test('an idea paper, a register and a CHANGES file are not reference docs', () => {
    // IDEAS/ names commands that deliberately do not exist — that is what an
    // idea paper IS — and a register is argument and history. Grading them
    // would make the check fire on 29 mentions that are all correct.
    expect(isReferenceDoc('IDEAS/diagnostics.md')).toBe(false)
    expect(isReferenceDoc('ISSUES.md')).toBe(false)
    expect(isReferenceDoc('packages/cli/CHANGES.md')).toBe(false)
    expect(isReferenceDoc('docs/handoff-archive/2026-08.md')).toBe(false)
  })

  test('a README, a CLAUDE.md and a command file are', () => {
    expect(isReferenceDoc('packages/cli/README.md')).toBe(true)
    expect(isReferenceDoc('CLAUDE.md')).toBe(true)
    expect(isReferenceDoc('packages/cli/commands/fli/check.md')).toBe(true)
  })

  test('the built-ins come from bin/fli.js rather than a list restated here', () => {
    // `fli list` is answered by the entry point and has no command file, so the
    // registry has never heard of it. A copy here would report the next one as
    // missing and nobody would know why.
    const builtins = builtinCommands(CLI)
    expect(builtins.has('list')).toBe(true)
    expect(builtins.has('help')).toBe(true)
  })

  test('a namespace resolves, a label is not a mention, and a wrong name is', () => {
    // `fli make` names the family, which a writer is entitled to do. `fli root:`
    // is a log LABEL inside a template literal. `fli make:widgets` is the shape
    // this test exists for — one letter off a command that exists.
    const dir = mkdtempSync(join(tmpdir(), 'fli-docs-'))
    writeFileSync(join(dir, 'README.md'),
      'Run `fli make:widget`, or the family `fli make`. Built in: `fli list`.\n' +
      'A label: `fli root:   /path`\n' +
      'And a wrong one: `fli make:widgets`.\n')

    const { unresolved, mentions } = checkDocCommands({
      root: dir, names: ['make:widget', 'make:model'], builtins: new Set(['list']),
    })
    rmSync(dir, { recursive: true, force: true })

    expect(mentions).toBe(4)
    expect(unresolved.map(u => u.command)).toEqual(['make:widgets'])
  })
})

describe('the repo it ships with', () => {
  test('every fli command named in a reference doc resolves', async () => {
    const names  = await registryNames()
    const result = checkDocCommands({ root: REPO, names, builtins: builtinCommands(CLI) })

    const unresolved = result.unresolved.filter(u => !(u.command in ALLOWED))
    const detail = unresolved.map(u => `  ${u.command} — ${u.file}:${u.line}`).join('\n')

    expect(result.checked).toBeGreaterThan(200)
    expect(result.mentions).toBeGreaterThan(200)
    expect(unresolved.length, `commands named in a doc that resolve to nothing:\n${detail}`).toBe(0)
  })

  test('a stale allowance is reported, the way every other allowance here is', async () => {
    const names  = await registryNames()
    const result = checkDocCommands({ root: REPO, names, builtins: builtinCommands(CLI) })
    const seen   = new Set(result.unresolved.map(u => u.command))
    const stale  = Object.keys(ALLOWED).filter(c => !seen.has(c))

    expect(stale, `allowed and no longer found — delete the entry: ${stale.join(', ')}`).toEqual([])
  })
})
