// tutorial.test.js — the course, and the three places its order is written.
//
// `fli tutor` is a course, and a course is an ORDER. That order is stated in
// `index.md`'s LESSONS array, in each lesson's `## Lesson N —` heading, and in
// each lesson's finish step naming the next one. Nothing held the three
// together, and inserting a lesson at position 2 costs twenty hand edits.
//
// What is worth testing is that the reader survives the files these actually
// are — prose full of backticks, a finish step that legitimately names no next
// lesson because it is last, and a `## Lesson N` inside a fenced block that is
// not a heading — and that each way of being wrong is reported as its own
// finding rather than as a parse failure.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { readCourse, tutorDir } from '../core/tutorial.js'
import { runChecks }            from '../core/checks.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * A workspace with a tutorial in it. `lessons` is [id, headingNumber, next],
 * where `next` of null writes a finish step that names none.
 */
function fixture(order, lessons) {
  const root = mkdtempSync(join(tmpdir(), 'fli-tutorial-'))
  const dir  = join(root, 'packages', 'cli', 'commands', 'tutor')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }))

  const rows = order.map(id => `  ['${id}', 'A lesson', 'nothing'],`).join('\n')
  writeFileSync(join(dir, 'index.md'), [
    '---', 'title: tutor:index', '---', '', '```js',
    'const LESSONS = [', rows, ']', '```', '',
  ].join('\n'))

  for (const [id, heading, next] of lessons) {
    const short = id.split(':')[1]
    const steps = `_steps-${short}`
    writeFileSync(join(dir, `${short}.md`), [
      '---', `title: ${id}`, `steps: ${steps}`, '---', '',
      `## Lesson ${heading} — a lesson`, '',
      'Prose with `backticks` and a `## Lesson 99 — not a heading` inside one.', '',
    ].join('\n'))

    mkdirSync(join(dir, steps), { recursive: true })
    writeFileSync(join(dir, steps, '01-do.md'), '---\ntitle: 01-do\n---\n')
    writeFileSync(join(dir, steps, '09-finish.md'), [
      '---', 'title: 09-finish', '---', '', '```js',
      `log.success('Lesson ${heading} done')`,
      next ? `log.info('  fli ${next}   next — the one after this')` : "log.info('  that is all')",
      '```', '',
    ].join('\n'))
  }
  return { root, dir }
}

const findings = (root, rule) =>
  runChecks({ root, scope: 'repo', only: [rule] }).findings.map(f => f.message)

const CLEAN = [
  ['tutor:app',    1, 'tutor:tools'],
  ['tutor:tools',  2, 'tutor:access'],
  ['tutor:access', 3, null],
]
const ORDER = ['tutor:app', 'tutor:tools', 'tutor:access']

describe('readCourse', () => {
  test('reads the order, the headings and the pointers', () => {
    const { root, dir } = fixture(ORDER, CLEAN)
    const course = readCourse(root)

    expect(course.dir).toBe(dir)
    expect(course.order).toEqual(ORDER)
    expect(course.orphanSteps).toEqual([])

    const byId = Object.fromEntries(course.lessons.map(l => [l.id, l]))
    expect(byId['tutor:app'].heading).toBe(1)
    expect(byId['tutor:app'].next).toBe('tutor:tools')
    // The last lesson names none, and that is not a missing value.
    expect(byId['tutor:access'].next).toBe(null)
    // A `## Lesson 99` inside prose is not the heading.
    expect(byId['tutor:tools'].heading).toBe(2)

    rmSync(root, { recursive: true, force: true })
  })

  test('a workspace with no tutorial answers null rather than an empty course', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-tutorial-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
    expect(tutorDir(root)).toBe(null)
    expect(readCourse(root)).toBe(null)
    rmSync(root, { recursive: true, force: true })
  })

  test('the real tutorial parses — every lesson has a heading and a steps directory', () => {
    const course = readCourse(REPO)
    expect(course).not.toBe(null)
    expect(course.order.length).toBeGreaterThan(1)
    for (const l of course.lessons) {
      expect(l.hasStepsDir).toBe(true)
      expect(l.heading).not.toBe(null)
    }
  })
})

