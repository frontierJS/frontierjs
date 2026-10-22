/*
 * keys.js — a key sequence read against a keymap: the chord grammar, the trie,
 * and the pure step a host feeds one chord at a time (`IDEAS/keys.md`).
 *
 * No clock and no DOM: a host passes `now` and the text predicate, so the
 * terminal and a browser tab answer one table the same way (`FJS-D1382`–
 * `FJS-D1388`).
 *
 * A chord is `{ key, mod?, ctrl?, alt?, meta?, shift? }` — `key` is the DOM's
 * `KeyboardEvent.key` name, a flag is present only when set. It is written in
 * vim's spelling (`FJS-D1383`): `gg`, `<C-k>`, `<S-CR>`, and `<Mod-k>` for Cmd
 * on a Mac and Ctrl elsewhere.
 *
 * One chord has one spelling, and it is what `formatChord` writes: a key
 * string written any other way — `<cr>`, `<Enter>`, `<S-C-k>` — is refused
 * naming the canonical one, so a search for `<CR>` finds every binding of it.
 *
 * Shift on a printable key is carried by the character it types, because that
 * is what `e.key` reports: `G` is a chord and `<S-g>` is refused as a second
 * spelling of it, and `<S-1>` is refused because what Shift+1 types depends on
 * the layout. Beside Ctrl, Alt, Cmd or Mod a letter is lowercase with Shift
 * explicit — `<C-S-k>` — and `<C-K>` is refused, since vim reads it as `<C-k>`
 * and the DOM as the shifted one.
 */

// vim's key names, lowercased, to the DOM's — its aliases too, so a refusal
// can name the one spelling they are written in.
const NAMED = {
  cr: 'Enter', return: 'Enter', enter: 'Enter',
  esc: 'Escape', tab: 'Tab', space: ' ',
  bs: 'Backspace', backspace: 'Backspace', del: 'Delete', insert: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  lt: '<', gt: '>',
}

const SPELLED = {
  Enter: 'CR', Escape: 'Esc', Tab: 'Tab', ' ': 'Space',
  Backspace: 'BS', Delete: 'Del', Insert: 'Insert',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
}

const FKEY = /^f([1-9]|1[0-9]|2[0-4])$/i

// The order a chord's modifiers are written in, and the flag each one sets.
const MODIFIERS = [['mod', 'Mod'], ['ctrl', 'C'], ['alt', 'A'], ['meta', 'D'], ['shift', 'S']]
const PREFIX = { mod: 'mod', c: 'ctrl', a: 'alt', d: 'meta', s: 'shift' }

const WEB_SHAPE = /^(mod|ctrl|control|cmd|command|meta|alt|option|opt|shift|super)[+-]./i

const isLetter = (c) => c.toLowerCase() !== c.toUpperCase()
const isChar = (key) => key !== ' ' && Array.from(key).length === 1

function refuse(fn, input, why) {
  throw new TypeError(`${fn}(${JSON.stringify(input)}): ${why}`)
}

/** One chord, `k` or `<C-k>`. A string of more than one chord is refused. */
export function parseChord(s) {
  const seq = read(s, 'parseChord')
  if (seq.length !== 1) refuse('parseChord', s, `that is ${seq.length} keys; parseKeys reads a sequence`)
  return seq[0]
}

/** A sequence: `gg`, `]u`, `<C-w>j`, `<Esc>`. */
export function parseKeys(s) {
  return read(s, 'parseKeys')
}

