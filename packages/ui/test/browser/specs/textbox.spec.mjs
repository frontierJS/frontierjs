/*
 * textbox.spec.mjs — Textbox, a <textarea> edited by vim's keys (L1,
 * IDEAS/keys.md Phase 4).
 *
 * The reducer is toolbelt's and its rows are pinned there; what this holds is
 * the half a reducer cannot see: the box and the real control agreeing. INSERT
 * types natively and the box reads the text back; NORMAL's keys move the
 * control's caret and change its value; a letter no row binds types nothing;
 * a caller's rows rebind, add and unbind; and the bound value and mode reach
 * the parent. Phase 4's exit keys are all here: i, Esc, w, 0, $, x, dd, u, p.
 */
export const name = 'Textbox'
export const covers = ['forms/Textbox']

const text  = `document.getElementById('tb').value`
const caret = `document.getElementById('tb').selectionStart`
const badge = `document.querySelector('.fjs-textbox-mode').textContent`
const box   = (k) => `window.__box().${k}`

export async function run(t) {
  await t.mount('textbox')
  await t.clickAt('#tb')

  t.is(await t.evaluate(`return ${badge};`), 'INSERT', 'the box opens in INSERT')
  await t.type('hello world')
  await t.eventually(box('value'), 'hello world', 'INSERT types natively and the bound value follows')

  await t.press('Escape')
  await t.eventually(box('mode'), 'normal', 'Esc is NORMAL, and the bound mode follows')
  t.is(await t.evaluate(`return ${badge};`), 'NORMAL', 'the badge says so')
  t.is(await t.evaluate(`return ${caret};`), 10, 'Esc steps back onto the last character typed')

  await t.press('0')
  t.is(await t.evaluate(`return ${caret};`), 0, '0 moves the caret to the line start')
  await t.press('w')
  t.is(await t.evaluate(`return ${caret};`), 6, 'w moves to the next word')
  await t.press('$')
  t.is(await t.evaluate(`return ${caret};`), 10, '$ moves to the last character')

  await t.press('x')
  await t.eventually(text, 'hello worl', 'x deletes the character under the caret')
  t.is(await t.evaluate(`return ${box('value')};`), 'hello worl', 'and the bound value follows')
  await t.press('q')
  await t.press('Enter')
  t.is(await t.evaluate(`return ${text};`), 'hello worl', 'a letter and Enter no NORMAL row binds type nothing')

  await t.press('u')
  await t.eventually(text, 'hello world', 'u undoes x')
  await t.press('U')
  await t.eventually(text, 'hello worl', 'U redoes it, a row the caller added')
  await t.press('X')
  t.is(await t.evaluate(`return ${text};`), 'hello worl', 'X unbound by nop deletes nothing')

  await t.press('d')
  await t.press('d')
  await t.eventually(text, '', 'dd deletes the line')
  await t.press('p')
  await t.eventually(text, '\nhello worl', 'p puts the line after')
  await t.press('u')
  await t.press('u')
  await t.eventually(text, 'hello worl', 'u twice undoes the put and the dd')

  // A click is a selection the box reads at the next key.
  await t.evaluate(`document.getElementById('tb').setSelectionRange(2, 2); return true;`)
  await t.press('x')
  await t.eventually(text, 'helo worl', 'x deletes where a click put the caret')

  await t.press('i')
  await t.eventually(box('mode'), 'insert', 'i is INSERT')
  await t.type('LL')
  await t.eventually(text, 'heLLlo worl', 'typed where the caret was')
  await t.press('s', 2)
  await t.eventually(box('saved'), 1, 'a function row the caller added runs, Ctrl+S in INSERT')
  await t.press('Escape')
  await t.press('u')
  await t.eventually(text, 'helo worl', 'one u undoes all of the INSERT')

  await t.evaluate(`window.__set('from outside'); return true;`)
  await t.eventually(text, 'from outside', 'a value the parent writes reaches the control')
  await t.press('0')
  await t.press('x')
  await t.eventually(box('value'), 'rom outside', 'and the box edits it')
}
