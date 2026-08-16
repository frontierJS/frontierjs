// This package is an entry point, so what is worth testing is the entering:
// where the app lands, what reaches `fli new`, and what happens with no name.
//
// The scaffold itself is @frontierjs/cli's and is tested there. Running it here
// would be a second, slower copy of `scripts/scaffold-build.mjs`.

import { test, expect, describe } from 'bun:test'
import { spawnSync }              from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath }          from 'node:url'
import { tmpdir }                 from 'node:os'

const HERE  = dirname(fileURLToPath(import.meta.url))
const PKG   = resolve(HERE, '..')
const ENTRY = join(PKG, 'index.js')
const CLI   = resolve(PKG, '..', 'cli')

// A stub `fli` that writes its argv down instead of scaffolding. The point of
// the tests below is what this package HANDS to fli — running the real scaffold
// takes half a minute and proves someone else's code.
function stubWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'create-frontier-'))
  const cliDir = join(dir, 'node_modules', '@frontierjs', 'cli')
  mkdirSync(join(cliDir, 'bin'), { recursive: true })
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ name: '@frontierjs/cli', version: '0.0.0' }))
  writeFileSync(join(cliDir, 'bin', 'fli.js'),
    `import { writeFileSync } from 'node:fs'\n` +
    `writeFileSync(process.env.ARGV_SINK, JSON.stringify(process.argv.slice(2)))\n`)

  // index.js resolves @frontierjs/cli from ITS OWN location, so the entry has
  // to live inside this tree the way an install would put it. Copied and not
  // symlinked: node resolves a symlink to its target before resolving imports
  // from it, so a link would look for the cli beside the real source file.
  const own = join(dir, 'node_modules', 'create-frontier')
  mkdirSync(own, { recursive: true })
  copyFileSync(ENTRY, join(own, 'index.js'))

  return { dir, entry: join(own, 'index.js'), sink: join(dir, 'argv.json') }
}

function run(ws, argv, { cwd = ws.dir, input = '' } = {}) {
  const result = spawnSync(process.execPath, [ws.entry, ...argv], {
    cwd, input, encoding: 'utf8',
    env: { ...process.env, ARGV_SINK: ws.sink },
  })
  const forwarded = existsSync(ws.sink) ? JSON.parse(readFileSync(ws.sink, 'utf8')) : null
  return { ...result, forwarded }
}

const withWorkspace = (fn) => {
  const ws = stubWorkspace()
  try { return fn(ws) } finally { rmSync(ws.dir, { recursive: true, force: true }) }
}

describe('what reaches fli', () => {
  test('a flag that takes a value survives intact', () => {
    // The bug this pins: an early version sorted argv into flags and
    // positionals, which does not survive `--source npm` — fli received
    // `--source true` with a stray `npm` beside it. This script cannot know
    // which flags take a value, so it must not reorder any of them.
    withWorkspace(ws => {
      const { forwarded } = run(ws, ['my-app', '--source', 'npm', '--no-auth'])
      expect(forwarded.slice(0, 5)).toEqual(['new', 'my-app', '--source', 'npm', '--no-auth'])
    })
  })

  test('the working directory is pinned', () => {
    // fli finds a project root by walking UP from cwd, which is right for every
    // other command: run inside an existing repository, `fli new my-app` writes
    // into that repository's root rather than beside you.
    withWorkspace(ws => {
      const nested = join(ws.dir, 'nested')
      mkdirSync(nested)
      const { forwarded } = run(ws, ['my-app'], { cwd: nested })
      expect(forwarded).toContain('--project')
      expect(forwarded[forwarded.indexOf('--project') + 1]).toBe(nested)
    })
  })

  test('the subcommand is always `new`', () => {
    withWorkspace(ws => {
      expect(run(ws, ['my-app']).forwarded[0]).toBe('new')
    })
  })

  test('--here needs no name', () => {
    withWorkspace(ws => {
      const { forwarded, status } = run(ws, ['--here'])
      expect(status).toBe(0)
      expect(forwarded.slice(0, 2)).toEqual(['new', '--here'])
    })
  })
})

describe('no name given', () => {
  // The prompt itself has no test here and that is deliberate. Reaching it needs
  // a real tty — without one the code takes the branch above, so an assertion
  // about the prompt would pass for the wrong reason — and driving one through
  // `script` from bun:test hung on EOF rather than failing, which is a flake
  // wearing a test's clothes. What it does instead is a recorded manual check;
  // see PROJECT_STATE.md. The two things checked by hand: a rejected name
  // re-prompts, and Ctrl+D prints `nothing written.` rather than an AbortError
  // stack, which is what the catch in index.js is for.

  test('a non-interactive run says how to pass one rather than hanging', () => {
    // `npm create frontier@latest` inside a CI job has no tty. Prompting there
    // is a hang with no output, which reads as a broken installer.
    withWorkspace(ws => {
      const { status, stderr } = run(ws, [])
      expect(status).toBe(1)
      expect(stderr).toContain('project name is required')
      expect(stderr).toContain('npm create frontier@latest my-app')
    })
  })
})

describe('the package itself', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))

  test('it is named so that `npm create frontier` finds it', () => {
    // npm and bun both map `create <x>` to the package `create-<x>` and run the
    // bin of the same name. Both halves have to be right or the command is a
    // 404 that mentions neither.
    expect(pkg.name).toBe('create-frontier')
    expect(Object.keys(pkg.bin)).toEqual(['create-frontier'])
  })

  test('the scaffold is a dependency, not a copy', () => {
    // One implementation of what a FrontierJS app looks like. A second copy
    // here is how the two would start disagreeing about the defaults.
    expect(pkg.dependencies['@frontierjs/cli']).toBeTruthy()
    const source = readFileSync(ENTRY, 'utf8')
    expect(source).not.toContain('schema.lite')
  })

  test('index.js is executable and ships', () => {
    expect(readFileSync(ENTRY, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
    expect(pkg.files).toContain('index.js')
  })

  test('the cli it depends on is really there', () => {
    expect(existsSync(join(CLI, 'bin', 'fli.js'))).toBe(true)
  })
})