function read(s, fn) {
  if (typeof s !== 'string' || s === '') refuse(fn, s, 'a key string is required')
  if (/\s/.test(s)) {
    refuse(fn, s, "a space separates nothing in vim's spelling: 'gg' is the sequence and '<Space>' the key (FJS-D1383)")
  }
  if (WEB_SHAPE.test(s)) {
    refuse(fn, s, "that is the web's spelling, which would read as letters; write it in vim's brackets, '<Mod-k>' or '<S-CR>' (FJS-D1383)")
  }
  const named = Array.from(s).length > 1 && namedKey(s)
  if (named) {
    refuse(fn, s, `that would read as ${Array.from(s).length} keys; a named key is written in brackets, '${formatChord({ key: named })}'`)
  }

  const out = []
  let rest = s
  while (rest) {
    const bracket = rest[0] === '<' && bracketAt(rest)
    const token = bracket || Array.from(rest)[0]
    const c = bracket ? bracketChord(bracket.slice(1, -1), s, fn) : { key: token }
    const spelled = formatChord(c)
    if (spelled !== token) refuse(fn, s, `'${token}' is written '${spelled}', one spelling per chord (FJS-D1383)`)
    out.push(c)
    rest = rest.slice(token.length)
  }
  return out
}

// The DOM key a bare word names, in vim's spelling or the DOM's.
function namedKey(word) {
  const lower = word.toLowerCase()
  if (NAMED[lower] !== undefined) return NAMED[lower]
  if (FKEY.test(word)) return word.toUpperCase()
  return Object.keys(SPELLED).find((k) => k.toLowerCase() === lower)
}

// `<…>` at the head of `rest`, or null when the `<` is a literal one. A `>`
// directly after a trailing `-` is the key itself, as in `<C->>`.
function bracketAt(rest) {
  let end = rest.indexOf('>', 2)
  if (end < 0) return null
  if (rest[end - 1] === '-' && rest[end + 1] === '>') end++
  const inner = rest.slice(1, end)
  return inner.includes('<') ? null : rest.slice(0, end + 1)
}

function bracketChord(inner, input, fn) {
  const flags = {}
  let name = inner
  for (let m; (m = /^(mod|[a-z])-(.+)$/i.exec(name)); name = m[2]) {
    const p = m[1].toLowerCase()
    if (p === 'm') refuse(fn, input, "'M-' is Alt in vim and Cmd on a Mac; write '<A-…>' or '<D-…>'")
    const flag = PREFIX[p]
    if (!flag) refuse(fn, input, `'${m[1]}-' is no modifier; vim's are C, A, D, S, and Mod for the platform's`)
    if (flags[flag]) refuse(fn, input, `'${m[1]}-' is written twice`)
    flags[flag] = true
  }
  if (flags.mod && (flags.ctrl || flags.meta)) {
    refuse(fn, input, "Mod is Cmd on a Mac and Ctrl elsewhere, so beside C or D it names one key twice on one platform")
  }

  let key
  if (Array.from(name).length === 1) key = name
  else if (NAMED[name.toLowerCase()] !== undefined || FKEY.test(name)) key = namedKey(name)
  else refuse(fn, input, `'<${inner}>' names no key; a named key is one of ${Object.values(SPELLED).join(', ')}, F1–F24, lt or gt`)

  const others = flags.mod || flags.ctrl || flags.alt || flags.meta
  if (isChar(key)) {
    if (!others && !flags.shift && Array.from(name).length === 1) {
      refuse(fn, input, `'<${inner}>' has no modifier; a lone key is written bare, '${name}'`)
    }
    if (flags.shift && !others) {
      refuse(fn, input, isLetter(key)
        ? `Shift on a letter is its capital; write '${key.toUpperCase()}'`
        : `what Shift types on '${key}' depends on the keyboard layout; write the character it types`)
    }
    if (flags.shift && !isLetter(key)) {
      refuse(fn, input, `what Shift types on '${key}' depends on the keyboard layout; write the character it types`)
    }
    if (others && isLetter(key) && key !== key.toLowerCase()) {
      refuse(fn, input, `beside a modifier a letter is lowercase; write '<${inner.slice(0, -1)}${key.toLowerCase()}>', and Shift as 'S-'`)
    }
  }
  return chord(key, flags)
}

function chord(key, flags) {
  const c = { key }
  for (const [flag] of MODIFIERS) if (flags[flag]) c[flag] = true
  return c
}

