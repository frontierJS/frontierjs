/**
 * test/memory-history.test.js — the router with no `window`: handed a
 * `createMemoryHistory`, as the terminal shell hands it one.
 *
 * No window mock is installed, which is the point: every read of the address
 * the router makes must go through the History it was handed, and one that
 * reaches for `window` throws a ReferenceError here.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import {
  initRouter, goto, back, followLink, setParams, isActive, page, createMemoryHistory,
  _resetPage, _resetInternals,
} from '../src/router/index.js'

// A fresh tree per boot: the router marks a node whose component it loaded.
const makeTree = () => ({
  id: 'root', path: '/', file: 'src/routes/index.mesa', meta: {}, params: [],
  children: [
    {
      id: 'orders', path: '/orders/', file: 'src/routes/orders/index.mesa', meta: { title: 'Orders' }, params: [],
      children: [
        { id: 'orders.[id]', path: '/orders/:id/', file: 'src/routes/orders/[id].mesa', meta: {}, params: ['id'], children: [] },
      ],
    },
    { id: '[...404]', path: '/*', file: 'src/routes/[...404].mesa', meta: { spread: true }, params: ['404'], children: [] },
  ],
})

const components = Object.fromEntries(
  ['root', 'orders', 'orders.[id]', '[...404]'].map((id) => [id, async () => ({ default: function () {} })]),
)

// Boot and popstate navigations are not awaited by anything a test holds.
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('createMemoryHistory', () => {
  test('push, replace and the location read off the current entry', () => {
    const h = createMemoryHistory('/a/?x=1#top')
    expect([h.location.pathname, h.location.search, h.location.hash]).toEqual(['/a/', '?x=1', '#top'])
    h.pushState({ index: 1 }, '', '/b/')
    expect(h.location.pathname).toBe('/b/')
    expect(h.state).toEqual({ index: 1 })
    h.replaceState({ index: 1 }, '', 'c/')
    expect(h.location.pathname).toBe('/b/c/')
    expect(h.length).toBe(2)
  })

  test('back fires the listener after it has moved, and never synchronously', async () => {
    const h = createMemoryHistory('/a/')
    h.pushState(null, '', '/b/')
    const heard = []
    h.listen(() => heard.push(h.location.pathname))
    h.back()
    expect(heard).toEqual([])
    expect(h.location.pathname).toBe('/a/')
    await settled()
    expect(heard).toEqual(['/a/'])
    h.back()
    await settled()
    expect(heard).toEqual(['/a/'])
  })

  test('a push forward of the current entry drops the entries past it', () => {
    const h = createMemoryHistory('/a/')
    h.pushState(null, '', '/b/')
    h.back()
    h.pushState(null, '', '/c/')
    expect(h.length).toBe(2)
    h.forward()
    expect(h.location.pathname).toBe('/c/')
  })

  test('refuses another origin, as pushState does', () => {
    const h = createMemoryHistory('/')
    expect(() => h.pushState(null, '', 'https://elsewhere.example/')).toThrow(/cannot move a memory history/)
  })
})

describe('the router handed a memory History', () => {
  let history
  beforeEach(async () => {
    expect(typeof window).toBe('undefined')
    _resetInternals()
    _resetPage()
    history = createMemoryHistory('/orders/7/?status=open')
    initRouter(makeTree(), components, {}, { trailingSlash: 'always', history })
    await settled()
  })

  test('boots onto the History\'s entry, params and query split', () => {
    expect(page.route.id).toBe('orders.[id]')
    expect(page.params).toEqual({ id: '7' })
    expect(page.query).toEqual({ status: 'open' })
    expect(history.state.index).toBe(0)
  })

  test('goto pushes, and back returns through popstate', async () => {
    await goto('/orders/')
    expect(page.route.id).toBe('orders')
    expect(history.location.pathname).toBe('/orders/')
    expect(history.length).toBe(2)
    back()
    await settled()
    expect(page.route.id).toBe('orders.[id]')
    expect(page.params).toEqual({ id: '7' })
  })

  test('setParams and isActive read the History\'s address', async () => {
    setParams({ status: 'paid' })
    await settled()
    expect(history.location.search).toBe('?status=paid')
    expect(isActive('/orders/')).toBe(true)
    expect(isActive('/orders/', { exact: true })).toBe(false)
  })

  test('followLink resolves against the current entry and takes what the table covers', async () => {
    expect(followLink('../8/')).toBe(true)
    await settled()
    expect(page.params).toEqual({ id: '8' })
    expect(history.location.pathname).toBe('/orders/8/')
  })

  test('followLink leaves another host, an uncovered path and the catch-all alone', async () => {
    expect(followLink('https://elsewhere.example/orders/')).toBe(false)
    expect(followLink('mailto:someone@example.com')).toBe(false)
    expect(followLink('/nowhere/at/all/')).toBe(false)
    await settled()
    expect(page.route.id).toBe('orders.[id]')
    expect(history.length).toBe(1)
  })

  test('a fragment on the page already showing is an entry, not a navigation', async () => {
    const route = page.route
    expect(followLink('#lines')).toBe(true)
    await settled()
    expect(history.location.hash).toBe('#lines')
    expect(history.length).toBe(2)
    expect(page.route).toBe(route)
  })
})
