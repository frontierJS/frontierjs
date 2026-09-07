// ─── shortcuts.js ─────────────────────────────────────────────────────────────
// The one owner of what a SHORTCUT is: a project-local name for a command line
// you type often — `fli go-time` for `fli ws:atlas --open --live`.
//
// A shortcut is not a new kind of thing. It is an ordinary project command file
// under `routesDir/shortcut/`, so discovery, `--help`, completion, `fli edit`
// and the doc rules already know about it, and a shortcut that grows into a
// real command is an edit to that file rather than a migration out of a table.
// A registry of name → string would have been a second place a command name
// comes from, and every one of those readers would have had to learn it.
//
// `alias:` in frontmatter keeps its existing meaning — a second name for one
// command file — which is why the noun here is `shortcut` and not `alias`.
// ─────────────────────────────────────────────────────────────────────────────

import { resolve } from 'path'

export const SHORTCUT_NAMESPACE = 'shortcut'

// A command name is kebab: `ws:atlas`, `check-deps`, `make:command`. The colon
// is the namespace separator and a shortcut's namespace is chosen for it, so a
// name carrying one would claim a namespace it does not own.
const NAME = /^[a-z][a-z0-9-]*$/

export function shortcutTitle(name) {
  return `${SHORTCUT_NAMESPACE}:${name}`
}

export function shortcutPath({ root, routesDir, name }) {
  return resolve(root, routesDir, SHORTCUT_NAMESPACE, `${name}.md`)
}

// ─── Refusals ────────────────────────────────────────────────────────────────
// Both are checked before anything is written, and both name what to do next:
// a refusal a reader cannot act on is a refusal they work around.

/** Why this name cannot be a shortcut, or null. */
export function refuseName(name) {
  if (!name)             return 'A shortcut needs a name — `fli make:shortcut go-time "fli ws:atlas --open --live"`'
  if (name.includes(':')) return `"${name}" carries a ":", which is the namespace separator — a shortcut is named "${SHORTCUT_NAMESPACE}:<name>" for you. Try "${name.split(':').pop()}"`
  if (!NAME.test(name))  return `"${name}" is not a command name — lower-case, digits and dashes, starting with a letter`
  return null
}

/**
 * Why this command line cannot be a shortcut, or null.
 *
 * One line only: the target goes into the file's own frontmatter description,
 * and a second line there ends the frontmatter block or is read as another key.
 * A shortcut that needs two lines is a command, and the file it would be
 * written into is already one.
 */
export function refuseCommand(command) {
  const value = (command ?? '').trim()
  if (!value)                  return 'A shortcut needs a command to run — `fli make:shortcut go-time "fli ws:atlas --open --live"`'
  if (/[\r\n]/.test(command))  return 'A shortcut is one line. Scaffold it with the first line, then edit the file — it is an ordinary command.'
  return null
}

/**
 * Why this name is already taken, or null.
 *
 * The registry is deliberately silent when a project command overrides a core
 * one — that override is the authoring model. It is the wrong default for a
 * shortcut, which is typed from memory: `fli make:shortcut new "…"` would eat
 * `fli new` and say nothing.
 */
export function refuseTaken(name, registry) {
  const hit = registry?.get?.(name)
  if (!hit) return null
  const title = hit.meta?.title ?? name
  const owner = title === name ? title : `${title} (as "${name}")`
  return `"${name}" already runs ${owner}. Pick another name, or rename that command.`
}

// ─── The file ────────────────────────────────────────────────────────────────

// The target is embedded in a template literal so `${context.fli}` can be
// spliced into it. Everything the author typed is data.
const escapeTemplate = (s) => s
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

/**
 * The command line as it appears inside the generated template literal.
 *
 * A leading `fli` becomes `${context.fli}` — the fli that is running, resolved
 * by absolute path, rather than whichever one is on the shell's PATH. A global
 * install and a workspace checkout are routinely both present, and a shortcut
 * that reached the other one would be wrong in a way nothing prints.
 * Anything else is run as written.
 */
export function targetExpression(command) {
  const value = command.trim()
  const rest  = value === 'fli' ? '' : value.startsWith('fli ') ? value.slice(4) : null
  if (rest === null) return escapeTemplate(value)
  return '${context.fli}' + (rest ? ' ' + escapeTemplate(rest) : '')
}

export function renderShortcut({ name, command, description = '' }) {
  const target = targetExpression(command)
  const line   = command.trim()
  const fence  = '`'.repeat(3)

  return [
    '---',
    `title: ${shortcutTitle(name)}`,
    `description: ${description || line}`,
    `alias: ${name}`,
    // The command's flags are the TARGET's. Without this, every forwarded flag
    // is announced as "not defined" by the one command that does not define
    // flags on purpose.
    'mode: passthrough',
    'examples:',
    `  - fli ${name}`,
    '---',
    '',
    `Runs \`${line}\` from the project root.`,
    '',
    'Anything typed after the name is appended verbatim, so `fli ' + name + ' --as=report`',
    'reaches the target command. `--help` does not: fli answers that itself, and',
    'the answer is this file.',
    '',
    'An ordinary command file — a shortcut that grows into a command is an edit',
    'here, not a migration.',
    '',
    fence + 'js',
    "// minimist has already read the argv into `flag`, so forwarding `flag`",
    "// would send fli's own defaults (--dry, --test) to a command that never",
    '// asked for them. The raw tail is the only faithful copy of what was typed.',
    'const q     = (a) => "\'" + a.split("\'").join("\'\\\\\'\'") + "\'"',
    'const extra = process.argv.slice(3).map(q).join(\' \')',
    '',
    'context.exec({',
    '  command: `' + target + '${extra ? \' \' + extra : \'\'}`,',
    '  cwd:     context.paths.root,',
    '  dry:     flag.dry,',
    '})',
    fence,
    '',
  ].join('\n')
}
