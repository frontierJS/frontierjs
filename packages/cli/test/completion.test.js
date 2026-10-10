// completion.test.js — the bash completion script completes past a colon, and
// hands a path back to readline where a command takes an argument.
//
// ':' is in COMP_WORDBREAKS, so readline hands the function "env:g" as three
// words and replaces only the text after the last colon. The script is driven
// here in a real bash with COMP_WORDS split that way. `fli` is a shell function
// answering a fixed list, so what is graded is the script and not whichever fli
// happens to be on PATH.

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

const script = spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), 'completion:generate', '--shell', 'bash'], {
  encoding: 'utf8',
  cwd: ROOT,
}).stdout

const NAMES = ['env:get', 'env:set', 'eget', 'deploy', 'deploy:logs', 'deploy:local']

// words: COMP_WORDS as readline splits them, the last one being completed
const complete = (line, words, answer = NAMES) => {
  const program = `
${script}
fli() { printf '%s\\n' ${answer.join(' ')}; }
COMP_LINE=${JSON.stringify(line)}
COMP_POINT=\${#COMP_LINE}
COMP_WORDS=(${words.map((w) => JSON.stringify(w)).join(' ')})
COMP_CWORD=${words.length - 1}
_fli_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`
  const out = spawnSync('bash', ['-c', program], { encoding: 'utf8' })
  expect(out.stderr).toBe('')
  return out.stdout.split('\n').filter(Boolean).sort()
}

describe('bash completion', () => {

  test('a word with no colon completes whole names', () => {
    expect(complete('fli dep', ['fli', 'dep'])).toEqual(['deploy', 'deploy:local', 'deploy:logs'])
  })

  test('after a colon, replies are the part after it', () => {
    expect(complete('fli env:', ['fli', 'env', ':'])).toEqual(['get', 'set'])
  })

  test('a partial after a colon narrows', () => {
    expect(complete('fli deploy:lo', ['fli', 'deploy', ':', 'lo'])).toEqual(['local', 'logs'])
    expect(complete('fli env:g', ['fli', 'env', ':', 'g'])).toEqual(['get'])
  })

  test('the files answer leaves the reply empty, for readline to complete a path', () => {
    expect(complete('fli cat RE', ['fli', 'cat', 'RE'], ['__fli_files__'])).toEqual([])
  })

})

describe('completion:query', () => {
  const query = (line) => spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), 'completion:query', line], {
    encoding: 'utf8',
    cwd: ROOT,
  }).stdout.split('\n').filter(Boolean)

  test('where a command takes an argument, it answers files', () => {
    expect(query('fli cat ')).toEqual(['__fli_files__'])
    expect(query('fli outline core/ca')).toEqual(['__fli_files__'])
  })

  test('a word starting with a dash still answers flags', () => {
    expect(query('fli cat --')).toContain('--raw')
  })

  test('a command with no arguments answers flags', () => {
    expect(query('fli ws:atlas ')).toContain('--dry')
  })
})
