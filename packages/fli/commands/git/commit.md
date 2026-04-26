---
title: git:commit
description: Interactive conventional commit prompt (type, scope, message, body)
alias: gc
examples:
  - fli gc
  - fli git:commit
  - fli gc --dry
---

<script>
import { execSync } from 'child_process'

const TYPES = [
  { value: 'feat',     label: 'feat      ✨  A new feature' },
  { value: 'fix',      label: 'fix       🐛  A bug fix' },
  { value: 'docs',     label: 'docs      📝  Documentation changes' },
  { value: 'style',    label: 'style     💄  Formatting, no logic changes' },
  { value: 'refactor', label: 'refactor  ♻️   Code refactored, no feature/fix' },
  { value: 'perf',     label: 'perf      ⚡️  Performance improvement' },
  { value: 'test',     label: 'test      ✅  Adding or fixing tests' },
  { value: 'chore',    label: 'chore     🔧  Build process or tooling' },
  { value: 'ci',       label: 'ci        👷  CI/CD changes' },
  { value: 'revert',   label: 'revert    ⏪️  Reverts a previous commit' },
]

const getStagedFiles = () => {
  try {
    return execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch { return [] }
}
</script>

Walks you through a [Conventional Commits](https://www.conventionalcommits.org) message.
Staged files are shown first so you know what you're committing.

```js
// ─── Check for staged changes ─────────────────────────────────────────────────
const staged = getStagedFiles()
if (!staged.length) {
  log.error('Nothing staged — run `git add` first')
  return
}

log.info(`Staged files (${staged.length}):`)
for (const f of staged.slice(0, 8)) echo(`  ${f}`)
if (staged.length > 8) echo(`  … and ${staged.length - 8} more`)
echo('')

// ─── Type ─────────────────────────────────────────────────────────────────────
echo('Commit types:')
TYPES.forEach((t, i) => echo(`  ${String(i + 1).padStart(2)}. ${t.label}`))
echo('')

let typeInput = await question('Type (number or name): ')
typeInput = typeInput.trim()
const typeEntry = TYPES.find((t, i) =>
  t.value === typeInput || String(i + 1) === typeInput
)
if (!typeEntry) { log.error('Invalid type'); return }
const type = typeEntry.value

// ─── Scope (optional) ────────────────────────────────────────────────────────
const scopeInput = await question('Scope (optional, e.g. auth, db — press Enter to skip): ')
const scope = scopeInput.trim()

// ─── Breaking change ──────────────────────────────────────────────────────────
const breaking = (await question('Breaking change? (y/N): ')).trim().toLowerCase() === 'y'

// ─── Subject ──────────────────────────────────────────────────────────────────
let subject = ''
while (!subject) {
  subject = (await question('Subject (short description): ')).trim()
  if (!subject) log.warn('Subject is required')
}

// ─── Body (optional) ─────────────────────────────────────────────────────────
const body = (await question('Body (optional, press Enter to skip): ')).trim()

// ─── Build message ────────────────────────────────────────────────────────────
const scopeStr   = scope ? `(${scope})` : ''
const breakingStr = breaking ? '!' : ''
const header     = `${type}${scopeStr}${breakingStr}: ${subject}`
const fullMsg    = body ? `${header}\n\n${body}` : header

echo('')
echo('─── Commit message ───────────────────────────────')
echo(fullMsg)
echo('──────────────────────────────────────────────────')
echo('')

const confirm = (await question('Commit? (Y/n): ')).trim().toLowerCase()
if (confirm === 'n') { log.warn('Aborted'); return }

if (flag.dry) {
  log.dry(`Would run: git commit -m "${header}"`)
  return
}

execSync(`git commit -m ${JSON.stringify(fullMsg)}`, { stdio: 'inherit' })
log.success('Committed')
```
