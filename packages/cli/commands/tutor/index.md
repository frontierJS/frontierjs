---
title: tutor:index
description: The lessons, in order, and how far through them you are
alias: tutor
examples:
  - fli tutor
  - fli tutor --workspace ~/frontier-tutorial
flags:
  workspace:
    char: w
    type: string
    description: The directory the lessons build in — progress is read from its journal
    defaultValue: ''
---

```js
// The order is stated here and nowhere else. A namespace listing is
// alphabetical, which for a course is the one order that is wrong.
const LESSONS = [
  ['tutor:app',    'An app that runs',              'nothing'],
  ['tutor:ui',     'A screen you did not write',    'Chrome'],
  ['tutor:tools',  'The four tools, and when',      'nothing'],
  ['tutor:access', 'Who may do what',               'nothing'],
  ['tutor:live',   'A change reaching somebody else','nothing'],
  ['tutor:jobs',   'Work that outlives the request','nothing'],
  ['tutor:notify', 'Telling somebody something',    'nothing'],
  ['tutor:site',   'The public half',               'nothing'],
  ['tutor:deploy', 'A deploy you can take back',    'Docker · git'],
  ['tutor:change', 'The schema you already deployed','nothing'],
  ['tutor:test',   'Knowing it is right',           'nothing'],
  ['tutor:fleet',  'A machine that takes orders',   'a checkout'],
  ['tutor:adopt',  'A database you already have',   'nothing'],
]

// Progress is a fact about a DIRECTORY, so there is nothing to report without
// one: a throwaway workspace is deleted when its lesson ends, which is what
// makes `--tmp` safe and also what makes it unanswerable here.
const ws = flag.workspace ? resolve(process.cwd(), flag.workspace) : null
const doc = ws ? T.readJournal(ws) : null

const next = LESSONS.find(([id]) => doc?.lessons?.[id]?.status !== 'succeeded')

log.info('')

// The roster is PROGRESS, so it is worth printing only once there is progress
// to report. Printed to somebody who has run nothing it reads as a syllabus,
// and a thirteen-row syllabus is a reason to close the terminal.
if (ws) {
  log.info(`  The tutorial — ${LESSONS.length} lessons, in order. Each runs the real commands and`)
  log.info('  then asks the running world whether they worked.')
  log.info('')
  for (const [id, name, needs] of LESSONS) {
    const row  = doc?.lessons?.[id]
    const mark = row?.status === 'succeeded' ? '✓'
               : row?.status                 ? '·'
               : ' '
    const note = row?.status === 'succeeded' ? ''
               : row                        ? '  (started)'
               : needs === 'nothing'        ? ''
               : `  (needs ${needs})`
    log.info(`  ${mark}  ${id.padEnd(14)} ${name}${note}`)
  }
  log.info('')
  log.info(`  workspace  ${ws}`)
  log.info(next ? `  next       fli ${next[0]} --workspace ${flag.workspace}`
                : '  every lesson in this workspace is finished')
} else {
  log.info(`  ${LESSONS.length} lessons. Each one runs the commands you would run, then asks the`)
  log.info('  running world whether they worked — a port that answers, a table that')
  log.info('  exists, a row really in the file. Nothing here is a demonstration.')
  log.info('')
  log.info('  Lesson 1  an app that runs, with a model of your own in it')
  log.info('  Lesson 2  one attribute added to one column of the schema, and a browser')
  log.info('            that starts refusing. No form is edited. There is no form.')
  log.info('')
  log.info('  fli tutor:app --workspace ~/frontier-tutorial    keep what you build')
  log.info('  fli tutor:app --tmp --yes                        a throwaway run')
  log.info('')
  log.info('  Pass the same --workspace here to see how far through you are.')
}
log.info('')
```
