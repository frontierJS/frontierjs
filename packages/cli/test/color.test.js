// color.js decides once, at import, so each case runs in a child with its own
// environment. Its stdout is a pipe, which is the case FORCE_COLOR exists for.
import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const COLOR = join(import.meta.dir, '..', 'core', 'color.js')

const paint = (env) => {
  const inherited = { ...process.env }
  delete inherited.FORCE_COLOR
  delete inherited.NO_COLOR
  const r = spawnSync(process.execPath, ['-e',
    `const { chalk } = await import(${JSON.stringify(COLOR)}); process.stdout.write(chalk.red('x'))`],
  { encoding: 'utf8', env: { ...inherited, ...env } })
  return r.stdout
}

test('FORCE_COLOR=0 and =false are off, as chalk reads them', () => {
  expect(paint({ FORCE_COLOR: '0' })).toBe('x')
  expect(paint({ FORCE_COLOR: 'false' })).toBe('x')
})

test('any other FORCE_COLOR colors a pipe, and NO_COLOR outranks it', () => {
  expect(paint({ FORCE_COLOR: '1' })).toBe('\x1b[31mx\x1b[39m')
  expect(paint({ FORCE_COLOR: '1', NO_COLOR: '1' })).toBe('x')
  expect(paint({})).toBe('x')
  expect(paint({ FORCE_COLOR: '' })).toBe('x')
})
