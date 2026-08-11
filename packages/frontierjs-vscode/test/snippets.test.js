// Snippet files — the shape VS Code refuses to expand.
//
// Run:  npm test  ·  node test/snippets.test.js
//
// A snippet body is not JSON's problem and not tsc's: `$onCleanup` is a VS Code
// snippet VARIABLE, and an unknown variable expands to nothing, so the snippet
// silently inserts `(() => { })` with the call gone. Both languages here write
// `$` as ordinary text — Mesa's runtime globals and Litestone's nothing — so a
// literal `$` must be escaped, every time, and the only thing that says
// otherwise is a warning in the extension host's log at startup:
//   "One or more snippets from the extension 'frontierjs' very likely confuse
//    snippet-variables and snippet-placeholders"
// which names no snippet and no file.

'use strict'

const path = require('path')
const fs   = require('fs')

const ROOT = path.resolve(__dirname, '..')
const PKG  = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

let pass = 0, fail = 0, group = ''
const failures = []

function section(name) { group = name; console.log(`\n${name}`) }

function ok(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok    ${name}`) }
  else {
    fail++
    failures.push(`${group} › ${name}${detail ? `\n        ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// The variables VS Code resolves. Anything else after a `$` is a typo to the
// editor — it expands to nothing rather than to the text that was written.
const VARIABLES = new Set([
  'TM_SELECTED_TEXT', 'TM_CURRENT_LINE', 'TM_CURRENT_WORD', 'TM_LINE_INDEX',
  'TM_LINE_NUMBER', 'TM_FILENAME', 'TM_FILENAME_BASE', 'TM_DIRECTORY', 'TM_FILEPATH',
  'RELATIVE_FILEPATH', 'CLIPBOARD', 'WORKSPACE_NAME', 'WORKSPACE_FOLDER',
  'CURSOR_INDEX', 'CURSOR_NUMBER', 'RANDOM', 'RANDOM_HEX', 'UUID',
  'CURRENT_YEAR', 'CURRENT_YEAR_SHORT', 'CURRENT_MONTH', 'CURRENT_MONTH_NAME',
  'CURRENT_MONTH_NAME_SHORT', 'CURRENT_DATE', 'CURRENT_DAY_NAME',
  'CURRENT_DAY_NAME_SHORT', 'CURRENT_HOUR', 'CURRENT_MINUTE', 'CURRENT_SECOND',
  'CURRENT_SECONDS_UNIX', 'CURRENT_TIMEZONE_OFFSET',
  'BLOCK_COMMENT_START', 'BLOCK_COMMENT_END', 'LINE_COMMENT'
])

/** Every `$` in `body` that is neither escaped, nor a tabstop, nor a known variable. */
function strayDollars(body) {
  const stray = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '$') continue
    if (i > 0 && body[i - 1] === '\\') continue                    // \$ — literal, correct
    const rest = body.slice(i)
    if (/^\$\d/.test(rest)) continue                               // $1 $0
    if (/^\$\{\d/.test(rest)) continue                             // ${1:x} ${1|a,b|}
    const named = rest.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)/)
    if (named && VARIABLES.has(named[1])) continue
    stray.push(named ? `$${named[1]}` : '$')
  }
  return stray
}

// ─── Cases ────────────────────────────────────────────────────────────────────

section('Snippets')

for (const entry of PKG.contributes.snippets) {
  const file = path.join(ROOT, entry.path)
  let json
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
    ok(`${entry.language}: ${entry.path} parses`, true)
  } catch (err) {
    ok(`${entry.language}: ${entry.path} parses`, false, String(err.message))
    continue
  }

  const names = Object.keys(json)
  ok(`${entry.language}: every snippet has a prefix and a body`,
    names.every(n => json[n].prefix && json[n].body),
    names.filter(n => !json[n].prefix || !json[n].body).join(', '))

  const offenders = []
  for (const name of names) {
    const body  = Array.isArray(json[name].body) ? json[name].body.join('\n') : String(json[name].body)
    const stray = strayDollars(body)
    if (stray.length) offenders.push(`${name} → ${[...new Set(stray)].join(' ')}`)
  }
  // Bodies only: a prefix is typed rather than expanded, so `"prefix": "$watch"`
  // is right and a rule reaching into it would push the vocabulary out of the
  // snippet list.
  ok(`${entry.language}: no body confuses a variable for text`, offenders.length === 0,
    offenders.join('\n        '))
}

console.log(`\n${'─'.repeat(60)}`)
console.log(`  ${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\nFailures:')
  failures.forEach(f => console.log(`  ✗ ${f}`))
}
process.exit(fail ? 1 : 0)
