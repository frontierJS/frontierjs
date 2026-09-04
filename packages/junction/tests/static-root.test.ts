// tests/static-root.test.ts — a file that stays inside the root, not a path
// that does.
//
// `sanitizePath` refuses `..` and a NUL byte, which is the whole of what a URL
// can say. A symlink INSIDE the root says the rest, and it was followed: a
// `link.css` pointing at `../../secret.txt` was served 200 with the contents
// (`FJS-746`). Every refusal here is paired with an ordinary file served from
// the same directory, because a containment check that refused everything
// would satisfy the refusals on its own.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { serveStatic } from '../src/transport/static.ts'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'

let base: string, root: string, outside: string, shared: string

beforeAll(() => {
  // realpath: macOS puts /var/folders behind a symlink, so a root read from
  // mkdtemp is itself a link and every containment check would compare a
  // resolved file against an unresolved directory.
  base    = realpathSync(mkdtempSync(join(tmpdir(), 'fjs-static-')))
  root    = join(base, 'public')
  outside = join(base, 'private')
  shared  = join(base, 'shared')

  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(shared,  { recursive: true })

  writeFileSync(join(root, 'assets', 'real.css'),  'body { color: red }')
  writeFileSync(join(outside, 'secret.txt'),       'TOP SECRET')
  writeFileSync(join(shared, 'logo.svg'),          '<svg/>')

  symlinkSync(join(outside, 'secret.txt'), join(root, 'assets', 'link.css'))
  symlinkSync(join(root, 'assets', 'real.css'), join(root, 'assets', 'inside.css'))
  symlinkSync(shared, join(root, 'brand'))
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const ask = (path: string, opts: Record<string, unknown> = {}) =>
  serveStatic(new Request(`http://x${path}`), path, { root, ...opts } as never)

describe('a symlink out of the root', () => {
  it('is refused', async () => {
    expect(await ask('/assets/link.css')).toBeNull()
  })

  it('while the ordinary file beside it is served', async () => {
    // The control. Without it, a check that refused every static file would
    // pass the assertion above.
    const res = await ask('/assets/real.css')
    expect(res?.status).toBe(200)
    expect(await res!.text()).toContain('color: red')
  })

  it('answers as not found rather than forbidden', async () => {
    // 403 would confirm the caller found a way out of the root. `..` still
    // answers 403, because that is a request nobody makes by accident.
    expect(await ask('/assets/link.css')).toBeNull()
    expect((await ask('/../private/secret.txt'))?.status).toBe(403)
  })
})

describe('a symlink that stays inside', () => {
  it('is served, because containment is about where it LANDS', async () => {
    const res = await ask('/assets/inside.css')
    expect(res?.status).toBe(200)
    expect(await res!.text()).toContain('color: red')
  })
})

describe('a directory the operator published on purpose', () => {
  it('is refused until it is named', async () => {
    expect(await ask('/brand/logo.svg')).toBeNull()
  })

  it('and served once it is', async () => {
    const res = await ask('/brand/logo.svg', { allowOutside: [shared] })
    expect(res?.status).toBe(200)
    expect(await res!.text()).toBe('<svg/>')
  })

  it('which does not widen it to everything else outside', async () => {
    expect(await ask('/assets/link.css', { allowOutside: [shared] })).toBeNull()
  })
})

describe('no root is not a root', () => {
  it('serves a path the application named itself', async () => {
    // `ctx.file('/var/data/report.pdf')` — the app chose the file and there is
    // nothing for it to be inside of. Containment is about a directory an
    // operator published.
    const res = await serveStatic(
      new Request('http://x/x'), join(outside, 'secret.txt'), { root: '' },
    )
    expect(res?.status).toBe(200)
    expect(await res!.text()).toBe('TOP SECRET')
  })
})