/**
 * A chord in vim's spelling, the inverse of `parseChord`. A chord as a host
 * reads it from an event — `{ key: 'K', ctrl: true }` for Ctrl+Shift+K — is
 * written canonically, so two chords are the same key when this agrees.
 */
export function formatChord(c) {
  if (!c || typeof c.key !== 'string' || c.key === '') refuse('formatChord', c, 'a chord is { key, mod?, ctrl?, alt?, meta?, shift? }')
  return spell(c) ?? refuse('formatChord', c, `'${c.key}' is no key vim's spelling names`)
}

/**
 * The chord a `KeyboardEvent` reports — `e.key` and the four modifier flags,
 * never `e.code`, which a terminal fills with its own name for the key
 * (`FJS-3407`). Mesa's `keys()` reads a keydown with it and sierra's terminal
 * shell a keypress the runtime has not yet made one of.
 */
export function chordOf(e) {
  if (!e || typeof e.key !== 'string') refuse('chordOf', e, 'an event is { key, ctrlKey?, altKey?, metaKey?, shiftKey? }')
  return {
    key: e.key,
    ...(e.ctrlKey && { ctrl: true }),
    ...(e.altKey && { alt: true }),
    ...(e.metaKey && { meta: true }),
    ...(e.shiftKey && { shift: true }),
  }
}

// A chord's one spelling, or null for a key vim's spelling has no name for.
function spell(c) {
  let { key } = c
  const flags = { ...c }
  const others = c.mod || c.ctrl || c.alt || c.meta

  if (isChar(key)) {
    if (isLetter(key) && others) {
      if (key !== key.toLowerCase()) flags.shift = true
      key = key.toLowerCase()
    } else {
      if (isLetter(key) && c.shift) key = key.toUpperCase()
      flags.shift = false
    }
  } else if (!SPELLED[key] && !FKEY.test(key)) {
    return null
  }

  const prefix = MODIFIERS.filter(([flag]) => flags[flag]).map(([, p]) => p + '-').join('')
  if (isChar(key)) {
    if (!prefix) return key === '<' ? '<lt>' : key
    return `<${prefix}${key === '<' ? 'lt' : key === '>' ? 'gt' : key}>`
  }
  return `<${prefix}${SPELLED[key] ?? key}>`
}

/**
 * A table of bindings, built once: `{ gg: 'top', '<Mod-k>': 'palette',
 * f: { await: 'find' } }`. An action is a name or a function; `{ await }` is
 * an await-char, whose next printable key is its argument.
 *
 * The result holds one trie per platform, because `<Mod-k>` is `<D-k>` on a
 * Mac and `<C-k>` elsewhere and this kit may not ask which it is running on.
 * A trie is `{ exact, prefixes }`, both keyed by the sequence as `formatChord`
 * writes it with Mod resolved, so a lookup is string equality.
 *
 * Refused by name, since each binds a key that never fires: a key Mod also
 * names on one platform, a key after an await-char's own, and `<Esc>` after
 * the first chord, since Esc clears what is pending.
 */
export function keymap(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    refuse('keymap', table, "a table is { keys: action }, as in { gg: 'top' }")
  }
  const rows = Object.entries(table).map(([keys, value]) => {
    const seq = parseKeys(keys)
    if (seq.slice(1).some(isEsc)) refuse('keymap', keys, '<Esc> clears a pending sequence, so a binding with it after the first key never fires')
    return { keys, seq, ...bindingOf(keys, value) }
  })
  return Object.freeze({ mac: trie(rows, true), other: trie(rows, false) })
}

const isEsc = (c) => c.key === 'Escape' && !c.mod && !c.ctrl && !c.alt && !c.meta && !c.shift

function bindingOf(keys, value) {
  const isAction = (v) => typeof v === 'function' || (typeof v === 'string' && v !== '')
  if (isAction(value)) return { action: value }
  if (value && typeof value === 'object' && Object.keys(value).join() === 'await' && isAction(value.await)) {
    return { action: value.await, await: true }
  }
  return refuse('keymap', keys, "an action is a name or a function, or { await: action } for one that takes the next character")
}

