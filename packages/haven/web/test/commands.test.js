// web/test/commands.test.js — the registry of verbs and keys (12.4), `/` and
// Tab: which command a partial word names, what Tab makes of the line, what a
// verb's reach lets a figure say, and the mode that takes a key first.
import { test, expect } from 'bun:test'
import { complete, createCommands, matches, partial, reaches } from '../src/commands.js'

const verb = (extra) => ({ help: '/x', run: () => 'ok', ...extra })
const at = (x, y) => ({ x, y })

test('only a bare slash-word is completable', () => {
  expect(partial('/m')).toBe('m')
  expect(partial('/')).toBe('')
  expect(partial('hello')).toBeNull()
  expect(partial('/ban sam')).toBeNull()
})

test('/ lists every word and /m only the ones starting with m', () => {
  const words = ['ban', 'map', 'unban', 'w']
  expect(matches('/', words)).toEqual(words)
  expect(matches('/m', words)).toEqual(['map'])
  expect(matches('/x', words)).toEqual([])
})

test('Tab completes a lone match and opens its argument', () => {
  const words = ['ban', 'map', 'unban', 'w']
  expect(complete('/m', words)).toBe('/map ')
  expect(complete('/un', words)).toBe('/unban ')
  expect(complete('/w', words)).toBe('/w ')
})

test('Tab on several matches stops at what they share, and on none leaves the line', () => {
  const words = ['ban', 'map', 'unban', 'w']
  expect(complete('/', words)).toBe('/')
  expect(complete('/x', words)).toBe('/x')
  expect(complete('hello', words)).toBe('hello')
  expect(complete('/ban sam', words)).toBe('/ban sam')
  expect(complete('/l', ['ledger', 'lamp'])).toBe('/l')
  expect(complete('/le', ['ledger', 'lever'])).toBe('/le')
  expect(complete('/led', ['ledger', 'ledge'])).toBe('/ledge')
})

test('a verb needs a run, a word or a key, and a word a help', () => {
  const c = createCommands()
  expect(() => c.add({ word: 'x', help: '/x' })).toThrow('run')
  expect(() => c.add({ run() {} })).toThrow('word or a key')
  expect(() => c.add({ word: 'x', run() {} })).toThrow('help')
})

test('words are the verbs in reach plus those with none, sorted, aliases left out', () => {
  const c = createCommands()
  c.add(verb({ word: 'w' }))
  c.add(verb({ word: 'ban' }))
  c.add(verb({ word: 'yes', aliases: ['y'], reach: { x: 10, y: 10, within: 2 } }))
  expect(c.words(at(0, 0))).toEqual(['ban', 'w'])
  expect(c.words(at(11, 9))).toEqual(['ban', 'w', 'yes'])
  expect(c.words(at(13, 10))).toEqual(['ban', 'w'])
  expect(c.words(null)).toEqual(['ban', 'w'])
  expect(reaches({ reach: { x: 0, y: 0, within: 1 } }, at(1, 1))).toBe(true)
  expect(reaches({ reach: { x: 0, y: 0, within: 1 } }, at(2, 0))).toBe(false)
})

test('a word names the nearest verb in reach; out of reach it is found, not reached', () => {
  const c = createCommands()
  c.add(verb({ word: 'yes', aliases: ['y'], run: () => 'far', reach: { x: 20, y: 5, within: 6 } }))
  c.add(verb({ word: 'yes', run: () => 'near', reach: { x: 12, y: 5, within: 6 } }))
  c.add(verb({ word: 'yes', run: () => 'room' }))
  expect(c.find('yes', at(13, 5)).verb.run()).toBe('near')
  expect(c.find('y', at(18, 5)).verb.run()).toBe('far')
  expect(c.find('yes', at(0, 0)).verb.run()).toBe('room')
  expect(c.find('nope', at(0, 0))).toBeNull()
  const lone = createCommands()
  lone.add(verb({ word: 'yes', reach: { x: 10, y: 10, within: 2 } }))
  expect(lone.find('yes', at(0, 0))).toMatchObject({ reached: false })
  expect(lone.find('yes', at(10, 12))).toMatchObject({ reached: true })
})

test('help is one line per word in reach, in Tab order', () => {
  const c = createCommands()
  c.add(verb({ word: 'w', help: '/w <nick> <line>' }))
  c.add(verb({ word: 'ban', help: '/ban <nick>' }))
  c.add(verb({ word: 'yes', help: '/yes', reach: { x: 10, y: 10, within: 2 } }))
  expect(c.helps(at(0, 0))).toEqual(['/ban <nick>', '/w <nick> <line>'])
  expect(c.helps(at(10, 10))).toEqual(['/ban <nick>', '/w <nick> <line>', '/yes'])
})

