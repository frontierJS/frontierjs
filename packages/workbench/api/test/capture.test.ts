/**
 * capture.test.ts -- Capture's settings file over a temp path, so the real
 * ~/.config/capture/config.toml is never read or written. Every call passes
 * `{ file }`; the service itself reads the real path and is not called here.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureConfig, resetCaptureConfig, setCaptureConfig } from '../src/domain/capture/config.ts'
import { connecting, connectedRoute, landed, resetConnect, startConnect, testShare } from '../src/domain/capture/connect.ts'

const dir  = mkdtempSync(join(tmpdir(), 'wb-capture-'))
const file = join(dir, 'capture', 'config.toml')
const SECRET = 'KEY_NEVER_IN_A_RESPONSE_9f3a'
const mode = () => (statSync(file).mode & 0o777).toString(8)
const set  = (patch: object) => setCaptureConfig(patch, { file })

beforeEach(() => { rmSync(join(dir, 'capture'), { recursive: true, force: true }); resetConnect() })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('read', () => {
  test('no file reads as Capture\'s defaults', () => {
    const c = captureConfig({ file })
    expect(c).toMatchObject({
      exists: false, invalid: null, saveToFile: true, nameTemplate: 'Screenshot_%Y-%m-%d_%H-%M-%S', delaySecs: 5,
      uiScale: null, fileFormat: 'webp', captureMode: 'screenshot', videoFps: 30, videoInkSecs: 3,
      videoNameTemplate: 'Recording_%Y-%m-%d_%H-%M-%S', videoCursorHighlight: true, recordAudio: false,
      recordSystemAudio: false, webcam: false, webcamSize: 'medium', webUrl: '', webKeySet: false, shareOn: false,
    })
    expect(c.saveDir.endsWith('/Screenshots')).toBe(true)
    expect(c.toolStyles.highlighter).toEqual({ color: '#ffc107', size: 'medium' })
    expect(existsSync(file)).toBe(false)
  })

  test('a partial file fills the rest from the defaults, and the old image_quality reads as png', () => {
    set({ delaySecs: 9 })
    writeFileSync(file, 'delay_secs = 3\nimage_quality = "lossless"\n')
    expect(captureConfig({ file })).toMatchObject({ exists: true, delaySecs: 3, fileFormat: 'png', nameTemplate: 'Screenshot_%Y-%m-%d_%H-%M-%S' })
  })

  test('a file Capture cannot load reads as the defaults and says why', () => {
    set({ delaySecs: 9 })
    writeFileSync(file, 'delay_secs = "soon"\n')
    expect(captureConfig({ file })).toMatchObject({ delaySecs: 5, invalid: expect.stringContaining('delay_secs') })
    writeFileSync(file, 'delay_secs = [[[')
    expect(captureConfig({ file }).invalid).toBeTruthy()
  })
})

describe('write', () => {
  const every = {
    saveToFile: false, saveDir: '/tmp/shots', nameTemplate: '%Y%m%d-%H%M%S', delaySecs: 12, uiScale: 1.5,
    fileFormat: 'png256', captureMode: 'video', videoFps: 60, videoInkSecs: 4.5, videoNameTemplate: 'Rec_%n',
    videoCursorHighlight: false, recordAudio: true, recordSystemAudio: true, webcam: true, webcamSize: 'large',
    webUrl: 'https://share.example.com/', webKey: SECRET,
  }

  test('every field written reads back, and the key reads as set but never returns', () => {
    const out = set(every)
    expect(out).not.toHaveProperty('refused')
    const { webKey, ...rest } = every
    expect(captureConfig({ file })).toMatchObject({ ...rest, webKeySet: true, shareOn: true, exists: true, invalid: null })
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(JSON.stringify(captureConfig({ file }))).not.toContain(SECRET)
    expect(readFileSync(file, 'utf8')).toContain(`web_key = "${SECRET}"`)
  })

  test('the file is 0600, also over a looser file that was there', () => {
    set({ delaySecs: 7 })
    expect(mode()).toBe('600')
    chmodSync(file, 0o644)
    set({ webKey: SECRET })
    expect(mode()).toBe('600')
    expect(existsSync(file + '.tmp')).toBe(false)
  })

  test('a float field is written as a float, which is what Capture\'s own save writes', () => {
    set({ uiScale: 2, videoInkSecs: 3 })
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('ui_scale = 2.0')
    expect(text).toContain('video_ink_secs = 3.0')
  })

  test('a key not named in the patch is untouched, null clears the scale, and an empty key removes it', () => {
    set({ webKey: SECRET, webUrl: 'https://s.example.com', uiScale: 1.25 })
    set({ delaySecs: 8 })
    expect(captureConfig({ file })).toMatchObject({ delaySecs: 8, uiScale: 1.25, webKeySet: true })
    set({ uiScale: null })
    expect(captureConfig({ file }).uiScale).toBeNull()
    expect(readFileSync(file, 'utf8')).not.toContain('ui_scale')
    set({ webKey: '' })
    expect(captureConfig({ file })).toMatchObject({ webKeySet: false, shareOn: false })
  })

  test('unknown keys and sections survive a write, including inside tool_styles', () => {
    set({ delaySecs: 6 })
    writeFileSync(file, [
      'delay_secs = 6', 'future_flag = true', 'image_quality = "optimized"', 'nickname = "ada"', '',
      '[tool_styles.pen]', 'size = "large"', 'wobble = 3', '',
      '[mine]', 'list = [1, 2]', 'name = "kept"', '[mine.deep]', 'x = 1.5', '',
    ].join('\n'))
    chmodSync(file, 0o600)
    set({ nameTemplate: 'shot_%n', toolStyles: { pen: { color: '#0080FF' }, text: { size: 30, family: 'mono' } } })
    const parsed = Bun.TOML.parse(readFileSync(file, 'utf8')) as any
    expect(parsed).toMatchObject({ future_flag: true, image_quality: 'optimized', nickname: 'ada', name_template: 'shot_%n', delay_secs: 6 })
    expect(parsed.mine).toEqual({ list: [1, 2], name: 'kept', deep: { x: 1.5 } })
    expect(parsed.tool_styles.pen).toEqual({ size: 'large', wobble: 3, color: '#0080ff' })
    expect(parsed.tool_styles.text).toEqual({ size: 30, family: 'mono' })
    expect(readFileSync(file, 'utf8')).toContain('size = 30.0')
    expect(captureConfig({ file }).toolStyles.pen).toEqual({ color: '#0080ff', size: 'large' })
  })

  test('a tool size the wheel set is a number, kept beside the preset names', () => {
    set({ toolStyles: { pen: { size: 6 }, highlighter: { size: 22.5 }, arrow: { size: 'small' } } })
    const parsed = Bun.TOML.parse(readFileSync(file, 'utf8')) as any
    expect(parsed.tool_styles.pen.size).toBe(6)
    expect(parsed.tool_styles.highlighter.size).toBe(22.5)
    expect(parsed.tool_styles.arrow.size).toBe('small')
    expect(readFileSync(file, 'utf8')).toContain('size = 6.0')
    expect(captureConfig({ file })).toMatchObject({ invalid: null })
    expect(captureConfig({ file }).toolStyles.pen.size).toBe(6)

    // Capture wrote it; a later save of something else leaves it alone.
    writeFileSync(file, ['[tool_styles.rect]', 'size = 14.0', ''].join('\n'))
    chmodSync(file, 0o600)
    expect(captureConfig({ file })).toMatchObject({ invalid: null })
    set({ delaySecs: 7 })
    expect((Bun.TOML.parse(readFileSync(file, 'utf8')) as any).tool_styles.rect.size).toBe(14)
  })
})

describe('refusals', () => {
  const refuses = (patch: object, re?: RegExp) => {
    set({ delaySecs: 5 })
    const before = readFileSync(file, 'utf8')
    const out = set(patch)
    expect(out).toHaveProperty('refused')
    if (re) expect((out as { refused: string }).refused).toMatch(re)
    expect(readFileSync(file, 'utf8')).toBe(before)
  }

  test('an empty or blank name template, for a screenshot or a recording', () => {
    refuses({ nameTemplate: '' }, /must not be empty/)
    refuses({ nameTemplate: '   ' }, /must not be empty/)
    refuses({ videoNameTemplate: '' }, /must not be empty/)
  })

  test('a value of the wrong type, which Capture would answer by resetting the whole file', () => {
    refuses({ delaySecs: '5' })
    refuses({ delaySecs: 2.5 })
    refuses({ saveToFile: 'yes' })
    refuses({ fileFormat: 'gif' })
    refuses({ captureMode: 'photo' })
    refuses({ webcamSize: 'huge' })
    refuses({ uiScale: 'big' })
    refuses({ saveDir: 7 })
    refuses({ webUrl: null })
  })

  test('a value outside the range the settings window offered', () => {
    refuses({ delaySecs: 0 }, /1 to 30/)
    refuses({ delaySecs: 31 })
    refuses({ delaySecs: -1 })
    refuses({ uiScale: 0.1 })
    refuses({ uiScale: 5 })
    refuses({ videoFps: 45 })
    refuses({ videoInkSecs: 0.2 })
    refuses({ saveDir: '  ' })
  })

  test('a share address Capture would not send the key to, and a key with a newline', () => {
    refuses({ webUrl: 'http://share.example.com' }, /https/)
    refuses({ webUrl: 'ftp://share.example.com' })
    refuses({ webKey: 'a\nb' })
    expect(set({ webUrl: 'http://localhost' })).not.toHaveProperty('refused')
    expect(set({ webUrl: 'share.example.com' })).not.toHaveProperty('refused')
    expect(set({ webUrl: '' })).not.toHaveProperty('refused')
  })

  test('a name that is not a setting, and a bad tool style', () => {
    refuses({ nope: 1 }, /not a Capture setting/)
    refuses({ toolStyles: { laser: {} } })
    refuses({ toolStyles: { pen: { color: 'red' } } })
    refuses({ toolStyles: { pen: { size: 'huge' } } })
    refuses({ toolStyles: { pen: { size: 0 } } })
    refuses({ toolStyles: { pen: { size: -2 } } })
    refuses({ toolStyles: { pen: { size: Infinity } } })
    refuses({ webcamSize: 6 })
    refuses({ toolStyles: { text: { size: 5 } } })
    refuses({ toolStyles: { pen: { wobble: 1 } } })
  })

  test('one bad value among good ones writes none of them', () => {
    set({ delaySecs: 5 })
    expect(set({ delaySecs: 9, nameTemplate: '' })).toHaveProperty('refused')
    expect(captureConfig({ file }).delaySecs).toBe(5)
  })

  test('a file that is not TOML, or holds a value Capture cannot load, is not overwritten', () => {
    set({ delaySecs: 5 })
    writeFileSync(file, 'delay_secs = [[[')
    expect(set({ delaySecs: 6 })).toHaveProperty('refused')
    expect(readFileSync(file, 'utf8')).toBe('delay_secs = [[[')
    writeFileSync(file, 'file_format = "gif"\nkeep = 1\n')
    expect(set({ delaySecs: 6 })).toHaveProperty('refused')
    expect(readFileSync(file, 'utf8')).toBe('file_format = "gif"\nkeep = 1\n')
  })
})

describe('reset', () => {
  const reset = () => resetCaptureConfig({ file })
  const defaultsRead = () => { rmSync(join(dir, 'capture'), { recursive: true, force: true }); return captureConfig({ file }) }

  test('every setting goes back to the defaults, the share URL and key stay, and the file stays 0600', () => {
    const fresh = defaultsRead()
    set({
      saveToFile: false, saveDir: '/tmp/shots', nameTemplate: 'x_%n', delaySecs: 12, uiScale: 1.5, fileFormat: 'png',
      captureMode: 'video', videoFps: 60, videoInkSecs: 0, videoNameTemplate: 'r_%n', videoCursorHighlight: false,
      recordAudio: true, recordSystemAudio: true, webcam: true, webcamSize: 'large',
      webUrl: 'https://share.example.com/', webKey: SECRET,
      toolStyles: { pen: { color: '#0080ff', size: 'large' }, text: { size: 40, bold: true } },
    })
    const out = reset()
    if ('refused' in out) throw new Error(out.refused)
    const { path, exists, webUrl, webKeySet, webKeyHint, shareOn, ...settings } = out
    const { path: _p, exists: _e, webUrl: _u, webKeySet: _s, webKeyHint: _h, shareOn: _o, ...want } = fresh
    expect(settings).toEqual(want)
    expect({ webUrl, webKeySet, shareOn }).toEqual({ webUrl: 'https://share.example.com/', webKeySet: true, shareOn: true })
    expect(JSON.stringify(out)).not.toContain(SECRET)
    const parsed = Bun.TOML.parse(readFileSync(file, 'utf8')) as any
    expect(parsed.web_key).toBe(SECRET)
    expect('ui_scale' in parsed).toBe(false)
    expect(mode()).toBe('600')
  })

  test('unknown keys and sections survive, including inside a tool\'s style', () => {
    set({ delaySecs: 6 })
    writeFileSync(file, [
      'delay_secs = 9', 'future_flag = true', '',
      '[tool_styles.pen]', 'size = "large"', 'wobble = 3', '',
      '[tool_styles.laser]', 'color = "#00ff00"', '',
      '[mine]', 'name = "kept"', '',
    ].join('\n'))
    reset()
    const parsed = Bun.TOML.parse(readFileSync(file, 'utf8')) as any
    expect(parsed).toMatchObject({ delay_secs: 5, future_flag: true, mine: { name: 'kept' }, web_url: '', web_key: '' })
    expect(parsed.tool_styles.pen).toEqual({ size: 'medium', wobble: 3, color: '#e53935' })
    expect(parsed.tool_styles.laser).toEqual({ color: '#00ff00' })
    expect(readFileSync(file, 'utf8')).toContain('size = 22.0')
  })

  test('a value Capture cannot load is replaced, but a file that is not TOML is refused and left alone', () => {
    set({ delaySecs: 6 })
    writeFileSync(file, 'file_format = "gif"\nweb_url = "https://kept.example/"\nkeep = 1\n')
    const out = reset()
    expect(out).toMatchObject({ invalid: null, fileFormat: 'webp', webUrl: 'https://kept.example/' })
    expect((Bun.TOML.parse(readFileSync(file, 'utf8')) as any).keep).toBe(1)
    writeFileSync(file, 'delay_secs = [[[')
    expect(reset()).toHaveProperty('refused')
    expect(readFileSync(file, 'utf8')).toBe('delay_secs = [[[')
  })

  test('no file writes one holding the defaults', () => {
    const out = reset()
    expect(out).toMatchObject({ exists: true, delaySecs: 5, webKeySet: false })
    expect(mode()).toBe('600')
  })
})

// ─── connect and test, against a stand-in share app ──────────────────────────

describe('connect and test', () => {
  const KEY = 'SHARE_KEY_NEVER_ON_A_PAGE_77c1'
  let exchanged: any[] = []
  let exchange: (body: any) => Response = () => Response.json({ key: KEY, name: 'Ada', email: 'ada@example.com' })
  let ping: (req: Request) => Response = () => Response.json({ app: 'capture', user: { id: 'u1', email: 'ada@example.com', name: null }, credentialId: 'k1' })

  const share = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/kw/api/connect/exchange' && req.method === 'POST') { const body = await req.json(); exchanged.push(body); return exchange(body) }
      if (pathname === '/kw/api/ping') return ping(req)
      return new Response('<html>not the share app</html>', { status: 404 })
    },
  })
  afterAll(() => share.stop(true))
  const BASE = `http://127.0.0.1:${share.port}/kw/`
  const land = (query: string) => landed(new URLSearchParams(query), { file })
  const begin = () => {
    set({ webUrl: BASE })
    const out = startConnect({ port: 4321 }, { file }) as { url: string }
    const q = new URL(out.url).searchParams
    return { out, q, state: q.get('state')! }
  }

  test('Connect is refused with no address saved, and writes nothing', () => {
    expect(startConnect({ port: 4321 }, { file })).toEqual({ refused: expect.stringContaining('address') })
    expect(connecting()).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  test('the URL carries the device, the loopback return, a state and a 43-character S256 challenge', () => {
    const { out, q } = begin()
    expect(out.url.startsWith(`http://127.0.0.1:${share.port}/kw/connect/?`)).toBe(true)
    expect([...q.keys()].sort()).toEqual(['code_challenge', 'device', 'redirect_uri', 'state'])
    expect(q.get('device')).toBe(require('node:os').hostname())
    expect(q.get('redirect_uri')).toBe('http://localhost:4321/capture-connected')
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(16)
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(connecting()).toBe(true)
  })

  test('a new Connect replaces the old attempt', async () => {
    const first = begin()
    const second = begin()
    expect(second.state).not.toBe(first.state)
    expect((await land(`code=c1&state=${first.state}`)).status).toBe(400)
    expect(connecting()).toBe(true)
  })

  test('a landing with the wrong or no state, or no attempt, writes nothing and leaves the attempt waiting', async () => {
    expect((await land('code=c1&state=nope')).status).toBe(400)
    set({ webUrl: BASE })
    const { state } = begin()
    exchanged = []
    expect((await land('code=c1&state=nope')).message).toContain('not waiting')
    expect((await land('code=c1')).status).toBe(400)
    expect(exchanged).toEqual([])
    expect(captureConfig({ file }).webKeySet).toBe(false)
    expect(connecting()).toBe(true)
    expect((await land(`code=c1&state=${state}`)).status).toBe(200)
  })

  test('a good code trades for the key, which lands 0600 and is on no page, and the attempt is spent', async () => {
    const { q, state } = begin()
    exchanged = []
    const res = await connectedRoute({ file })({ $raw: { url: `http://localhost:4321/capture-connected?code=c0de&state=${state}` }, html: (b: string, status?: number) => new Response(b, { status, headers: { 'content-type': 'text/html' } }) } as any)
    const page = await res.text()
    expect(res.status).toBe(200)
    expect(page).toContain('Connected as ada@example.com. You can close this tab and go back to Workbench.')
    expect(page).not.toContain(KEY)
    expect(exchanged).toEqual([{ code: 'c0de', verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), redirectUri: q.get('redirect_uri') }])
    // the verifier is the one the challenge was made from
    expect(new Bun.CryptoHasher('sha256').update(exchanged[0].verifier).digest('base64url')).toBe(q.get('code_challenge')!)
    expect(readFileSync(file, 'utf8')).toContain(`web_key = "${KEY}"`)
    expect(mode()).toBe('600')
    expect(JSON.stringify(captureConfig({ file }))).not.toContain(KEY)
    expect(captureConfig({ file })).toMatchObject({ webKeySet: true, shareOn: true })
    expect(connecting()).toBe(false)
    expect((await land(`code=c0de&state=${state}`)).status).toBe(400)
  })

  test('access_denied is a plain cancelled page, writes nothing, and clears the attempt', async () => {
    const { state } = begin()
    exchanged = []
    const out = await land(`error=access_denied&state=${state}`)
    expect(out.message).toContain('cancelled')
    expect(exchanged).toEqual([])
    expect(captureConfig({ file }).webKeySet).toBe(false)
    expect(connecting()).toBe(false)
  })

  test('a refused exchange shows the share app\'s sentence and writes no key', async () => {
    const { state } = begin()
    exchange = () => Response.json({ error: 'That code was already used' }, { status: 400 })
    const out = await land(`code=old&state=${state}`)
    exchange = () => Response.json({ key: KEY, name: 'Ada', email: 'ada@example.com' })
    expect(out).toEqual({ status: 400, message: 'That code was already used' })
    expect(captureConfig({ file }).webKeySet).toBe(false)
    expect(connecting()).toBe(false)
  })

  test('an address changed while waiting writes no key', async () => {
    const { state } = begin()
    set({ webUrl: `${BASE}other/` })
    expect((await land(`code=c&state=${state}`)).message).toContain('changed')
    expect(captureConfig({ file }).webKeySet).toBe(false)
  })

  test('test names the failing part, and succeeds with whose key it is', async () => {
    expect(await testShare({ file })).toMatchObject({ ok: false, part: 'url' })
    set({ webUrl: BASE })
    expect(await testShare({ file })).toMatchObject({ ok: false, part: 'key' })

    set({ webKey: KEY })
    expect(await testShare({ file })).toEqual({ ok: true, part: null, message: 'Connected as ada@example.com.', email: 'ada@example.com' })

    ping = req => req.headers.get('authorization') === `Bearer ${KEY}` ? Response.json({ error: 'The key is missing, wrong or revoked' }, { status: 401 }) : new Response('?', { status: 500 })
    expect(await testShare({ file })).toMatchObject({ ok: false, part: 'key' })

    for (const wrong of [() => new Response('<html></html>'), () => Response.json({ app: 'other', user: { id: 'u' } }), () => new Response('gone', { status: 404 })]) {
      ping = wrong
      expect(await testShare({ file })).toMatchObject({ ok: false, part: 'url' })
    }

    const gone = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const closed = gone.port
    await gone.stop(true)
    set({ webUrl: `http://127.0.0.1:${closed}/` })
    expect(await testShare({ file })).toMatchObject({ ok: false, part: 'network' })
  })
})
