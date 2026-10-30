// ─── diagram.test.js — the digest `project:diagram` sends, and the page it keeps
//
// The run itself is `ask-claude.test.js`'s draw argv; what this module owns is
// what goes in (the heart, not the boilerplate) and which page comes back out.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APP_PROMPT, DIAGRAM_PROMPT, diagramDigest, diagramPrompt, pageOf, readNotes, restarted, surfacePages } from '../core/diagram.js'

const dir = mkdtempSync(join(tmpdir(), 'fli-diagram-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const map = {
  schema: { $defs: {
    Project: {
      'x-litestone-kind': 'model',
      properties: { clientId: {}, stage: {}, name: {} },
      'x-relations': [
        { field: 'client', model: 'Client', type: 'belongsTo' },
        { field: 'todos', model: 'Todo', type: 'hasMany' },
      ],
    },
    Client: { 'x-litestone-kind': 'model', properties: { name: {} } },
    Stage:  { type: 'string', enum: ['lead', 'live'] },
  } },
  access: { models: [
    { name: 'Project', transitions: [{ name: 'golive', from: ['qa', 'deployment'], to: 'live' }] },
    { name: 'Client', transitions: [] },
  ] },
}
const atlas = { app: {
  services: [
    { name: 'projects', model: 'projects', customMethods: ['convert', 'golive'] },
    { name: 'clients', model: 'clients', customMethods: [] },
  ],
  routes: [
    { method: 'GET', path: '/api/{service}', kind: 'service' },
    { method: 'POST', path: '/api/intake/{token}', kind: 'raw' },
  ],
} }

describe('diagramDigest', () => {

  test('machines, belongsTo refs, verbs and raw routes; enums, hasMany and plain CRUD left out', () => {
    const d = diagramDigest({ name: 'app', map, atlas, notes: 'Turns leads into sites.', surfaces: [{ name: 'web', pages: 3 }] })
    expect(d.app).toEqual({ name: 'app' })
    expect(d.machines).toEqual([{ model: 'Project', moves: ['golive: qa|deployment→live'] }])
    expect(d.models).toEqual([
      { name: 'Client', refs: [], fields: 1 },
      { name: 'Project', refs: ['Client'], fields: 3 },
    ])
    expect(d.services).toEqual([{ name: 'projects', model: 'projects', verbs: ['convert', 'golive'] }])
    expect(d.rawRoutes).toEqual(['POST /api/intake/{token}'])
    expect(d.surfaces).toEqual([{ name: 'web', pages: 3 }])
    expect(d.notes).toBe('Turns leads into sites.')
  })

  test('no notes, no key; an empty model reads as empty', () => {
    expect('notes' in diagramDigest({ name: 'app', map, atlas })).toBe(false)
    expect(diagramDigest({ name: 'app', map: {}, atlas: {} })).toEqual({ app: { name: 'app' }, machines: [], models: [], services: [], rawRoutes: [], surfaces: [] })
  })

})

describe('the app around it', () => {

  test('the prompt: the one asked for, else the app\'s own, else the package\'s', () => {
    const app = join(dir, 'prompt-app')
    mkdirSync(app, { recursive: true })
    expect(diagramPrompt(app)).toBe(DIAGRAM_PROMPT)
    mkdirSync(join(app, 'cli/prompts'), { recursive: true })
    writeFileSync(join(app, APP_PROMPT), 'mine')
    expect(diagramPrompt(app)).toBe(join(app, APP_PROMPT))
    expect(diagramPrompt(app, 'other.md')).toBe(join(app, 'other.md'))
  })

  test('surfaces are the UI ones present, with their route files counted', () => {
    const app = join(dir, 'surface-app')
    mkdirSync(join(app, 'web/src/routes/clients'), { recursive: true })
    mkdirSync(join(app, 'api/src/routes'), { recursive: true })
    writeFileSync(join(app, 'web/src/routes/index.mesa'), '')
    writeFileSync(join(app, 'web/src/routes/clients/[id].mesa'), '')
    expect(surfacePages(app)).toEqual([{ name: 'web', pages: 2 }])
  })

  test('notes are read when the file is there and null when it is not or none is named', () => {
    writeFileSync(join(dir, 'NOTES.md'), 'about')
    expect(readNotes(dir, 'NOTES.md')).toBe('about')
    expect(readNotes(dir, 'MISSING.md')).toBe(null)
    expect(readNotes(dir, '')).toBe(null)
  })

})

describe('pageOf', () => {

  test('the page from its doctype to its last </html>, whatever wraps it', () => {
    expect(pageOf('Here:\n<!doctype html><html></html>\nDone.')).toBe('<!doctype html><html></html>')
    expect(pageOf('no page')).toBe(null)
    expect(pageOf('<!doctype html><html> cut off')).toBe(null)
  })

  test('a reply that started over keeps the last whole page and says so', () => {
    const text = '<!DOCTYPE html><html>first, cut<!doctype html><html>second</html>'
    expect(pageOf(text)).toBe('<!doctype html><html>second</html>')
    expect(restarted(text)).toBe(true)
    expect(restarted('<!doctype html><html></html>')).toBe(false)
  })

})
