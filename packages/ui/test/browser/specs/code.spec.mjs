/*
 * code.spec.mjs — Code, a code block with a copy button in its corner.
 *
 * Two things only a browser can say. The button sits over the block's padding
 * and is wider than it, so the end of a line can be on screen and underneath a
 * control — present, correct, and unreadable, the same shape as Json's first
 * row (packages/ui/CLAUDE.md § Json). And what is COPIED is what is SHOWN: glow
 * strips a leading `>` as a callout marker, so a block could draw one string
 * and hand the clipboard another with nothing on screen saying so.
 */
export const name = 'Code'
export const covers = ['display/Code']

export async function run(t) {
  await t.mount('code')

  /* ── the button does not sit on the line ──────────────────────────────── */

  // Measured against the last character rather than the <code> box, because
  // the box is as wide as the block's content area whether or not the button
  // covers any text inside it.
  const geometry = (root) => t.evaluate(`
    const root = document.querySelector('${root}');
    const code = root.querySelector('pre code');
    const range = document.createRange();
    range.setStart(code.firstChild, code.firstChild.length - 1);
    range.setEnd(code.firstChild, code.firstChild.length);
    const last = range.getBoundingClientRect();
    const btn  = root.querySelector('button');
    const b    = btn?.getBoundingClientRect();
    const hit  = b && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      lastRight: last.right,
      btnLeft:   b ? b.left : null,
      clickable: b ? (hit === btn || btn.contains(hit)) : null,
      padEnd:    parseFloat(getComputedStyle(root.querySelector('pre')).paddingInlineEnd),
    };
  `)

  const fit  = await geometry('#fit')
  const bare = await geometry('#fit-bare')

  t.ok(fit.clickable, 'the copy button is what a click in its middle reaches')
  t.ok(fit.lastRight <= fit.btnLeft,
    `the last character ends before the button starts (${fit.lastRight.toFixed(1)} ≤ ${fit.btnLeft?.toFixed(1)})`)
  t.ok(bare.btnLeft === null, 'copy={false} renders no button')
  t.ok(fit.padEnd > bare.padEnd,
    'and reserves no room for one — the reserve belongs to the button, not to every block')

  /* ── what is copied is what is shown ──────────────────────────────────── */

  await t.clickAt('#fit button')
  await t.eventually(`window.__copied`, 'fli auth:create-user you@example.com --role admin',
    'clicking the button puts the block’s text on the clipboard')
  await t.eventually(`document.querySelector('#fit button').getAttribute('aria-label')`, 'Copied',
    'and the button says so')

  t.is(await t.evaluate(`return document.querySelector('#css code[language]').textContent;`),
    '> .child { color: red }', 'a highlighted block keeps a leading `>` — the callout pass is off')
  await t.clickAt('#css button')
  await t.eventually(`window.__copied`, '> .child { color: red }',
    'and copies the same string it draws')

  /* ── text is text ─────────────────────────────────────────────────────── */

  const markup = await t.evaluate(`
    const code = document.querySelector('#markup pre code');
    return { text: code.textContent, elements: code.children.length };
  `)
  t.is(markup.text, '<b>not bold</b>', 'a block with no language shows markup as characters')
  t.is(markup.elements, 0, 'and parses none of it into elements')
}