function trie(rows, mac) {
  const exact = new Map()
  const prefixes = new Map()
  for (const row of rows) {
    const steps = row.seq.map((c) => formatChord(resolveMod(c, mac)))
    const seq = steps.join('')
    const other = exact.get(seq)
    if (other) {
      refuse('keymap', row.keys, `'${other.keys}' is the same key ${mac ? 'on a Mac' : 'off a Mac'}, so one of them never fires`)
    }
    exact.set(seq, Object.freeze({ keys: row.keys, action: row.action, ...(row.await && { await: true }) }))
    for (let i = 1; i < steps.length; i++) {
      const prefix = steps.slice(0, i).join('')
      if (!prefixes.has(prefix)) prefixes.set(prefix, row.keys)
    }
  }
  for (const [seq, b] of exact) {
    if (b.await && prefixes.has(seq)) {
      const under = prefixes.get(seq)
      refuse('keymap', under, `'${b.keys}' waits for a character, so the key after it is that argument and '${under}' never fires`)
    }
  }
  return Object.freeze({ exact, prefixes: new Set(prefixes.keys()) })
}

function resolveMod(c, mac) {
  if (!c.mod) return c
  const { mod, ...rest } = c
  return { ...rest, [mac ? 'meta' : 'ctrl']: true }
}

/**
 * `table` with `changes` laid over it, as khat's `with_overrides`:
 * `{ table, warnings }`, the table ready for `keymap`. A change rebinds a key
 * or adds one, and `'nop'` unbinds it, a prefix with it, so `{ dd: 'nop' }`
 * leaves `d` free to fire. A key is matched by its spelling, which is one per
 * chord, so `<C-r>` over `<C-r>` replaces it and `<Mod-r>` is a key of its own.
 *
 * A change that cannot apply is skipped with a warning and never throws,
 * since what it costs is one key that does not fire: a spelling the grammar
 * refuses, an action `actions` does not list, where one is given (a function
 * is always an action), and a row the table could not build with — a
 * duplicate across Mod, a key under an await-char. The table it answers
 * always builds. The host decides how a warning reaches a person.
 */
export function withOverrides(table, changes, { actions } = {}) {
  for (const [name, t] of [['table', table], ['changes', changes ?? {}]]) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) refuse('withOverrides', t, `the ${name} is { keys: action }`)
  }
  const known = actions && new Set(actions)
  const out = { ...table }
  const warnings = []
  for (const [keys, action] of Object.entries(changes ?? {})) {
    try { parseKeys(keys) } catch (e) { warnings.push(e.message); continue }
    if (action === 'nop') { delete out[keys]; continue }
    if (known && typeof action === 'string' && !known.has(action)) {
      warnings.push(`withOverrides(${JSON.stringify(keys)}): '${action}' is no action here; it knows ${[...known].join(', ')}`)
      continue
    }
    const had = Object.hasOwn(out, keys)
    const was = out[keys]
    out[keys] = action
    try { keymap(out) } catch (e) {
      if (had) out[keys] = was
      else delete out[keys]
      warnings.push(e.message)
    }
  }
  return { table: Object.freeze(out), warnings }
}

// ─── What a page never sees ──────────────────────────────────────────────

