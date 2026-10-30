/*
 * form-changed.spec.mjs — every kit form control tells its <Form> it changed.
 *
 * A hand-written <Form> heard a field change only through a bubbling `input`
 * or `change` event from an element carrying that field's `name`. A control
 * that commits on a click (a calendar day, a listbox option), from a hidden
 * or unnamed element, or from a key on a handle emitted nothing the form
 * could key on: the form stayed pristine, so no autosave and no unload guard,
 * and a server message sat under a field that had already been fixed
 * (`FJS-2590`). `$context.form.changed(name)` is the one owner (`FJS-D903`).
 *
 * Either way a control that forgets is silent, so this walks the component
 * list: every file in `components/forms/` is a control with a row in COMMITS
 * or is named in NOT_CONTROLS with the reason.
 */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'Form — every control reports a change'
export const covers = [
  'forms/Form', 'forms/Input', 'forms/Textarea', 'forms/Select', 'forms/Checkbox',
  'forms/Switch', 'forms/RadioGroup', 'forms/Slider', 'forms/Thresholds', 'forms/SignaturePad',
  'forms/NumberInput', 'forms/MoneyInput', 'forms/Combobox', 'forms/MultiSelect',
  'forms/DatePicker', 'forms/DateTimeInput', 'forms/CodeInput', 'forms/JsonInput', 'forms/MarkdownInput',
  'forms/FileUpload', 'forms/FileField', 'forms/GeoField', 'forms/Textbox',
]

const FORMS = fileURLToPath(new URL('../../../components/forms/', import.meta.url))

const NOT_CONTROLS = {
  Form:      'the owner itself',
  Field:     'a wrapper; holds no value',
  Fieldset:  'a wrapper; holds no value',
  Label:     'a label; holds no value',
  Button:    'a button; holds no value',
  FormField: 'the generated-form dispatcher; reaches the form through writeField',
}

const box = (ctl) => `[data-ctl=${ctl}]`

// A value written straight into an element, then announced the way a browser
// announces a typed or picked value.
const setValue = (sel, value) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
`
const click = (sel) => `document.querySelector(${JSON.stringify(sel)}).click(); return true;`

const dropFile = (ctl) => `
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(4)], 'a.txt', { type: 'text/plain' }));
  document.querySelector('${box(ctl)} .fjs-dropzone')
    .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
