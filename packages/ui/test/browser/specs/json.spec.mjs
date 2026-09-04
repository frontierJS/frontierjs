/*
 * json.spec.mjs — Json (the viewer) and JsonInput (the control).
 *
 * Both are new surface for a `Json` column, which until now had no control at
 * all and no renderer but `<pre>{JSON.stringify(…)}</pre>`. Two things here
 * cannot be seen anywhere else:
 *
 *   - the tree's colours come from @frontierjs/css's code theme, which keys off
 *     ELEMENTS inside `code[language]`. Nothing but a real browser can say
 *     whether that theme actually reached the tree, and a hand-written palette
 *     would look identical in the markup and wrong in ten of eleven themes.
 *   - the control holds TEXT and writes a DOCUMENT, so the assertion that
 *     matters is what happens between the two: a half-typed document must not
 *     be written, and must not be silently discarded either.
 */
export const name = 'Json · JsonInput'
export const covers = ['display/Json', 'forms/JsonInput']

const rows      = `[...document.querySelectorAll('#viewer .fjs-json-row')]`
const keyText   = `${rows}.map(r => (r.querySelector('.fjs-json-key b') || {}).textContent || '')`
const editor    = `document.querySelector('#editor')`

export async function run(t) {
  await t.mount('json')

  /* ── the tree at rest ─────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return ${keyText}.join('|');`),
    'a.b|a|count|live|missing|literal|tags|blank',
    'a closed document is one row per top-level entry, in the document order')

  // The default is one level open, seeded once. Asserting it here because
  // `expand` is the only prop whose wrong answer looks like a working component
  // — a tree that opens nothing and a tree that opens everything both render.
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#deep .fjs-json-row')]
      .map(r => (r.querySelector('.fjs-json-key b') || {}).textContent || '·').join('|');
  `), 'a.b|a|b|count|live|missing|literal|tags|0|1|blank|·',
    'and the default opens exactly one level, no further')

  // First-appearance order, not sorted — the author's order is the only order a
  // JSON document states.
  t.is(await t.evaluate(`return ${keyText}[0];`), 'a.b',
    'and the order is the document order, not an alphabetical one')

  /* ── a key that would collide with a path ─────────────────────────────── */

  // `['a.b']` and `['a','b']` join to one string, so a tree keyed by the join
  // renders one row for two nodes and toggles both at once. Opening `a` must
  // leave the flat `a.b` key exactly where it is.
  await t.clickAt(`#viewer [data-path='["a"]'] button`)
  await t.eventually(`${keyText}.join('|')`,
    'a.b|a|b|count|live|missing|literal|tags|blank',
    'opening a container inserts its children under it and nothing else moves')

  t.is(await t.evaluate(`
    const btns = [...document.querySelectorAll('#viewer button')];
    return btns.filter(b => b.getAttribute('aria-expanded') === 'true').length;
  `), 1, 'exactly one container reports itself open')

  // A leaf has no toggle, so the flat 'a.b' row must not have grown one.
  t.is(await t.evaluate(`
    const row = ${rows}.find(r => (r.querySelector('.fjs-json-key b') || {}).textContent === 'a.b');
    return row.querySelector('button') === null;
  `), true, 'the flat key stayed a leaf — the two nodes are not one row')

  /* ── null is the keyword, not the string ──────────────────────────────── */

  const kinds = await t.evaluate(`
    const of = (name) => {
      const row = ${rows}.find(r => (r.querySelector('.fjs-json-key b') || {}).textContent === name);
      const val = row.querySelector('.fjs-json-value');
      const el  = val.querySelector('em, strong, sup, i');
      return { tag: el.tagName, text: val.textContent.trim() };
    };
    return { missing: of('missing'), literal: of('literal'), count: of('count'), live: of('live') };
  `)

  t.is(kinds.missing.tag, 'STRONG', 'null is marked as a keyword')
  t.is(kinds.literal.tag, 'EM', 'and the string "null" is marked as a value')
  // The two read identically as text, which is the whole reason they are marked
  // with different elements.
  t.is(kinds.literal.text, '"null"', 'a string is shown quoted, so it cannot be mistaken for the keyword')
  t.is(kinds.missing.text, 'null', 'and the keyword is not')
  t.is(kinds.count.tag, 'EM', 'a number is a value')
  t.is(kinds.live.tag, 'STRONG', 'a boolean is a keyword')

  /* ── a row is one line ────────────────────────────────────────────────── */

  // The tree wears `.code`, which is `white-space: pre` — right for a document
  // and wrong for a row built out of elements, because the newlines and the
  // indentation BETWEEN the tags in the component would render as blank lines.
  // Nothing in the markup says so and nothing else here would catch it: every
  // assertion above passes against a tree three times too tall.
  //
  // Measured on the TREE, not on a row. A row is `display: contents` and has no
  // box at all, so a per-row rect is 0 and an assertion built on one passes
  // against anything — and the blank lines are BETWEEN the rows regardless,
  // which is outside every row box even when there is one. This is the shape
  // the bug actually had: every assertion above passed while the tree rendered
  // seven blank lines per entry.
  const box = await t.evaluate(`
    const tree = document.querySelector('#viewer');
    const rs   = tree.querySelectorAll('.fjs-json-row').length;
    const one  = parseFloat(getComputedStyle(tree).lineHeight) || 20;
    return { height: tree.getBoundingClientRect().height, rows: rs, one };
  `)
  t.ok(box.height <= box.rows * box.one * 1.6,
    `the tree is one line per row (${box.height}px for ${box.rows} rows at ${box.one}px)`)

  /* ── the columns are columns ──────────────────────────────────────────── */

  // The tree is one grid and a row is `display: contents`, so a value at depth
  // three starts at the same x as a value at depth zero and every remove button
  // shares one right edge. A per-row flex line renders the same document and
  // aligns each row only with itself, which reads as a ragged wall the deeper
  // it goes — and no assertion above can tell the two apart.
  const cols = await t.evaluate(`
    const rs = [...document.querySelectorAll('#deep .fjs-json-row')];
    const xs = (sel) => [...new Set(rs
      .map(r => r.querySelector(sel))
      .filter(Boolean)
      .map(el => Math.round(el.getBoundingClientRect().left)))];
    const depths = [...new Set(rs.map(r =>
      Math.round(parseFloat(getComputedStyle(r.querySelector('.fjs-json-cell')).paddingInlineStart))))];
    return { valueLefts: xs('.fjs-json-value'), depths: depths.length };
  `)
  t.ok(cols.depths > 1, `the fixture actually nests (${cols.depths} indent levels on screen)`)
  t.is(cols.valueLefts.length, 1,
    'every value starts at one x, whatever its depth — the tree is one grid, not a row of flex lines')

  /* ── an editable cell says so before it is clicked ────────────────────── */

  // `cursor: text` is what ordinary selectable text already shows, so it says
  // nothing; the pointer is the only thing that can tell someone a value
  // answers a click before they make one.
  t.is(await t.evaluate(`
    return getComputedStyle(document.querySelector('#editor-tree .fjs-json-edit')).cursor;
  `), 'pointer', 'an editable value shows a pointer, not a text caret')

  // The row band has to be a colour the block is not already painted in.
  // `.code`'s ground IS `var(--code-bg, var(--surface-sunken))`, so the band was
  // `--surface-sunken` on `--surface-sunken`: the rule matched, the declaration
  // applied, and nothing changed — in every theme at once. Read the AUTHORED
  // declaration out of the sheet and resolve it in place, rather than restating
  // the recipe here, which would assert only that this spec agrees with itself.
  const band = await t.evaluate(`
    const tree = document.querySelector('#editor-tree');
    const rules = [...document.styleSheets]
      .flatMap(sh => { try { return [...sh.cssRules] } catch { return [] } })
      .filter(r => r.selectorText && r.selectorText.includes('fjs-json-row:hover'));
    if (!rules.length) return { found: false };
    const probe = document.createElement('span');
    probe.style.cssText = rules[0].style.cssText;
    tree.appendChild(probe);
    const painted = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { found: true, painted, ground: getComputedStyle(tree).backgroundColor };
  `)
  t.ok(band.found, 'the row band is declared')
  t.ok(band.painted !== band.ground && !/rgba\(0, 0, 0, 0\)/.test(band.painted),
    `the row band is not the block's own ground (${band.painted} against ${band.ground})`)

  /* ── the theme actually reached the tree ──────────────────────────────── */

  // This component ships no palette: it marks tokens with the elements
  // `code.css` themes inside `code[language]`. If that selector ever stops
  // matching, every token collapses to one inherited colour and the tree still
  // renders — which is exactly the failure this asserts against.
  const painted = await t.evaluate(`
    const colourOf = (sel) => getComputedStyle(document.querySelector(sel)).color;
    return {
      key:   colourOf('#viewer .fjs-json-key b'),
      value: colourOf('#viewer .fjs-json-value em'),
      punct: colourOf('#viewer .fjs-json-key i'),
    };
  `)
  t.ok(painted.key !== painted.value,
    `a key and a value are different colours (${painted.key} vs ${painted.value})`)
  t.ok(painted.punct !== painted.key,
    `and punctuation is quieter than an identifier (${painted.punct} vs ${painted.key})`)

  /* ── an empty container says so ───────────────────────────────────────── */

  await t.clickAt(`#viewer [data-path='["blank"]'] button`)
  await t.eventually(
    `((document.querySelector('#viewer [data-empty]') || {}).textContent || '').trim()`,
    'empty', 'an opened empty object says empty rather than showing nothing')

  /* ── keyboard: the tree is a treegrid ─────────────────────────────────── */

  // `treegrid` rather than `tree` because that is what this component IS: a
  // tree whose rows carry several focusable things. A treeitem's interactive
  // descendants are not separately reachable under a roving tabindex, so `tree`
  // would have meant moving every row control somewhere else.
  const roles = await t.evaluate(`
    const tree = document.querySelector('#editor-tree');
    const row  = tree.querySelector('.fjs-json-row[data-path]');
    return {
      grid:  tree.getAttribute('role'),
      row:   row.getAttribute('role'),
      level: row.getAttribute('aria-level'),
      cells: [...row.children].map(c => c.getAttribute('role')).filter(Boolean).join(','),
      nested: tree.querySelector('[data-path=' + JSON.stringify(JSON.stringify(['nested'])) + ']').getAttribute('aria-expanded'),
      deep:   tree.querySelector('[data-path=' + JSON.stringify(JSON.stringify(['nested','deep'])) + ']').getAttribute('aria-level'),
      leafExpanded: tree.querySelector('[data-path=' + JSON.stringify(JSON.stringify(['count'])) + ']').getAttribute('aria-expanded'),
    };
  `)
  t.is(roles.grid, 'treegrid', 'the tree reports itself as a treegrid')
  t.is(roles.row, 'row', 'and a row as a row')
  t.is(roles.cells, 'gridcell,gridcell,gridcell', 'with three cells')
  t.is(roles.level, '1', 'depth is announced')
  t.is(roles.deep, '2', 'and it counts from the row, not from the document')
  t.is(roles.nested, 'true', 'a container says whether it is open')
  t.is(roles.leafExpanded, null, 'and a LEAF says nothing — it is not collapsible')

  // A row must have a BOX to take focus. This is what `display: contents` could
  // not give: measured, a contents row with tabindex="0" leaves activeElement
  // on the body, which rules out a roving tabindex and with it the whole
  // pattern. Subgrid keeps the column alignment and restores the box.
  t.ok(await t.evaluate(`
    return document.querySelector('#editor-tree .fjs-json-row[data-path]').getBoundingClientRect().height > 0;
  `), 'a row has a box, which is what makes any of this possible')

  // ONE tab stop for the whole widget, and tabbing in lands on a cell rather
  // than on the container — nobody should have to press an arrow to find out
  // where they are.
  t.is(await t.evaluate(`
    return document.querySelectorAll('#editor-tree [tabindex="0"]').length;
  `), 0, 'nothing inside the tree is in the tab order')
  t.is(await t.evaluate(`return document.querySelector('#editor-tree').tabIndex;`), 0,
    'the tree itself is the single tab stop')

  await t.evaluate(`document.querySelector('#editor-tree').focus(); return true;`)
  await t.eventually(`document.activeElement.classList.contains('fjs-json-cell')`, true,
    'focusing the tree hands focus straight to a cell')

  const atRow = `document.activeElement.closest('.fjs-json-row').dataset.path`

  await t.press('ArrowDown')
  await t.eventually(atRow, JSON.stringify(['count']), 'Down moves to the next row')
  await t.press('ArrowRight')
  await t.eventually(`document.activeElement.classList.contains('fjs-json-value')`, true,
    'Right moves across the cells of a row')

  // The column is KEPT across rows: arrowing down a document should not throw
  // the cursor back to the key every time.
  await t.press('ArrowDown')
  await t.eventually(`document.activeElement.classList.contains('fjs-json-value')`, true,
    'and the column survives a row change')

  await t.press('Home')
  await t.eventually(atRow, JSON.stringify(['name']), 'Home is the first row')
  await t.press('End')
  await t.eventually(atRow, JSON.stringify(['nested', 'deep']), 'End is the last one')

  // Left on the first cell of an OPEN container closes it — the treegrid
  // reading of *go back up*.
  await t.evaluate(`
    const tree = document.querySelector('#editor-tree');
    tree.querySelector('[data-path=' + JSON.stringify(JSON.stringify(['nested'])) + '] .fjs-json-cell').focus();
    return true;
  `)
  await t.press('ArrowLeft')
  await t.eventually(`
    document.querySelector('#editor-tree [data-path=' + JSON.stringify(JSON.stringify(['nested'])) + ']').getAttribute('aria-expanded')
  `, 'false', 'Left on an open container closes it')
  await t.press('ArrowRight')
  await t.eventually(`
    document.querySelector('#editor-tree [data-path=' + JSON.stringify(JSON.stringify(['nested'])) + ']').getAttribute('aria-expanded')
  `, 'true', 'and Right opens it again')

  // A caret owns the arrows. Stealing Left from a text field is the fastest
  // way to make a keyboard user distrust the whole widget.
  await t.clickAt(`#editor-tree [data-path='["name"]'] .fjs-json-edit`)
  await t.type('Grace')
  await t.press('ArrowLeft')
  t.is(await t.evaluate(`return document.activeElement.tagName;`), 'INPUT',
    'an arrow inside an open editor belongs to the caret, not to the tree')
  await t.press('Escape')

  /* ── copy a value, and where it is ────────────────────────────────────── */

  // The clipboard cannot be read back without a permission prompt, so the
  // assertion is on what the component ASKS to copy: `copyText` is stubbed and
  // records its argument. That is the whole of what this component decides —
  // the writing itself belongs to CopyButton and is one implementation.
  await t.evaluate(`
    window.__copied = [];
    navigator.clipboard.writeText = (t) => { window.__copied.push(t); return Promise.resolve(); };
    return true;
  `)
  const copyAt = async (root, path, which) => {
    const sel = `#${root} [data-path='${JSON.stringify(path)}'] .fjs-json-copy`
    await t.clickAt(which === 'path' ? `${sel}:nth-of-type(2)` : sel)
  }
  const lastCopied = `window.__copied[window.__copied.length - 1]`

  await copyAt('copyable', ['items', 0, 'sku'], 'value')
  await t.eventually(lastCopied, '"A-1"', 'copying a value copies it as JSON, quoted')

  await copyAt('copyable', ['items', 0], 'value')
  await t.eventually(lastCopied, '{\n  "sku": "A-1"\n}',
    'and a container copies its whole subtree, formatted — the thing a <pre> cannot give')

  // The keys that break a naive path. `headers.content-type` parses as a
  // subtraction and `odd.0` is a syntax error: both look right, neither runs.
  await copyAt('copyable', ['headers', 'content-type'], 'path')
  await t.eventually(lastCopied, 'headers["content-type"]',
    'a key that is not an identifier is bracketed, not dotted')

  await copyAt('copyable', ['odd', '0'], 'path')
  await t.eventually(lastCopied, 'odd["0"]', 'and a string key that looks like an index stays a key')

  await copyAt('copyable', ['items', 0, 'sku'], 'path')
  await t.eventually(lastCopied, 'items[0].sku', 'an array index is a subscript')

  // The other spelling, on a key that is the reason the format needs escaping
  // at all — a slash in a key is otherwise two segments naming nothing.
  await copyAt('pointered', ['odd', 'a/b'], 'path')
  await t.eventually(lastCopied, '/odd/a~1b', 'a JSON Pointer escapes a slash in a key')

  // Feedback lands on the button that was pressed, not on every one of them.
  t.is(await t.evaluate(`
    const marks = [...document.querySelectorAll('#pointered .fjs-json-copy')].filter(b => b.textContent.trim() === '✓');
    return marks.length;
  `), 1, 'exactly one button shows it copied')

  // A hit test, not a presence check. The actions sit in `.code`'s own top
  // padding and a `.btn.square` is taller than it, so the FIRST row's tools end
  // up underneath the document copy button — present, correct, and clicking
  // something else. Nothing that asks whether the button exists can see it.
  t.is(await t.evaluate(`
    const btns = document.querySelectorAll('#copyable .fjs-json-row[data-path] .fjs-json-copy');
    const b = btns[1];
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === b || b.contains(hit);
  `), true, 'the first row’s controls are clickable — the document actions do not sit on them')

  t.is(await t.evaluate(`
    return document.querySelectorAll('#viewer .fjs-json-copy').length;
  `), 0, 'a tree that did not ask for copy has no row buttons')

  /* ── search ───────────────────────────────────────────────────────────── */

  // The reason the component exists is a wall of unindexable text with no way
  // to fold a branch away. Folding shipped; finding did not.
  const sKeys = `[...document.querySelectorAll('#searchable .fjs-json-row[data-path] .fjs-json-key b')].map(e => e.textContent).join('|')`
  const type  = async (term) => t.evaluate(`
    const box = document.querySelector('#searchable .fjs-json-query');
    box.value = ${JSON.stringify(term)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)

  // expand={0}, so `needle` is four levels down and CLOSED. `treeRows` only
  // emits children of an open container, so a filter that does not open its own
  // ancestors finds everything and shows nothing — this is the assertion for
  // that, and it is why searchDoc answers `open` at all.
  t.is(await t.evaluate(`return ${sKeys};`), 'shallow|deep|tags|repeats|count|nothing',
    'the document starts closed')

  await type('needle')
  await t.eventually(sKeys, 'deep|a|b|needle',
    'a hit four levels down brings its whole route on screen, and nothing else')

  t.is(await t.evaluate(`
    return document.querySelector('#searchable .fjs-json-count').textContent;
  `), '1 match', 'the ancestors kept to reach it are not counted as hits')

  // A container that matches by NAME means its items too — "find me tags" is
  // not a search for the word.
  await type('tags')
  await t.eventually(sKeys, 'tags|0|1', 'a matching container keeps its whole subtree')

  // A value is matched as the text a reader SEES, or `null` is unfindable by
  // the word on screen and a number by its digits.
  await type('null')
  await t.eventually(sKeys, 'nothing', 'null is findable by the word that is on screen')
  await type('23')
  await t.eventually(sKeys, 'count', 'and a number by its digits')

  // Marked with the package's own `<mark>` — `code.css` themes it inside a
  // code[language] as *draw the eye to one run inside a line*, with a negative
  // margin against equal padding so it does not push the monospace grid out.
  await type('X')
  const hits = await t.evaluate(`
    const el = document.querySelector('#searchable [data-path=' + JSON.stringify(JSON.stringify(['repeats'])) + '] .fjs-json-value');
    const ms = [...el.querySelectorAll('mark')];
    return {
      count: ms.length,
      text:  ms.map(m => m.textContent).join(''),
      // The TOKEN, not the cell: the cell also holds the template's own
      // whitespace, which nowrap collapses on screen. Any space inside the
      // token would be one that marking had inserted.
      // (No backticks in here — the whole probe is a template literal.)
      whole: el.querySelector('em').textContent,
      bg:    ms.length ? getComputedStyle(ms[0]).backgroundColor : null,
    };
  `)
  // Every occurrence: marking one and not the next says *this is the one*,
  // which is a claim a highlighter cannot make.
  t.is(hits.count, 2, 'every occurrence is marked, not the first')
  t.is(hits.text, 'XX', 'and the mark keeps the document’s casing, not the query’s')
  t.is(hits.whole, '"aXbXc"', 'marking rewrote none of the text')
  t.ok(hits.bg && !/rgba\(0, 0, 0, 0\)/.test(hits.bg),
    `the highlight is painted by the code theme (${hits.bg})`)

  await type('zzzz')
  await t.eventually(sKeys, '', 'a term nothing holds keeps no rows')
  t.is(await t.evaluate(`
    return document.querySelector('#searchable .fjs-json-count').textContent;
  `), 'no matches', 'and says so — an empty filter and an empty document look identical otherwise')

  await type('')
  await t.eventually(sKeys, 'shallow|deep|tags|repeats|count|nothing',
    'clearing the box is not a search for nothing — the whole document is back, closed as it was')

  t.is(await t.evaluate(`
    return document.querySelectorAll('#viewer .fjs-json-query').length;
  `), 0, 'a tree that did not ask for search has no box')

  /* ── changing what KIND a value is ────────────────────────────────────── */

  const tAt   = (path) => `#typed [data-path='${JSON.stringify(path)}']`
  const tLast = `document.querySelector('#t-last').textContent`


  // The hole: `coerceLike` keeps the type an edit replaces — right for a text
  // box, and it meant a document could be edited and never RESHAPED. Typing
  // `{}` into a string field produced the string "{}", and there was no way at
  // all to turn a value into an object.
  // The selector is JSON.stringify'd rather than quoted: a `data-path` value is
  // itself JSON and carries single quotes, so embedding one in a single-quoted
  // string closes it early and the whole probe fails to parse — which reports
  // as the drive being broken rather than as this line.
  const setKind = (sel, kind) => t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel + ' .fjs-json-type')});
    el.value = ${JSON.stringify(kind)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)

  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#typed [data-path='
      + JSON.stringify(JSON.stringify(['a'])) + '] .fjs-json-type option')].map(o => o.value).join(',');
  `), 'string,number,boolean,null,object,array', 'every kind a JSON document can hold is offered')

  // What the control SHOWS, which no probe that sets `el.value` itself can see
  // — and it was wrong: a select's value is applied before its options exist,
  // so every row fell back to the first option and the whole document read as
  // strings. Found by looking at it.
  t.is(await t.evaluate(`
    // [data-path] only — the add row is not a row of the document.
    return [...document.querySelectorAll('#editor-tree .fjs-json-row[data-path]')].map(r => {
      const k = r.querySelector('.fjs-json-key b');
      const sel = r.querySelector('.fjs-json-type');
      return (k ? k.textContent : '·') + '=' + (sel ? sel.value : '-');
    }).join(' ');
  `), 'name=string count=number live=boolean missing=null tags=array 0=string 1=string nested=object deep=number',
    'the control reports the kind each row actually holds')

  await setKind(tAt(['a']), 'array')
  await t.eventually(`${tLast}`, '{"a":[1],"b":2}',
    'a leaf becomes a container, and the value it had is carried in')

  await setKind(tAt(['a']), 'object')
  await t.eventually(`${tLast}`, '{"a":{"0":1},"b":2}',
    'and an array becomes an object keyed by index — the only mapping an array has')

  await setKind(tAt(['a']), 'string')
  await t.eventually(`${tLast}`, '{"a":"{\\"0\\":1}","b":2}',
    'a container becomes its own JSON text, not [object Object]')

  // The other half of the same claim: a string that PARSES as the kind asked
  // for becomes the parsed value, so pasting a document in and saying `object`
  // does what it looks like it should.
  await setKind(tAt(['a']), 'object')
  await t.eventually(`${tLast}`, '{"a":{"0":1},"b":2}',
    'and back again, because the string parsed as one')

  // Lossy on purpose, and undoable — which is the whole reason it is allowed to
  // be lossy at all.
  await t.clickAt('#typed .fjs-json-history')
  await t.eventually(`${tLast}`, '{"a":"{\\"0\\":1}","b":2}',
    'a type change is one history step like any other')

  // An ordinary edit still keeps its type. Both rules are live at once, and
  // that is the point: the box coerces, the control converts.
  await setKind(tAt(['b']), 'string')
  await t.eventually(`${tLast}`, '{"a":"{\\"0\\":1}","b":"2"}', 'b is a string now')
  await t.clickAt(`${tAt(['b'])} .fjs-json-edit`)
  await t.type('7')
  await t.press('Enter')
  t.is(await t.evaluate(`return typeof JSON.parse(${tLast}).b;`), 'string',
    'and typing a number into it leaves a string — coerceLike still owns the box')

  t.is(await t.evaluate(`
    return document.querySelectorAll('#viewer .fjs-json-type, #diffed .fjs-json-type').length;
  `), 0, 'neither a viewer nor a diff offers a type control')

  /* ── undo ─────────────────────────────────────────────────────────────── */

  // Affordable only because every write answers a COPY: `setIn` shares every
  // branch it did not touch, so an entry costs the path that changed. A
  // component that edited in place would have nothing left to go back to.
  const uAt   = (path) => `#undoable [data-path='${JSON.stringify(path)}']`
  const uLast = `document.querySelector('#u-last').textContent`

  t.is(await t.evaluate(`return document.querySelector('#undoable .fjs-json-history').disabled;`), true,
    'undo is offered and refused before there is anything to undo')

  await t.clickAt(`${uAt(['a'])} .fjs-json-edit`)
  await t.type('7')
  await t.press('Enter')
  await t.eventually(`JSON.parse(${uLast}).a`, 7, 'an edit lands')

  await t.clickAt(`${uAt(['b'])} .fjs-json-edit`)
  await t.type('8')
  await t.press('Enter')
  await t.eventually(`JSON.parse(${uLast}).b`, 8, 'and a second one')

  // Both directions, one step at a time — a stack that collapsed several edits
  // into one entry passes a single round trip and fails here.
  await t.clickAt('#undoable .fjs-json-history')
  await t.eventually(`${uLast}`, '{"a":7,"b":2}', 'undo goes back exactly one edit')
  await t.clickAt('#undoable .fjs-json-history')
  await t.eventually(`${uLast}`, '{"a":1,"b":2}', 'and again, to the document it started on')

  // Announced, not just shown. An undo the caller never hears about is a screen
  // disagreeing with the object it is editing.
  t.ok(Number(await t.evaluate(`return document.querySelector('#u-count').textContent;`)) >= 4,
    'every undo was announced, like any other write')

  t.is(await t.evaluate(`return document.querySelector('#undoable .fjs-json-history').disabled;`), true,
    'and the button refuses again once there is nothing left')

  const redo = `document.querySelectorAll('#undoable .fjs-json-history')[1]`
  await t.clickAt('#undoable .fjs-json-history:nth-of-type(2)')
  await t.eventually(`${uLast}`, '{"a":7,"b":2}', 'redo walks forward again')

  // A fresh edit has to drop the forward stack — redoing onto a document that
  // no longer exists is how an editor loses work.
  await t.clickAt(`${uAt(['b'])} .fjs-json-edit`)
  await t.type('9')
  await t.press('Enter')
  await t.eventually(`JSON.parse(${uLast}).b`, 9, 'a new edit lands')
  t.is(await t.evaluate(`return ${redo}.disabled;`), true,
    'and it drops what was ahead — there is nothing to redo onto any more')

  // The shortcut is bound to the TREE. A document-level handler would take ⌘Z
  // off a page that has its own, from inside a component — so the assertion has
  // to put focus INSIDE the tree first, which clicking undo does on its way
  // through. `modifiers: 2` is CDP's Ctrl; a bare `{ ctrlKey: true }` is not an
  // option it reads, and lands as the letter z.
  await t.clickAt('#undoable .fjs-json-history')
  await t.eventually(`${uLast}`, '{"a":7,"b":2}', 'the button walked one step back')
  await t.key('z', { modifiers: 2 })
  await t.eventually(`${uLast}`, '{"a":1,"b":2}', 'and Ctrl+Z walks the next one, from inside the tree')

  /* ── undo when the caller rebuilds the document ───────────────────────── */

  // The case the design turns on, and `example`'s /settings/ is the live one:
  // a caller that adopts a write key by key hands back a document that is EQUAL
  // and not identical. Compared by identity that reads as a second, foreign
  // change, the write goes on the stack twice, and every edit costs two presses
  // to undo — which looks like undo being broken rather than like a rule.
  await t.clickAt(`#normalizing [data-path='["a"]'] .fjs-json-edit`)
  await t.type('5')
  await t.press('Enter')
  await t.eventually(`document.querySelector('#n-doc').textContent`, '{"a":5}',
    'a controlled, rebuilding caller still edits')

  await t.clickAt('#normalizing .fjs-json-history')
  await t.eventually(`document.querySelector('#n-doc').textContent`, '{"a":1}',
    'and ONE undo is enough — the echo is recognized by value, not by identity')

  t.is(await t.evaluate(`
    return document.querySelectorAll('#viewer .fjs-json-history').length;
  `), 0, 'a viewer without `editable` offers no history at all')

  /* ── diff ─────────────────────────────────────────────────────────────── */

  // A removed key is in neither the new document nor any tree built from it,
  // so a diff that walks only `value` shows every change except the ones that
  // took something away. It is the merged document that makes `gone` a row at
  // all — and `expand={0}` here, so the rows below `n` and `tags` are on screen
  // only because a change opened them.
  const diffRows = await t.evaluate(`
    return [...document.querySelectorAll('#diffed .fjs-json-row')].map(r => {
      const k = r.querySelector('.fjs-json-key b');
      const v = r.querySelector('.fjs-json-value');
      return (k ? k.textContent : '·') + ':' + (v ? (v.getAttribute('data-diff') || '') : '');
    }).join(' | ');
  `)
  t.is(diffRows, 'keep: | gone:removed | n:changed | deep:changed | same: | tags:changed | 0: | 1: | 2:added | fresh:added',
    'every state is a row: removed survives, added appears, and a container says its children moved')

  // The elements are the package's, not this component's — `code.css` draws
  // <ins>/<del>/<dfn> as stripes off --code-ins/--code-del/--code-note, so the
  // diff retints with the theme exactly as the tokens do.
  const marks = await t.evaluate(`
    const at = (p) => document.querySelector('#diffed [data-path=' + JSON.stringify(JSON.stringify(p)) + '] .fjs-json-value');
    return {
      removed: at(['gone']).firstElementChild.tagName,
      added:   at(['fresh']).firstElementChild.tagName,
      rollup:  at(['n']).firstElementChild.tagName,
      changed: [...at(['n','deep']).children].map(e => e.tagName).join('+'),
    };
  `)
  t.is(marks.removed, 'DEL', 'a removed row is marked with the element that means removed')
  t.is(marks.added,   'INS', 'and an added one with the element that means added')
  t.is(marks.rollup,  'DFN', 'a container is the note element — the detail is in the rows under it')
  // The half a status alone cannot express: changed FROM what.
  t.is(marks.changed, 'DEL+INS', 'a changed leaf shows both sides, old above new')

  t.is(await t.evaluate(`
    const el = document.querySelector('#diffed [data-path=' + JSON.stringify(JSON.stringify(['n','deep'])) + '] del');
    return el.textContent.trim();
  `), '1', 'and the old side is the value that was actually there')

  // A theme that stopped reaching the marks would render three identical
  // stripes, which looks like a working diff and says nothing.
  const hues = await t.evaluate(`
    const of = (sel) => getComputedStyle(document.querySelector(sel)).borderInlineStartColor;
    return { ins: of('#diffed ins'), del: of('#diffed del'), note: of('#diffed dfn') };
  `)
  t.ok(hues.ins !== hues.del && hues.del !== hues.note,
    `added, removed and changed are three different colours (${hues.ins} · ${hues.del} · ${hues.note})`)

  // Nothing changed must look like nothing changed — no marks, and no branch
  // forced open by a difference that is not there.
  t.is(await t.evaluate(`
    return document.querySelectorAll('#undiffed ins, #undiffed del, #undiffed dfn, #undiffed [data-diff]').length;
  `), 0, 'two documents that agree render an ordinary tree')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#undiffed .fjs-json-row').length;
  `), 2, 'and stay closed — nothing opened a branch that holds no difference')

  /* ── raw mode ─────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('#raw code[language]').getAttribute('language');`),
    'json', 'raw mode emits the wrapper the code theme keys off')

  // prefix: false. With prefixes on, glow reads a leading `-` as a diff marker
  // and REMOVES it, so a negative number at the head of a line loses its sign
  // and the block still looks like valid JSON.
  t.ok(await t.evaluate(`return document.querySelector('#raw code[language]').textContent.includes('-1');`),
    'a negative number keeps its sign — the diff-prefix pass is off')

  t.is(await t.evaluate(`return document.querySelector('#blank').textContent.trim();`),
    'Nothing here', 'an absent document renders the empty message, not an empty box')

  /* ── edit mode ────────────────────────────────────────────────────────── */

  // The property the whole kit rests on, asserted at the end of every operation
  // below: `pristine` is the SAME object the component was handed, and every
  // write answers a copy. An in-place edit would look identical on screen and
  // reach a reactive runtime as a value === to the one it replaced.
  const PRISTINE = '{"name":"Ada","count":3,"live":true,"missing":null,"tags":["x","y"],"nested":{"deep":1}}'
  const at = (path) => `#editor-tree [data-path='${JSON.stringify(path)}']`
  const edited = `document.querySelector('#edited').textContent`

  // ── a leaf keeps its type ──
  await t.clickAt(`${at(['count'])} .fjs-json-edit`)
  await t.type('7')
  await t.press('Enter')
  await t.eventually(`JSON.parse(${edited}).count`, 7, 'a number edit writes a number')
  t.is(await t.evaluate(`return typeof JSON.parse(${edited}).count;`), 'number',
    'and not the string the box handed back — coerceLike keeps the type it replaced')

  // ── a boolean is a toggle, not a text box ──
  await t.clickAt(`${at(['live'])} .fjs-json-edit`)
  await t.eventually(`JSON.parse(${edited}).live`, false, 'clicking a boolean flips it')

  // ── rename keeps the key WHERE IT WAS ──
  await t.clickAt(`${at(['name'])} .fjs-json-name`)
  await t.type('title')
  await t.press('Enter')
  // The whole reason renameKey rebuilds the object: delete + set sends the key
  // to the end, so correcting a typo in the first field drops it to the bottom
  // of the form with nothing the person can do about it.
  t.is(await t.evaluate(`return Object.keys(JSON.parse(${edited})).join(',');`),
    'title,count,live,missing,tags,nested',
    'a renamed key stays in its position, it does not move to the end')

  // ── a rename onto an existing key is refused, and says so ──
  await t.clickAt(`${at(['count'])} .fjs-json-name`)
  await t.type('title')
  await t.press('Enter')
  await t.eventually(`(document.querySelector('#editor-tree .fjs-json-rowerror') || {}).textContent`,
    "renameKey: 'title' already exists here — renaming onto it would discard its value",
    'renaming onto a key that exists is refused with the reason, not silently merged')
  t.is(await t.evaluate(`return Object.keys(JSON.parse(${edited})).length;`), 6,
    'and nothing was lost')

  // ── removing an array item removes the one that was clicked ──
  await t.clickAt(`${at(['tags', 0])} .fjs-json-remove`)
  t.is(await t.evaluate(`return JSON.stringify(JSON.parse(${edited}).tags);`), '["y"]',
    'removing by index removes the row that was clicked')

  // ── adding to an array ──
  await t.clickAt(`${at(['tags'])} .fjs-json-add`)
  await t.type('z')
  await t.press('Enter')
  t.is(await t.evaluate(`return JSON.stringify(JSON.parse(${edited}).tags);`), '["y","z"]',
    'a new array item is appended')

  // ── adding a key to a nested object, with the value parsed where it parses ──
  await t.clickAt(`${at(['nested'])} .fjs-json-add`)
  await t.type('list')
  await t.press('Tab')
  await t.type('[1,2]')
  await t.press('Enter')
  t.is(await t.evaluate(`return JSON.stringify(JSON.parse(${edited}).nested);`), '{"deep":1,"list":[1,2]}',
    'a new key takes a parsed value where the text parses as JSON')

  // ── adding to the ROOT, which is not a row ──
  await t.clickAt('#editor-tree [data-add=root] input')
  await t.type('note')
  await t.press('Tab')
  await t.type('hello')
  await t.press('Enter')
  t.is(await t.evaluate(`return JSON.parse(${edited}).note;`), 'hello',
    'the root takes a new key too — it has no row of its own, so it has an add row of its own')

  // ── and after every one of those, the caller's object is untouched ──
  // Read off the LIVE object rather than a rendered copy. An in-place mutation
  // changes no binding, so an <output> holding JSON.stringify(pristine) still
  // shows what it rendered at mount — this assertion passed against a
  // deliberately mutating removeRow until it was read this way.
  t.is(await t.evaluate(`return JSON.stringify(window.__jsonPristine);`), PRISTINE,
    'the document the component was handed was never mutated, through eight operations')

  // Seven, not eight: eight operations were attempted and the refused rename
  // wrote nothing. A refusal that still announced would be a form saving a
  // change it had just told the person it would not make.
  t.is(await t.evaluate(`return document.querySelector('#edits').textContent;`), '7',
    'each accepted operation announced exactly once, and the refused one not at all')

  // ── a controlled tree yields to its caller ──
  //
  // A new `value` identity from above wins over the draft, which is what lets
  // this be ONE editor among several over the same object: without it, a tree
  // that had been touched once would keep showing its own copy while the rest
  // of the screen moved on, and nothing would say so.
  await t.clickAt(`#controlled [data-path='["a"]'] .fjs-json-edit`)
  await t.type('2')
  await t.press('Enter')
  await t.eventually(`document.querySelector('#controlled').textContent.includes('2')`, true,
    'a controlled tree still edits')

  await t.clickAt('#replace-doc')
  await t.eventually(`document.querySelector('#controlled').textContent.includes('swapped')`, true,
    'and a change made anywhere else replaces what it is showing, draft and all')

  // ── a read-only tree offers none of it ──
  t.is(await t.evaluate(`
    return document.querySelectorAll('#viewer .fjs-json-remove, #viewer .fjs-json-add, #viewer .fjs-json-edit').length;
  `), 0, 'a viewer without `editable` has no affordance to change anything')

  /* ── the control: text in, document out ───────────────────────────────── */

  t.is(await t.evaluate(`return ${editor}.value;`), '{\n  "keep": 1\n}',
    'the control opens on the document, pretty-printed')

  // Break it with one real keystroke at the end of the buffer.
  await t.clickAt('#editor')
  await t.evaluate(`${editor}.setSelectionRange(${editor}.value.length, ${editor}.value.length); return true;`)
  await t.type('x')

  await t.eventually(`document.querySelector('#refused').textContent`, '1',
    'an unparseable buffer is reported')
  t.is(await t.evaluate(`return document.querySelector('#writes').textContent;`), '0',
    'and NOT written — a half-typed document must not reach the record')
  t.ok(await t.evaluate(`
    const p = document.querySelector('.field-hint.danger');
    return !!p && p.textContent.length > 0;
  `), 'the parse error is rendered, with the engine\'s own message')
  t.is(await t.evaluate(`return ${editor}.getAttribute('aria-invalid');`), 'true',
    'and the box reports itself invalid')

  // Take it back out again.
  await t.press('Backspace')
  await t.eventually(`document.querySelector('#writes').textContent`, '1',
    'a buffer that parses again is written through')
  t.is(await t.evaluate(`return document.querySelector('#written').textContent;`), '{"keep":1}',
    'as a document — an object, not the text of one')
  t.is(await t.evaluate(`return ${editor}.getAttribute('aria-invalid');`), null,
    'and the invalid state is cleared')

  /* ── inside a form, an unconvertible box refuses the submit ───────────── */

  // The half a standalone control cannot reach. The record holds the last
  // document that parsed, so every check the form makes on it passes while the
  // screen shows something else — a save at that moment stores a value the
  // person can see is not in front of them (`FJS-404`). The control reports it
  // through `$context.form.reportInvalid` and the form refuses.
  const guarded = `document.querySelector('#guarded [name=payload]')`

  await t.clickAt('#guarded [name=payload]')
  await t.evaluate(`${guarded}.setSelectionRange(${guarded}.value.length, ${guarded}.value.length); return true;`)
  await t.type('%')

  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '0',
    'a form does not submit while a control cannot convert what it is showing')

  // …and it is rendered by <Field>, in the place a server error appears, rather
  // than by the control drawing a second message of its own.
  t.is(await t.evaluate(`
    return document.querySelectorAll('#guarded .field-hint.danger').length;
  `), 1, 'and the message appears once, where a server error would')

  // The retraction is the half that turns a guard into a lock if it is missing.
  await t.clickAt('#guarded [name=payload]')
  await t.press('Backspace')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '1',
    'fixing the box retracts the refusal and the form submits')
  t.is(await t.evaluate(`return document.querySelector('#sent').textContent;`), '{"keep":1}',
    'and what it sends is the document, parsed')

  /* ── and in a HAND-WRITTEN form, which is the case only this can stop ─── */

  // A form with children renders no generated field, so `rendered` is empty and
  // the record-level refusal above deliberately never fires — `make()` seeds
  // columns such a form may legitimately complete in its own onsubmit
  // (`FJS-316`). The control's own report is the only thing here that knows the
  // box cannot be converted.
  const hand = `document.querySelector('#handwritten [name=payload]')`

  await t.clickAt('#handwritten [name=payload]')
  await t.evaluate(`${hand}.setSelectionRange(${hand}.value.length, ${hand}.value.length); return true;`)
  await t.type('%')

  await t.clickAt('#hand-save')
  await t.eventually(`document.querySelector('#hand-saves').textContent`, '0',
    'a hand-written form refuses too — the report came from a control on screen')

  await t.clickAt('#handwritten [name=payload]')
  await t.press('Backspace')
  await t.clickAt('#hand-save')
  await t.eventually(`document.querySelector('#hand-saves').textContent`, '1',
    'and it submits again once the box parses')

  /* ── the label came from the field name ───────────────────────────────── */

  // Standing outside a <Form> there is no schema to ask, so the control falls
  // back to the title-cased column name rather than rendering bare — a control
  // with nowhere to put a label has nowhere to put a server error either.
  t.is(await t.evaluate(`
    const l = document.querySelector('label[for="editor"]');
    // The label carries Field's own (Optional) badge behind it; the first line
    // is the label itself. fromCharCode because everything here is a template
    // literal — a backslash escape in it is resolved before the browser sees it.
    return l ? l.textContent.trim().split(String.fromCharCode(10))[0].trim() : null;
  `), 'Payload', 'a named control wraps itself in a Field')
}
