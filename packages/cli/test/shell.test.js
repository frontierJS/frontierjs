// shell.test.js — `$`, the callable context, and the shell behind it: fli's
// rules over Bun's, each asserted by running a real command.

import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commandContext, isCommandContext, renderShell } from '../core/shell.js'
import { setVerbose } from '../core/verbosity.js'

afterEach(() => setVerbose(false))

const ctx = (over = {}) => {
  const dry = [], detail = []
  const $ = commandContext({
    flag: {},
    log:  { dry: (t) => dry.push(t), detail: (t) => detail.push(t) },
    emit: null,
    ...over,
  })
  return { $, dry, detail }
}

describe('the context is callable', () => {
  test('fields are on it, a spread copies them, and name is allowed', () => {
    const $ = commandContext({ flag: { x: 1 }, name: 'deploy', length: 3 })
    expect(typeof $).toBe('function')
    expect($.flag.x).toBe(1)
    expect($.name).toBe('deploy')
    expect($.length).toBe(3)
    expect({ ...$ }).toEqual({ flag: { x: 1 }, name: 'deploy', length: 3 })
    expect(isCommandContext($)).toBe(true)
    expect(isCommandContext({ ...$ })).toBe(false)
  })

  test('called with a string it refuses by name', () => {
    const { $ } = ctx()
    expect(() => $('ls')).toThrow(/template tag/)
  })
})

describe('running', () => {
  test('captures by default and .text() reads it', async () => {
    const { $ } = ctx()
    expect((await $`echo hi`).text()).toBe('hi\n')
    expect(await $`printf 'a\nb'`.lines()).toEqual(['a', 'b'])
  })

  test('an interpolation with a space is one argument', async () => {
    const { $ } = ctx()
    const arg = 'a b'
    expect(await $`printf '[%s]' ${arg}`.text()).toBe('[a b]')
  })

  test('a non-zero exit throws with the command named, and nothrow opts out', async () => {
    const { $ } = ctx()
    let err
    try { await $`sh -c 'echo bad 1>&2; exit 3'` } catch (e) { err = e }
    expect(err.exitCode).toBe(3)
    expect(err.message).toContain("sh -c 'echo bad 1>&2; exit 3' failed (exit 3)")
    expect(err.message).toContain('bad')
    expect(err.stderr.toString()).toBe('bad\n')
    expect((await $`exit 4`.nothrow()).exitCode).toBe(4)
  })

  test('cwd and env chain', async () => {
    const { $ } = ctx()
    expect((await $`pwd`.cwd('/tmp')).text().trim()).toBe('/tmp')
    expect((await $`echo $FOO`.env({ ...process.env, FOO: 'bar' })).text().trim()).toBe('bar')
  })
})

describe('--dry', () => {
  test('runs nothing, logs the command at dry level, and answers an empty result that still chains', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-shell-'))
    const file = join(dir, 'made')
    const { $, dry } = ctx({ flag: { dry: true } })
    const out = await $`touch ${file}`.quiet().nothrow()
    expect(existsSync(file)).toBe(false)
    expect(dry).toEqual([`touch ${file}`])
    expect(out.exitCode).toBe(0)
    expect(out.text()).toBe('')
    expect(await $`cat ${file}`.text()).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('--verbose', () => {
  test('names the command at detail level', async () => {
    setVerbose(true)
    const { $, detail } = ctx()
    await $`true`
    expect(detail).toEqual(['$ true'])
  })

  test('a web run hands the output over as events after the fact', async () => {
    setVerbose(true)
    const events = []
    const { $ } = ctx({ emit: (e) => events.push(e) })
    const out = await $`echo shown`
    expect(out.text()).toBe('shown\n')
    expect(events).toEqual([{ type: 'output', text: 'shown\n' }])
  })
})

describe('renderShell', () => {
  test('quotes an interpolation as Bun does, a raw one not at all', () => {
    const r = (s, ...v) => renderShell(s, v)
    expect(r`echo ${'a b'} ${'plain'} ${['x', 'y z']} ${{ raw: '$HOME' }}`).toBe('echo "a b" plain x "y z" $HOME')
  })
})
