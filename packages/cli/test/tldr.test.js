// ─── tldr.test.js — the page `fli tldr` draws from a tldr-shaped reply ───────
//
// `chalk` here tags each style in brackets, so a test can read which part of a
// line was drawn how without escape codes.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderTldr, tldrPrompt, readVocabulary, TLDR_RULES } from '../core/tldr.js'
import { askArgv } from '../core/ask-claude.js'

const tag = name => s => `[${name}:${s}]`
const chalk = {
  bold: tag('b'), dim: tag('d'), green: tag('g'), cyan: tag('c'), underline: tag('u'),
  magenta: tag('m'), yellow: tag('y'),
}

// A VOCABULARY.md in the shape the real one has, through the real reader.
function vocabulary() {
  const root = mkdtempSync(join(tmpdir(), 'tldr-vocab-'))
  writeFileSync(join(root, 'VOCABULARY.md'), [
    '| Term | Status | Home | Under | Means | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Resource | blessed | UI | | | |',
    '| Gate | blessed | Data | Model | who may read or write a row, `@@gate` | |',
    '| Gate ladder | blessed | Data | Gate | the levels a gate grades | |',
    '| Run | blessed | API | | one execution of a flow | |',
    '| Move | alias | Data | Transition | Transition | |',
    '| Journey | refused | | | say navigation or a transition | |',
    '| Table | open | Data | | | |',
  ].join('\n'))
  return readVocabulary(root)
}

const PAGE = [
  '# Run tests',
  '',
  '> Run a package\'s own suite with `bun run test`.',
  '> More: docs/TESTING.md',
  '',
  '- Run one package:',
  '',
  '`cd packages/{{package}} && bun run test`',
  '',
  '',
  '- Run them all:',
  '',
  '`bun run --filter \'*\' test`',
].join('\n')

describe('renderTldr', () => {
  test('draws each part of the page in its own style', () => {
    expect(renderTldr(PAGE, chalk)).toBe([
      '  [b:Run tests]',
      '',
      '  [d:Run a package\'s own suite with ][c:bun run test][d:.]',
      '  [d:More: docs/TESTING.md]',
      '',
      '  [g:Run one package:]',
      '',
      '      [c:cd packages/][u:[c:package]][c: && bun run test]',
      '',
      '  [g:Run them all:]',
      '',
      '      [c:bun run --filter \'*\' test]',
      '',
    ].join('\n'))
  })

  test('a fenced page renders the same as a bare one', () => {
    expect(renderTldr('```markdown\n' + PAGE + '\n```\n', chalk)).toBe(renderTldr(PAGE, chalk))
  })

  test('a reply in no tldr shape still prints every line', () => {
    const out = renderTldr('I could not find that.\nTry `fli list`.', chalk)
    expect(out).toContain('I could not find that.')
    expect(out).toContain('Try [c:fli list].')
  })
})

describe('the vocabulary', () => {
  const vocab = vocabulary()

  test('an open row is not vocabulary yet', () => {
    expect(vocab.terms.has('table')).toBe(false)
    expect(vocab.terms.has('gate')).toBe(true)
  })

  test('a Capitalized term is colored, a lowercase word and a sentence-start verb are not', () => {
    const out = renderTldr('- Run the Gate ladder, then run the Gate on each Resources list:', chalk, vocab)
    expect(out).toContain('[g:Run the ][m:Gate ladder][g:, then run the ][m:Gate][g: on each ][m:Resources][g: list:]')
  })

  test('the glossary defines what the page used, refused words first, nothing it did not', () => {
    const out = renderTldr('> A Journey is a Move through a Gate.', chalk, vocab)
    const tail = out.trimEnd().split('\n').slice(-3)
    expect(tail).toEqual([
      '  [y:Journey] [d:is not a word here — say navigation or a transition]',
      '  [m:Move] [d:is Transition]',
      '  [m:Gate] [d:who may read or write a row, ][c:@@gate]',
    ])
    expect(out).not.toContain('Resource')
  })

  test('the prompt names blessed, alias and refused words, and no open ones', () => {
    const p = tldrPrompt('deploy', vocab)
    expect(p).toContain('Gate ladder')
    expect(p).toContain('Move (say Transition)')
    expect(p).toContain('Journey (say navigation or a transition)')
    expect(p).not.toContain('Table')
  })

  test('no VOCABULARY.md is no vocabulary', () => {
    expect(readVocabulary(mkdtempSync(join(tmpdir(), 'tldr-none-')))).toBe(null)
  })
})

describe('tldrPrompt', () => {
  test('the rules come first and the question last, trimmed', () => {
    const p = tldrPrompt('  how do I deploy  \n')
    expect(p.startsWith(TLDR_RULES)).toBe(true)
    expect(p.endsWith('The question:\n\nhow do I deploy')).toBe(true)
  })
})

describe('askArgv model', () => {
  test('a model is passed through, and none leaves the account default', () => {
    expect(askArgv({ model: 'haiku' }).join(' ')).toContain('--model haiku')
    expect(askArgv({}).includes('--model')).toBe(false)
  })
})
