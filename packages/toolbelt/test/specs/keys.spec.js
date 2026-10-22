/*
 * keys.spec.js
 *
 * The engine's case list is khat's `keymap.rs` tests (`IDEAS/keys.md` § Every
 * key site, counted); each row here names the one it ports. The chord grammar
 * is vim's (`FJS-D1383`), so every refusal is a string that would otherwise
 * parse as letters and bind a key nobody meant.
 */

import { parseChord, parseKeys, formatChord, chordOf, keymap, step, flush, bindings, browserOwned } from '../../src/keys/keys.js'

const ctx = (active, over = {}) => ({ active, mac: false, text: false, ...over })

// Each chord of `keys` stepped in turn at `now`; the outcomes, and the state left.
function run(context, keys, now = 0, state = null) {
  const outcomes = []
  for (const chord of parseKeys(keys)) {
    const r = step(state, chord, context, now)
    state = r.state
    outcomes.push(r.outcome)
  }
  return { outcomes, state }
}

test('keys: parse_basic — a sequence is one chord per key, a bracket is one chord', function () {
  assert.deepEqual(parseKeys('gg'), [{ key: 'g' }, { key: 'g' }])
  assert.deepEqual(parseKeys(']u'), [{ key: ']' }, { key: 'u' }])
  assert.deepEqual(parseChord('<C-d>'), { key: 'd', ctrl: true })
  assert.deepEqual(parseChord('<S-Tab>'), { key: 'Tab', shift: true })
  assert.deepEqual(parseChord('<Esc>'), { key: 'Escape' })
  assert.deepEqual(parseChord('<CR>'), { key: 'Enter' })
  assert.deepEqual(parseChord('<Space>'), { key: ' ' })
  assert.deepEqual(parseChord('G'), { key: 'G' })
  assert.deepEqual(parseChord('<A-CR>'), { key: 'Enter', alt: true })
  assert.deepEqual(parseChord('<F5>'), { key: 'F5' })
  assert.equal(parseKeys('a<C-x>b').length, 3)
})

