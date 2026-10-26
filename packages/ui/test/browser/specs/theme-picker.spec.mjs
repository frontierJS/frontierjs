/*
 * theme-picker.spec.mjs — ThemeSwatch draws in its own theme; ThemePicker
 * picks one over real radios.
 *
 * The apps that drew their own picker used <button role="radio">, which has
 * the role and none of the keys: every theme was a tab stop and the arrows
 * did nothing. A real radio group is one tab stop with arrows between, so the
 * keys are what this drives, not just the click.
 */
export const name = 'theme swatch and picker'
export const covers = ['display/ThemeSwatch', 'display/ThemePicker']

const text = (sel) => `document.querySelector('${sel}')?.textContent.trim() ?? null`

export async function run(t) {
  await t.mount('theme-picker')

  /* ── ThemeSwatch ──────────────────────────────────────────────────── */

  await t.eventually(text('#swatch-default .fjs-theme-label'), 'Dracula', 'the name comes from @frontierjs/css/themes.js')
  await t.eventually(text('#swatch-default .fjs-theme-blurb'), 'Violet and pink on dark', 'and so does the line')
  await t.eventually(`document.querySelector('#swatch-bare .fjs-theme-text') === null`, true,
    'label="" and blurb="" draw no text')
  await t.eventually(text('#swatch-unknown .fjs-theme-label'), 'theme-house', 'a theme the data does not know shows its class')
  await t.eventually(`getComputedStyle(document.querySelector('#swatch-default .fjs-theme-chip')).colorScheme`, 'dark',
    'the chip computes its own theme under a light page')
  await t.eventually(`getComputedStyle(document.querySelector('#swatch-default .fjs-theme-chip')).backgroundColor
    !== getComputedStyle(document.body).backgroundColor`, true, 'and draws its own surface')

  /* ── ThemePicker ──────────────────────────────────────────────────── */

  const checked = (root) => `document.querySelector('${root} input:checked')?.value ?? null`

  await t.eventually(`document.querySelectorAll('#picker [role=radiogroup] input[type=radio]').length`, 3, 'one radio per theme')
  await t.eventually(`document.querySelector('#picker [role=radiogroup]').getAttribute('aria-label')`, 'Theme', 'the group is named')
  await t.eventually(checked('#picker'), 'theme-forest', 'the value checks its card')

  await t.clickAt('#picker .fjs-theme-option:nth-of-type(3)')
  await t.eventually(text('#picked'), 'theme-dracula', 'clicking a card hands its class to onchange')

  // Arrow keys move the check within the group; that is the platform's, and
  // only real radios get it.
  await t.press('ArrowLeft')
  await t.eventually(text('#picked'), 'theme-forest', 'an arrow moves to the next theme and picks it')
  await t.eventually(`document.activeElement?.value`, 'theme-forest', 'and focus goes with it')
  await t.eventually(text('#calls'), '2', 'onchange once per pick')

  await t.eventually(checked('#picker-system'), null, "'system' checks no card")
}
