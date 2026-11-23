// ─── ask-prompt.test.js — what the console's ask says to Claude ─────────────
//
// The prompt for one press of the output panel's ask. What Claude may touch
// is the argv, pinned in `@frontierjs/claude`'s `test/transport.test.ts`.

import { describe, test, expect } from 'bun:test'

import { ASK_MAX_LINES, ASK_MAX_RULES, ASK_RULES, askPrompt } from '../core/ask-prompt.js'

describe('askPrompt', () => {

  test('a first question carries the ground rules, where I am, the tree and the output', () => {
    const p = askPrompt({
      question: 'why did this fail?',
      output:   '$ fli test:done\n✗ snapshots',
      context:  { panel: 'release', 'release-app': 'example', empty: '' },
      git:      '## main\n M ISSUES.md',
    })
    expect(p).toContain('read-only')
    expect(p).toContain('Question: why did this fail?')
    expect(p).toContain('- release-app: example')
    expect(p).not.toContain('empty:')
    expect(p).toContain(' M ISSUES.md')
    expect(p).toContain('✗ snapshots')
  })

  test('no question asks the default one', () => {
    expect(askPrompt({ output: 'x' })).toContain('Question: What does this output say')
  })

  test('edited instructions replace the default ones; blank ones fall back to them', () => {
    const p = askPrompt({ output: 'x', rules: '  Answer in one sentence.  ' })
    expect(p.startsWith('Answer in one sentence.\n\n')).toBe(true)
    expect(p).not.toContain(ASK_RULES)
    expect(askPrompt({ output: 'x', rules: '   ' })).toContain(ASK_RULES)
    expect(askPrompt({ output: 'x', rules: 'y'.repeat(ASK_MAX_RULES + 50) })).not.toContain('y'.repeat(ASK_MAX_RULES + 1))
  })

  test('a follow-up drops the ground rules, edited or not, and names the output as new', () => {
    expect(askPrompt({ output: 'x', rules: 'Answer in one sentence.', followUp: true })).not.toContain('one sentence')
    const p = askPrompt({ question: 'and now?', output: 'later line', followUp: true })
    expect(p).not.toContain('read-only')
    expect(p).toContain('Output since my last question')
  })

  test('a long output keeps its TAIL and says how much was cut', () => {
    const lines = Array.from({ length: ASK_MAX_LINES + 10 }, (_, i) => `line ${i}`)
    const p = askPrompt({ output: lines.join('\n') })
    expect(p).toContain(`the first 10 cut`)
    expect(p).not.toContain('line 9\n')
    expect(p).toContain(`line ${ASK_MAX_LINES + 9}`)
  })

})
