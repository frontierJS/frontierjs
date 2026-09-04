---
title: tutor:index
description: The eight lessons, in order, and how far through them you are
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
  ['tutor:access', 'Who may do what',               'nothing'],
  ['tutor:live',   'A change reaching somebody else','nothing'],
  ['tutor:jobs',   'Work that outlives the request','nothing'],
  ['tutor:site',   'The public half',               'nothing'],
  ['tutor:deploy', 'A deploy you can take back',    'Docker · git'],
  ['tutor:change', 'The schema you already deployed','nothing'],
  ['tutor:fleet',  'A machine that takes orders',   'a checkout'],
]

// Progress is a fact about a DIRECTORY, so there is nothing to report without
// one: a throwaway workspace is deleted when its lesson ends, which is what
// makes `--tmp` safe and also what makes it unanswerable here.
const ws = flag.workspace ? resolve(process.cwd(), flag.workspace) : null
const doc = ws ? T.readJournal(ws) : null

log.info('')
log.info('  The tutorial — eight lessons, in order. Each runs the real commands and')
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

const next = LESSONS.find(([id]) => doc?.lessons?.[id]?.status !== 'succeeded')

if (ws) {
  log.info(`  workspace  ${ws}`)
  log.info(next ? `  next       fli ${next[0]} --workspace ${flag.workspace}`
                : '  every lesson in this workspace is finished')
} else {
  log.info('  fli tutor:app --workspace ~/frontier-tutorial    keep what you build')
  log.info('  fli tutor:app --tmp --yes                        a throwaway run')
  log.info('')
  log.info('  Pass the same --workspace here to see how far through you are.')
}
log.info('')
```
