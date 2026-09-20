// src/tools/repl.js — the console, and the standing it runs at
//
// Every framework ships one of these and every one of them is god-mode by
// construction: authorization lives in the controller layer, and a console calls
// the model directly, *underneath* it. Here access is declared at the Data
// boundary, so a console can boot AS somebody and be refused exactly what they
// are refused — which is what makes "reproduce what the customer sees" a flag
// rather than guesswork.
//
// That only holds if you cannot forget what you are running as, so the standing
// is in the prompt on every line rather than in a banner you scrolled past. It
// is the whole reason this is not `bun repl` with a preload: a subprocess REPL
// owns its own prompt and will not say.
//
// Two names are bound and they are different clients:
//
//   db   the standing you asked for — anonymous, a principal, or a level
//   sys  asSystem(), which bypasses every gate, policy and field lock
//
// `sys` is reachable on purpose. Refusing it means people run a one-off script
// instead, which is the same power with none of this in front of it.
//
// Never imported by application code.

import { createInterface }        from 'node:readline'
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir }                from 'node:os'
import { join }                   from 'node:path'

const HISTORY  = join(homedir(), '.litestone_repl_history')
const MAX_KEPT = 500

// ─── the standing ─────────────────────────────────────────────────────────────
//
// Three shapes, and the difference between the middle two is the one thing this
// file most needs to keep straight. `--as` runs the app's OWN resolver over a
// real row; `--level` fixes the answer. A grid walked with the second passes in
// full while the first is broken, because the resolver was never called — the
// same separation `createTestEnv` keeps between `actingAs` and `atLevel`.

export function describeStanding({ label = null, graded = 0, synthetic = false }) {
  if (label && synthetic) return `${label}@${graded}`
  if (label)              return `${label}(${graded})`
  if (synthetic)          return `level ${graded}`
  return 'anonymous(0)'
}

// ─── an app's own commands ────────────────────────────────────────────────────
//
// `db/tinker.js`, beside the schema, default-exports `{ name: { help, run } }`.
// `.name a b` calls `run({ db, sys, args: ['a', 'b'], out, tenant })`. The file
// is refused whole rather than entry by entry: a command silently missing from
// the list reads as a typo at the prompt, not as a broken file.

const BUILT_IN     = ['help', 'standing', 'exit']
const COMMAND_NAME = /^[A-Za-z][\w-]*$/

export function tinkerCommands(mod, file = 'db/tinker.js') {
  const table = mod?.default
  if (!table || typeof table !== 'object' || Array.isArray(table))
    throw new Error(`${file} must export default an object of commands — { resetPasswords: { help, run } }`)

  for (const [name, cmd] of Object.entries(table)) {
    if (!COMMAND_NAME.test(name))
      throw new Error(`${file}: "${name}" is not a command name — a letter, then letters, digits, - or _`)
    if (BUILT_IN.includes(name))
      throw new Error(`${file}: .${name} is built in — name the command something else`)
    if (!cmd || typeof cmd.run !== 'function')
      throw new Error(`${file}: .${name} needs a run function — { help: '…', run({ db, sys, args, out }) { … } }`)
    if (cmd.help != null && typeof cmd.help !== 'string')
      throw new Error(`${file}: .${name}'s help must be a string`)
  }
  return table
}

// ─── startRepl ────────────────────────────────────────────────────────────────
//
//   startRepl({ db, sys, standing, accessors, commands, tenant, hints, out })  → Promise<void>
//
// Resolves when the session ends. `out` is injectable so a test can read what a
// session printed without a terminal.

export function startRepl({ db, sys, standing, accessors = [], commands = {}, tenant = null, hints = [], out = console.log } = {}) {
  const prompt = `${standing} > `

  const rl = createInterface({
    input:     process.stdin,
    output:    process.stdout,
    prompt,
    completer: completerFor(accessors, Object.keys(commands)),
    history:   loadHistory(),
    terminal:  process.stdin.isTTY,
  })

  for (const line of hints) out(line)

  return new Promise((resolve) => {
    // A promise CHAIN, not `rl.pause()`. Pausing does not hold back lines that
    // are already buffered — a pasted block or a piped heredoc emits every line
    // synchronously — so the handlers overlap and the statements complete in
    // whatever order their awaits finish. Against a database that is writes
    // landing in an order nobody wrote. Measured: two lines, the slow one first,
    // came back reversed.
    let chain = Promise.resolve()

    // `rl.prompt()` resumes the input stream, and a closed interface raises
    // ERR_USE_AFTER_CLOSE there rather than returning. The chain above is what
    // makes that reachable: the LAST line's continuation runs after the input
    // ended and the interface closed, so a session's final statement threw on
    // its way to drawing the next prompt — after the answer was printed, which
    // is the worst moment for a console to lose its voice. Every prompt goes
    // through here.
    //
    // The flag is this file's own rather than a property read off the
    // interface, because whether one is exposed, and whether resuming a closed
    // one throws at all, is a runtime's choice and has changed under us.
    let closed = false
    const showPrompt = () => { if (!closed) rl.prompt() }

    showPrompt()

    rl.on('line', (raw) => {
      chain = chain.then(() => handleLine(raw))
    })

    rl.on('close', () => {
      closed = true
      // The chain, not the event: closing mid-statement otherwise reports the
      // session over while a write is still in flight.
      chain.then(() => { out(''); resolve() })
    })

    async function handleLine(raw) {
      const line = raw.trim()

      if (!line)                 return showPrompt()
      if (line === '.exit')      return rl.close()
      if (line === '.help')      { for (const l of helpLines(accessors, commands)) out(l); return showPrompt() }
      if (line === '.standing')  { out(`  ${standing}`); return showPrompt() }

      remember(line)

      // No JavaScript statement starts with a dot, so a dotted line that names
      // no command is a typo — evaluating it would print a SyntaxError about
      // the typo's punctuation instead of the name.
      if (line.startsWith('.')) {
        const [name, ...args] = line.slice(1).split(/\s+/)
        if (!Object.hasOwn(commands, name)) {
          out(`  No command .${name}. ${dim('.help lists them')}`)
          return showPrompt()
        }
        try {
          await commands[name].run({ db, sys, args, out, tenant })
        } catch (err) {
          out(`  ${err.name}: ${err.message}`)
        }
        return showPrompt()
      }

      try {
        out(format(await evaluate(line, db, sys)))
      } catch (err) {
        // The message alone. A stack from inside the client names our files and
        // says nothing about the expression that asked, which is what a person
        // at a prompt is debugging.
        out(`  ${err.name}: ${err.message}`)
      }
      showPrompt()
    }
  })
}

