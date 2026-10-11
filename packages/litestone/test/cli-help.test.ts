// `litestone <command> --help` — a command's own flags, from the one HELP table.
// FJS-2427: every subcommand printed the global list, so a flag a command reads
// was discoverable only from source.
//
// Run with:  bun test test/cli-help.test.ts

import { describe, test, expect } from 'bun:test'
import { resolve } from 'path'
import { spawnSync } from 'child_process'

const CLI = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')

function run(...argv: string[]) {
  const r = spawnSync('bun', [CLI, ...argv], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  return { out: r.stdout + r.stderr, code: r.status }
}

describe('litestone <command> --help', () => {
  test('prints that command\'s flags, not the whole list', () => {
    const { out, code } = run('jsonschema', '--help')
    expect(code).toBe(0)
    expect(out).toContain('litestone jsonschema')
    expect(out).toContain('--format')
    expect(out).toContain('--mode')
    expect(out).not.toContain('litestone backup')
    expect(out).not.toContain('litestone tenant list')
  })

  test('studio names --port, --gate, --host and --token', () => {
    const { out } = run('studio', '--help')
    for (const f of ['--port', '--gate', '--host', '--token', '--no-open']) expect(out).toContain(f)
    expect(out).not.toContain('litestone backup')
  })

  test('a command with several heads prints all of them', () => {
    const { out } = run('migrate', '--help')
    for (const w of ['migrate create', 'migrate apply', 'migrate status']) expect(out).toContain(w)
    expect(out).not.toContain('litestone backup')
  })

  test('`help <command>` is the same call', () => {
    expect(run('help', 'export').out).toBe(run('export', '--help').out)
  })

  test('audit is doctor', () => {
    expect(run('audit', '--help').out).toContain('litestone doctor')
  })

  test('a word that is no command prints the global list', () => {
    const { out } = run('nonesuch', '--help')
    expect(out).toContain('litestone backup')
  })

  test('bare --help is still the global list', () => {
    expect(run('--help').out).toContain('litestone backup')
  })
})
