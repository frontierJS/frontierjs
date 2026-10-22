// Studio's keyboard (FJS-3409): Escape closes ONE layer — palette, then the row
// drawer, then the pinned ER view — and Ctrl/Cmd+R or Ctrl+I is the browser's,
// not Studio's r and i.
//
// The page's script is one inline block, so the two key functions are sliced
// out of studio.html and run against a stub of the few things they touch.
//
// Run with:  bun test test/studio-keys.test.ts

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const HTML = readFileSync(resolve(import.meta.dir, '..', 'src', 'tools', 'studio.html'), 'utf8')

const start = HTML.indexOf('function studioEscape')
const end   = HTML.indexOf("document.addEventListener('keydown', studioKey)")

function page(open: { palette?: boolean, drawer?: boolean, pinned?: boolean, search?: string }) {
  const s = { palette: !!open.palette, drawer: !!open.drawer, pinned: open.pinned ? 'User' : null, search: open.search ?? '' }
  const log: string[] = []
  const els: any = {
    palette:    { get hidden() { return !s.palette } },
    rowDrawer:  { get open() { return s.drawer } },
    browseSearch: {
      get value() { return s.search }, set value(v) { s.search = v },
      blur() {}, focus() {},
    },
  }
  const env: any = {
    document: { getElementById: (id: string) => els[id], querySelector: () => ({}) },
    palClose:       () => { s.palette = false; log.push('palette') },
    closeRowDetail: () => { s.drawer = false;  log.push('drawer') },
    erPin:          () => { s.pinned = null;   log.push('er') },
    filterRows:     () => log.push('filter'),
    loadTable:      () => log.push('reload'),
    toast:          () => {},
    showTool:       () => {},
    nextPage:       () => log.push('next'),
    prevPage:       () => log.push('prev'),
    openRowDetail:  () => log.push('detail'),
    currentTable: 'User',
    get _erPinned() { return s.pinned },
  }
  // `with` so a bare _erPinned / currentTable reads the stub live, as the page's globals are
  const studioKey = new Function('env', `with (env) { ${HTML.slice(start, end)}\nreturn studioKey }`)(env)
  const key = (init: any, target: any = { tagName: 'BODY', closest: () => null }) => {
    studioKey({ key: '', ctrlKey: false, metaKey: false, altKey: false, target, preventDefault() {}, ...init })
    return log.splice(0)
  }
  return { key, log }
}

describe('Escape closes one layer (FJS-3409)', () => {
  test('with the palette, the drawer and a pin all open, the first Escape closes the palette only', () => {
    const p = page({ palette: true, drawer: true, pinned: true })
    expect(p.key({ key: 'Escape' })).toEqual(['palette'])
  })

  test('the drawer is next, then the pin', () => {
    const p = page({ drawer: true, pinned: true })
    expect(p.key({ key: 'Escape' })).toEqual(['er'])
    expect(p.key({ key: 'Escape' })).toEqual(['drawer'])
  })

  test('inside the palette field Escape closes the palette and nothing behind it', () => {
    const p = page({ palette: true, drawer: true })
    expect(p.key({ key: 'Escape' }, { tagName: 'INPUT', closest: () => null })).toEqual(['palette'])
  })

  test('nothing but the browse search is left to clear', () => {
    const p = page({ search: 'abc' })
    expect(p.key({ key: 'Escape' })).toEqual(['filter'])
  })
})

describe('r and i take no modifier (FJS-3409)', () => {
  test('a bare r reloads, Ctrl/Cmd+R does not', () => {
    const p = page({})
    expect(p.key({ key: 'r' })).toEqual(['reload'])
    expect(p.key({ key: 'r', ctrlKey: true })).toEqual([])
    expect(p.key({ key: 'R', metaKey: true })).toEqual([])
  })

  test('Ctrl+I does not open the row detail', () => {
    const p = page({})
    expect(p.key({ key: 'i' })).toEqual(['detail'])
    expect(p.key({ key: 'i', ctrlKey: true })).toEqual([])
  })

  test('Alt+arrow still pages', () => {
    const p = page({})
    expect(p.key({ key: 'ArrowRight', altKey: true })).toEqual(['next'])
  })
})