`

async function typeInto(t, sel, text) {
  await t.clickAt(sel)
  await t.type(text)
}

// field — the name the control is given; commit — a person committing a value.
const COMMITS = {
  Input:         { field: 'headline', commit: (t) => typeInto(t, `${box('Input')} input`, 'x') },
  Textarea:      { field: 'summary',  commit: (t) => typeInto(t, `${box('Textarea')} textarea`, 'x') },
  Select:        { field: 'plan',     commit: (t) => t.evaluate(setValue(`${box('Select')} select`, 'b')) },
  Checkbox:      { field: 'live',     commit: (t) => t.evaluate(click(`${box('Checkbox')} input`)) },
  Switch:        { field: 'notify',   commit: (t) => t.evaluate(click(`${box('Switch')} input`)) },
  RadioGroup:    { field: 'owner',    commit: (t) => t.evaluate(click(`${box('RadioGroup')} input[value=b]`)) },
  Slider:        { field: 'weight',   commit: async (t) => {
    await t.evaluate(`document.querySelector('${box('Slider')} .fjs-slider-handle').focus(); return true;`)
    await t.press('ArrowRight')
  } },
  Thresholds:    { field: 'cuts',     commit: (t) => t.evaluate(setValue(`${box('Thresholds')} input[type=range]`, '3')) },
  SignaturePad:  { field: 'signature', commit: async (t) => {
    // drag presses at viewport coordinates and does not scroll to them, as clickAt does.
    await t.evaluate(`document.querySelector('${box('SignaturePad')} canvas').scrollIntoView({ block: 'center' }); return true;`)
    await t.drag(`${box('SignaturePad')} canvas`, `${box('SignaturePad')} canvas`)
  } },
  NumberInput:   { field: 'seats',    commit: (t) => typeInto(t, `${box('NumberInput')} input`, '5') },
  MoneyInput:    { field: 'price',    commit: (t) => typeInto(t, `${box('MoneyInput')} input`, '5') },
  Combobox:      { field: 'region',   commit: async (t) => {
    await t.clickAt(`${box('Combobox')} [role=combobox]`)
    await t.press('ArrowDown')
    await t.evaluate(`return await waitVisible('${box('Combobox')} [role=option]');`)
    await t.clickAt(`${box('Combobox')} [role=option]`)
  } },
  MultiSelect:   { field: 'tags',     commit: async (t) => {
    await t.clickAt(`${box('MultiSelect')} [role=combobox]`)
    await t.evaluate(`return await waitVisible('${box('MultiSelect')} [role=option]');`)
    await t.clickAt(`${box('MultiSelect')} [role=option]`)
  } },
  DatePicker:    { field: 'due',      commit: (t) => t.clickAt(`${box('DatePicker')} button.fjs-dp-day`) },
  DateTimeInput: { field: 'at',       commit: (t) => t.evaluate(setValue(`${box('DateTimeInput')} input`, '2026-01-02T03:04')) },
  CodeInput:     { field: 'body',     commit: (t) => typeInto(t, `${box('CodeInput')} textarea`, 'x') },
  JsonInput:     { field: 'doc',      commit: (t) => t.evaluate(setValue(`${box('JsonInput')} textarea`, '5')) },
  MarkdownInput: { field: 'notes',    commit: (t) => typeInto(t, `${box('MarkdownInput')} textarea`, 'x') },
  FileUpload:    { field: 'files',   commit: (t) => t.evaluate(dropFile('FileUpload')) },
  FileField:     { field: 'photo',    commit: (t) => t.evaluate(dropFile('FileField')) },
  GeoField:      { field: 'site',     commit: (t) => t.evaluate(setValue(`${box('GeoField')} input:not([name])`, '3')) },
  // NORMAL's x writes the value from code, so no event carries it.
  Textbox:       { field: 'line',     commit: async (t) => {
    await t.clickAt(`${box('Textbox')} textarea`)
    await t.press('Escape')
    await t.press('x')
  } },
}

const dirty     = `document.querySelector('#dirty').textContent`
const errorKeys = `document.querySelector('#errorKeys').textContent`

export async function run(t) {
  const files = readdirSync(FORMS).filter((f) => f.endsWith('.mesa')).map((f) => f.slice(0, -5))
  for (const ctl of files) {
    t.ok(ctl in COMMITS || ctl in NOT_CONTROLS,
      `${ctl} is walked here, or named as not a control`)
  }

  await t.mount('form-changed')

  for (const [ctl, { field, commit }] of Object.entries(COMMITS)) {
    await t.evaluate(`window.kitReset(); window.kitFailWith({ ${field}: 'ERR-${field}' }); return true;`)
    await t.evaluate(`document.querySelector('#host form').requestSubmit(); return true;`)
    await t.eventually(errorKeys, field, `${ctl}: the rejected submit puts a server message on ${field}`)
    await t.eventually(dirty, 'false', `${ctl}: and the form is still pristine`)

    // A retired message above this control collapses its line, so a press
    // aimed at a rect read mid-collapse lands beside the target.
    await t.evaluate(`return await waitSettled('body');`)
    await commit(t)
    await t.eventually(dirty, 'true', `${ctl}: committing a value turns the form dirty`)
    await t.eventually(errorKeys, '', `${ctl}: and retires the server message on ${field}`)

    // A typed box fires its native `change` when it loses focus, and the next
    // submit disables it while focused, so that `change` would dirty the next
    // control's pristine form.
    await t.evaluate(`document.activeElement?.blur?.(); return true;`)
  }
}
