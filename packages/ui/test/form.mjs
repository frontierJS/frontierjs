/*
 * form.mjs
 * <Form> and the form context.
 *
 * What is asserted here is the claim that makes <Form> worth having: a control
 * that was handed nothing but a `name` still comes out labelled, constrained
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

let failed = 0
let cases  = 0

async function render(source, data) {
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

console.log(
  failed
    ? `${failed} form assertion(s) failed`
    : `${cases}/${cases} form cases wire the schema and the error map into the DOM`,
)
if (failed) process.exit(1)