// ─── evaluating ───────────────────────────────────────────────────────────────
//
// Wrapped in an async function so top-level await works and a bare expression
// still answers its value. A single expression is parenthesized so `db.x.count()`
// returns rather than being a statement; anything with a newline or a `;` or a
// leading keyword is a body, where a `return` is the caller's to write.

const BODY = /^(const|let|var|if|for|while|function|class|try|switch|do|return|import|throw)\b/

function evaluate(code, db, sys) {
  const body = code.includes('\n') || code.includes(';') || BODY.test(code)
  const src  = body ? `return (async () => { ${code} })()`
                    : `return (async () => (${code}))()`
  return new Function('db', 'sys', src)(db, sys)
}

// A row is the thing being looked at, so it is printed whole. `JSON.stringify`
// is not enough on its own — a Date and a BigInt are both routine in an answer
// here and neither survives it, one silently and one as a throw.
function format(value) {
  if (value === undefined) return '  undefined'
  if (value === null)      return '  null'

  const text = JSON.stringify(value, (_, v) => {
    if (typeof v === 'bigint')       return `${v}n`
    if (v instanceof Date)           return v.toISOString()
    if (v instanceof Uint8Array)     return `<${v.length} bytes>`
    return v
  }, 2)

  // A function or a symbol stringifies to nothing at all — printing an empty
  // string reads as a query that answered nothing.
  if (text === undefined) return `  ${String(value)}`

  return text.split('\n').map(l => `  ${l}`).join('\n')
}

// ─── completion ───────────────────────────────────────────────────────────────
//
// The accessors and the method names, which is what is actually typed. It does
// not reach into the client, because a Litestone client THROWS on an unknown
// property — enumerating one to build a completion list is a throwing expression
// on a good day and a surprise on a bad one.

const METHODS = [
  'findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow',
  'findManyAndCount', 'findManyCursor', 'count', 'exists', 'aggregate', 'groupBy',
  'search', 'query', 'create', 'createMany', 'update', 'updateMany', 'upsert',
  'remove', 'removeMany', 'delete', 'deleteMany', 'restore', 'transitions',
]

function completerFor(accessors, commandNames = []) {
  const roots = [
    ...accessors.flatMap(a => [`db.${a}.`, `sys.${a}.`]),
    'db.', 'sys.', '.help', '.standing', '.exit',
    ...commandNames.map(n => `.${n}`),
  ]

  return (line) => {
    const at = Math.max(line.lastIndexOf(' '), line.lastIndexOf('('), line.lastIndexOf(',')) + 1
    const word = line.slice(at)

    const dot = word.lastIndexOf('.')
    const stem = dot === -1 ? '' : word.slice(0, dot + 1)

    const candidates = accessors.some(a => stem.endsWith(`${a}.`))
      ? METHODS.map(m => stem + m)
      : roots

    const hits = candidates.filter(c => c.startsWith(word))
    return [hits.length ? hits : candidates, word]
  }
}

// ─── history ──────────────────────────────────────────────────────────────────
//
// Appended rather than rewritten, so two sessions open at once do not truncate
// each other's. readline wants it newest-first.

function loadHistory() {
  if (!existsSync(HISTORY)) return []
  try {
    return readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).slice(-MAX_KEPT).reverse()
  } catch { return [] }
}

function remember(line) {
  try { appendFileSync(HISTORY, `${line}\n`) } catch { /* a read-only home is not a reason to refuse a session */ }
}

// ─── help ─────────────────────────────────────────────────────────────────────

function helpLines(accessors, commands = {}) {
  const own   = Object.entries(commands)
  const width = Math.max(10, ...own.map(([n]) => n.length + 2))
  return [
    '',
    '  db          the standing this session booted at',
    '  sys         asSystem() — bypasses every gate, policy and field lock',
    '',
    `  accessors   ${accessors.join(', ') || '(none)'}`,
    '',
    '  .standing   what this session is running as',
    '  .help       this',
    '  .exit       leave (Ctrl-D also works)',
    '',
    ...(own.length
      ? [...own.map(([n, c]) => `  ${`.${n}`.padEnd(width)}  ${c.help ?? ''}`.trimEnd()), '']
      : ['  db/tinker.js beside the schema adds commands of your own', '']),
  ]
}

function dim(s) { return process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s }
