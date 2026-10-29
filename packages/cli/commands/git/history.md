---
title: git:history
description: Commits per day as a column chart — time across, count up
alias: ghist
examples:
  - fli ghist
  - fli ghist --days 90
  - fli ghist --days 365 --by week
  - fli ghist --lines
  - fli ghist --files --days 365
  - fli ghist --files --code
  - fli ghist --author Jordan
  - fli ghist --claude
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
  files:
    char: f
    type: boolean
    description: Two charts, each on its own scale — files created, then files edited — instead of commits
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
  code:
    type: boolean
    description: Leave out tests, specs and markdown — what is left is source code
    defaultValue: false
  claude:
    char: c
    type: boolean
    description: A second chart under the commits — Claude Code output tokens per bucket, from ~/.claude/projects
    defaultValue: false
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
import { resolve as joinPath, join } from 'path'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { homedir } from 'os'

// Every session transcript written since `since`, subagents included. A
// `tool-results/` folder holds no transcript and is never read.
const transcripts = (dir, since, out = []) => {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'tool-results') transcripts(p, since, out) }
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= since) out.push(p)
  }
  return out
}
</script>

`git log` answers one commit at a time; the shape of the work — which weeks
were heavy, where it stopped — is something a reader has to tally by hand.

This draws it: one column per day, left to right, height the commit count.
A quiet day is a gap in the chart, never a missing column, so the x axis is
real time. Past what fits the terminal, `--by auto` folds the columns into
weeks.

`--lines` makes the height lines changed instead, which is the reading that
tells a rename sweep from a day of small fixes.

`--files` reads which files each commit touched instead, and draws two
charts, each scaled to its own tallest day: files created above, files
edited below. Edits run several times creations, so a shared scale draws
creation flat. The pair is where a project stands — new ground or work on
what exists. A rename counts as an edit and a deletion is only counted in
the summary.

`--code` leaves out tests, specs and markdown, so `--files` counts new
source rather than new docs and suites. It is three exclude pathspecs, and
composes with `--path`.

`--claude` draws a second chart under it on the same columns: Claude Code
output tokens, read from the session transcripts under `~/.claude/projects/`
whose working directory is inside this repo. Output, not total, because total
is mostly cache reads and measures context size times turns rather than work.
A headless session is a `claude -p` run — a fix loop, not a person.

