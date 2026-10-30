// FJS-3486 — the commands docs/output.md names print a result a person scans
// with color, and print it plain when piped. Offline commands are run under
// FORCE_COLOR; the cloudflare ones need a login, so their source is read.
import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..')
const ESC = /\x1b\[/

const run = (args, env) => {
  const inherited = { ...process.env }
  delete inherited.FORCE_COLOR
  delete inherited.NO_COLOR
  return spawnSync(process.execPath, [join(CLI, 'bin', 'fli.js'), ...args], {
    cwd: CLI, encoding: 'utf8', env: { ...inherited, ...env }, timeout: 60000,
  }).stdout
}

const OFFLINE = [
  ['register:check', '--rules'],
  ['register:next', '--limit', '3'],
  ['register:decisions'],
  ['register:close', 'NOPE-0', '--how', 'x'],
  ['register:amend', 'NOPE-0', '--detail', 'x'],
  ['register:file', '--sev', 'S4', '--area', 'cli', '--title', 'x', '--detail', 'x', '--dry'],
]

for (const args of OFFLINE) {
  test(`${args[0]} colors a result under FORCE_COLOR and stays plain piped`, () => {
    const colored = run(args, { FORCE_COLOR: '1' })
    const piped   = run(args, {})
    expect(colored).toMatch(ESC)
    expect(piped).not.toMatch(ESC)
    // Same words either way: color is the only difference.
    expect(colored.replace(/\x1b\[[0-9;]*m/g, '')).toBe(piped)
  })
}

test('--json stays plain even under FORCE_COLOR', () => {
  const out = run(['register:next', '--json'], { FORCE_COLOR: '1' })
  expect(out).not.toMatch(ESC)
  expect(() => JSON.parse(out)).not.toThrow()
})

const STYLED = [
  'cloudflare/dns', 'cloudflare/zones', 'cloudflare/workers', 'project/map',
  'register/next', 'register/decisions', 'register/check', 'test/done',
  'utils/outline', 'workspace/tidy', 'register/close', 'register/file',
  'register/amend', 'register/archive', 'register/decide', 'test/snapshots',
  'dev/tui', 'basecamp/_module', 'register/atlas', 'cloudflare/pages',
  'project/intent',
]

for (const name of STYLED) {
  test(`${name} paints with chalk`, () => {
    const src = readFileSync(join(CLI, 'commands', `${name}.md`), 'utf8')
    expect(src).toContain('chalk.')
  })
}