// The chords a browser or the OS takes before a page's keydown, so
// `preventDefault` cannot keep them: read from Chromium's
// `kReservedCommandIds` (browser_command_controller.cc), Firefox's
// `reserved="true"` keys and tab switching (browser-sets.inc.xhtml,
// ShortcutUtils.sys.mjs), and the fixed defaults of macOS, Windows and GNOME.
// A key a browser uses but lets a page cancel (Ctrl+S, Ctrl+P, Ctrl+K) is not
// here; a row only one browser takes is, since it is dead for that browser's
// users. An app window or a fullscreen Keyboard Lock gets most of these back,
// and nothing here asks which it is.
const BROWSER_OWNS = {
  mac: {
    '<D-w>': 'closes the tab in every browser', '<D-S-w>': 'closes the window in Chrome and Firefox',
    '<D-t>': 'opens a tab in every browser', '<D-S-t>': 'reopens a closed tab in Chrome',
    '<D-n>': 'opens a window in every browser', '<D-S-n>': 'opens an incognito window in Chrome',
    '<D-S-p>': 'opens a private window in Firefox', '<D-q>': 'quits every browser',
    '<C-Tab>': 'switches tabs in every browser', '<C-S-Tab>': 'switches tabs in every browser',
    '<C-PageUp>': 'switches tabs in Chrome', '<C-PageDown>': 'switches tabs in Chrome',
    '<A-D-Left>': 'switches tabs in Chrome and Firefox', '<A-D-Right>': 'switches tabs in Chrome and Firefox',
    '<A-D-Up>': 'switches tabs in Firefox', '<A-D-Down>': 'switches tabs in Firefox',
    '<D-Tab>': 'switches apps in macOS', '<D-S-Tab>': 'switches apps in macOS',
    '<D-Space>': 'opens Spotlight in macOS', '<A-D-Esc>': 'opens Force Quit in macOS',
    '<C-D-q>': 'locks the screen in macOS', '<D-S-q>': 'logs out of macOS',
    '<A-D-d>': 'hides the Dock in macOS',
    '<C-Up>': 'opens Mission Control in macOS', '<C-Down>': 'shows the app\'s windows in macOS',
  },
  other: {
    '<C-w>': 'closes the tab in Chrome and Firefox', '<C-F4>': 'closes the tab in Chrome and Firefox',
    '<C-S-w>': 'closes the window in Chrome and Firefox',
    '<C-t>': 'opens a tab in Chrome and Firefox', '<C-S-t>': 'reopens a closed tab in Chrome',
    '<C-n>': 'opens a window in Chrome and Firefox', '<C-S-n>': 'opens an incognito window in Chrome',
    '<C-S-p>': 'opens a private window in Firefox',
    '<C-q>': 'quits Firefox on Linux', '<C-S-q>': 'quits Firefox on Windows',
    '<C-Tab>': 'switches tabs in Chrome and Firefox', '<C-S-Tab>': 'switches tabs in Chrome and Firefox',
    '<C-PageUp>': 'switches tabs in Chrome and Firefox', '<C-PageDown>': 'switches tabs in Chrome and Firefox',
    '<C-S-PageUp>': 'moves the tab in Firefox', '<C-S-PageDown>': 'moves the tab in Firefox',
    '<A-F4>': 'closes the window in Windows and GNOME',
    '<A-Tab>': 'switches windows in Windows and GNOME', '<A-S-Tab>': 'switches windows in Windows and GNOME',
    '<A-Esc>': 'cycles windows in Windows and GNOME', '<A-Space>': 'opens the window menu in Windows and GNOME',
    '<C-Esc>': 'opens the Start menu in Windows', '<C-S-Esc>': 'opens Task Manager in Windows',
    '<C-A-Del>': 'is the secure attention sequence in Windows and GNOME',
    '<C-A-Tab>': 'switches windows in Windows and GNOME', '<C-A-Esc>': 'switches system controls in GNOME',
    '<A-`>': 'switches an app\'s windows in GNOME', '<A-F2>': 'opens the run prompt in GNOME',
    '<A-F5>': 'restores the window in GNOME', '<A-F6>': 'switches an app\'s windows in GNOME',
    '<A-F7>': 'moves the window in GNOME', '<A-F8>': 'resizes the window in GNOME',
    '<A-F10>': 'maximizes the window in GNOME',
    '<C-A-Up>': 'switches workspaces in GNOME', '<C-A-Down>': 'switches workspaces in GNOME',
    '<C-A-Left>': 'switches workspaces in GNOME', '<C-A-Right>': 'switches workspaces in GNOME',
    '<C-A-S-Up>': 'moves the window to a workspace in GNOME', '<C-A-S-Down>': 'moves the window to a workspace in GNOME',
    '<C-A-S-Left>': 'moves the window to a workspace in GNOME', '<C-A-S-Right>': 'moves the window to a workspace in GNOME',
  },
}

