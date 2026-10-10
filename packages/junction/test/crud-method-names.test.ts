// test/crud-method-names.test.ts — one list of the framework's own method names.
//
// `FJS-2444`. Three tables each held a different subset: the call path knew
// eight, the header block six, the pipeline resolver six with different gaps.
// A name one of them missed was treated as custom there, so `Aggregate` in
// `X-Service-Method` became a method called `Aggregate` and a hook keyed
// `update` was resolved as a custom one. Every table now reads
// CRUD_METHODS, and the header block is that list less the verbs a header is
// the only way to reach.

import { describe, test, expect } from 'bun:test'
import { CRUD_METHODS }       from '../src/core/context.ts'
import { resolvePipelines }   from '../src/core/hooks.ts'
import { bridge }             from '../src/transport/bridge.ts'
import type { TransportContext } from '../src/transport/types.ts'

function transport(method: string, headers: Record<string, string> = {}): TransportContext {
  return {
    method, path: '/api/posts', route: {}, query: {}, headers, body: null, files: [],
    ip: '127.0.0.1', protocol: 'http', host: 'localhost', user: null,
    $raw: { $req: new Request('http://x'), url: 'http://x' },
  } as unknown as TransportContext
}

describe('the CRUD method names', () => {
  test('a pipeline is resolved for every one of them', () => {
    const resolved = resolvePipelines({})
    for (const name of CRUD_METHODS) expect(Object.keys(resolved)).toContain(name)
  })

  test('a header names a built-in with no HTTP verb whatever its case', () => {
    for (const name of ['aggregate', 'restore']) {
      for (const sent of [name, name.toUpperCase(), name[0]!.toUpperCase() + name.slice(1)]) {
        const sc = bridge.toContext(transport('POST', { 'x-service-method': sent }), 'posts')
        expect(sc.method).toBe(name)
      }
    }
  })

  test('a header cannot swap a verb the HTTP method already names', () => {
    for (const name of ['find', 'get', 'create', 'update', 'patch', 'remove']) {
      const sc = bridge.toContext(transport('POST', { 'x-service-method': name.toUpperCase() }), 'posts')
      expect(sc.method).toBe('create')
    }
  })

  test('a camelCase custom method keeps its case', () => {
    const sc = bridge.toContext(transport('POST', { 'x-service-method': 'getStats' }), 'posts')
    expect(sc.method).toBe('getStats')
  })
})
