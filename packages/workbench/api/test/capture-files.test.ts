/**
 * capture-files.test.ts -- the Captures gallery's reads and its Delete, over a
 * temp save folder. Every call passes `{ dir }`; the real folder in
 * ~/.config/capture is never read. Open, Reveal and Share spawn programs on the
 * machine and are not called here.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTestEnv, sessionContext } from '@frontierjs/testing'
import type { App } from '@frontierjs/junction'
import { buildWorkbenchApp } from '../src/app.ts'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { byteRange, captureFiles, captureFileRoute, removeCaptureFile, resolveCaptureFile, vttText } from '../src/domain/capture/files.ts'

const root    = mkdtempSync(join(tmpdir(), 'wb-capture-files-'))
const dir     = join(root, 'shots')
const outside = join(root, 'elsewhere')
const where   = { dir }

/** A file whose mtime is `ago` seconds before a fixed moment, so the order is not the clock's. */
const put = (name: string, text = 'x', ago = 0) => {
  const path = join(dir, name)
  writeFileSync(path, text)
  const t = new Date(1_800_000_000_000 - ago * 1000)
  utimesSync(path, t, t)
}

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  mkdirSync(outside, { recursive: true })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('files', () => {
  test('lists newest first, by extension, and pairs a transcript with its recording or call', () => {
    put('Screenshot_2026-01-01_10-00-00.png', 'png', 300)
    put('Recording_2026-01-02_10-00-00.mp4', 'mp4', 100)
    put('Recording_2026-01-02_10-00-00.txt', 'said hello', 100)
    put('Call_2026-01-03_10-00-00.ogg', 'ogg', 10)
    put('Call_2026-01-03_10-00-00.vtt', 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nfirst line\n', 10)
    put('dropped-in.JPG', 'jpg', 200)
    put('notes.txt', 'no media beside me', 0)
    put('.hidden.png', 'h', 0)
    put('readme.pdf', 'p', 0)

    const out = captureFiles(where)
    expect(out.exists).toBe(true)
    expect(out.files.map(f => [f.name, f.kind])).toEqual([
      ['Call_2026-01-03_10-00-00.ogg', 'audio'],
      ['Recording_2026-01-02_10-00-00.mp4', 'video'],
      ['dropped-in.JPG', 'image'],
      ['Screenshot_2026-01-01_10-00-00.png', 'image'],
    ])
    const [call, rec, , shot] = out.files
    expect(call!.transcript).toBe('first line')
    expect(call!.sidecars).toEqual(['Call_2026-01-03_10-00-00.vtt'])
    expect(rec!.transcript).toBe('said hello')
    expect(shot!.transcript).toBeNull()
    expect(rec!.mime).toBe('video/mp4')
    expect(rec!.size).toBe(3)
  })

  test('the .txt wins over the .vtt, and a transcript is not a card', () => {
    put('Call_a.ogg', 'o'); put('Call_a.txt', 'from txt'); put('Call_a.vtt', 'WEBVTT\n\n00:00 --> 00:01\nfrom vtt')
    const out = captureFiles(where)
    expect(out.files).toHaveLength(1)
    expect(out.files[0]!.transcript).toBe('from txt')
    expect(out.files[0]!.sidecars).toEqual(['Call_a.txt', 'Call_a.vtt'])
  })

  test('a missing folder is exists:false, not an error, and an empty one is none', () => {
    expect(captureFiles({ dir: join(root, 'nope') })).toEqual({ dir: join(root, 'nope'), exists: false, files: [] })
    expect(captureFiles(where)).toEqual({ dir, exists: true, files: [] })
  })

  test('a link out of the folder is not listed; a link to a file inside it is', () => {
    writeFileSync(join(outside, 'secret.png'), 's')
    symlinkSync(join(outside, 'secret.png'), join(dir, 'leak.png'))
    put('real.png')
    symlinkSync(join(dir, 'real.png'), join(dir, 'alias.png'))
    expect(captureFiles(where).files.map(f => f.name).sort()).toEqual(['alias.png', 'real.png'])
  })

  test('vttText drops the header, ids, timestamps and a repeated line', () => {
    expect(vttText('WEBVTT\n\nNOTE x\n\n1\n00:00:00.000 --> 00:00:01.000\n<v A>hi\n\n2\n00:00:01.000 --> 00:00:02.000\n<v A>hi\nthere\n')).toBe('hi\nthere')
  })
})

describe('resolve', () => {
  test('a plain name resolves, with its kind', () => {
    put('a.png')
    expect(resolveCaptureFile('a.png', where)).toMatchObject({ name: 'a.png', kind: 'image', path: join(dir, 'a.png') })
  })

  test('refuses a slash, a dot-dot, a NUL, a backslash and nothing', () => {
    put('a.png'); writeFileSync(join(root, 'x.png'), 'x'); mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'a', 'b.png'), 'b')
    for (const bad of ['../x.png', 'a/b.png', '..', '.', 'a\\b.png', 'a\0.png', '/etc/passwd', '', undefined, 4]) {
      expect(resolveCaptureFile(bad, where)).toHaveProperty('refused')
    }
  })

  test('refuses a link that leads outside the folder, and one that dangles', () => {
    writeFileSync(join(outside, 'secret.png'), 's')
    symlinkSync(join(outside, 'secret.png'), join(dir, 'leak.png'))
    symlinkSync(join(dir, 'gone.png'), join(dir, 'dangling.png'))
    expect(resolveCaptureFile('leak.png', where)).toEqual({ refused: 'leak.png leads outside the save folder' })
    expect(resolveCaptureFile('dangling.png', where)).toHaveProperty('refused')
  })

  test('refuses a name that is not media, a transcript, and a file that is not there', () => {
    put('a.txt'); put('b.vtt')
    for (const bad of ['a.txt', 'b.vtt', 'c.pdf', 'missing.png']) expect(resolveCaptureFile(bad, where)).toHaveProperty('refused')
  })
})