/**
 * The rows of a keymap a page in a browser tab never receives:
 * `[{ keys, chord, reason }]`, `keys` as the table wrote it and `chord` the
 * one a browser or the OS takes, with a sentence a refusal can end on. Both
 * platforms are read whichever this is, as `keymap` builds both, so a table
 * answers the same on every machine: `<Mod-w>` is two rows, `<C-t>` one, and
 * a key with Cmd off a Mac is the Windows key, which Windows takes whole.
 * A sequence is listed when any of its chords is.
 */
export function browserOwned(km) {
  if (!km?.mac?.exact || !km?.other?.exact) refuse('browserOwned', km, 'a keymap(table) result is required')
  const rows = []
  for (const mac of [true, false]) {
    const owns = mac ? OWNED.mac : OWNED.other
    for (const b of (mac ? km.mac : km.other).exact.values()) {
      for (const c of parseKeys(b.keys).map((c) => resolveMod(c, mac))) {
        const chord = formatChord(c)
        const why = owns.get(chord) ?? (!mac && c.meta ? 'holds the Windows key, which Windows takes whole' : null)
        if (!why) continue
        const where = mac ? 'on a Mac' : 'off a Mac'
        const what = chord === b.keys ? `${where} ${why}` : `presses ${chord} ${where}, which ${why}`
        rows.push({ keys: b.keys, chord, reason: `'${b.keys}' ${what} before a page sees it, so it never fires` })
        break
      }
    }
  }
  return rows
}

// Each row read through `parseChord`, so one written in any spelling but the
// one an event is formatted in fails at import rather than matching nothing.
const OWNED = {
  mac: new Map(Object.entries(BROWSER_OWNS.mac).map(([k, why]) => [formatChord(parseChord(k)), why])),
  other: new Map(Object.entries(BROWSER_OWNS.other).map(([k, why]) => [formatChord(parseChord(k)), why])),
}

// vim's `timeoutlen`: how long an exact binding that is also a prefix waits
// for the key that would continue it (`FJS-D1385`).
const TIMEOUT = 720

/**
 * One key press read against the active keymaps: `step(state, chord,
 * context, now)` → `{ state, outcome }`. `state` is `null` when nothing is
 * pending, and is otherwise only ever passed back in.
 *
 * `context` is what the host knows about where the press landed —
 * `{ active, mac, text }`: the keymaps in the order they answer, the first
 * with an exact or a prefix match winning; whether this is a Mac, which picks
 * the trie `<Mod-…>` was resolved into; whether a text control has focus.
 *
 * The outcome is one of:
 *   { action, arg? }   a binding fired; `arg` is an await-char's character
 *   { pending: 'g' }   the keys so far, for a status line
 *   { typed: 'x' }     a printable key in a text control, which is the control's
 *   null               nothing here took it
 *
 * In a text control only a chord with Ctrl, Alt or Cmd starts a lookup, and
 * every other key is the control's (`FJS-D1386`) — a host whose editable runs
 * its own keymap says `text: false`. A sequence a modified chord began takes
 * the next key wherever focus is, since the first key already chose it.
 *
 * An exact binding that is also a prefix leaves `state.due` set: the host
 * calls `flush` then, and it fires unless a key came first. A key the
 * spelling has no name for — a lone Shift, a dead key — leaves the state as
 * it was, so `gG` and `fG` survive the Shift pressed between them.
 */
