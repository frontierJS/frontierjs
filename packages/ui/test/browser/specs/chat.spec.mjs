/*
 * chat.spec.mjs — the three chat parts: a log that follows the newest message
 * unless the reader scrolled up, a bubble on the reader's side or the other
 * party's, and a box where Enter sends and Shift+Enter breaks the line
 * (`FJS-2810`).
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
}