test('keys: a key is the DOM key name, so a host compares e.key and nothing else', function () {
  const names = ['<Up>', '<Down>', '<Left>', '<Right>', '<BS>', '<Del>', '<Home>', '<End>', '<PageUp>', '<PageDown>', '<Insert>']
  assert.deepEqual(names.map((s) => parseChord(s).key),
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'])
})

test('keys: one spelling per chord — vim\'s aliases and case folding are refused naming it', function () {
  assert.throws(() => parseChord('<cr>'), /'<cr>' is written '<CR>'/)
  assert.throws(() => parseChord('<Enter>'), /'<Enter>' is written '<CR>'/)
  assert.throws(() => parseChord('<Return>'), /is written '<CR>'/)
  assert.throws(() => parseChord('<c-d>'), /is written '<C-d>'/)
  assert.throws(() => parseChord('<S-C-k>'), /is written '<C-S-k>'/)
  assert.throws(() => parseChord('<f5>'), /is written '<F5>'/)
  assert.throws(() => parseKeys('a<b'), /'<' is written '<lt>'/)
  assert.throws(() => parseChord('<C->>'), /is written '<C-gt>'/)
})

test('keys: <Mod-k> is the platform modifier, and <C-k> <A-k> <D-k> stay literal', function () {
  assert.deepEqual(parseChord('<Mod-k>'), { key: 'k', mod: true })
  assert.deepEqual(parseChord('<D-k>'), { key: 'k', meta: true })
  assert.deepEqual(parseChord('<Mod-A-S-p>'), { key: 'p', mod: true, alt: true, shift: true })
  // Off a Mac, Mod IS Ctrl; beside C it would name Ctrl twice.
  assert.throws(() => parseChord('<Mod-C-k>'), /names one key twice/)
  assert.throws(() => parseChord('<Mod-D-k>'), /names one key twice/)
})

test('keys: Shift on a printable key is the character it types', function () {
  // e.key for Shift+g is 'G', so 'G' is the chord and '<S-g>' a second spelling.
  assert.throws(() => parseChord('<S-g>'), /write 'G'/)
  // Shift+1 types '!' on one layout and something else on another.
  assert.throws(() => parseChord('<S-1>'), /depends on the keyboard layout/)
  assert.throws(() => parseChord('<C-S-1>'), /depends on the keyboard layout/)
  // Beside Ctrl a letter is lowercase and Shift explicit: vim reads <C-K> as
  // <C-k> and the DOM as the shifted one, so it is neither.
  assert.throws(() => parseChord('<C-K>'), /write '<C-k>', and Shift as 'S-'/)
  assert.deepEqual(parseChord('<C-S-k>'), { key: 'k', ctrl: true, shift: true })
  // Space is a named key, so Shift on it is kept.
  assert.deepEqual(parseChord('<S-Space>'), { key: ' ', shift: true })
})

test('keys: < is <lt> and > beside a modifier is <gt>, as a bracket would otherwise close', function () {
  assert.deepEqual(parseChord('<lt>'), { key: '<' })
  assert.deepEqual(parseChord('>'), { key: '>' })
  assert.deepEqual(parseChord('<C-gt>'), { key: '>', ctrl: true })
  assert.deepEqual(parseChord('<C-->'), { key: '-', ctrl: true })
  assert.deepEqual(parseChord('-'), { key: '-' })
})

test('keys: parse_dashed_forms — the web\'s spelling is refused by name, not read as letters', function () {
  for (const s of ['mod+k', 'Mod+K', 'ctrl-j', 'alt-enter', 'shift-tab', 'Shift+Enter', 'cmd+s']) {
    assert.throws(() => parseKeys(s), /the web's spelling.*FJS-D1383/, s)
  }
})

test('keys: a space or a bare key name is refused, since either reads as letters', function () {
  assert.throws(() => parseKeys('g g'), /'gg' is the sequence and '<Space>' the key/)
  assert.throws(() => parseKeys(' '), /<Space>/)
  assert.throws(() => parseKeys('Escape'), /6 keys.*'<Esc>'/)
  assert.throws(() => parseKeys('Enter'), /'<CR>'/)
  assert.throws(() => parseKeys('ArrowUp'), /'<Up>'/)
  assert.throws(() => parseKeys('f5'), /'<F5>'/)
})

test('keys: parse_errors — each refusal names what it read', function () {
  assert.throws(() => parseKeys(''), /a key string is required/)
  assert.throws(() => parseKeys(null), /a key string is required/)
  assert.throws(() => parseKeys('<Bogus>'), /'<Bogus>' names no key/)
  assert.throws(() => parseKeys('<F99>'), /'<F99>' names no key/)
  assert.throws(() => parseKeys('<x>'), /a lone key is written bare, 'x'/)
  assert.throws(() => parseKeys('<X-k>'), /'X-' is no modifier/)
  assert.throws(() => parseKeys('<C-C-k>'), /'C-' is written twice/)
  assert.throws(() => parseKeys('<M-k>'), /Alt in vim and Cmd on a Mac/)
  assert.throws(() => parseChord('gg'), /2 keys; parseKeys reads a sequence/)
})

test('keys: display_roundtrip — formatChord is the inverse of parseChord', function () {
  const seqs = ['gg', '<C-d>', '<Space>', '<Esc>', '<CR>', '<S-Tab>', ']u', '<A-CR>', '<lt>', 'G',
    '<Mod-k>', '<C-S-k>', '<C-gt>', '<C-->', '<D-F12>', '<S-Space>', '<Mod-A-S-p>', '<C-lt>']
  for (const s of seqs) {
    const seq = parseKeys(s)
    assert.equal(seq.map(formatChord).join(''), s, s)
    assert.deepEqual(parseKeys(seq.map(formatChord).join('')), seq, s)
  }
})

test('keys: formatChord writes a chord as an event reports it in the one canonical spelling', function () {
  // Ctrl+Shift+K reports e.key 'K'; Shift+G reports 'G' with shiftKey set.
  assert.equal(formatChord({ key: 'K', ctrl: true }), '<C-S-k>')
  assert.equal(formatChord({ key: 'G', shift: true }), 'G')
  assert.equal(formatChord({ key: '?', shift: true }), '?')
  assert.equal(formatChord({ key: 'Enter', shift: true }), '<S-CR>')
  assert.throws(() => formatChord({ key: 'Dead' }), /'Dead' is no key/)
  assert.throws(() => formatChord({}), /a chord is/)
})

test('keys: event_normalization — chordOf reads e.key and the four flags, never e.code', function () {
  // A terminal's keydown carries its own name in `code`; a browser's 'KeyJ'.
  assert.deepEqual(chordOf({ key: 'j', code: 'KeyJ' }), { key: 'j' })
  assert.deepEqual(chordOf({ key: 'K', code: 'k', ctrlKey: true, shiftKey: true, altKey: false }), { key: 'K', ctrl: true, shift: true })
  assert.equal(formatChord(chordOf({ key: 'w', metaKey: true, altKey: true })), '<A-D-w>')
  assert.throws(() => chordOf({ code: 'KeyJ' }), /an event is/)
})

test('keys: keymap — a binding is exact, and every strict prefix of one is pending', function () {
  const km = keymap({ gg: 'top', g: 'go', ']u': 'unread', '<C-w>j': 'down', G: 'bottom' })
  for (const t of [km.mac, km.other]) {
    assert.deepEqual([...t.exact.keys()].sort(), ['<C-w>j', 'G', ']u', 'g', 'gg'])
    assert.deepEqual([...t.prefixes].sort(), ['<C-w>', ']', 'g'])
    assert.deepEqual(t.exact.get('gg'), { keys: 'gg', action: 'top' })
  }
  // An empty table is a keymap: nothing is bound, so every key is unhandled.
  assert.equal(keymap({}).other.exact.size, 0)
})

test('keys: keymap — <Mod-k> is <D-k> on a Mac and <C-k> elsewhere, so each trie is keyed by the key pressed', function () {
  const km = keymap({ '<Mod-k>': 'palette', '<Mod-S-p>g': 'go' })
  assert.deepEqual(km.mac.exact.get('<D-k>'), { keys: '<Mod-k>', action: 'palette' })
  assert.deepEqual(km.other.exact.get('<C-k>'), { keys: '<Mod-k>', action: 'palette' })
  assert.ok(km.mac.prefixes.has('<D-S-p>') && km.other.prefixes.has('<C-S-p>'))
})

test('keys: keymap — a key Mod also names on one platform is refused naming both', function () {
  assert.throws(() => keymap({ '<Mod-k>': 'palette', '<C-k>': 'kill' }), /keymap\("<C-k>"\): '<Mod-k>' is the same key off a Mac/)
  assert.throws(() => keymap({ '<Mod-k>': 'palette', '<D-k>': 'kill' }), /'<Mod-k>' is the same key on a Mac/)
  assert.throws(() => keymap({ '<Mod-w>j': 'a', '<C-w>j': 'b' }), /same key off a Mac/)
  // A collision as a prefix is the ordinary ambiguity the timeout settles.
  const both = keymap({ '<Mod-w>': 'close', '<C-w>j': 'down' }).other
  assert.ok(both.exact.has('<C-w>') && both.prefixes.has('<C-w>'))
})

test('keys: keymap — an await-char takes the next character, so a binding under it is refused', function () {
  const km = keymap({ f: { await: 'find' }, df: { await: 'deleteTo' }, r: 'reply' })
  assert.deepEqual(km.other.exact.get('f'), { keys: 'f', action: 'find', await: true })
  assert.throws(() => keymap({ f: { await: 'find' }, fx: 'x' }), /keymap\("fx"\): 'f' waits for a character.*'fx' never fires/)
  assert.throws(() => keymap({ d: { await: 'del' }, dd: 'line' }), /'dd' never fires/)
})

test('keys: keymap — <Esc> after the first key is refused, since Esc clears what is pending', function () {
  assert.throws(() => keymap({ 'g<Esc>': 'x' }), /<Esc> clears a pending sequence/)
  assert.equal(keymap({ '<Esc>': 'cancel', '<C-w><S-Esc>': 'y' }).other.exact.size, 2)
})

test('keys: keymap — a table and each action are refused by name', function () {
  const fn = () => {}
  assert.equal(keymap({ x: fn }).other.exact.get('x').action, fn)
  assert.throws(() => keymap(null), /a table is \{ keys: action \}/)
  assert.throws(() => keymap([['gg', 'top']]), /a table is/)
  assert.throws(() => keymap({ gg: '' }), /keymap\("gg"\): an action is a name or a function/)
  assert.throws(() => keymap({ gg: 1 }), /an action is/)
  assert.throws(() => keymap({ f: { await: 'find', extra: 1 } }), /an action is/)
  assert.throws(() => keymap({ 'g g': 'top' }), /parseKeys\("g g"\)/)
})

test('keys: browserOwned — a chord a browser takes before the page is listed per platform, naming who takes it', function () {
  const owned = (table) => browserOwned(keymap(table)).map((r) => `${r.keys} ${r.chord}`)
  assert.deepEqual(owned({ '<Mod-w>': 'close' }), ['<Mod-w> <D-w>', '<Mod-w> <C-w>'])
  assert.deepEqual(owned({ '<C-t>': 'tab', '<C-Tab>': 'next' }), ['<C-Tab> <C-Tab>', '<C-t> <C-t>', '<C-Tab> <C-Tab>'])
  const [mod] = browserOwned(keymap({ '<Mod-n>': 'new' }))
  assert.equal(mod.reason, "'<Mod-n>' presses <D-n> on a Mac, which opens a window in every browser before a page sees it, so it never fires")
  assert.match(browserOwned(keymap({ '<C-S-t>': 'reopen' }))[0].reason, /^'<C-S-t>' off a Mac reopens a closed tab in Chrome before/)
})

test('keys: browserOwned — a key a browser uses but lets a page cancel is not listed', function () {
  const cancelable = { '<Mod-k>': 'palette', '<Mod-s>': 'save', '<Mod-p>': 'print', '<Mod-f>': 'find', '<Mod-l>': 'go', '<Mod-1>': 'one', '<Mod-r>': 'reload' }
  assert.deepEqual(browserOwned(keymap(cancelable)), [])
  assert.deepEqual(browserOwned(keymap({ gg: 'top', '<Esc>': 'close', '<C-w>': 'x' })).map((r) => r.chord), ['<C-w>'], '<C-w> on a Mac is Ctrl, which a page receives')
})

test('keys: browserOwned — a sequence is listed by the chord in it, and Cmd off a Mac is the Windows key', function () {
  assert.deepEqual(browserOwned(keymap({ 'g<C-PageUp>': 'prev' })).map((r) => r.chord), ['<C-PageUp>', '<C-PageUp>'])
  const [win] = browserOwned(keymap({ '<D-j>': 'jump' }))
  assert.equal(win.reason, "'<D-j>' off a Mac holds the Windows key, which Windows takes whole before a page sees it, so it never fires")
  assert.throws(() => browserOwned({ gg: 'top' }), /browserOwned\(.*\): a keymap\(table\) result is required/)
})

test('keys: pending_sequences — a prefix is pending, the sequence fires, and a miss starts over', function () {
  const c = ctx([keymap({ gg: 'top', dd: 'delete', ']u': 'unread', j: 'down' })])
  assert.deepEqual(run(c, 'gg').outcomes, [{ pending: 'g' }, { action: 'top' }])
  assert.deepEqual(run(c, ']u').outcomes, [{ pending: ']' }, { action: 'unread' }])
  // The key that missed is spent, not retried; the next one is read fresh.
  assert.deepEqual(run(c, 'gqj').outcomes, [{ pending: 'g' }, null, { action: 'down' }])
  assert.deepEqual(run(c, 'g').state, { keys: 'g' })
  assert.equal(run(c, 'gg').state, null)
  assert.deepEqual(run(c, 'x').outcomes, [null])
})

test('keys: esc_resets_pending — Esc clears what is pending, then is read as itself', function () {
  const c = ctx([keymap({ gg: 'top', '<Esc>': 'cancel', j: 'down' })])
  assert.deepEqual(run(c, 'g<Esc>j').outcomes, [{ pending: 'g' }, { action: 'cancel' }, { action: 'down' }])
  const bare = ctx([keymap({ gg: 'top', j: 'down' })])
  assert.deepEqual(run(bare, 'g<Esc>'), { outcomes: [{ pending: 'g' }, null], state: null })
})

test('keys: layer_precedence — the first active keymap with an exact or a prefix match answers', function () {
  const scene = keymap({ a: 'answer', g: 'go' })
  const shell = keymap({ a: 'append', gg: 'top', j: 'down' })
  // FJS-3279: the scene's `a` before the shell's is an ordering, not a fix.
  assert.deepEqual(run(ctx([scene, shell]), 'a').outcomes, [{ action: 'answer' }])
  assert.deepEqual(run(ctx([shell, scene]), 'a').outcomes, [{ action: 'append' }])
  // The scene's exact `g` answers, so the shell's `gg` is not reached from it.
  assert.deepEqual(run(ctx([scene, shell]), 'gg').outcomes, [{ action: 'go' }, { action: 'go' }])
  assert.deepEqual(run(ctx([scene, shell]), 'j').outcomes, [{ action: 'down' }])
  assert.deepEqual(run(ctx([]), 'j').outcomes, [null])
})

test('keys: <Mod-k> answers Cmd on a Mac and Ctrl elsewhere, as context.mac says', function () {
  const km = keymap({ '<Mod-k>': 'palette' })
  const cmd = { key: 'k', meta: true }
  const ctrl = { key: 'k', ctrl: true }
  assert.deepEqual(step(null, cmd, ctx([km], { mac: true }), 0).outcome, { action: 'palette' })
  assert.equal(step(null, ctrl, ctx([km], { mac: true }), 0).outcome, null)
  assert.deepEqual(step(null, ctrl, ctx([km]), 0).outcome, { action: 'palette' })
  assert.equal(step(null, cmd, ctx([km]), 0).outcome, null)
})

test('keys: a chord as the event reports it is read in its one spelling', function () {
  const c = ctx([keymap({ G: 'bottom', '<C-S-k>': 'up', '<S-CR>': 'newline', '?': 'help' })])
  // A host passes the event's flags as they are, false included.
  const ev = (key, flags = {}) => ({ key, ctrl: false, alt: false, meta: false, shift: false, ...flags })
  assert.deepEqual(step(null, ev('G', { shift: true }), c, 0).outcome, { action: 'bottom' })
  assert.deepEqual(step(null, ev('K', { ctrl: true, shift: true }), c, 0).outcome, { action: 'up' })
  assert.deepEqual(step(null, ev('Enter', { shift: true }), c, 0).outcome, { action: 'newline' })
  assert.deepEqual(step(null, ev('?', { shift: true }), c, 0).outcome, { action: 'help' })
})

test('keys: a key the spelling cannot name leaves the state as it was', function () {
  const c = ctx([keymap({ gG: 'x', f: { await: 'find' } })])
  let { state } = run(c, 'g')
  for (const key of ['Shift', 'Control', 'Meta', 'Alt', 'CapsLock', 'Dead', 'Unidentified', 'AudioVolumeUp']) {
    const r = step(state, { key }, c, 0)
    assert.equal(r.state, state, key)
    assert.equal(r.outcome, null, key)
  }
  assert.deepEqual(step(state, { key: 'G', shift: true }, c, 0).outcome, { action: 'x' })
  state = run(c, 'f').state
  state = step(state, { key: 'Shift', shift: true }, c, 0).state
  assert.deepEqual(step(state, { key: 'G', shift: true }, c, 0).outcome, { action: 'find', arg: 'G' })
})

test('keys: timeout_ambiguity — an exact that is also a prefix fires at state.due, unless a key comes first', function () {
  const c = ctx([keymap({ g: 'yank', gg: 'top', d: { await: 'del' }, ']u': 'unread' })])
  const { state } = run(c, 'g', 1000)
  assert.deepEqual(state, { keys: 'g', due: 1720 })
  assert.deepEqual(flush(state, c, 1719), { state, outcome: null })
  assert.deepEqual(flush(state, c, 1720), { state: null, outcome: { action: 'yank' } })
  // Typed quickly, the sequence wins.
  assert.deepEqual(run(c, 'gg', 1000).outcomes, [{ pending: 'g' }, { action: 'top' }])
  // Nothing pending, nothing to flush.
  assert.deepEqual(flush(null, c, 9999), { state: null, outcome: null })
  // A prefix with no exact never fires on the clock, and neither does an await-char.
  for (const keys of [']', 'd']) {
    const s = run(c, keys, 0).state
    assert.equal(s.due, undefined, keys)
    assert.deepEqual(flush(s, c, 1e9), { state: s, outcome: null }, keys)
  }
  // Read against the keymaps active when it fires: one without `g` fires nothing.
  assert.deepEqual(flush(state, ctx([keymap({ gg: 'top' })]), 1720), { state: null, outcome: null })
})

test('keys: char_argument_pending_and_cancel — an await-char takes the next printable, anything else cancels', function () {
  const c = ctx([keymap({ f: { await: 'find' }, df: { await: 'deleteTo' }, l: 'right' })])
  assert.deepEqual(run(c, 'fa').outcomes, [{ pending: 'f' }, { action: 'find', arg: 'a' }])
  assert.deepEqual(run(c, 'f<Space>').outcomes[1], { action: 'find', arg: ' ' })
  assert.deepEqual(run(c, 'dfx').outcomes, [{ pending: 'd' }, { pending: 'df' }, { action: 'deleteTo', arg: 'x' }])
  assert.deepEqual(run(c, 'df').state, { keys: 'df', awaiting: { keys: 'df', action: 'deleteTo', await: true } })
  // Esc cancels and is not read as itself; a named key cancels too.
  assert.deepEqual(run(c, 'f<Esc>l'), { outcomes: [{ pending: 'f' }, null, { action: 'right' }], state: null })
  assert.deepEqual(run(c, 'f<Left>l').outcomes, [{ pending: 'f' }, null, { action: 'right' }])
  assert.deepEqual(run(c, 'f<C-a>').outcomes[1], null)
  // A digit is a character, so it is an argument like any other.
  // ('f5' itself is refused as a key string, since it reads as '<F5>'.)
  const { state } = run(c, 'f')
  assert.deepEqual(step(state, { key: '5' }, c, 0).outcome, { action: 'find', arg: '5' })
})

test('keys: digits_are_pane_jumps_not_counts — a digit is a key and accumulates nothing', function () {
  const panes = keymap({ 1: 'paneOne', 2: 'paneTwo', 3: 'paneThree', j: 'down', gg: 'top' })
  const input = keymap({ 0: 'lineStart', $: 'lineEnd' })
  for (const active of [[panes], [input, panes]]) {
    assert.deepEqual(run(ctx(active), '123').outcomes, [{ action: 'paneOne' }, { action: 'paneTwo' }, { action: 'paneThree' }])
  }
  // No count: `6j` is an unbound 6 then a plain move, `6gg` a plain jump, `10` a pane jump then nothing.
  assert.deepEqual(run(ctx([panes]), '6j'), { outcomes: [null, { action: 'down' }], state: null })
  assert.deepEqual(run(ctx([panes]), '6gg').outcomes, [null, { pending: 'g' }, { action: 'top' }])
  assert.deepEqual(run(ctx([panes]), '10'), { outcomes: [{ action: 'paneOne' }, null], state: null })
  // `0` is a binding where a keymap binds it and unbound elsewhere — never the tail of a count.
  assert.deepEqual(run(ctx([input, panes]), '0').outcomes, [{ action: 'lineStart' }])
  assert.deepEqual(run(ctx([panes]), '0').outcomes, [null])
  // A digit types in a text control.
  assert.deepEqual(run(ctx([input, panes], { text: true }), '40').outcomes, [{ typed: '4' }, { typed: '0' }])
})

test('keys: insert_char_fallback — in a text control a key without Ctrl, Alt or Cmd is the control\'s (FJS-D1386)', function () {
  const c = ctx([keymap({ j: 'down', gg: 'top', '<CR>': 'submit', '<C-k>': 'up', '<A-CR>': 'newline', '<C-w>j': 'paneDown' })], { text: true })
  // A bound letter types, as an unbound one does; a space and a digit are characters.
  assert.deepEqual(run(c, 'jg<Space>5G').outcomes, [{ typed: 'j' }, { typed: 'g' }, { typed: ' ' }, { typed: '5' }, { typed: 'G' }])
  // A named key with no modifier is the control's too, Shift beside it or not.
  assert.deepEqual(run(c, '<CR><S-CR><Esc><Up><S-Tab>').outcomes, [null, null, null, null, null])
  assert.deepEqual(run(c, '<C-k><A-CR>').outcomes, [{ action: 'up' }, { action: 'newline' }])
  // A sequence a modified chord began takes the next key wherever focus is.
  assert.deepEqual(run(c, '<C-w>j').outcomes, [{ pending: '<C-w>' }, { action: 'paneDown' }])
})

test('keys: empty_keymap_is_unhandled_but_types', function () {
  assert.deepEqual(run(ctx([keymap({})]), 'j').outcomes, [null])
  assert.deepEqual(run(ctx([keymap({})], { text: true }), 'j').outcomes, [{ typed: 'j' }])
})

test('keys: step and flush refuse a context that would bind silently wrong', function () {
  const km = keymap({ j: 'down' })
  const j = { key: 'j' }
  assert.throws(() => step(null, j, { active: [km], text: false }, 0), /context.mac is required/)
  assert.throws(() => step(null, j, { active: [km], mac: false }, 0), /context.text is required/)
  assert.throws(() => step(null, j, { active: [{ j: 'down' }], mac: false, text: false }, 0), /a list of keymap\(table\) results/)
  assert.throws(() => step(null, j, null, 0), /a context is/)
  assert.throws(() => flush(null, { active: km, mac: false, text: false }, 0), /flush.*a list of keymap/)
  assert.throws(() => step(null, 'j', ctx([km]), 0), /a chord is/)
})

test('keys: bindings_for_help — each row as the table wrote it, in the order the keymaps answer', function () {
  const shell = keymap({ j: 'down', '<Down>': 'down', gg: 'top', '<C-d>': 'halfDown', '<Mod-k>': 'palette', f: { await: 'find' } })
  const scene = keymap({ a: 'answer' })
  assert.deepEqual(bindings(ctx([scene, shell])), [
    { keys: 'a', action: 'answer' },
    { keys: 'j', action: 'down' },
    { keys: '<Down>', action: 'down' },
    { keys: 'gg', action: 'top' },
    { keys: '<C-d>', action: 'halfDown' },
    { keys: '<Mod-k>', action: 'palette' },
    { keys: 'f', action: 'find', await: true },
  ])
  // hint_keys_follow_bindings: a hint is the first row for its action, so the key written first.
  assert.equal(bindings(ctx([shell])).find((r) => r.action === 'down').keys, 'j')
  assert.deepEqual(bindings(ctx([keymap({})])), [])
  assert.deepEqual(bindings(ctx([])), [])
})

test('keys: bindings — a row is listed exactly when step fires it, across platforms and text', function () {
  const scene = keymap({ a: 'answer', g: 'go', '<C-k>': 'sceneUp', ']x': 'sceneX', d: 'sceneD' })
  const shell = keymap({
    a: 'append', gg: 'top', j: 'down', '<Mod-k>': 'palette', ']u': 'unread', f: { await: 'find' },
    '<Esc>': 'cancel', '<C-w>j': 'paneDown', dd: 'deleteLine', '<A-CR>': 'newline', y: 'yank', yy: 'yankLine',
  })
  // Stepped as a person would: an ambiguity left to its timeout, an await-char given a character.
  function fires(context, keys, action) {
    let { outcomes, state } = run(context, keys)
    let last = outcomes.at(-1)
    if (state?.due !== undefined) ({ state, outcome: last } = flush(state, context, state.due))
    if (state?.awaiting) last = step(state, { key: 'x' }, context, 0).outcome
    return last?.action === action
  }
  const rows = (km) => [...km.other.exact.values()]
  for (const mac of [false, true]) {
    for (const text of [false, true]) {
      const context = ctx([scene, shell], { mac, text })
      const listed = new Set(bindings(context).map((r) => r.keys + ' ' + r.action))
      for (const r of [...rows(scene), ...rows(shell)]) {
        const label = `${r.keys} → ${r.action}, mac ${mac}, text ${text}`
        assert.equal(listed.has(r.keys + ' ' + r.action), fires(context, r.keys, r.action), label)
      }
    }
  }
  // What that grid holds: the scene's `a`, `g` and `d` shadow the shell's, its `]` prefix does not,
  // and its <C-k> is the shell's <Mod-k> off a Mac only.
  const names = (c) => bindings(c).map((r) => r.keys)
  assert.deepEqual(names(ctx([scene, shell])),
    ['a', 'g', '<C-k>', ']x', 'd', 'j', ']u', 'f', '<Esc>', '<C-w>j', '<A-CR>', 'y', 'yy'])
  assert.deepEqual(names(ctx([scene, shell], { mac: true })),
    ['a', 'g', '<C-k>', ']x', 'd', 'j', '<Mod-k>', ']u', 'f', '<Esc>', '<C-w>j', '<A-CR>', 'y', 'yy'])
  // In a text control only a row whose first chord has Ctrl, Alt or Cmd fires.
  assert.deepEqual(names(ctx([scene, shell], { text: true })), ['<C-k>', '<C-w>j', '<A-CR>'])
})

test('keys: bindings refuses the context step refuses', function () {
  const km = keymap({ j: 'down' })
  assert.throws(() => bindings({ active: [km], text: false }), /bindings\(.*context.mac is required/)
  assert.throws(() => bindings({ active: [km], mac: false }), /context.text is required/)
  assert.throws(() => bindings(km), /a list of keymap\(table\) results/)
})