test('a verb taken away is gone', () => {
  const c = createCommands()
  const off = c.add(verb({ word: 'ledger' }))
  expect(c.words(at(0, 0))).toEqual(['ledger'])
  off()
  expect(c.words(at(0, 0))).toEqual([])
})

test('a key goes to the nearest verb in reach first and passes on when one answers false', () => {
  const c = createCommands()
  const heard = []
  c.add({ key: 'e', run: () => { heard.push('room') } })
  c.add({ key: 'e', run: () => { heard.push('far'); return false }, reach: { x: 30, y: 5, within: 40 } })
  c.add({ key: 'e', run: () => { heard.push('near'); return false }, reach: { x: 10, y: 5, within: 40 } })
  expect(c.press('e', at(12, 5))).toBe(true)
  expect(heard).toEqual(['near', 'far', 'room'])
  expect(c.press('x', at(12, 5))).toBe(false)
  expect(c.press('e', at(12, 5), { tag: 'event' })).toBe(true)
})

test('a key in reach of nothing named is not taken', () => {
  const c = createCommands()
  c.add({ key: 'e', run: () => 'bar', reach: { x: 10, y: 5, within: 2 } })
  expect(c.press('e', at(0, 0))).toBe(false)
  expect(c.press('e', at(11, 5))).toBe(true)
})

test('a mode takes its own keys, and Esc closes it unless it names Esc', () => {
  const c = createCommands()
  const log = []
  c.open({ name: 'history', closed: () => log.push('closed') })
  expect(c.mode.name).toBe('history')
  expect(c.modeKey({ key: 'ArrowUp' })).toBe(false)
  expect(c.modeKey({ key: 'Escape' })).toBe(true)
  expect(c.mode).toBeNull()
  expect(log).toEqual(['closed'])
  expect(c.modeKey({ key: 'Escape' })).toBe(false)

  c.open({ name: 'booth', keys: { Escape: () => log.push('stood') } })
  expect(c.modeKey({ key: 'Escape' })).toBe(true)
  expect(c.mode.name).toBe('booth')
  expect(log).toEqual(['closed', 'stood'])
})

test('opening a mode closes the one before it, and a stale close leaves the new one open', () => {
  const c = createCommands()
  const log = []
  const closeMap = c.open({ name: 'map', closed: () => log.push('map') })
  const closeHistory = c.open({ name: 'history', closed: () => log.push('history') })
  expect(log).toEqual(['map'])
  closeMap()
  expect(c.mode.name).toBe('history')
  expect(log).toEqual(['map'])
  closeHistory()
  expect(c.mode).toBeNull()
  expect(log).toEqual(['map', 'history'])
})

test('of two keys as near, the one the figure faces is asked first', () => {
  const c = createCommands()
  const heard = []
  c.add({ key: 'e', run: () => { heard.push('west'); return false }, reach: { x: 8, y: 5, within: 3 } })
  c.add({ key: 'e', run: () => { heard.push('east'); return false }, reach: { x: 12, y: 5, within: 3 } })
  c.press('e', { ...at(10, 5), facing: 'e' })
  c.press('e', { ...at(10, 5), facing: 'w' })
  c.press('e', at(10, 5))
  expect(heard).toEqual(['east', 'west', 'west', 'east', 'west', 'east'])
})

test('a mode with a take is handed every key, Esc included, and lets go of what it does not take', () => {
  const c = createCommands()
  const log = []
  const close = c.open({
    name: 'walk',
    take: (e) => { log.push(e.key); close(); return e.key === 'Escape' },
    closed: () => log.push('closed'),
  })
  expect(c.modeKey({ key: 'ArrowLeft' })).toBe(false)
  expect(c.mode).toBeNull()
  expect(log).toEqual(['ArrowLeft', 'closed'])

  c.open({ name: 'operator', take: () => true })
  expect(c.modeKey({ key: 'Escape' })).toBe(true)
  expect(c.mode.name).toBe('operator')
})

test('close names the mode it closes, and leaves another open', () => {
  const c = createCommands()
  const log = []
  c.open({ name: 'map', closed: () => log.push('map') })
  expect(c.close('walk')).toBe(false)
  expect(c.mode.name).toBe('map')
  expect(c.close('map')).toBe(true)
  expect(c.mode).toBeNull()
  expect(log).toEqual(['map'])
  expect(c.close('map')).toBe(false)
})
