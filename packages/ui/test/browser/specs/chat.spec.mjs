/*
 * chat.spec.mjs — the three chat parts: a log that follows the newest message
 * unless the reader scrolled up, a bubble on the reader's side or the other
 * party's, and a box where Enter sends and Shift+Enter breaks the line
 * (`FJS-2810`). The second composer carries every option: Stop while a reply
 * streams, a send that fails and gives the words back, a draft written from
 * outside (`FJS-3613`).
 *
 * Scroll position and key handling are properties of a real layout and real
 * input; a render test sees neither.
 */
export const name = 'chat: a transcript that follows, a bubble per side, a composer that sends on Enter'
export const covers = ['display/Transcript', 'display/Message', 'display/Composer']

const SHIFT = 8
const gap = `(() => { const l = document.querySelector('#log'); return l.scrollHeight - l.scrollTop - l.clientHeight })()`

export async function run(t) {
  await t.mount('chat')

  /* ── the log opens on the newest message ──────────────────────────── */

  t.ok(await t.evaluate(`const l = document.querySelector('#log'); return l.scrollHeight > l.clientHeight`),
    'twelve messages overflow the log')
  await t.eventually(`${gap} <= 1`, true, 'it opens scrolled to the newest')

  /* ── it follows a new message and a streamed token ────────────────── */

  await t.clickAt('#add')
  await t.eventually(`${gap} <= 1`, true, 'a new message is followed')
  const before = await t.evaluate(`return document.querySelector('#log').scrollHeight`)
  await t.clickAt('#token')
  await t.eventually(`document.querySelector('#log').scrollHeight > ${before}`, true, 'the token grew the last bubble')
  await t.eventually(`${gap} <= 1`, true, 'and a token landing in it is followed')

  /* ── a reader who scrolled up is left where they are ──────────────── */

  await t.evaluate(`document.querySelector('#log').scrollTop = 0; return 1`)
  await t.eventually(`document.querySelector('#log').scrollTop`, 0, 'the reader is at the top')
  await t.clickAt('#add')
  await t.clickAt('#token')
  await t.evaluate(`return new Promise(r => setTimeout(r, 150))`)
  t.is(await t.evaluate(`return document.querySelector('#log').scrollTop`), 0,
    'a message and a token arriving do not move a reader who scrolled up')

  /* ── and it follows again once they come back to the bottom ───────── */

  await t.evaluate(`const l = document.querySelector('#log'); l.scrollTop = l.scrollHeight; return 1`)
  await t.evaluate(`return new Promise(r => setTimeout(r, 100))`)
  await t.clickAt('#add')
  await t.eventually(`${gap} <= 1`, true, 'back at the bottom, it follows again')

  /* ── bubbles: side and tone ───────────────────────────────────────── */

  const sides = await t.evaluate(`
    const log = document.querySelector('#log').getBoundingClientRect();
    const mine = document.querySelector('#log [data-side=mine]');
    const theirs = document.querySelector('#log [data-side=theirs]');
    const box = (e) => e.getBoundingClientRect();
    return {
      mineCls: mine.className,
      theirsCls: theirs.className,
      mineEnd: Math.round(log.right - box(mine).right),
      theirsStart: Math.round(box(theirs).left - log.left),
      failed: document.querySelector('#failed .fjs-message').className,
      width: box(mine).width / log.width,
    };
  `)
  t.ok(/\bsurface\b/.test(sides.mineCls) && /\bprimary\b/.test(sides.mineCls), 'mine is a surface in the primary tone')
  t.ok(/\bsurface\b/.test(sides.theirsCls) && !/\bprimary\b/.test(sides.theirsCls), 'theirs is an untoned surface')
  t.ok(/\bdanger\b/.test(sides.failed) && !/\bprimary\b/.test(sides.failed), 'a stated tone replaces the side’s own')
  t.ok(sides.mineEnd < sides.theirsStart + 40 && sides.mineEnd >= 0 && sides.theirsStart >= 0,
    `mine sits at the end and theirs at the start (${sides.mineEnd}px / ${sides.theirsStart}px)`)
  t.ok(sides.width <= 0.86, `a bubble stops short of the full width (${sides.width.toFixed(2)})`)

  /* ── the composer ─────────────────────────────────────────────────── */

  await t.clickAt('#composer textarea')
  await t.type('first')
  await t.press('Enter', SHIFT)
  await t.type('second')
  t.is(await t.evaluate(`return document.querySelector('#composer textarea').value`), 'first\nsecond',
    'Shift+Enter breaks the line and sends nothing')
  t.is(await t.evaluate(`return document.querySelector('#sent').textContent`), '', 'nothing sent yet')

  await t.evaluate(`document.querySelector('#log').scrollTop = 0; return 1`)
  await t.press('Enter')
  await t.eventually(`document.querySelector('#sent').textContent`, 'first\nsecond', 'Enter sends the text')
  await t.eventually(`document.querySelector('#composer textarea').value`, '', 'and clears the box')
  await t.eventually(`${gap} <= 1`, true, 'sending scrolls the log to the end, even from the top')

  await t.press('Enter')
  await t.type('   ')
  await t.press('Enter')
  t.is(await t.evaluate(`return document.querySelector('#sent').textContent`), 'first\nsecond',
    'an empty or blank box sends nothing')

  await t.type('x')
  t.is(await t.evaluate(`return document.querySelector('#composer button').disabled`), false, 'Send is live with text in the box')
  await t.evaluate(`document.querySelector('#composer button').click(); return 1`)
  await t.eventually(`document.querySelector('#sent').textContent`, 'first\nsecond|x', 'the Send button sends too')

  /* ── the composer's names: the box's own, and an icon button's ────── */

  const names = await t.evaluate(`
    const q = (s) => document.querySelector(s);
    return {
      plain: q('#composer textarea').getAttribute('aria-label'),
      plainMax: q('#composer textarea').hasAttribute('maxlength'),
      rich: q('#rich textarea').getAttribute('aria-label'),
      richMax: q('#rich textarea').maxLength,
      button: q('#rich button').getAttribute('aria-label'),
      square: q('#rich button').classList.contains('square'),
      icon: !!q('#rich button .icon-send'),
    };
  `)
  t.is(names.plain, 'Write a message', 'with no inputLabel the box is named by its placeholder')
  t.is(names.plainMax, false, 'and carries no maxlength')
  t.is(names.rich, 'Message the bot', 'inputLabel names the box')
  t.is(names.richMax, 12, 'maxlength reaches the textarea')
  t.ok(names.button === 'Send' && names.square && names.icon, 'a send snippet makes a square icon button named by label')

  /* ── a send that fails gives the words back ───────────────────────── */

  const rich = (k) => `document.querySelector('#${k}').textContent`
  const box  = `document.querySelector('#rich textarea')`
  await t.clickAt('#fail')
  await t.clickAt('#rich textarea')
  await t.type('hi')
  await t.press('Enter')
  await t.eventually(rich('rich-sent'), 'hi', 'Enter hands the words over')
  await t.eventually(`${box}.value`, '', 'and the box clears before the send settles')
  await t.clickAt('#settle')
  await t.eventually(`${box}.value`, 'hi', 'a false result puts the words back')
  await t.eventually(rich('drafts'), 'h|hi||hi', 'ondraft hears the typing, the clear and the restore')
  await t.eventually(`document.activeElement === ${box}`, true, 'focus returns to the box once the send settles')

  await t.press('Enter')
  await t.eventually(`${box}.value`, '', 'sent again')
  await t.type('x')
  await t.clickAt('#settle')
  await t.evaluate(`return new Promise(r => setTimeout(r, 50))`)
  t.is(await t.evaluate(`return ${box}.value`), 'x', 'words typed while the send was pending are not overwritten')
  await t.clickAt('#fail')

  /* ── sending and busy leave Enter inert ───────────────────────────── */

  await t.clickAt('#sending')
  await t.eventually(`document.querySelector('#rich button').getAttribute('aria-busy')`, 'true', 'sending shows the button loading')
  await t.clickAt('#rich textarea')
  await t.press('Enter')
  t.is(await t.evaluate(`return ${rich('rich-sent')}`), 'hi|hi', 'Enter sends nothing while sending')
  await t.clickAt('#sending')

  await t.clickAt('#busy')
  await t.clickAt('#rich textarea')
  await t.press('Enter')
  t.is(await t.evaluate(`return ${rich('rich-sent')}`), 'hi|hi', 'Enter sends nothing while busy')
  await t.press('Backspace')
  const stop = await t.evaluate(`
    const b = document.querySelector('#rich button');
    return { text: b.textContent.trim(), danger: b.classList.contains('danger'), off: b.disabled,
             typing: !${box}.disabled, value: ${box}.value };
  `)
  t.is(stop.value, '', 'the box stays live while busy')
  t.ok(stop.text === 'Stop' && stop.danger, 'busy turns the button into a danger Stop')
  t.is(stop.off, false, 'and an empty box does not disable Stop')
  await t.clickAt('#rich button')
  await t.eventually(rich('stops'), '1', 'Stop calls onstop')
  await t.clickAt('#busy')
  await t.eventually(`document.querySelector('#rich button').disabled`, true, 'back to Send, off over an empty box')

  /* ── a draft set from outside regrows the box, up to maxRows ──────── */

  const empty = await t.evaluate(`return ${box}.offsetHeight`)
  await t.clickAt('#suggest')
  await t.eventually(`${box}.value`, 'one\ntwo\nthree', 'the outside draft lands in the box')
  await t.eventually(`${box}.offsetHeight > ${empty}`, true, 'and the box regrows to it')
  t.ok(await t.evaluate(`const b = ${box}; return b.scrollHeight > b.clientHeight`),
    'three lines past maxRows=2 scroll')
}
