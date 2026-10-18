/*
 * no-legacy-aliases.mjs
 * FJS-1140: one name for one thing. `tone` is the colour prop and `square` the
 * icon-only shape; a component that also declares `color`, `type`, `variant`
 * or `icon` for the same job keeps a second spelling alive that only training
 * data can reach, since AGENTS.md teaches the first.
 *
 * Run: node test/no-legacy-aliases.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderComponent } from '../../mesa/src/render-component.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let failed = 0
const check = (ok, label) => { if (!ok) { console.error(`✗ ${label}`); failed++ } }

// Components that once declared a second spelling, and the spelling they dropped.
const GONE = {
  'display/Badge': 'color',  'display/Dot': 'color',   'display/Pill': 'color',
  'display/Sparkline': 'color', 'display/Stat': 'color', 'display/StatCard': 'color',
  'display/Tag': 'color',    'feedback/Progress': 'color', 'feedback/Spinner': 'color',
  'forms/Slider': 'color',   'display/Callout': 'type', 'feedback/Alert': 'type',
  'feedback/Toast': 'type',  'forms/Button': 'icon',
  'overlay/ConfirmationPopover': 'variant', 'overlay/DropdownItem': 'variant',
}

for (const [name, prop] of Object.entries(GONE)) {
  const src = readFileSync(join(ROOT, 'components', `${name}.mesa`), 'utf8')
  check(!new RegExp(`export let ${prop}\\b`).test(src), `${name} declares no \`${prop}\``)
}

// And nothing in the kit calls itself a legacy alias.
for (const name of Object.keys(GONE)) {
  const src = readFileSync(join(ROOT, 'components', `${name}.mesa`), 'utf8')
  check(!/export let [^\n]*legacy/i.test(src), `${name} has no prop commented legacy`)
}

async function render(file, data) {
  const out = await renderComponent(readFileSync(join(ROOT, file), 'utf8'), {
    data, cwd: ROOT, filename: file, styleTag: false,
    tmpDir: join(ROOT, 'components', '.mesa-tmp'),
  })
  return out.html
}

// The caller's `type="error"` is no longer a tone; `tone="danger"` still is.
{
  const html = await render('components/feedback/Alert.mesa', { type: 'error', tone: '' })
  check(!/\bdanger\b/.test(html), 'Alert type="error" no longer resolves to danger')
  const ok = await render('components/feedback/Alert.mesa', { tone: 'danger' })
  check(/\bdanger\b/.test(ok), 'Alert tone="danger" does')
}

// FJS-3265: tone() answers the seven tones and nothing else -- a hue or a
// foreign semantic name is a typo, and it renders untoned.
{
  const { tone, TONES } = await import('../utils.js')
  for (const name of TONES) check(tone(name) === name, `tone('${name}') is itself`)
  for (const name of ['error', 'neutral', 'gray', 'red', 'green', 'blue', 'teal', 'amber', 'pink', 'default', 'none', 'Danger']) {
    check(tone(name) === '', `tone('${name}') is not a tone`)
  }
  check(tone('') === '' && tone(undefined) === '' && tone(null) === '', 'tone() of nothing is untoned')

  const { toasts } = await import('../stores/toastStore.js')
  const { alert }  = await import('../stores/alertStore.js')
  toasts.error('x')
  check(toasts.items.at(-1).type === 'danger', 'toasts.error() writes the danger tone')
  toasts.clear()
  alert.error('x')
  check(alert.type === 'danger', 'alert.error() writes the danger tone')
  alert.hide()
}

if (failed) { console.error(`${failed} failed`); process.exit(1) }
console.log('no-legacy-aliases: ok')
