/*
 * color-input.spec.mjs — ColorInput picks a stored data colour: a radiogroup
 * of swatches and a native picker for anything else.
 *
 * Every app drew this by hand, a row of <button>s with no radio keys beside a
 * `type="color"`. Real radios give one tab stop and the arrows, so the keys
 * are driven here as well as the click. The fill is the data value through
 * `--data-accent`, so it must not follow the theme.
 * FJS-3625
 */
export const name = 'color input'
export const covers = ['forms/ColorInput']

const text = (sel) => `document.querySelector('${sel}')?.textContent.trim() ?? null`
const checked = (root) => `document.querySelector('${root} [role=radiogroup] input:checked')?.value ?? null`

export async function run(t) {
  await t.mount('color-input')

  await t.eventually(`document.querySelectorAll('#basic [role=radiogroup] input[type=radio]').length`, 3, 'one radio per swatch')
  await t.eventually(`document.querySelector('#basic [role=radiogroup]').getAttribute('aria-label')`, 'Color', 'the group is named')
  await t.eventually(checked('#basic'), '#22c55e', 'the value checks its swatch')
  await t.eventually(`getComputedStyle(document.querySelector('#basic .fjs-color-fill')).backgroundColor`, 'rgb(239, 68, 68)',
    'a swatch is filled with its data value')
  await t.eventually(`document.querySelector('#basic input[type=color]').value`, '#22c55e', 'the custom picker shows the value')

  await t.clickAt('#basic .fjs-color-option:nth-of-type(3)')
  await t.eventually(text('#picked'), '#3b82f6', 'clicking a swatch hands its value to onchange')

  await t.press('ArrowLeft')
  await t.eventually(text('#picked'), '#22c55e', 'an arrow moves to the previous swatch and picks it')
  await t.eventually(text('#calls'), '2', 'onchange once per pick')

  // A colour outside the set: no swatch is checked, the picker owns it.
  await t.eventually(checked('#custom'), null, 'a value outside the swatches checks none')
  await t.eventually(`document.querySelector('#custom input[type=color]').value`, '#abcdef', 'and sits in the custom picker')
  await t.eventually(`document.querySelector('#custom .fjs-color-custom').classList.contains('is-active')`, true,
    'which reads as the chosen one')
  await t.eventually(`document.querySelector('#custom [role=radiogroup]').getAttribute('aria-label')`, 'Brand colour', 'label names the group')

  await t.evaluate(`
    const el = document.querySelector('#custom input[type=color]');
    el.value = '#123456';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  await t.eventually(text('#custom-value'), '#123456', 'the custom picker writes the bound value')

  await t.clickAt('#custom .fjs-color-option:nth-of-type(1)')
  await t.eventually(text('#custom-value'), '#ef4444', 'a swatch replaces a custom colour')
  await t.eventually(`document.querySelector('#custom .fjs-color-custom').classList.contains('is-active')`, false,
    'and the picker stops reading as chosen')

  await t.eventually(`document.querySelector('#bare input[type=color]') === null`, true, 'custom={false} draws no picker')
  await t.eventually(checked('#bare'), null, "'' checks no swatch")
}
