/*
 * form.mjs
 * <Form> and the form context.
 *
 * What is asserted here is the claim that makes <Form> worth having: a control
 * that was handed nothing but a `name` still comes out labeled, constrained
 * and carrying its server error, because the form put the schema and the error
 * map in context and the control read them.
 *
 * These render server-side, so they cover the WIRING (what each control
 * resolves and emits) and not the state machine (what happens on submit).
 * The machine's inputs — the thrown-value unwrapping and the create/patch
 * pipeline — are pinned in sierra's resource-validation.test.js, which has a
 * real runner. The machine end to end is example/'s `bun run verify`.
 *
 * Run: node test/form.mjs
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { renderComponent } from '../../mesa/src/render-component.js'
// The REAL control table, by relative path — the same rule Sierra hands a real
// resource. A fixture that decided for itself which control a `Float` gets
// would pass while the two disagreed, which is the whole failure this table
// exists to prevent. field-rules.js is a leaf and imports nothing.
import {
  formFieldList, registerControl, unregisterControl, registeredControls,
} from '../../sierra/src/junction/field-rules.js'
// The kit's half of a contributed control. Same module instance the fixtures
// below import through '../../controls.js' — both resolve to this file.
import { unregisterFormControl, registeredFormControls } from '../controls.js'

const ROOT   = fileURLToPath(new URL('..', import.meta.url))
// Two levels under the package root, so the relative imports a fixture writes
// are the same ones a real component writes. See the note in render.mjs.
const TMPDIR = join(ROOT, 'components', '.mesa-tmp')

// What createResource() hands a form: buildFieldRules() output plus the two
// functions Form calls. Shaped from db/schema.lite, not invented here —
// `title` is @label, `maxLength` is @length, `format` is the column type.
const RESOURCE = {
  context: { model: 'Lead', service: 'leads', idField: 'id' },
  fields: {
    name:  { type: 'string', required: true,  maxLength: 20, minLength: 1 },
    email: { type: 'string', required: true,  format: 'email', title: 'Email address' },
    score: { type: 'number', required: false, minimum: 0, maximum: 100 },
    site:  { type: 'string', required: false, format: 'uri' },
    notes: { type: 'string', required: false },
  },
  make: () => ({ name: '', email: '', score: 0, site: '', notes: '' }),
  fieldErrors: () => ({ fields: {}, message: '' }),
  service: {},
}
RESOURCE.formFields = (opts) => formFieldList(RESOURCE.fields, opts)
RESOURCE.options    = () => Promise.resolve([])

// A model with one of everything the control table has an answer for, plus one
// it does not. Field ORDER here is the order a generated form must render.
const ORDER = {
  context: { model: 'Order', service: 'orders', idField: 'id' },
  fields: {
    reference:  { type: 'string',  required: true, maxLength: 20 },
    status:     { type: 'string',  required: false, enum: ['pending', 'paid', 'shipped'] },
    total:      { type: 'number',  required: false, minimum: 0 },
    active:     { type: 'boolean', required: false, title: 'Is live' },
    body:       { type: 'string',  required: false, contentMediaType: 'text/markdown' },
    dueOn:      { type: 'string',  required: false, format: 'date' },
    customerId: { type: 'integer', required: true, title: 'Customer',
                  references: { model: 'Customer', field: 'id', relation: 'customer' } },
    computed:   { type: 'string',  required: false, readOnly: true },
    tags:       { type: 'array',   required: false },
    // A type the control table has never heard of — the case the warning below
    // exists for. `array` and `object` used to be it, and both have a control
    // now, so without a column like this the warning has nothing to fire on and
    // stops being tested at all.
    shape:      { type: 'geography', required: false },
  },
  make: () => ({}),
  fieldErrors: () => ({ fields: {}, message: '' }),
  service: {},
}
ORDER.formFields = (opts) => formFieldList(ORDER.fields, opts)
ORDER.options    = () => Promise.resolve([])

let failed = 0
let cases  = 0

// What the render said out loud. A generated form REPORTS the columns it could
// not give a control, so the warnings are part of the behavior under test —
// captured rather than printed, and asserted below.
let warnings = []

async function render(source, data) {
  warnings = []
  const realWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    return await _render(source, data)
  } finally {
    console.warn = realWarn
  }
}

async function _render(source, data) {
  const out = await renderComponent(source, {
    data,
    // Both the entry source's imports and the nested ones resolve from here,
    // so a fixture writes the same relative paths a real component does.
    cwd: TMPDIR,
    filename: 'fixture.mesa',
    styleTag: false,
    tmpDir: TMPDIR,
  })
  return out.html
}

async function check(label, source, data, assertions) {
  cases++
  let html
  try {
    html = await render(source, data)
  } catch (err) {
    console.error(`✗ ${label}\n    render threw: ${err.message}`)
    failed++
    return
  }
  for (const [what, ok] of Object.entries(assertions)) {
    if (!ok(html)) {
      console.error(`✗ ${label}\n    ${what}\n    got: ${html.replace(/\s+/g, ' ').slice(0, 400)}`)
      failed++
    }
  }
}

const has    = (re) => (html) => re.test(html)
const hasNot = (re) => (html) => !re.test(html)

// ── A form over a resource, with controls given nothing but a name ──────────

await check(
  'schema reaches a control that was told only its name',
  `<script>
     import Form from '../forms/Form.mesa'
     import Input from '../forms/Input.mesa'
     export let resource
   </script>
   <Form {resource}>
     <Input name="email" />
     <Input name="score" />
     <Input name="site" />
   </Form>`,
  { resource: RESOURCE },
  {
    'the @label reached the label element':      has(/Email address/),
    'a labelless column was title-cased':        has(/>\s*Score\s*</),
    'format: email became type="email"':         has(/type="email"/),
    'format: uri became type="url"':             has(/type="url"/),
    'a numeric column became type="number"':     has(/type="number"/),
    'required came from the schema':             has(/required/),
    'the numeric bounds came from the schema':   has(/max="100"/),
    'novalidate is on by default':               has(/novalidate/),
  },
)

await check(
  'a string column carries its @length as maxlength',
  `<script>
     import Form from '../forms/Form.mesa'
     import Input from '../forms/Input.mesa'
     export let resource
   </script>
   <Form {resource}><Input name="name" /></Form>`,
  { resource: RESOURCE },
  {
    'maxLength became maxlength': has(/maxlength="20"/),
    'minLength became minlength': has(/minlength="1"/),
  },
)

// ── Errors reach a control nobody handed an error map to ────────────────────

await check(
  'a server error map reaches the right field through context',
  `<script>
     import Form from '../forms/Form.mesa'
     import Input from '../forms/Input.mesa'
     export let resource
     export let errors
   </script>
   <Form {resource} {errors}>
     <Input name="email" />
     <Input name="notes" />
   </Form>`,
  { resource: RESOURCE, errors: { email: 'That address is already taken' } },
  {
    'the message rendered':                 has(/That address is already taken/),
    'it is toned danger on the hint':       has(/class="field-hint danger\b/),
    'it is announced':                      has(/role="alert"/),
    'the field is marked invalid':          has(/aria-invalid="true"/),
    'exactly one field claimed the error':  (html) => (html.match(/role="alert"/g) ?? []).length === 1,
  },
)

await check(
  'a form-level failure renders as an Alert, not under a field',
  `<script>
     import Form from '../forms/Form.mesa'
     import Input from '../forms/Input.mesa'
     export let resource
     export let formError
   </script>
   <Form {resource} {formError}><Input name="email" /></Form>`,
  { resource: RESOURCE, formError: 'Service unavailable' },
  {
    'the message rendered':      has(/Service unavailable/),
    'as an alert surface':       has(/class="[^"]*\balert\b[^"]*danger/),
    'no field-hint claimed it':  hasNot(/field-hint danger/),
  },
)

// ── An explicit prop always beats the schema ────────────────────────────────

await check(
  'a stated prop wins over the schema, including a falsy one',
  `<script>
     import Form from '../forms/Form.mesa'
     import Input from '../forms/Input.mesa'
     export let resource
   </script>
   <Form {resource}>
     <Input name="email" label="Work email" type="text" required={false} />
   </Form>`,
  { resource: RESOURCE },
  {
    'the stated label won':        has(/Work email/),
    'the schema label lost':       hasNot(/Email address/),
    'the stated type won':         has(/type="text"/),
    'required={false} disarmed it': hasNot(/\brequired\b/),
  },
)

// ── Standing alone, nothing changes ─────────────────────────────────────────

await check(
  'a control outside any form still renders',
  `<script>
     import Input from '../forms/Input.mesa'
   </script>
   <Input name="email" label="Email" />`,
  {},
  {
    'the label rendered':     has(/Email/),
    'the control rendered':   has(/class="field\b/),
    'type fell back to text': has(/type="text"/),
  },
)

// ── The submit button reports the form's state ──────────────────────────────

await check(
  'a submit button spins while the form is in flight',
  `<script>
     import Form from '../forms/Form.mesa'
     import Button from '../forms/Button.mesa'
     export let resource
     export let submitting
   </script>
   <Form {resource} {submitting}>
     <Button type="submit">Save</Button>
     <Button type="button">Cancel</Button>
   </Form>`,
  { resource: RESOURCE, submitting: true },
  {
    'the submit button is busy':      has(/aria-busy="true"/),
    'and drawn as loading':           has(/class="[^"]*\bloading\b/),
    'and disabled':                   has(/disabled/),
    // The cancel button has to stay live — you abandon a save while it runs.
    // The <form> is aria-busy too, so count buttons rather than occurrences.
    'only the submit button went busy':
      (html) => (html.match(/<button[^>]*aria-busy="true"/g) ?? []).length === 1,
    'only the submit button was disabled':
      (html) => (html.match(/<button[^>]*disabled/g) ?? []).length === 1,
  },
)

// ── The generated field list ────────────────────────────────────────────────
//
// `<Form {resource} />` with no children. What is asserted is that the field
// SET and the control each field gets both come off the schema — the last two
// things a form still restated about a model.

const GEN = `<script>
   import Form from '../forms/Form.mesa'
   export let resource
 </script>
 <Form {resource} />`

await check(
  'every writable column is rendered, in schema order, with nothing named',
  GEN,
  { resource: ORDER },
  {
    'the string column is there':   has(/name="reference"/),
    'the enum column is there':     has(/name="status"/),
    'the numeric column is there':  has(/name="total"/),
    'the boolean column is there':  has(/name="active"/),
    'the date column is there':     has(/name="dueOn"/),
    'the foreign key is there':     has(/name="customerId"/),
    'in schema order': (html) =>
      html.indexOf('name="reference"') < html.indexOf('name="status"') &&
      html.indexOf('name="status"')    < html.indexOf('name="total"') &&
      html.indexOf('name="total"')     < html.indexOf('name="customerId"'),
  },
)

await check(
  'each column gets the control its type implies',
  GEN,
  { resource: ORDER },
  {
    'an enum became a select carrying its members':
      has(/<select[^>]*name="status"[\s\S]*?<option value="pending"[\s\S]*?<option value="shipped"/),
    'a boolean became a checkbox':      has(/type="checkbox"[^>]*name="active"|name="active"[^>]*type="checkbox"/),
    'and the checkbox says its @label': has(/Is live/),
    'markdown became a textarea':       has(/<textarea[^>]*name="body"/),
    'a date became type="date"':        has(/name="dueOn"[^>]*type="date"|type="date"[^>]*name="dueOn"/),
    'a number became type="number"':    has(/name="total"[^>]*type="number"|type="number"[^>]*name="total"/),
    // The one field where a spinner is obviously wrong. It is a SEARCHABLE
    // select rather than a native one (`FJS-459`): the rows arrive from the
    // related service after mount and the server caps them, so a control with
    // no way to type cannot reach past the page it was handed.
    'a foreign key became a searchable select, not a number input':
      has(/role="combobox"[^>]*|<input[^>]*name="customerId"/),
    'and it announces itself as one to assistive tech':
      has(/name="customerId"[\s\S]{0,400}?role="combobox"|role="combobox"[\s\S]{0,400}?name="customerId"/),
    'and it is not a number input':
      hasNot(/name="customerId"[^>]*type="number"/),
  },
)

await check(
  'the labels and constraints still come from the schema, not from the generator',
  GEN,
  { resource: ORDER },
  {
    'the @label on the foreign key won':  has(/Customer/),
    'a labelless column was title-cased': has(/>\s*Reference\s*</),
    '@length reached the input':          has(/maxlength="20"/),
    'required came off the schema':       has(/required/),
  },
)

await check(
  'a column with no control is left out — and says so, rather than vanishing',
  GEN,
  { resource: ORDER },
  {
    'a column of an unknown type is not rendered': hasNot(/name="shape"/),
    'a readOnly column is not rendered':  hasNot(/name="computed"/),
    // The silence is the bug this row exists to end: a column added to .lite
    // that never appears, in the one place a person would look for it.
    'the unrenderable column was named out loud': () =>
      warnings.some(w => w.includes('Order.shape') && w.includes('geography')),
    // …and an array is no longer one of them. It has no field list under it, so
    // it is edited as its own syntax rather than dropped.
    'an array column renders as the json control': has(/name="tags"/),
    // …but a readOnly column is the SCHEMA saying it is not the caller's to
    // write — @system, @computed, @generated, @from. The form leaving it out is
    // the annotation working, not a gap in the kit, so it says nothing.
    'a readOnly column is not complained about': () =>
      !warnings.some(w => w.includes('Order.computed')),
  },
)

await check(
  '`only` narrows and orders; `except` removes',
  `<script>
     import Form from '../forms/Form.mesa'
     export let resource
   </script>
   <div>
     <Form {resource} only={['status', 'reference']} />
     <Form {resource} except={['reference', 'status', 'total', 'active', 'body', 'dueOn']} />
   </div>`,
  { resource: ORDER },
  {
    'only kept what it named':      has(/name="reference"/),
    'only dropped what it did not': hasNot(/name="total"/),
    'only ordered by its own list': (html) =>
      html.indexOf('name="status"') < html.indexOf('name="reference"'),
    'except left the rest':         has(/name="customerId"/),
  },
)

await check(
  'children win — a caller writing the form gets no generated fields',
  `<script>
     import Form from '../forms/Form.mesa'
     import Input from '../forms/Input.mesa'
     export let resource
   </script>
   <Form {resource}><Input name="reference" /></Form>`,
  { resource: ORDER },
  {
    'the stated control rendered':  has(/name="reference"/),
    'nothing else was generated':   hasNot(/name="total"/),
    'not even the foreign key':     hasNot(/name="customerId"/),
  },
)

await check(
  'auto with children renders both, generated first',
  `<script>
     import Form from '../forms/Form.mesa'
     import Input from '../forms/Input.mesa'
     export let resource
   </script>
   <Form {resource} auto={true} only={['reference']}>
     <Input name="afterwards" />
   </Form>`,
  { resource: ORDER },
  {
    'the generated field rendered': has(/name="reference"/),
    'so did the child':             has(/name="afterwards"/),
    'generated first':              (html) =>
      html.indexOf('name="reference"') < html.indexOf('name="afterwards"'),
  },
)

// ── A contributed control ───────────────────────────────────────────────────
//
// `FJS-D17`. A control is two registrations in two packages — the NAME comes
// from Sierra's table (a leaf that runs in plain Node and cannot hold a
// component) and the COMPONENT from this kit. What is asserted here is that
// both halves meet: a column the built-in table has no answer for renders, and
// a registered name replaces a built-in of the same name rather than losing to
// it.
//
// Registration happens inside the fixture's own script so it runs before the
// <Form> under it instantiates — which is also where an app would put it.

const clearRegistrations = () => {
  for (const name of registeredControls()) unregisterControl(name)
  for (const name of registeredFormControls()) unregisterFormControl(name)
}

await check(
  'a column the kit has no control for renders once an app contributes one',
  `<script>
     import Form  from '../forms/Form.mesa'
     import Stars from '../../test/fixtures/Stars.mesa'
     import { registerControl }     from '../../../sierra/src/junction/field-rules.js'
     import { registerFormControl } from '../../controls.js'
     export let resource

     registerControl('stars', (rule, ctx) =>
       (ctx.field === 'tags' ? { control: 'stars', max: 3 } : null))
     registerFormControl('stars', Stars)
   </script>
   <Form {resource} />`,
  { resource: ORDER },
  {
    'the contributed control rendered':      has(/data-control="stars"/),
    'and it was handed the column name':     has(/<input[^>]*name="tags"/),
    'and the descriptor reached it whole':   has(/<input[^>]*max="3"/),
    'the built-in columns still render':     has(/name="reference"/),
    // The array column was the one <Form> used to warn about by name. It has a
    // control now, so the warning has to stop — a warning that never goes quiet
    // is one nobody reads.
    'and it is no longer reported as unrenderable': () =>
      !warnings.some(w => w.includes('Order.tags')),
  },
)
clearRegistrations()

await check(
  'a registered name replaces the built-in of that name, everywhere at once',
  `<script>
     import Form  from '../forms/Form.mesa'
     import Stars from '../../test/fixtures/Stars.mesa'
     import { registerFormControl } from '../../controls.js'
     export let resource

     registerFormControl('checkbox', Stars)
   </script>
   <Form {resource} only={['active', 'reference']} />`,
  { resource: ORDER },
  {
    'the replacement rendered for the boolean column': has(/data-control="stars"/),
    'the kit control it replaced did not':             hasNot(/type="checkbox"/),
    'and nothing else moved':                          has(/name="reference"/),
  },
)
clearRegistrations()

await check(
  'a control nobody bound a component to says which half is missing',
  `<script>
     import Form from '../forms/Form.mesa'
     import { registerControl } from '../../../sierra/src/junction/field-rules.js'
     export let resource

     registerControl('half', (rule, ctx) => (ctx.field === 'reference' ? 'tag-input' : null))
   </script>
   <Form {resource} only={['reference', 'total']} />`,
  { resource: ORDER },
  {
    'the unbound field rendered nothing':  hasNot(/name="reference"/),
    'the rest of the form still rendered': has(/name="total"/),
    'and the missing half was named': () =>
      warnings.some(w => w.includes('tag-input') && w.includes('registerFormControl')),
  },
)
clearRegistrations()

console.log(
  failed
    ? `${failed} form assertion(s) failed`
    : `${cases}/${cases} form cases wire the schema and the error map into the DOM`,
)
if (failed) process.exit(1)
