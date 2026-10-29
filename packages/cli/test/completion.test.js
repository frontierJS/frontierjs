// completion.test.js — what Tab offers, and the three scripts that offer it.
//
// ':' is in COMP_WORDBREAKS, so readline hands the bash function "env:g" as three
// words and replaces only the text after the last colon. The script is driven
// here in a real bash with COMP_WORDS split that way. `fli` is a shell function
// answering a fixed list, so what is graded is the script and not whichever fli
// happens to be on PATH. zsh and fish are graded only where they are installed,
// and are skipped, not passed, where they are not.

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { KINDS, declarationProblem } from '../core/flags.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')
const FLI   = resolve(ROOT, 'bin/fli.js')

const generate = (shell) =>
  spawnSync(process.execPath, [FLI, 'completion:generate', '--shell', shell], { encoding: 'utf8', cwd: ROOT }).stdout

const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0

const NAMES = ['env:get\tRead one', 'env:set\tWrite one', 'eget\tRead one', 'deploy', 'deploy:logs', 'deploy:local']

// ─── bash ────────────────────────────────────────────────────────────────────

const bashScript = generate('bash')

// bash's $'…' quoting, so a tab in an answer reaches the script as a tab
const ansiQuote = (s) => "$'" + s.replace(/[\\']/g, (c) => '\\' + c).replace(/\t/g, () => '\\t') + "'"

// words: COMP_WORDS as readline splits them, the last one being completed
const complete = (line, words, answer = NAMES) => {
  const program = `
${bashScript}
fli() { printf '%s\\n' ${answer.map(ansiQuote).join(' ')}; }
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

  test('a description never reaches the reply', () => {
    expect(complete('fli eg', ['fli', 'eg'])).toEqual(['eget'])
  })

  test('the path and dir answers leave the reply empty, for readline to complete', () => {
    expect(complete('fli cat RE', ['fli', 'cat', 'RE'], ['__fli_path__'])).toEqual([])
    expect(complete('fli db:restore p', ['fli', 'db:restore', 'p'], ['__fli_dir__'])).toEqual([])
  })

})

// ─── zsh and fish ────────────────────────────────────────────────────────────
// Each script is loaded into the real shell with a stub `fli`, and the
// candidates it would hand the shell's completion system are captured by
// replacing that system's entry point.

describe('zsh completion', () => {
  test.skipIf(!has('zsh'))('escapes the colon in a name and keeps the description', () => {
    const program = `
compdef() { :; }
_describe() { print -rl -- "\${(@P)4}"; }
${generate('zsh')}
fli() { print -- $'env:get\\tRead one'; print -- deploy; }
words=(fli env:)
CURRENT=2
_fli
`
    const out = spawnSync('zsh', ['-f', '-c', program], { encoding: 'utf8' })
    expect(out.stderr).toBe('')
    expect(out.stdout.split('\n').filter(Boolean)).toEqual(['env\\:get:Read one', 'deploy'])
  })
})

describe('fish completion', () => {
  test.skipIf(!has('fish'))('passes a described line through as fish reads it', () => {
    const program = `
${generate('fish')}
function fli; printf '%s\\n' (printf 'env:get\\tRead one') deploy; end
function commandline; echo 'fli env:'; end
__fli_complete
`
    const out = spawnSync('fish', ['--no-config', '-c', program], { encoding: 'utf8' })
    expect(out.stderr).toBe('')
    expect(out.stdout.split('\n').filter(Boolean)).toEqual(['env:get\tRead one', 'deploy'])
  })
})

// ─── completion:query ────────────────────────────────────────────────────────

const query = (line, cwd = ROOT) =>
  spawnSync(process.execPath, [FLI, 'completion:query', line], { encoding: 'utf8', cwd })
    .stdout.split('\n').filter(Boolean)

const values = (line, cwd) => query(line, cwd).map((l) => l.split('\t')[0])

// An app root with two models, for the `model` kind.
const app = mkdtempSync(join(tmpdir(), 'fli-completion-'))
mkdirSync(join(app, 'db'))
writeFileSync(join(app, 'db', 'schema.lite'), 'model Lead {\n  id Int @id\n}\n\nmodel Invoice {\n  id Int @id\n}\n')

describe('completion:query', () => {

  test('a command name comes with its description', () => {
    expect(query('fli ')).toContain(query('fli ').find((l) => l.startsWith('ws:atlas\t')))
    expect(query('fli ').find((l) => l.startsWith('ws:atlas\t'))).toMatch(/\t\S/)
  })

  // One line per kind, and the set is compared to KINDS, so a kind added there
  // is a red test until the query answers it.
  const BY_KIND = {
    path:    ['fli cat ',           (v) => expect(v).toEqual(['__fli_path__'])],
    dir:     ['fli db:restore ',    (v) => expect(v).toEqual(['__fli_dir__'])],
    model:   ['fli make:factory ',  (v) => expect(v.sort()).toEqual(['Invoice', 'Lead']), app],
    package: ['fli ws:link ',       (v) => expect(v).toContain('cli')],
    command: ['fli fli:edit ',      (v) => expect(v).toContain('ws:atlas')],
  }

  test('every kind is answered', () => {
    expect(Object.keys(BY_KIND).sort()).toEqual([...KINDS].sort())
    for (const [line, check, cwd] of Object.values(BY_KIND)) check(values(line, cwd))
  })

  test('an argument with choices offers them', () => {
    expect(values('fli crypto:keygen ')).toEqual(['secret', 'aes', 'vapid'])
  })

  test('a flag waiting for its value offers that value, by either spelling', () => {
    expect(values('fli completion:generate --shell ')).toEqual(['bash', 'zsh', 'fish'])
    expect(values('fli completion:generate -s z')).toEqual(['bash', 'zsh', 'fish'])
  })

  test('the argument offered is the one the cursor is at', () => {
    expect(values('fli ws:link cli ')).toContain('cli')
    // both filled, so flags
    expect(values('fli ws:link cli mesa ')).toContain('--dev')
    // a flag's value is not a positional
    expect(values('fli outline --json core/cat.js ')).not.toContain('__fli_path__')
  })

  test('an argument that declares no kind offers nothing', () => {
    expect(query('fli env:get ')).toEqual([])
  })

  test('a word starting with a dash offers flags, with descriptions', () => {
    expect(values('fli cat --')).toContain('--raw')
    expect(query('fli cat --').find((l) => l.startsWith('--dry\t'))).toBeTruthy()
  })

  test('a command with no arguments offers flags', () => {
    expect(values('fli ws:atlas ')).toContain('--dry')
  })
})

// ─── declarations ────────────────────────────────────────────────────────────
// The runtime refuses a broken declaration when the command runs; this finds
// one in a command nobody has run since it was written.

describe('shipped declarations', () => {
  test('every argument and flag of every shipped command is well formed', async () => {
    global.fliRoot     = ROOT
    global.projectRoot = ROOT
    const { buildRegistry, uniqueCommands } = await import('../core/registry.js')
    const problems = uniqueCommands(buildRegistry()).flatMap((m) => [
      ...(m.args || []).map((d) => declarationProblem(d.name, d)),
      ...Object.entries(m.flags || {}).map(([n, d]) => declarationProblem(n, d)),
    ].filter(Boolean).map((p) => `${m.title}: ${p}`))
    expect(problems).toEqual([])
  })
})
