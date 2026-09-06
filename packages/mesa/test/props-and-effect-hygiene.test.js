/**
 * Two ways state escapes the shape it was declared in.
 *
 * `restProps` backs `$attributes`, which is spread straight onto a DOM node —
 * so anything it enumerates that the caller did not put there is markup the
 * author never wrote (`FJS-878`). And `createEffect` rethrows a first-run
 * failure to the caller, which leaves the caller with no disposer for a node
 * that has already subscribed (`FJS-879`).
 */
import { describe, it, expect } from 'vitest'
import {
  createSignal, createEffect, restProps, flushSync, createRoot,
  push_component, pop_component, makeExternalProperty,
  registerComponentAnchor, pushProps,
} from '../src/runtime.js'

describe('restProps enumerates own keys only', () => {
  it('drops what a class instance carries on its prototype', () => {
    class Props {}
    // What a caller spreading a model object hands over. `onclick` is the sharp
    // end: spread onto an element it is a handler the author never wrote.
    Props.prototype.secret = 'internal'
    Props.prototype.onclick = 'alert(1)'
    const props = new Props()
    props.title = 'ok'

    const rest = restProps(props, [])
    expect(Object.keys(rest)).toEqual(['title'])
    expect(rest.secret).toBeUndefined()
    expect('secret' in rest).toBe(false)
  })

  it('drops what Object.create put behind a payload', () => {
    const props = Object.create({ inherited: 'x' })
    props.id = 'a'
    expect(Object.keys(restProps(props, []))).toEqual(['id'])
  })

  it('still carries own keys, and still drops the declared ones', () => {
    const rest = restProps({ tone: 'danger', id: 'a', class: 'c', children: 1 }, ['tone'])
    expect(Object.keys(rest)).toEqual(['id'])
  })
})

describe('an effect whose first run throws', () => {
  it('does not stay subscribed', () => {
    const [read, set] = createSignal(0)
    let runs = 0
    expect(() => {
      createEffect(() => { read(); runs++; if (runs === 1) throw new Error('boom') })
    }).toThrow('boom')
    expect(runs).toBe(1)

    // The caller never received a disposer — the throw escaped before the
    // return — so nothing but this can unsubscribe it.
    set(1)
    flushSync()
    expect(runs).toBe(1)
  })

  it('runs its cleanups and leaves the owner holding nothing', () => {
    const [read, set] = createSignal(0)
    let inner = 0
    expect(() => {
      createEffect(() => {
        read()
        createEffect(() => { read(); inner++ })
        throw new Error('boom')
      })
    }).toThrow('boom')
    expect(inner).toBe(1)

    // A child created before the throw goes with the parent, or the failed
    // setup leaves a live effect nobody can name.
    set(1)
    flushSync()
    expect(inner).toBe(1)
  })
})

/*
 * `pushProps` had the same unguarded `for…in` one function down from `pick`
 * (`FJS-905`). It cannot reach the DOM — each name is looked up in the child's
 * prop registry — so an inherited key overwrote a CHILD'S OWN PROP instead,
 * which is quieter and a different severity.
 *
 * Driven through the real registry rather than a stub: the arrangement is what
 * the compiler emits around a child — push_component, a prop registered with
 * makeExternalProperty, pop_component, then registerComponentAnchor — and a
 * hand-made registry would be a test of the map, not of the walk.
 */
describe('pushProps writes own keys only', () => {
  const child = (declared) => {
    const anchor = document.createComment('child')
    const signals = {}
    push_component()
    for (const [name, initial] of Object.entries(declared)) {
      const [read, write] = createSignal(initial)
      signals[name] = read
      makeExternalProperty(name, read, write)
    }
    pop_component()
    registerComponentAnchor(anchor)
    return { anchor, signals }
  }

  it('leaves a declared prop alone when the key is only on the prototype', () => {
    createRoot(() => {
      const { anchor, signals } = child({ label: 'own-default', n: 0 })

      class Model {}
      Model.prototype.label = 'FROM_PROTOTYPE'
      const props = new Model()
      props.n = 1

      pushProps(anchor, props)
      flushSync()

      expect(signals.n()).toBe(1)              // the key the parent passed
      expect(signals.label()).toBe('own-default')
    })
  })

  it('an Object.create payload is the same answer', () => {
    createRoot(() => {
      const { anchor, signals } = child({ label: 'own-default' })
      const props = Object.create({ label: 'FROM_PROTOTYPE' })
      pushProps(anchor, props)
      flushSync()
      expect(signals.label()).toBe('own-default')
    })
  })

  it('an own key still writes — the control', () => {
    createRoot(() => {
      const { anchor, signals } = child({ label: 'own-default' })
      pushProps(anchor, { label: 'passed' })
      flushSync()
      expect(signals.label()).toBe('passed')
    })
  })
})
