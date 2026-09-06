// ─── tutorial.js — the course, read off the files that are the course ────────
//
// `fli tutor` is eleven commands in one directory, and the thing that makes it a
// COURSE rather than eleven commands is an order — which is stated in three
// places that can disagree:
//
//   • `index.md`'s LESSONS array, which is the order, deliberately stated once
//   • each lesson's own `## Lesson N —` heading
//   • each lesson's finish step, which names the next lesson to run
//
// Nothing held them together. Inserting a lesson at position 2 costs twenty
// hand edits across eleven files, and a missed one is silent in the way this
// repo cares about: a heading with the wrong number misleads, and a finish step
// pointing at the wrong lesson is advice that fails when it is taken. One was
// already wrong when this was written — `tutor:fleet` named no next lesson at
// all, so a person following the pointers stopped one lesson early.
//
// A reader, not a rule: `checks.js` renders the findings, the same split
// `proofs.js` and `preflight.js` make.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join }                                            from 'path'

const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
const dirs = (p) => { try { return readdirSync(p).sort() } catch { return [] } }
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

// The line a match is on, for a finding that can be clicked.
const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** Where the tutorial lives, or null. Searched rather than assumed: a rule keyed
 *  on a hard-coded path reports a workspace that moved it as having none. */
export function tutorDir(root) {
  const pkgs = join(root, 'packages')
  for (const name of dirs(pkgs)) {
    const dir = join(pkgs, name, 'commands', 'tutor')
    if (existsSync(join(dir, 'index.md'))) return dir
  }
  return null
}

/** The order, off `index.md`'s LESSONS array. The array is the source: a
 *  namespace listing is alphabetical, which for a course is the one order that
 *  is wrong. */
function readOrder(dir) {
  const text = read(join(dir, 'index.md'))
  if (!text) return []
  const block = text.match(/const LESSONS\s*=\s*\[([\s\S]*?)\n\]/)
  if (!block) return []
  return [...block[1].matchAll(/\[\s*'(tutor:[a-z-]+)'/g)].map(m => m[1])
}

/** One lesson, as its own files describe it. */
function readLesson(dir, file) {
  const path = join(dir, file)
  const text = read(path)
  if (!text) return null

  const title = text.match(/^title:\s*(tutor:[a-z-]+)\s*$/m)
  const steps = text.match(/^steps:\s*(\S+)\s*$/m)
  if (!title || !steps) return null

  // The heading a reader sees, and the number in it.
  const heading = text.match(/^##\s+Lesson\s+(\d+)\s*—/m)

  const stepsDir = join(dir, steps[1])
  const finish   = dirs(stepsDir).find(f => /-finish\.md$/.test(f)) ?? null
  const fText    = finish ? read(join(stepsDir, finish)) : null

  // The pointer. Matched on the shape every finish step writes — the command,
  // then the word `next` — rather than on any lesson id, so a pointer at a
  // lesson that does not exist is read and reported rather than missed.
  const nextM = fText ? fText.match(/fli (tutor:[a-z-]+)\s+next\b/) : null

  return {
    id:          title[1],
    file,
    stepsName:   steps[1],
    stepsDir,
    hasStepsDir: isDir(stepsDir),
    heading:     heading ? Number(heading[1]) : null,
    headingLine: heading ? lineOf(text, heading.index) : 1,
    finishFile:  finish ? join(stepsDir, finish) : null,
    next:        nextM ? nextM[1] : null,
    nextLine:    nextM ? lineOf(fText, nextM.index) : 1,
  }
}

/**
 * The whole course.
 *   order        the ids `index.md` lists, in order
 *   lessons      every command file that declares a `steps:` directory
 *   orphanSteps  a `_steps-*` directory no command file claims
 */
export function readCourse(root) {
  const dir = tutorDir(root)
  if (!dir) return null

  const order   = readOrder(dir)
  const lessons = dirs(dir)
    .filter(f => f.endsWith('.md') && f !== 'index.md' && !f.startsWith('_'))
    .map(f => readLesson(dir, f))
    .filter(Boolean)

  const claimed    = new Set(lessons.map(l => l.stepsName))
  const orphanSteps = dirs(dir).filter(f => f.startsWith('_steps-') && isDir(join(dir, f)) && !claimed.has(f))

  return { dir, order, lessons, orphanSteps }
}