describe('tutor-order', () => {
  test('a course that agrees with itself reports nothing', () => {
    const { root } = fixture(ORDER, CLEAN)
    expect(findings(root, 'tutor-order')).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  test('a heading number that is not the index position', () => {
    const { root } = fixture(ORDER, [
      ['tutor:app', 1, 'tutor:tools'],
      ['tutor:tools', 7, 'tutor:access'],
      ['tutor:access', 3, null],
    ])
    const f = findings(root, 'tutor-order')
    expect(f.length).toBe(1)
    expect(f[0]).toContain('calls itself Lesson 7')
    expect(f[0]).toContain('index has it at 2')
    rmSync(root, { recursive: true, force: true })
  })

  test('a lesson that names no next one, where the index has one after it', () => {
    const { root } = fixture(ORDER, [
      ['tutor:app', 1, 'tutor:tools'],
      ['tutor:tools', 2, null],
      ['tutor:access', 3, null],
    ])
    const f = findings(root, 'tutor-order')
    expect(f.length).toBe(1)
    expect(f[0]).toContain('names no next one')
    expect(f[0]).toContain('tutor:access')
    rmSync(root, { recursive: true, force: true })
  })

  test('a pointer at the wrong lesson', () => {
    const { root } = fixture(ORDER, [
      ['tutor:app', 1, 'tutor:access'],
      ['tutor:tools', 2, 'tutor:access'],
      ['tutor:access', 3, null],
    ])
    const f = findings(root, 'tutor-order')
    expect(f.length).toBe(1)
    expect(f[0]).toContain('points at `tutor:access`')
    expect(f[0]).toContain('index has `tutor:tools`')
    rmSync(root, { recursive: true, force: true })
  })

  test('the last lesson pointing onward', () => {
    const { root } = fixture(ORDER, [
      ['tutor:app', 1, 'tutor:tools'],
      ['tutor:tools', 2, 'tutor:access'],
      ['tutor:access', 3, 'tutor:app'],
    ])
    const f = findings(root, 'tutor-order')
    expect(f.length).toBe(1)
    expect(f[0]).toContain('last lesson')
    rmSync(root, { recursive: true, force: true })
  })

  test('the index naming a lesson that has no command file', () => {
    const { root } = fixture([...ORDER, 'tutor:ghost'], CLEAN)
    const f = findings(root, 'tutor-order')
    // The ghost is reported, and the lesson before it is no longer last.
    expect(f.some(m => m.includes('lists `tutor:ghost`'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  test('the repo\'s own tutorial agrees with itself', () => {
    expect(findings(REPO, 'tutor-order')).toEqual([])
  })
})

describe('tutor-lesson-named', () => {
  test('a lesson the index does not list', () => {
    const { root } = fixture(['tutor:app', 'tutor:tools'], CLEAN)
    const f = findings(root, 'tutor-lesson-named')
    expect(f.length).toBe(1)
    expect(f[0]).toContain('`tutor:access` is a lesson that tutor/index.md does not list')
    rmSync(root, { recursive: true, force: true })
  })

  test('a step directory no lesson claims', () => {
    const { root, dir } = fixture(ORDER, CLEAN)
    mkdirSync(join(dir, '_steps-orphan'), { recursive: true })
    const f = findings(root, 'tutor-lesson-named')
    expect(f.length).toBe(1)
    expect(f[0]).toContain('_steps-orphan')
    rmSync(root, { recursive: true, force: true })
  })

  test('a lesson whose steps directory is not there', () => {
    const { root, dir } = fixture(ORDER, CLEAN)
    rmSync(join(dir, '_steps-tools'), { recursive: true, force: true })
    const f = findings(root, 'tutor-lesson-named')
    expect(f.length).toBe(1)
    expect(f[0]).toContain('no such directory')
    rmSync(root, { recursive: true, force: true })
  })

  test('the repo\'s own tutorial names every lesson', () => {
    expect(findings(REPO, 'tutor-lesson-named')).toEqual([])
  })
})
