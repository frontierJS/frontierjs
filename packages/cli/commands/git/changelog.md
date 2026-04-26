---
title: git:changelog
description: Generate or update CHANGELOG.md from git commit history
alias: changelog
examples:
  - fli changelog
  - fli changelog --from v1.0.0 --to v1.1.0
  - fli changelog --output CHANGELOG.md
  - fli changelog --dry
flags:
  from:
    type: string
    description: Start tag/commit (defaults to last tag)
    defaultValue: ''
  to:
    type: string
    description: End tag/commit (defaults to HEAD)
    defaultValue: HEAD
  output:
    char: o
    type: string
    description: Output file (defaults to CHANGELOG.md in project root)
    defaultValue: CHANGELOG.md
  print:
    char: p
    type: boolean
    description: Print to stdout instead of writing file
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

const runCmd = (cmd, cwd) => {
  try { return execSync(cmd, { encoding: 'utf8', cwd, stdio: ['pipe','pipe','ignore'] }).trim() }
  catch { return '' }
}

const getLastTag = (cwd) => runCmd('git describe --tags --abbrev=0', cwd)

const getCommits = (from, to, cwd) => {
  const range = from ? `${from}..${to}` : to
  const log   = runCmd(`git log ${range} --format="%s|%h|%an" --no-merges`, cwd)
  return log.split('\n').filter(Boolean).map(line => {
    const [msg, hash, author] = line.split('|')
    const match = msg.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/)
    return match
      ? { type: match[1], scope: match[2]||'', breaking: !!match[3], subject: match[4], hash, author }
      : { type: 'other', scope: '', breaking: false, subject: msg, hash, author }
  })
}

const GROUP_LABELS = {
  feat:     '✨ Features',
  fix:      '🐛 Bug Fixes',
  perf:     '⚡ Performance',
  docs:     '📝 Documentation',
  refactor: '♻️  Refactors',
  test:     '✅ Tests',
  chore:    '🔧 Chores',
  ci:       '👷 CI',
  other:    '📦 Other',
}
</script>

Parses [Conventional Commits](https://www.conventionalcommits.org) from git history
and generates a grouped, readable `CHANGELOG.md`.

```js
const cwd      = context.paths.root
const lastTag  = flag.from || getLastTag(cwd)
const commits  = getCommits(lastTag, flag.to, cwd)

if (!commits.length) {
  log.warn(`No commits found ${lastTag ? `since ${lastTag}` : ''}`)
  return
}

// Group by type
const groups = {}
for (const c of commits) {
  const key = GROUP_LABELS[c.type] ? c.type : 'other'
  ;(groups[key] ??= []).push(c)
}

// Build markdown
const version = runCmd('git describe --tags --abbrev=0 2>/dev/null || echo "Unreleased"', cwd) || 'Unreleased'
const date    = new Date().toISOString().split('T')[0]
const breaking = commits.filter(c => c.breaking)

let md = `## [${version}] — ${date}\n\n`

if (breaking.length) {
  md += `### 💥 Breaking Changes\n\n`
  for (const c of breaking) {
    const scope = c.scope ? `**${c.scope}:** ` : ''
    md += `- ${scope}${c.subject} (\`${c.hash}\`)\n`
  }
  md += '\n'
}

for (const [type, label] of Object.entries(GROUP_LABELS)) {
  if (!groups[type]?.length) continue
  md += `### ${label}\n\n`
  for (const c of groups[type]) {
    const scope = c.scope ? `**${c.scope}:** ` : ''
    md += `- ${scope}${c.subject} (\`${c.hash}\`)\n`
  }
  md += '\n'
}

if (flag.print || flag.dry) {
  if (flag.dry) log.dry(`Would write ${commits.length} commits to ${flag.output}`)
  echo(md)
  return
}

const outPath    = resolve(cwd, flag.output)
const existing   = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
const newContent = md + (existing ? '\n---\n\n' + existing : '')
writeFileSync(outPath, newContent, 'utf8')
log.success(`Updated ${flag.output} with ${commits.length} commit(s)${lastTag ? ` since ${lastTag}` : ''}`)
```
