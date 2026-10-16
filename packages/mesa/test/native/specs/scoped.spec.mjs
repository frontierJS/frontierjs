/*
 * scoped — a component's scoped `<style>` reaches the bundle's stylesheet and
 * matches its elements, and `class:`, `style` and `style:` paint and move.
 * Read off Chrome's computed style, so it pins that the rules arrive and
 * match on Lynx for Web; what a phone paints of them is `--device`.
 */
const paint = (cls, prop) => `(() => {
  const el = document.querySelector('lynx-view')?.shadowRoot?.querySelector('.${cls}');
  return el ? getComputedStyle(el)[${JSON.stringify(prop)}] : null;
})()`

export async function run(t) {
  await t.open('Scoped')
  await t.eventually(t.shows('Scoped', 'Flip'), true, 'it paints')
  await t.eventually(paint('card', 'backgroundColor'), 'rgb(10, 20, 30)', 'a scoped class rule paints')
  await t.eventually(paint('label', 'color'), 'rgb(200, 100, 0)', 'a scoped child-combinator rule paints')
  await t.eventually(paint('swatch', 'width'), '40px', 'the style attribute paints')
  await t.eventually(paint('swatch', 'backgroundColor'), 'rgb(0, 0, 200)', 'a style: property paints')
  await t.tap('Flip')
  await t.eventually(paint('card', 'backgroundColor'), 'rgb(40, 50, 60)', 'a class: toggle switches the rule')
  await t.eventually(paint('swatch', 'backgroundColor'), 'rgb(0, 200, 0)', 'a style: property moves')
  await t.eventually(paint('swatch', 'width'), '40px', 'the style attribute survives the style: write')
}
