// ============================================================
// Conduit — Test Factory
// Quick-setup helper for unit and integration tests.
// Import from '@frontierjs/conduit/testing' — never in production.
//
// Usage:
//
//   import { createTestConduit } from '@frontierjs/conduit/testing'
//
//   const { conduit, stubs } = await createTestConduit({
//     'outpost:srv_abc': {
//       '/deploy':       { deployed: true },
//       '/health-check': { healthy: true },
//     },
//     'provider:hetzner': {
//       '/servers/42': { id: 42, status: 'running' },
//     },
//   })
//
//   // run code under test that calls app.conduit.send(...)
//
//   expect(stubs['outpost:srv_abc'].calls).toHaveLength(2)
//   expect(stubs['outpost:srv_abc'].calls[0].path).toBe('/deploy')
//
//   stubs['outpost:srv_abc'].reset()
// ============================================================

import { createConduit }     from './conduit.ts'
import { StubTransport }     from './transports/stub.ts'
import { createNullResolver } from './credentials.ts'
import type { IConduit, TargetDescriptor, ConduitOptions } from './types.ts'
import type { BaseTransport } from './transports/base.ts'

// Map of targetId → { path → response data }
export type StubMocks = Record<string, Record<string, unknown>>

export type TestConduit<T extends StubMocks> = {
  conduit: IConduit
  stubs:   { [K in keyof T]: StubTransport }
}

export type TestConduitOptions = Pick<ConduitOptions, 'observers' | 'store' | 'credentials'> & {
  // Extra descriptors registered in the store without a stub. Use to test
  // code that mixes stubbed calls with real target resolution.
  targets?: TargetDescriptor[]
}

// Async because the store is async. Stubbed targets are registered in the
// store as well as in the transport overrides, so resolve(), list() and
// stats() report them — code that calls send() alongside resolve() can be
// integration-tested, which the previous bypass made impossible.
export async function createTestConduit<T extends StubMocks>(
  mocks: T,
  opts:  TestConduitOptions = {}
): Promise<TestConduit<T>> {
  const overrides   = new Map<string, BaseTransport>()
  const stubs       = {} as { [K in keyof T]: StubTransport }
  const descriptors: TargetDescriptor[] = [...(opts.targets ?? [])]

  for (const [targetId, pathMocks] of Object.entries(mocks)) {
    // Minimal descriptor — protocol and auth don't matter for stubs
    const descriptor: TargetDescriptor = {
      id:            targetId,
      kind:          inferKind(targetId),
      protocol:      'http',
      address:       'stub://',
      auth:          { type: 'none' },
      registered_at: Date.now(),
      last_seen_at:  null
    }

    const stub = new StubTransport(descriptor, 'http')

    // Register each path mock on the stub
    for (const [pattern, data] of Object.entries(pathMocks)) {
      stub.mock(pattern, data)
    }

    overrides.set(targetId, stub)
    ;(stubs as Record<string, StubTransport>)[targetId] = stub
    descriptors.push(descriptor)
  }

  const conduit = createConduit({
    observers: opts.observers,
    store:     opts.store,
    // Never the env resolver here — a test must not be able to pick up a
    // real credential from the developer's environment.
    credentials: opts.credentials ?? createNullResolver(),
    targets: descriptors,
  }, overrides)

  await conduit.init()

  return { conduit, stubs }
}

// ─── Internal ────────────────────────────────────────────────

function inferKind(targetId: string): TargetDescriptor['kind'] {
  if (targetId.startsWith('provider:')) return 'provider'
  if (targetId.startsWith('outpost:'))    return 'outpost'
  return 'local'
}

// ─── A connector's drive ──────────────────────────────────────
// The assertion shape every `packages/conduit-*` drive shares (`FJS-D890`):
// `t(name, actual)` records one row, `report(got, expected)` compares each
// row deep-equal against the expected table and prints the diff, so a drive
// reads as a table of claims rather than a script that throws at the first
// miss. Here rather than in each connector because a connector peers on
// conduit and may import nothing else of the framework's.

export type Rows = Record<string, unknown>

export function results() {
  const got: Rows = {}
  return {
    got,
    t(name: string, actual: unknown) {
      if (name in got) throw new Error(`drive: row '${name}' recorded twice`)
      got[name] = actual
    },
  }
}

const norm = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Rows).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, norm(x)]))
    : v
const same = (a: unknown, b: unknown): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b))

/** Prints every row and returns 1 on any miss. A row expected and never recorded is a miss, and so is one recorded and never expected. */
export function report(got: Rows, expected: Rows): number {
  let failed = 0
  for (const [name, want] of Object.entries(expected)) {
    const have = got[name]
    const ok = name in got && same(have, want)
    if (!ok) failed++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`)
    if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${name in got ? JSON.stringify(have) : '(not recorded)'}`)
  }
  for (const name of Object.keys(got)) if (!(name in expected)) { failed++; console.log(` FAIL  ${name}  (recorded, not expected)`) }
  if ('__threw' in got) failed++
  console.log(`\n${failed ? `${failed} failed` : 'all green'} — ${Object.keys(expected).length} rows`)
  return failed ? 1 : 0
}

/** `fetch` to a sink's control endpoint: `/_sink/reset`, `/_sink/arm`, `/_sink/seen`. */
export const control = (base: string) => ({
  reset: () => fetch(`${base}/_sink/reset`, { method: 'POST' }).then(r => r.json()),
  arm:   (what: Rows) => fetch(`${base}/_sink/arm`, { method: 'POST', body: JSON.stringify(what) }).then(r => r.json()),
  seen:  <T = unknown>() => fetch(`${base}/_sink/seen`).then(r => r.json() as Promise<T[]>),
})

/** The resilience a drive runs a connector under: short, so a lost response costs a second rather than the default ten. */
export const DRIVE_RESILIENCE = { timeout_ms: 800, retry_limit: 2, deadline_ms: 6_000 }
