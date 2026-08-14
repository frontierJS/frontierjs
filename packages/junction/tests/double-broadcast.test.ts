// tests/double-broadcast.test.ts
//
// FJS-045. Two mechanisms broadcast a mutation and a service can carry both:
//
//   channel: 'posts'            → announced by callService, the single point
//   after: [publish(fn)]        → the exported hook, sending its own frame
//
// Together the same record goes out twice, every subscribed tab applies it
// twice, and a non-idempotent client handler shows it twice. The register
// tracked it as "grep before merging" — a rule nobody can be relied on to
// follow and no test can check.
//
// The check runs where the FULL effective chain is known: the resolved
// pipeline, which is the only place service hooks and APP-level hooks are both
// in view. It matches MARKED hooks, never names, because an app may call its own
// hook `publish` and suppressing a real one on a name collision would silently
// stop broadcasting — the failure this exists to prevent, inverted.

import { describe, it, expect } from 'bun:test'
import { createService } from '../src/core/service.ts'
import { publish } from '../src/transport/channels.ts'

const chan = () => publish(() => null)

describe('a service cannot broadcast twice', () => {

  it('refuses channel: plus a publish() hook on the service', () => {
    const svc = createService({
      name: 'posts', model: 'Post', channel: 'posts',
      hooks: { after: { create: [chan()] } },
    })
    expect(() => svc.pipelines()).toThrow(/declares channel: and also runs a publish\(\) hook on 'create'/)
  })

  it('refuses it when the publish hook arrives from APP-level hooks', () => {
    // `after: { all: [publish(…)] }` applies to every service at once, so this
    // is the shape that doubles a whole app rather than one method.
    const svc = createService({ name: 'posts', model: 'Post', channel: 'posts' })
    expect(() => svc.pipelines({ after: { all: [chan()] } }))
      .toThrow(/declares channel: and also runs a publish\(\) hook/)
  })

  it('refuses it when the hook is added after construction', () => {
    const svc = createService({ name: 'posts', model: 'Post', channel: 'posts' })
    expect(() => svc.pipelines()).not.toThrow()
    svc.hooks({ after: { patch: [chan()] } })
    expect(() => svc.pipelines()).toThrow(/publish\(\) hook on 'patch'/)
  })

  it('either mechanism ALONE is fine', () => {
    expect(() => createService({ name: 'a', model: 'A', channel: 'a' }).pipelines()).not.toThrow()
    expect(() => createService({
      name: 'b', model: 'B',
      hooks: { after: { create: [chan()] } },
    }).pipelines()).not.toThrow()
  })

  it('channel: false is a declared opt-out, so the hook is the only broadcaster', () => {
    expect(() => createService({
      name: 'c', model: 'C', channel: false,
      hooks: { after: { create: [chan()] } },
    }).pipelines()).not.toThrow()
  })

  it("an app's OWN hook named publish is not mistaken for one", () => {
    // The whole reason the mark exists. Matching on the name would refuse this
    // service, and — worse in the other direction — would let a name-mangling
    // build step disable the real check.
    async function publish() { /* an app's own hook, same name */ }
    expect(() => createService({
      name: 'd', model: 'D', channel: 'd',
      hooks: { after: { create: [publish] } },
    }).pipelines()).not.toThrow()
  })
})
