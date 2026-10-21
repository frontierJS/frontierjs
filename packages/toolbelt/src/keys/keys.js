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
    const c = bracket ? chordOf(bracket.slice(1, -1), s, fn) : { key: token }
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

function chordOf(inner, input, fn) {
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
    refuse('formatChord', c, `'${key}' is no key vim's spelling names`)
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
