---
title: git:history
description: Commits per day as a column chart — time across, count up
alias: ghist
examples:
  - fli ghist
  - fli ghist --days 90
  - fli ghist --days 365 --by week
  - fli ghist --lines
  - fli ghist --author Jordan
  - fli ghist --json
flags:
  days:
    char: d
    type: number
    description: How far back, counting today
    defaultValue: 30
    min: 1
  by:
    type: string
    description: One column per day or per week — auto picks week when days will not fit the screen
    defaultValue: auto
    choices: [auto, day, week]
  lines:
    char: l
    type: boolean
    description: Height is lines changed (added + deleted), not commits
    defaultValue: false
  author:
    char: a
    type: string
    description: Only commits whose author matches (git's --author pattern)
    defaultValue: ''
  path:
    char: p
    type: string
    description: Only commits touching this path, from the repo root
    defaultValue: ''
  height:
    type: number
    description: Rows the chart is tall
    defaultValue: 12
    min: 3
  json:
    type: boolean
    description: Answer a machine — the series, one bucket per day or week
    defaultValue: false
---

<script>
import { execFileSync } from 'child_process'
import { resolve as joinPath } from 'path'
</script>

`git log` answers one commit at a time; the shape of the work — which weeks
were heavy, where it stopped — is something a reader has to tally by hand.

This draws it: one column per day, left to right, height the commit count.
A quiet day is a gap in the chart, never a missing column, so the x axis is
real time. Past what fits the terminal, `--by auto` folds the columns into
weeks.

`--lines` makes the height lines changed instead, which is the reading that
tells a rename sweep from a day of small fixes.

```js
const root = $.git.repoRoot($.paths.root) ?? $.paths.root
const { parseLog, buildSeries, renderChart, summarize } = await import(joinPath(global.fliRoot, 'core/git-history.js'))

const today = new Date()
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const width = Math.max(40, process.stdout.columns || 100)
const by = flag.by !== 'auto' ? flag.by : flag.days + 6 > width ? 'week' : 'day'
// A week column starts on Monday, so the log reaches back to it, or the first
// column counts only the days after the cut and reads as a quiet week.
const back = flag.days - 1 + (by === 'week' ? (today.getDay() - (flag.days - 1) % 7 + 6) % 7 : 0)
const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)

// argv, not a shell string: `--author` and `--path` are the caller's text.
const argv = ['log', `--since=${ymd(from)} 00:00`, '--date=short-local', '--format=@%ad', '--shortstat', '--no-color']
if (flag.author) argv.push(`--author=${flag.author}`)
if (flag.path) argv.push('--', flag.path)
let text = ''
try { text = execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }) }
catch (e) { log.error(`git log failed — ${e.message.split('\n')[0]}`); return }

const series = buildSeries(parseLog(text), { from: ymd(from), to: ymd(today), by })

if (flag.json) { console.log(JSON.stringify(series, null, 2)); return }

const value = flag.lines ? (b) => b.added + b.deleted : (b) => b.commits
const s = summarize(series, value)
const n = (v) => v.toLocaleString('en-US')
const unit = flag.lines ? 'lines changed' : 'commits'
console.log('')
console.log(`  ${chalk.bold(`${unit} per ${by}`)}${chalk.dim(` · last ${flag.days} day${flag.days === 1 ? '' : 's'}${flag.author ? ` · ${flag.author}` : ''}${flag.path ? ` · ${flag.path}` : ''}`)}`)
console.log('')
echo.lines(renderChart(series, {
  height: flag.height,
  width,
  value,
  bar: chalk.cyan,
  dim: chalk.dim,
}))
console.log('')
if (!s.commits) { log.warn('no commits in range'); return }
console.log('  ' + [
  `${n(s.commits)} commits`,
  `${chalk.green(`+${n(s.added)}`)} ${chalk.red(`-${n(s.deleted)}`)}`,
  `${s.active}/${s.buckets} ${by}s active`,
  `busiest ${by === 'week' ? 'week of ' : ''}${s.busiest.date} (${n(value(s.busiest))})`,
].join(chalk.dim('  ·  ')))
console.log('')
```
