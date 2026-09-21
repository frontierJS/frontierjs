/**
 * test/field-control-geo.test.js
 *
 * A `@point` column is a `Json` column, and `Json` is the one thing the schema
 * deliberately stops describing — so the built-in table answered `json` for it
 * and a generated form offered a DOCUMENT EDITOR for a latitude and a
 * longitude. That is the workaround the declaration exists to retire, rendered
 * by the framework itself.
 *
 * `x-geo` is what separates the two, and the KEY NAMES are the substance:
 * `@point(latitude, longitude)` is as ordinary as `@point(lat, lng)`, and a
 * control writing the other spelling writes a document the database's own
 * CHECK refuses. So the schemas here are generated from `.lite` source rather
 * than hand-written — a rule table typed into a test agrees with whatever it
 * says, including a keyword litestone does not emit.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

import {
  buildFieldRules, controlFor, defaultControlFor, displayFor,
  registerControl, unregisterControl,
} from '../src/junction/field-rules.js'

const SOURCE = `
model Visit {
  id      Int    @id @default(autoincrement())
  site    Json?  @point(lat, lng)
  meta    Json?
  @@gate("0.0.0.0")
}

model Survey {
  id     Int    @id @default(autoincrement())
  origin Json   @point(latitude, longitude)
  @@gate("0.0.0.0")
}
`

const rulesFor = (model) => {
  const parsed = parse(SOURCE)
  const js = generateJsonSchema(parsed.schema ?? parsed)
  return buildFieldRules(js.$defs[model], (ref) => js.$defs[ref.split('/').pop()])
}

afterEach(() => { unregisterControl('map') })

describe('a point column gets a point control', () => {
  test('litestone emits the two key names and nothing infers them', () => {
    const rules = rulesFor('Visit')
    expect(rules.site['x-geo']).toEqual({ lat: 'lat', lng: 'lng' })
    expect(rulesFor('Survey').origin['x-geo']).toEqual({ lat: 'latitude', lng: 'longitude' })
  })

  test('the control is geo, and it carries the keys a form has to write', () => {
    expect(controlFor(rulesFor('Visit').site)).toMatchObject({
      control: 'geo', latKey: 'lat', lngKey: 'lng',
    })
    expect(controlFor(rulesFor('Survey').origin)).toMatchObject({
      control: 'geo', latKey: 'latitude', lngKey: 'longitude',
    })
  })

  test('an ordinary Json column is still a document, which is the control this replaced', () => {
    // The negative control, and the row that makes the one above mean
    // something: answering `geo` for every Json column would satisfy that test
    // and put two number boxes over `settings Json`.
    expect(controlFor(rulesFor('Visit').meta).control).toBe('json')
  })

  test('it is decided on the keyword and not on the type', () => {
    // A point is `{}` in the schema — no `type` at all — exactly like the Json
    // column beside it, so a table waiting for `type: 'object'` sees neither
    // and a table branching on the type cannot tell them apart.
    const rules = rulesFor('Visit')
    expect(rules.site.type).toBe(rules.meta.type)
    expect(defaultControlFor(rules.site).control).toBe('geo')
  })

  test('a display renders it as a point too', () => {
    // Not `json`, which prints the document's punctuation into a table cell.
    expect(displayFor(rulesFor('Visit').site)).toMatchObject({
      display: 'geo', geo: { lat: 'lat', lng: 'lng' },
    })
  })

  test('an app that wants a map replaces the kit answer, without a fork', () => {
    // `FJS-D327` keeps a tile vendor out of this repo, so the escape has to be
    // the ordinary one: the same `x-geo`, a different name, a component the app
    // binds. Last registered is asked first.
    registerControl('map', (rule) => (rule['x-geo'] ? 'map' : null))
    expect(controlFor(rulesFor('Visit').site).control).toBe('map')
    expect(defaultControlFor(rulesFor('Visit').site).control).toBe('geo')
  })
})