```js
const root = $.git.repoRoot($.paths.root) ?? $.paths.root
const { parseLog, buildSeries, renderChart, summarize } = await import(joinPath(global.fliRoot, 'core/git-history.js'))
const { plural } = await import(joinPath(global.fliRoot, 'core/text.js'))

const today = new Date()
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const width = Math.max(40, process.stdout.columns || 100)
const by = flag.by !== 'auto' ? flag.by : flag.days + 6 > width ? 'week' : 'day'
// A week column starts on Monday, so the log reaches back to it, or the first
// column counts only the days after the cut and reads as a quiet week.
const back = flag.days - 1 + (by === 'week' ? (today.getDay() - (flag.days - 1) % 7 + 6) % 7 : 0)
const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)

// argv, not a shell string: `--author` and `--path` are the caller's text.
if (flag.files && flag.lines) { log.error('--files and --lines are two readings of the height — pick one'); return }
// git prints --name-status or --shortstat, never both.
const argv = ['log', `--since=${ymd(from)} 00:00`, '--date=short-local', '--format=@%ad', flag.files ? '--name-status' : '--shortstat', '--no-color']
if (flag.author) argv.push(`--author=${flag.author}`)
// `:!` is git's exclude pathspec; with no positive path it excludes from the whole tree.
const paths = [flag.path, ...(flag.code ? [':!*.test.*', ':!*.spec.*', ':!*.md'] : [])].filter(Boolean)
if (paths.length) argv.push('--', ...paths)
let text = ''
try { text = execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }) }
catch (e) { log.error(`git log failed — ${e.message.split('\n')[0]}`); return }

const series = buildSeries(parseLog(text), { from: ymd(from), to: ymd(today), by })

let claude = null
if (flag.claude) {
  const { tallySession, mergeSession, CLAUDE_ZERO } = await import(joinPath(global.fliRoot, 'core/claude-usage.js'))
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const days = new Map(), seen = new Set()
  // A project folder is its cwd with every other character a dash, so the prefix
  // narrows which folders are read and the transcript's own cwd decides.
  const slug = root.replace(/[^A-Za-z0-9]/g, '-')
  const dirs = existsSync(projects) ? readdirSync(projects).filter(d => d.startsWith(slug)) : []
  for (const file of dirs.flatMap(d => transcripts(join(projects, d), from.getTime()))) {
    const s = tallySession(readFileSync(file, 'utf8'), { seen })
    if (!s.cwd || (s.cwd !== root && !s.cwd.startsWith(root + '/'))) continue
    mergeSession(days, s, { subagent: file.includes('/subagents/') })
  }
  claude = buildSeries(days, { from: ymd(from), to: ymd(today), by, zero: CLAUDE_ZERO })
}

if (flag.json) {
  // A field git did not print this run is absent, never a 0 that reads as measured.
  const unread = flag.files ? ['added', 'deleted'] : ['created', 'edited', 'removed']
  const out = { ...series, buckets: series.buckets.map(b => Object.fromEntries(Object.entries(b).filter(([k]) => !unread.includes(k)))) }
  console.log(JSON.stringify(claude ? { ...out, claude: claude.buckets } : out, null, 2))
  return
}

const n = (v) => v.toLocaleString('en-US')
const scope = chalk.dim(` · last ${plural(flag.days, 'day')}${flag.author ? ` · ${flag.author}` : ''}${flag.path ? ` · ${flag.path}` : ''}${flag.code ? ' · code only' : ''}`)
const chart = (unit, value, bar) => {
  console.log('')
  console.log(`  ${chalk.bold(`${unit} per ${by}`)}${scope}`)
  console.log('')
  echo.lines(renderChart(series, { height: flag.height, width, value, bar, dim: chalk.dim }))
  console.log('')
}
const when = (b) => `${by === 'week' ? 'week of ' : ''}${b.date}`

if (flag.files) {
  const s = summarize(series, (b) => b.created + b.edited)
  chart('files created', (b) => b.created, chalk.green)
  chart('files edited', (b) => b.edited, chalk.cyan)
  if (!s.commits) log.warn('no commits in range')
  else console.log('  ' + [
    `${n(s.commits)} commits`,
    `${chalk.green(`${n(s.created)} created`)} ${chalk.cyan(`${n(s.edited)} edited`)} ${chalk.red(`${n(s.removed)} removed`)}`,
    s.created ? `${(s.edited / s.created).toFixed(1)} edits per new file` : 'no new files',
    `busiest ${when(s.busiest)} (${n(s.busiest.created + s.busiest.edited)} files)`,
  ].join(chalk.dim('  ·  ')))
  console.log('')
} else {
  const value = flag.lines ? (b) => b.added + b.deleted : (b) => b.commits
  const s = summarize(series, value)
  chart(flag.lines ? 'lines changed' : 'commits', value, chalk.cyan)
  if (!s.commits) log.warn('no commits in range')
  else console.log('  ' + [
    `${n(s.commits)} commits`,
    `${chalk.green(`+${n(s.added)}`)} ${chalk.red(`-${n(s.deleted)}`)}`,
    `${s.active}/${s.buckets} ${by}s active`,
    `busiest ${when(s.busiest)} (${n(value(s.busiest))})`,
  ].join(chalk.dim('  ·  ')))
  console.log('')
}

if (claude) {
  const { compact } = await import(joinPath(global.fliRoot, 'core/claude-usage.js'))
  const sum = (k) => claude.buckets.reduce((a, b) => a + b[k], 0)
  const busiest = claude.buckets.reduce((a, b) => (b.output > a.output ? b : a), claude.buckets[0])
  console.log(`  ${chalk.bold(`Claude output tokens per ${by}`)}${chalk.dim(` · sessions in ${root}`)}`)
  console.log('')
  echo.lines(renderChart(claude, { height: flag.height, width, value: (b) => b.output, bar: chalk.magenta, dim: chalk.dim, label: compact }))
  console.log('')
  if (!sum('output')) { log.warn('no Claude sessions in range'); return }
  console.log('  ' + [
    `${n(sum('sessions'))} sessions${chalk.dim(` (${n(sum('headless'))} headless)`)}`,
    `${compact(sum('output'))} output`,
    `${compact(sum('total'))} total`,
    `${claude.buckets.filter(b => b.output).length}/${claude.buckets.length} ${by}s active`,
    `busiest ${by === 'week' ? 'week of ' : ''}${busiest.date} (${compact(busiest.output)})`,
  ].join(chalk.dim('  ·  ')))
  console.log('')
}
```
