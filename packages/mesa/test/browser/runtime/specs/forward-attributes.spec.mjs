/*
 * `{...$attributes}` — a forwarded attribute against the same expression on a
 * plain element (`FJS-612`).
 *
 * The divergence is what this pins: the attribute path and the child path used
 * to disagree about ONE expression on ONE element, because `$attributes` was a
 * plain object copied once at component init. Everything reactive around it
 * worked — the parent's push effect, the child's spread effect — so a spec
 * asserting rendered TEXT passed while every forwarded `aria-*` announced its
 * first state for ever.
 *
 * Every assertion is a PAIR: the forwarded attribute beside the plain one, so
 * a fix that freezes both looks like a fix that froze neither.
 */
export const name = '{...$attributes} — a forwarded attribute tracks (FJS-612)'
export const covers = ['rest-props', 'attribute-forwarding', 'prop-push']

const read = `
  const at = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const out = { text: el.textContent.trim() }
    for (const a of el.attributes) out[a.name] = a.value
    return out
  }
  return { fwd: at('#fwd'), plain: at('#plain'), relayed: at('#relayed') }
`

export async function run(t) {
  await t.mount('forward-attributes')

  const first = await t.evaluate(read)
  t.is(first.fwd['data-rate'], '100', 'a forwarded attribute arrives')
  t.is(first.plain['data-rate'], '100', 'and so does the plain one beside it')
  t.is(first.fwd.text, '100', 'and the component renders its own children from the same value')
  t.is(first.fwd['data-kind'], 'rate', 'a STATIC undeclared attribute is forwarded too')
  t.is(first.fwd['data-extra'], '1', 'and one arriving through a spread')
  t.is(first.fwd.id, 'fwd', 'an id the caller set reaches the DOM')

  t.is(first.fwd.tone, undefined,
    'a DECLARED prop does not — that is what separates $attributes from $props')
  t.is(first.fwd['data-tone'], 'danger', 'the component reads it itself')

  t.is(first.relayed['data-rate'], '100', 'two hops of forwarding arrive')

  // ── the defect ────────────────────────────────────────────────────────────
  await t.clickAt('#bump')
  await t.eventually(`document.querySelector('#plain').getAttribute('data-rate')`, '101',
    'the plain element moves')

  const moved = await t.evaluate(read)
  t.is(moved.fwd['data-rate'], '101',
    'and the FORWARDED attribute moves with it — it used to freeze at its first value')
  t.is(moved.fwd.text, '101',
    'the component\'s own children agree, which they always did')
  t.is(moved.relayed['data-rate'], '101', 'two hops move too')
  t.is(moved.fwd['data-kind'], 'rate',
    'and a static attribute survives the push rather than being dropped by it')
  t.is(moved.fwd.id, 'fwd', 'so does the id')

  // ── a key LEAVING a spread ────────────────────────────────────────────────
  // The reason the rest object is rebuilt wholesale on every push rather than
  // merged: a merge can never remove a key, so a spread that stops carrying one
  // would leave it on the element for ever.
  await t.clickAt('#drop')
  await t.eventually(`document.querySelector('#fwd').hasAttribute('data-extra')`, false,
    'a key that leaves the spread leaves the element')

  const after = await t.evaluate(read)
  t.is(after.fwd['data-rate'], '101', 'and nothing else on it moved')
  t.is(after.fwd['data-kind'], 'rate', 'including the static one')
}
