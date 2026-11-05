---
title: basecamp:list
alias: basecamp
description: Every Basecamp this machine can reach — its origin, ssh Host, whether a key is filed, which one runs go to, and whether it answers
effects: reads only
examples:
  - fli basecamp
  - fli basecamp --json
flags:
  json:
    type: boolean
    description: Print the rows as JSON — keys are never in them
    defaultValue: false
---

The index `basecamps.json` keeps, one row per entry, each asked once at its
`/health` with three seconds to answer, all at the same time. A row never
shows a key, only whether one is filed. `runs` marks the Basecamp Charter runs
go to. With no entries it says where the file is and what adds one.

<script>
import { resolve } from 'path'

const mark = (chalk, ok) => ok ? chalk.green('✓') : chalk.red('✗')

const answer = (chalk, ping) => ping.ok
  ? chalk`{green ● answers} {dim ${ping.ms} ms}`
  : chalk`{red ● silent} {dim ${ping.why}}`

const row = (chalk, name, entry, ping, width) => [
  chalk`  {bold.cyan ${name.padEnd(width)}}`,
  entry.url.padEnd(34),
  chalk.dim(`ssh ${entry.host ?? '—'}`.padEnd(14)),
  chalk`key ${mark(chalk, !!entry.apiKey)}`,
  entry.runs ? chalk.magenta('runs') : '    ',
  answer(chalk, ping),
].join('  ')
</script>

```js
const { readBasecamps, basecampsPath, pingBasecamp } = await import(resolve(global.fliRoot, 'core/basecamps.js'))
const { plural }                                      = await import(resolve(global.fliRoot, 'core/text.js'))

const all   = readBasecamps()
const names = Object.keys(all)

if (!names.length) {
  echo`\n  {dim No Basecamps are filed in ${basecampsPath()}}\n  {dim fli basecamp:create adds one}\n`
  return
}

const pings = await Promise.all(names.map(name => pingBasecamp(all[name])))

if (flag.json) {
  echo(JSON.stringify(names.map((name, i) => {
    const { apiKey, scopedKey, ...rest } = all[name]
    return { name, ...rest, key: !!apiKey, scopedKey: !!scopedKey, answers: pings[i].ok, ...(pings[i].ok ? { ms: pings[i].ms } : { why: pings[i].why }) }
  }), null, 2))
  return
}

const width = Math.max(...names.map(n => n.length))
echo(chalk`\n  {bold ${plural(names.length, 'Basecamp')}}\n`)
echo.lines(names.map((name, i) => row(chalk, name, all[name], pings[i], width)))
echo``
```