describe('remove', () => {
  test('deletes the file and both its transcripts, and nothing else', () => {
    put('Call_a.ogg'); put('Call_a.txt'); put('Call_a.vtt'); put('Call_b.ogg'); put('Call_b.txt')
    expect(removeCaptureFile('Call_a.ogg', where)).toEqual({ removed: ['Call_a.txt', 'Call_a.vtt', 'Call_a.ogg'] })
    for (const gone of ['Call_a.ogg', 'Call_a.txt', 'Call_a.vtt']) expect(existsSync(join(dir, gone))).toBe(false)
    expect(existsSync(join(dir, 'Call_b.ogg'))).toBe(true)
    expect(existsSync(join(dir, 'Call_b.txt'))).toBe(true)
  })

  test('a name with no transcript removes just the file', () => {
    put('a.png')
    expect(removeCaptureFile('a.png', where)).toEqual({ removed: ['a.png'] })
    expect(existsSync(join(dir, 'a.png'))).toBe(false)
  })

  test('refuses ../x, a/b and a link out, and deletes nothing', () => {
    writeFileSync(join(root, 'x.png'), 'x'); writeFileSync(join(outside, 'secret.png'), 's'); writeFileSync(join(outside, 'secret.txt'), 't')
    symlinkSync(join(outside, 'secret.png'), join(dir, 'leak.png'))
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'))
    for (const bad of ['../x.png', 'a/b.png', 'leak.png']) expect(removeCaptureFile(bad, where)).toHaveProperty('refused')
    expect(existsSync(join(root, 'x.png'))).toBe(true)
    expect(existsSync(join(outside, 'secret.png'))).toBe(true)
    expect(existsSync(join(dir, 'leak.png'))).toBe(true)
  })

  test('a transcript that is a link out is unlinked and what it points at is left', () => {
    writeFileSync(join(outside, 'secret.txt'), 't')
    put('Call_a.ogg')
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'Call_a.txt'))
    removeCaptureFile('Call_a.ogg', where)
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
    expect(existsSync(join(dir, 'Call_a.txt'))).toBe(false)
  })
})

