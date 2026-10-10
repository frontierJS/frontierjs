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

// dim and bold share close code 22, so without the reopen the trailing text
// of a dim block printed undimmed.
test('an inner style closing reopens the outer one', () => {
  const r = spawnSync(process.execPath, ['-e',
    `const { chalk } = await import(${JSON.stringify(COLOR)}); process.stdout.write(chalk.dim('a' + chalk.bold('b') + 'c') + '|' + chalk.cyan('a' + chalk.green('b') + 'c'))`],
  { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' } })
  const [dim, cyan] = r.stdout.split('|')
  expect(dim).toBe('\x1b[2ma\x1b[1mb\x1b[22m\x1b[2mc\x1b[22m')
  expect(cyan).toBe('\x1b[36ma\x1b[32mb\x1b[39m\x1b[36mc\x1b[39m')
})

const tag = (expr) => spawnSync(process.execPath, ['-e',
  `const { chalk } = await import(${JSON.stringify(COLOR)}); process.stdout.write(${expr})`],
{ encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' } })

test('the tag styles a {name text} span the way the call would', () => {
  expect(tag('chalk`a {bold.cyan b} c`').stdout).toBe(`a ${'\x1b[1m\x1b[36mb\x1b[39m\x1b[22m'} c`)
  expect(tag('chalk`{dim x {bold y} z}`').stdout).toBe('\x1b[2mx \x1b[1my\x1b[22m\x1b[2m z\x1b[22m')
})

// A command line or a path can hold a brace, and markup read out of a value
// would restyle or swallow part of it.
test('an interpolated value is never read as markup, and a prose brace is left alone', () => {
  expect(tag("chalk`{dim ${'{bold x}'}}`").stdout).toBe('\x1b[2m{bold x}\x1b[22m')
  expect(tag('chalk`{a} and {nope b}`').stdout).toBe('{a} and {nope b}')
})

test('an unclosed span throws where it is written', () => {
  const r = tag('chalk`{bold x`')
  expect(r.status).not.toBe(0)
  expect(r.stderr).toContain('{bold is never closed')
})
