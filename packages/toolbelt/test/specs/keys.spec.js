/*
 * keys.spec.js
 *
 * The engine's case list is khat's `keymap.rs` tests (`IDEAS/keys.md` § Every
 * key site, counted); each row here names the one it ports. The chord grammar
 * is vim's (`FJS-D1383`), so every refusal is a string that would otherwise
 * parse as letters and bind a key nobody meant.
 */

import { parseChord, parseKeys, formatChord, keymap } from '../../src/keys/keys.js'

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