export function step(state, chord, context, now) {
  const tries = triesOf('step', context)
  if (!chord || typeof chord.key !== 'string') refuse('step', chord, 'a chord is { key, ctrl?, alt?, meta?, shift? } as the event reports it')
  const c = resolveMod(chord, context.mac)
  const name = spell(c)
  if (name === null) return { state, outcome: null }
  const typed = isPrintable(c) ? c.key : null

  if (state?.awaiting) {
    return { state: null, outcome: typed === null ? null : { action: state.awaiting.action, arg: typed } }
  }
  if (isEsc(c)) state = null
  if (context.text && !state && !isModified(c)) {
    return { state: null, outcome: typed === null ? null : { typed } }
  }

  const keys = (state?.keys ?? '') + name
  const found = lookup(tries, keys)
  if (!found) return { state: null, outcome: null }
  if (found.prefix) {
    const next = { keys, ...(found.exact && { due: now + TIMEOUT }) }
    return { state: Object.freeze(next), outcome: { pending: keys } }
  }
  if (found.exact.await) {
    return { state: Object.freeze({ keys, awaiting: found.exact }), outcome: { pending: keys } }
  }
  return { state: null, outcome: { action: found.exact.action } }
}

/**
 * The ambiguity settled: once `now` reaches `state.due`, the exact binding the
 * pending keys spell fires, read against the keymaps active now. Before it,
 * or with nothing ambiguous pending, the state comes back as it was.
 */
export function flush(state, context, now) {
  const tries = triesOf('flush', context)
  if (state?.due === undefined || now < state.due) return { state, outcome: null }
  const exact = lookup(tries, state.keys)?.exact
  return { state: null, outcome: exact && !exact.await ? { action: exact.action } : null }
}

/**
 * The bindings that can fire in `context` — the same `{ active, mac, text }`
 * `step` reads — as `[{ keys, action, await? }]`, for a help screen and a
 * hint bar. `keys` is the table's own spelling, `<Mod-k>` included.
 *
 * Rows come in the order they answer: the active keymaps first to last, each
 * in the order its table was written, so a hint showing the first row for an
 * action shows the key its author put first.
 *
 * A row that cannot fire here is left out, since help listing it is a key
 * that does nothing: one an earlier keymap binds or begins, one under an
 * earlier keymap's exact binding that is not also a prefix, and in a text
 * control one whose first chord has no Ctrl, Alt or Cmd.
 */
export function bindings(context) {
  const tries = triesOf('bindings', context)
  const rows = []
  for (const t of tries) {
    for (const [seq, b] of t.exact) {
      const steps = parseKeys(b.keys).map((c) => resolveMod(c, context.mac))
      if (context.text && !isModified(steps[0])) continue
      const names = steps.map(spell)
      const continues = names.slice(1).every((_, i) => lookup(tries, names.slice(0, i + 1).join('')).prefix)
      if (continues && lookup(tries, seq).exact === b) rows.push(b)
    }
  }
  return rows
}

function triesOf(fn, context) {
  if (!context || typeof context !== 'object') refuse(fn, context, 'a context is { active, mac, text }')
  const { active, mac, text } = context
  if (!Array.isArray(active) || !active.every((km) => km?.mac?.exact && km?.other?.exact)) {
    refuse(fn, active, 'active is a list of keymap(table) results, the first to answer first')
  }
  // Left out, either one is a binding that silently never fires or fires
  // while someone types, so neither has a default.
  if (typeof mac !== 'boolean') refuse(fn, mac, "context.mac is required: '<Mod-k>' is a different key on a Mac")
  if (typeof text !== 'boolean') refuse(fn, text, 'context.text is required: in a text control a letter types instead of firing')
  return active.map((km) => (mac ? km.mac : km.other))
}

// The first trie with an exact or a prefix match on `keys`, as khat reads its
// layers: `{ exact?, prefix }`, or null when none has either.
function lookup(tries, keys) {
  for (const t of tries) {
    const exact = t.exact.get(keys)
    const prefix = t.prefixes.has(keys)
    if (exact || prefix) return { exact, prefix }
  }
  return null
}

const isModified = (c) => !!(c.ctrl || c.alt || c.meta)
const isPrintable = (c) => !isModified(c) && Array.from(c.key).length === 1
