/**
 * test/control-task.test.js
 *
 * `controlFor` answers a TASK beside the control — what the person does to the
 * value (select, quantify, text, position; Foley, Wallace & Chan 1984) as
 * against the technique that does it (`IDEAS/ui-ontology.md` § 7 step 3).
 *
 * The failure this guards is a branch added to the table with no task on it:
 * nothing renders differently, so the only thing that notices is a test that
 * visits every control the table can answer and asks each for its task. The
 * visit is checked against the list of control names too, because a test that
 * iterates the fields it happens to have passes when a branch has none.
 *
 * The rules are generated from `.lite`, as the table's other suites are; the
 * value sets are written out, because a `@values` binding needs a second model
 * and a set declaration to reach the schema at all.
 */

import { describe, test, expect, afterEach, vi } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

import {
  buildFieldRules, controlFor, registerControl, unregisterControl, INTERACTION_TASKS,
} from '../src/junction/field-rules.js'

const SOURCE = `
enum Status { open closed }

model Customer {
  id    Int    @id @default(autoincrement())
  name  String
  @@gate("0.0.0.0")
}

model Visit {
  id         Int      @id @default(autoincrement())
  name       String
  body       String   @markdown
  count      Int
  weight     Float
  serial     Int      @big
  done       Boolean
  dueOn      DateTime @date
  startsAt   DateTime
  opensAt    String   @time
  status     Status
  price      Int      @money(USD)
  rate       Int      @scale(2)
  photo      File?
  site       Json?    @point(lat, lng)
  settings   Json
  tags       String[]
  customer   Customer @relation(fields: [customerId], references: [id])
  customerId Int
  @@gate("0.0.0.0")
}
`

const schema = generateJsonSchema(parse(SOURCE).schema)
const fields = buildFieldRules(schema.$defs.Visit, (ref) => schema.$defs[ref.split('/').pop()])

const str    = { type: 'string' }
const values = (over = {}) => ({
  set: 'VisitTag', strength: 'required', model: 'Tag', value: 'label', label: 'label', ...over,
})
const SETS = buildFieldRules({
  type: 'object',
  properties: {
    required: { ...str, 'x-values': values() },
    open:     { ...str, 'x-values': values({ strength: 'open' }) },
    many:     { type: 'array', items: str, 'x-values': values({ strength: 'open' }) },
  },
}, () => null)

// Every name the built-in table can answer. A new branch naming a new control
// fails here until it is listed, which is where its task gets decided.
const CONTROLS = [
  'checkbox', 'combobox', 'datetime', 'file', 'geo', 'input',
  'json', 'multiselect', 'picker', 'select', 'textarea',
]

afterEach(() => {
  unregisterControl('stars')
  unregisterControl('odd')
  unregisterControl('silent')
  vi.restoreAllMocks()
})

describe('every built-in answer names its task', () => {
  const answers = [
    ...Object.entries(fields).map(([name, rule]) => [name, controlFor(rule, { field: name, model: 'Visit' })]),
    ...Object.entries(SETS).map(([name, rule]) => [name, controlFor(rule)]),
  ]

  test('each control the table can answer is visited', () => {
    const seen = new Set(answers.map(([, a]) => a.control).filter(Boolean))
    expect([...seen].sort()).toEqual(CONTROLS)
  })

  test('each answer with a control carries one of the five tasks', () => {
    for (const [name, answer] of answers) {
      if (answer.control == null) continue
      expect(INTERACTION_TASKS, `${name} → ${answer.control}`).toContain(answer.task)
    }
  })

  test('the task follows the column, not the control', () => {
    const task = (name) => answers.find(([n]) => n === name)[1].task

    // One control, two tasks: an `input` over a count is quantify, over a name text.
    expect(task('count')).toBe('quantify')
    expect(task('name')).toBe('text')
    expect(task('serial')).toBe('quantify')
    expect(task('dueOn')).toBe('quantify')
    expect(task('opensAt')).toBe('quantify')

    // One task, five controls.
    for (const name of ['done', 'status', 'customerId', 'required', 'open', 'many']) {
      expect(task(name), name).toBe('select')
    }
    expect(task('site')).toBe('position')
    expect(task('photo')).toBe('bytes')
  })

  test('@money names its task and has no technique for it', () => {
    const answer = controlFor(fields.price)
    expect(answer.control).toBeNull()
    expect(answer.task).toBe('quantify')
    expect(answer.reason).toMatch(/register a control/)
  })

  test('a column nobody writes answers no task', () => {
    // buildFieldRules keeps a read-only column out of the list, so the rule is
    // written out rather than generated.
    expect(controlFor({ type: 'string', readOnly: true })).toEqual({ control: null, reason: 'readOnly' })
  })
})

describe('a registered control and the task', () => {
  test('a contribution that says nothing inherits the column\'s task', () => {
    registerControl('stars', (rule) => (rule.type === 'number' ? 'stars' : null))
    expect(controlFor(fields.weight)).toMatchObject({ control: 'stars', by: 'stars', task: 'quantify' })
  })

  test('a contribution may claim a task of its own', () => {
    // A choice of five fixed ratings over an integer is a select, whatever
    // the column's type would have said.
    registerControl('stars', (rule) => (rule.type === 'integer' ? { control: 'stars', task: 'select' } : null))
    expect(controlFor(fields.count).task).toBe('select')
  })

  test('a claim outside the five is replaced by the table\'s, and said', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerControl('odd', (rule) => (rule.type === 'boolean' ? { control: 'odd', task: 'orient' } : null))

    expect(controlFor(fields.done)).toMatchObject({ control: 'odd', task: 'select' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/'odd' claimed the task 'orient'/))
  })

  test('a contribution over a type the table does not know carries no task', () => {
    registerControl('silent', (rule) => (rule.unknownThing ? 'silent' : null))
    const answer = controlFor({ type: 'mystery', unknownThing: true })
    expect(answer).toEqual({ control: 'silent', by: 'silent' })
  })
})
