/**
 * vite-hmr-registry.test.js — what the HMR client's registry HOLDS (`FJS-875`).
 *
 * Every mounted component adds an entry carrying its marker, its anchor, its
 * props and its block, and until this the only thing that removed one was a
 * swap — which runs when that particular file is edited and never otherwise. A
 * route the developer navigates away from, an `{#if}` that flips, a list that
 * re-renders: each left a detached DOM node and its props retained for the life
 * of the tab.
 *
 * The leak is invisible from the swap, which drops a detached entry either way,
 * so the registry is read directly. Each drop is paired with a live entry that
 * must survive, because a sweep that emptied the registry would satisfy any
 * test that only counts what left.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'

import { _registry, __mesa_register, __mesa_hot_update } from '../mesa-vite/client.js'

const ID    = '/src/Counter.mesa'
const OTHER = '/src/Sibling.mesa'

/** A mount: a marker and an anchor, in the document or not. */
function mount(id, { connected = true } = {}) {
  const mark   = document.createComment(' mesa:hmr:X ')
  const anchor = document.createComment('')
  if (connected) {
    document.body.append(mark, anchor)
  }
  return __mesa_register(id, mark, anchor, { a: 1 }, {}, () => {})
}

/** What a teardown does: the nodes leave the document, the entry does not. */
function unmountLast(id) {
  const entry = [..._registry.get(id)].at(-1)
  entry.anchor.remove()
  entry.hmrMark.remove()
  return entry
}

const size = (id) => _registry.get(id)?.size ?? 0

beforeEach(() => {
  _registry.clear()
  document.body.innerHTML = ''
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

describe('a component that mounts and unmounts', () => {
  test('a torn-down instance does not outlive the next mount of the same file', () => {
    // Navigating to a route and away from it, over and over. Each entry retains
    // the detached anchor, the marker, the props and the block; unswept, this
    // ends at six.
    for (let i = 0; i < 5; i++) {
      mount(ID)
      unmountLast(ID)
    }
    mount(ID)

    expect(size(ID)).toBe(1)
  })

  test('a live instance is kept', () => {
    mount(ID)
    mount(ID)
    unmountLast(ID)
    mount(ID)

    expect(size(ID)).toBe(2)   // the survivor of the first two, and the new one
  })
})

describe('a component the developer will not mount again', () => {
  test('an edit anywhere sweeps it', () => {
    mount(OTHER)
    unmountLast(OTHER)
    const live = mount(ID)

    __mesa_hot_update(ID, Object.assign(() => {}, { __setMark() {} }))

    expect(_registry.has(OTHER)).toBe(false)
    expect(typeof live).toBe('function')
  })

  test('and a file with live instances keeps its id', () => {
    mount(OTHER)
    mount(ID)

    __mesa_hot_update(ID, Object.assign(() => {}, { __setMark() {} }))

    expect(size(OTHER)).toBe(1)
  })
})

describe('the unregister the register call answers', () => {
  test('drops that entry, and the id with the last of them', () => {
    const off = mount(ID)
    expect(size(ID)).toBe(1)

    off()
    expect(_registry.has(ID)).toBe(false)
  })
})
