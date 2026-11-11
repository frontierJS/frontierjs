// test/grade-theme.test.js — the AA suite grades a theme handed to it (FJS-4194).
//
// One external theme that clears AA and its twin that forgets a dark theme's
// window, both outside src/, both graded by run.js through gradeTheme(). Needs
// Chrome, like run.js.

import { test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { gradeTheme } from './grade-theme.js'

const fixture = (name) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url))

test('a theme that clears AA grades green and exits 0', () => {
  const r = gradeTheme(fixture('theme-graded-pass.css'))
  expect(r.output).toContain('grading .theme-graded-pass')
  expect(r.output).toMatch(/\d+ passing/)
  expect(r.status).toBe(0)
}, 60_000)

test('a theme under AA exits 1 and names the failing pairings', () => {
  const r = gradeTheme(fixture('theme-graded-fail.css'))
  expect(r.status).toBe(1)
  expect(r.output).toContain('in theme-graded-fail')
  expect(r.output).toContain('--ink-mute on --surface')
  expect(r.output).toMatch(/\d+ failing/)
}, 60_000)

test('a file naming no theme class is refused with exit 2', () => {
  const r = gradeTheme(fixture('../grade-theme.js'))
  expect(r.status).toBe(2)
  expect(r.output).toContain('names no .theme-<name> class')
}, 60_000)