describe('bytes', () => {
  test('byteRange reads the three forms and refuses the rest', () => {
    expect(byteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    for (const bad of ['bytes=100-', 'bytes=9-2', 'bytes=-', 'items=0-1', 'bytes=0-1,5-6', 'bytes=-0']) expect(byteRange(bad, 100)).toBeNull()
  })

  const route = captureFileRoute({} as any, where)
  const ask = (name: string, extra: object = {}) => route({ user: { id: '1' }, route: { name }, headers: {}, json: (b: unknown, s: number) => Response.json(b, { status: s }), ...extra } as any) as Promise<Response>

  test('the route answers the bytes, a slice for a Range, 401 to a stranger and 404 to a bad name', async () => {
    put('v.mp4', '0123456789')
    const whole = await ask('v.mp4')
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(await whole.text()).toBe('0123456789')

    const part = await ask('v.mp4', { headers: { range: 'bytes=2-4' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await part.text()).toBe('234')

    expect((await ask('v.mp4', { headers: { range: 'bytes=20-' } })).status).toBe(416)
    expect((await ask('v.mp4', { user: null })).status).toBe(401)
    expect((await ask('../x.png')).status).toBe(404)
    expect((await ask('missing.png')).status).toBe(404)
  })
})

// The service, through the real app: the config's save_dir is the temp folder
// (XDG_CONFIG_HOME), the member is the door's ADMINISTRATOR, a stranger is refused.
describe('the service', () => {
  const DB = join(import.meta.dir, '..', '..', 'db')
  const saved = process.env.XDG_CONFIG_HOME
  let env: any
  afterAll(async () => { saved === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = saved); await env?.close() })

  test('files lists the configured folder, removeFile deletes with sidecars and refuses a path, and a stranger is refused', async () => {
    process.env.XDG_CONFIG_HOME = join(root, 'xdg')
    mkdirSync(join(root, 'xdg', 'capture'), { recursive: true })
    writeFileSync(join(root, 'xdg', 'capture', 'config.toml'), `save_dir = "${dir}"\n`)
    env = await createTestEnv({
      schema: join(DB, 'schema.lite'), migrations: join(DB, 'migrations'), encryptionKey: '0'.repeat(64),
      api: ({ db }: any) => buildWorkbenchApp({ db, key: 'test-key' }) as Promise<App>,
    })
    const member = await (env.system as any).member.create({ data: { nick: 'jordan' } })
    const svc = env.as(sessionContext({ id: String(member.id), isAdmin: true })).service('capture')

    put('Call_a.ogg', 'o', 5); put('Call_a.txt', 'hello', 5); put('s.png', 'p', 50)
    const listed = await svc.call('files', null, {})
    expect(listed.dir).toBe(dir)
    expect(listed.files.map((f: any) => f.name)).toEqual(['Call_a.ogg', 's.png'])
    expect(listed.files[0].transcript).toBe('hello')

    const bad = await svc.call('removeFile', null, { name: '../x.png' }).then(() => null, (e: any) => e)
    expect(bad?.message).toContain('not a path')
    expect(await svc.call('removeFile', null, { name: 'Call_a.ogg' })).toEqual({ removed: ['Call_a.txt', 'Call_a.ogg'] })
    expect(existsSync(join(dir, 'Call_a.txt'))).toBe(false)
    expect(existsSync(join(dir, 's.png'))).toBe(true)

    const stranger = env.as(sessionContext({ id: '0', isAdmin: false })).service('capture')
    const refused = await stranger.call('files', null, {}).then(() => null, (e: any) => e)
    expect(refused).toBeTruthy()
  })
})
