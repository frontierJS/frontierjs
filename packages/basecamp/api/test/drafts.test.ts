/*
 * drafts.test.ts — an owner's draft of a static site, over a real git remote
 * (`IDEAS/owner-editing.md` 1.2, `FJS-D1227`).
 *
 * The remote is a bare repository in a temp directory and basecamp's clone is
 * another, so every claim here is git's answer rather than a stand-in's. Three
 * claims:
 *
 * **The grant is the authority, and a membership is not one.** An editor with
 * no membership reaches their site; a workspace admin with no grant does not.
 *
 * **A save is one commit on the draft, pushed, carrying the editor's name** —
 * and it touches only the lines the edit names.
 *
 * **What the owner may not write is refused before anything is pushed**: a
 * developer's file by path, a locked key by name, and a file someone saved
 * since it was read.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { execFileSync }           from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                 from 'node:os'
import { join }                   from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }             from '@frontierjs/litestone'
import { basecampGateLevel }      from '../src/core/gate.ts'
import { buildBasecampApp }       from '../src/app.ts'
import { grantsFor }              from '../src/core/capabilities.ts'
import { env as appEnv }          from '../src/core/env.ts'
import { cloudflareFor, markPreview, previewStatuses } from '../src/core/site-preview.ts'
import { NO_KEY, askStatuses }   from '../src/core/site-ask.ts'
import { MergeConflict, advanceBase, mergeDraft, revertDraft, saveDraftFile, openDraft, readDraftFile } from '../src/core/site-checkout.ts'
import { registerAccount }        from '../src/providers/compute/accounts.ts'
import { startCfSink, SINK_ACCOUNT } from '../src/providers/edge/cloudflare-sink.ts'

let env: any, editor: any, admin: any, stranger: any, site: any, tmp: string, remote: string
const uniq = () => Math.random().toString(36).slice(2, 8)
const git  = (dir: string, ...argv: string[]) => execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8' }).trim()

const PAGE = [
  '---',
  'layout: Block',
  'tone: muted',
  'title: Welcome   # the hero',
  '---',
  'We open at nine.',
  '',
].join('\n')

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'basecamp-drafts-'))
  ;(appEnv as Record<string, unknown>).SITES_DIR = join(tmp, 'sites')

  // The site lives under site/ in its repository, as the website's does.
  const work = join(tmp, 'work')
  mkdirSync(join(work, 'site', 'content', 'routes'), { recursive: true })
  mkdirSync(join(work, 'site', 'content', 'settings'), { recursive: true })
  writeFileSync(join(work, 'site', 'content', 'routes', 'index.md'), PAGE)
  writeFileSync(join(work, 'site', 'content', 'settings', 'site.js'), 'export default {}\n')
  git(tmp, 'init', '--quiet', '--initial-branch=main', work)
  git(work, 'add', '.')
  git(work, '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-m', 'Site')
  remote = join(tmp, 'remote.git')
  git(tmp, 'clone', '--quiet', '--bare', work, remote)

  env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  const sys  = env.system as any
  const acct = await sys.account.create({ data: { slug: `a-${uniq()}`, displayName: 'A' } })
  const person = (name: string) => sys.user.create({ data: { email: `${name}-${uniq()}@x.co`, name, accountId: acct.id, status: 'active' } })
  const [a, e, s] = [await person('Admin'), await person('Owner'), await person('Stranger')]

  const ws = await sys.workspace.create({ data: { accountId: acct.id, name: 'Agency', slug: `w-${uniq()}`, ownerId: a.id } })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: a.id, role: 'admin', capabilities: grantsFor('admin'), acceptedAt: new Date().toISOString() } })
  const project = await sys.project.create({ data: { workspaceId: ws.id, name: 'Sites', slug: `p-${uniq()}` } })
  const environment = await sys.environment.create({ data: {
    workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })
  site = await sys.app.create({ data: {
    workspaceId: ws.id, environmentId: environment.id, name: 'Spa', slug: `spa-${uniq()}`, type: 'static',
    source: { kind: 'git', repo: remote, path: 'site' } } })
  await sys.appEditor.create({ data: { appId: site.id, userId: e.id, role: 'edit' } })

  admin    = session({ id: a.id, workspaceId: ws.id })
  editor   = session({ id: e.id })
  stranger = session({ id: s.id })
})

const sink = startCfSink(0)
afterAll(() => { sink.stop(); rmSync(tmp, { recursive: true, force: true }) })

const drafts = (who: any) => env.as(who).service('drafts')

/** A `w`×`h` 24-bit BMP of a gradient, the smallest image Bun.Image reads that needs no fixture file. */
function bmp(w: number, h: number): Uint8Array {
  const row = Math.ceil(w * 3 / 4) * 4, size = 54 + row * h
  const b = Buffer.alloc(size)
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14)
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set([x * 8, y * 12, 128], 54 + y * row + x * 3)
  return new Uint8Array(b)
}
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)

describe('drafts', () => {
  test('an editor with no membership is offered their site; the admin and a stranger are not', async () => {
    const mine = await drafts(editor).call('sites', undefined, {})
    expect(mine.sites.map((s: any) => [s.id, s.role])).toEqual([[site.id, 'edit']])
    expect((await drafts(admin).call('sites', undefined, {})).sites).toEqual([])
    expect((await refusal(drafts(stranger).call('list', undefined, { appId: site.id }))).code).toBe(404)
    expect((await refusal(drafts(admin).call('list', undefined, { appId: site.id }))).code).toBe(404)
  })

  test('a draft is a branch on the remote, and a save is one commit pushed to it in the editor\'s name', async () => {
    const opened = await drafts(editor).call('open', undefined, { appId: site.id, name: 'Spring hours' })
    expect(opened.branch).toBe('draft/spring-hours')
    expect(git(remote, 'rev-parse', 'draft/spring-hours')).toBe(git(remote, 'rev-parse', 'main'))

    const files = await drafts(editor).call('files', undefined, { appId: site.id, draft: 'spring-hours' })
    expect(files.files).toEqual(['content/routes/index.md'])

    const form = await drafts(editor).call('read', undefined, { appId: site.id, draft: 'spring-hours', path: 'content/routes/index.md' })
    expect(form.keys.map((k: any) => [k.key, k.field])).toEqual([['layout', false], ['tone', false], ['title', true]])

    const saved = await drafts(editor).call('save', undefined, {
      appId: site.id, draft: 'spring-hours', path: 'content/routes/index.md', blob: form.blob,
      body: 'We open at ten.\n', values: { title: 'Hello' }, message: 'Open later',
    })
    expect(saved.changed).toBe(true)
    expect(git(remote, 'rev-parse', 'draft/spring-hours')).toBe(saved.commit)
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'draft/spring-hours')).toBe('Owner|Open later')
    expect(git(remote, 'show', 'draft/spring-hours:site/content/routes/index.md'))
      .toBe(PAGE.replace('Welcome', 'Hello').replace('nine', 'ten').trimEnd())
    expect(git(remote, 'rev-parse', 'main')).not.toBe(saved.commit)

    const listed = await drafts(editor).call('list', undefined, { appId: site.id })
    expect(listed.drafts.map((d: any) => [d.name, d.head, d.author])).toEqual([['spring-hours', saved.commit, 'Owner']])
  })

  test('a developer\'s file, a locked key and a stale read are refused, and nothing is pushed', async () => {
    const head = () => git(remote, 'rev-parse', 'draft/spring-hours')
    const before = head()
    const form = await drafts(editor).call('read', undefined, { appId: site.id, draft: 'spring-hours', path: 'content/routes/index.md' })
    const save = (extra: Record<string, unknown>) => refusal(drafts(editor).call('save', undefined, {
      appId: site.id, draft: 'spring-hours', path: 'content/routes/index.md', blob: form.blob, ...extra }))

    const devFile = await refusal(drafts(editor).call('read', undefined, { appId: site.id, draft: 'spring-hours', path: 'content/settings/site.js' }))
    expect([devFile.code, devFile.message]).toEqual([400, expect.stringMatching(/developer's/)])
    expect((await save({ values: { tone: 'danger' } })).message).toMatch(/tone decides what the block is/)
    expect((await save({ blob: '0'.repeat(40), body: 'x' })).code).toBe(409)
    expect((await save({ body: 'We open at nine.\n<script>fetch("/x")</script>\n' })).message).toMatch(/<script>.*developer's/)
    expect(head()).toBe(before)

    // Someone else saved since this form was read.
    await drafts(editor).call('save', undefined, {
      appId: site.id, draft: 'spring-hours', path: 'content/routes/index.md', blob: form.blob, body: 'Closed Mondays.\n' })
    expect((await save({ body: 'Open Sundays.\n' })).code).toBe(409)
    expect(git(remote, 'show', 'draft/spring-hours:site/content/routes/index.md')).toMatch(/Closed Mondays\.$/)
  })

  test('a text edit swaps the words in the block its line opens, and words it cannot place alone are refused', async () => {
    const path = 'content/routes/index.md'
    const call = (extra: Record<string, unknown>) => drafts(editor).call('save', undefined, { appId: site.id, draft: 'spring-hours', path, ...extra })
    const form = await drafts(editor).call('read', undefined, { appId: site.id, draft: 'spring-hours', path })
    await call({ blob: form.blob, body: 'Call us today.\n\nOpen late.\nCall us today.\n' })
    const second = form.bodyLine + 2

    const saved = await call({ text: { line: second, old: 'Call us today.', next: 'Ring us now.' } })
    expect(saved.changed).toBe(true)
    expect(git(remote, 'show', 'draft/spring-hours:site/content/routes/index.md'))
      .toBe(PAGE.replace('Welcome', 'Hello').replace('We open at nine.\n', 'Call us today.\n\nOpen late.\nRing us now.'))
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'draft/spring-hours')).toBe(`Owner|Edit ${path}`)

    const head = git(remote, 'rev-parse', 'draft/spring-hours')
    expect((await refusal(call({ text: { line: second, old: 'Open late, Sundays.', next: 'x' } }))).message).toMatch(/cannot be changed on their own/)
    expect((await refusal(call({ text: { line: second, old: 'Open late.', next: '*late*' } }))).message).toMatch(/markup/)
    expect((await refusal(call({ text: { line: second, old: 'Open late.', next: 'x' }, body: 'y' }))).message).toMatch(/not both/)
    expect((await refusal(call({ text: { line: 'two', old: 'Open late.', next: 'x' } }))).code).toBe(400)
    expect(git(remote, 'rev-parse', 'draft/spring-hours')).toBe(head)
  })

  test('a text edit on a front-matter line writes the value written there (FJS-D1231)', async () => {
    const path = 'content/routes/index.md'
    const call = (extra: Record<string, unknown>) => drafts(editor).call('save', undefined, { appId: site.id, draft: 'spring-hours', path, ...extra })
    const form = await drafts(editor).call('read', undefined, { appId: site.id, draft: 'spring-hours', path })
    const line = (k: string) => form.keys.find((e: any) => e.key === k).line
    const before = git(remote, 'show', 'draft/spring-hours:site/content/routes/index.md')

    expect((await call({ text: { line: line('title'), old: 'Hello', next: 'Spring: open' } })).changed).toBe(true)
    expect(git(remote, 'show', 'draft/spring-hours:site/content/routes/index.md')).toBe(before.replace('title: Hello', 'title: "Spring: open"'))

    const head = git(remote, 'rev-parse', 'draft/spring-hours')
    expect((await refusal(call({ text: { line: line('title'), old: 'Hello', next: 'x' } }))).message).toMatch(/title has changed/)
    expect((await refusal(call({ text: { line: line('tone'), old: 'muted', next: 'danger' } }))).message).toMatch(/tone decides/)
    expect(git(remote, 'rev-parse', 'draft/spring-hours')).toBe(head)
  })

  // ─── Lists (3.1, FJS-D1403–FJS-D1405) ──────────────────────────────────
  test('a menu entry and a collection item are moved, copied and removed, one commit each', async () => {
    // A developer pushes a draft holding a menu and a collection.
    const work = join(tmp, 'lists')
    git(tmp, 'clone', '--quiet', remote, work)
    git(work, 'checkout', '--quiet', '-b', 'draft/lists')
    mkdirSync(join(work, 'site/content/menus'), { recursive: true })
    mkdirSync(join(work, 'site/content/collections/reviews'), { recursive: true })
    writeFileSync(join(work, 'site/content/menus/main.md'),
      '---\nitems:\n-\n  name: Home\n  link: /\n-\n  name: Hours\n  link: /hours/\n---\n')
    for (const [f, who] of [['1-ann', 'Ann'], ['2-bo', 'Bo'], ['3-cy', 'Cy']])
      writeFileSync(join(work, `site/content/collections/reviews/${f}.md`), `---\nreviewer: ${who}\n---\nGood.\n`)
    git(work, 'add', '.')
    git(work, '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-m', 'Lists')
    git(work, 'push', '--quiet', 'origin', 'draft/lists')

    const args = { appId: site.id, draft: 'lists' }
    const read = (path: string) => drafts(editor).call('read', undefined, { ...args, path })
    const arrange = (path: string, extra: Record<string, unknown>) => drafts(editor).call('arrange', undefined, { ...args, path, ...extra })
    const show = (path: string) => git(remote, 'show', `draft/lists:site/${path}`)
    const head = () => git(remote, 'rev-parse', 'draft/lists')

    const menu = await read('content/menus/main.md')
    expect(menu.entries.map((e: any) => e.label)).toEqual(['Home', 'Hours'])
    const moved = await arrange('content/menus/main.md', { blob: menu.blob, line: menu.entries[1].line + 1, act: 'earlier' })
    expect(moved.changed).toBe(true)
    expect(show('content/menus/main.md')).toBe('---\nitems:\n-\n  name: Hours\n  link: /hours/\n-\n  name: Home\n  link: /\n---')
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'draft/lists')).toBe("Owner|Move 'Hours' earlier in content/menus/main.md")
    expect((await refusal(arrange('content/menus/main.md', { blob: menu.blob, line: 3, act: 'copy' }))).code).toBe(409)

    const item = await read('content/collections/reviews/1-ann.md')
    expect(item.collection).toEqual({ folder: 'content/collections/reviews', index: 0, count: 3 })
    const before = head()
    await arrange('content/collections/reviews/1-ann.md', { blob: item.blob, act: 'later' })
    expect(git(remote, 'rev-list', '--count', `${before}..draft/lists`)).toBe('1')
    expect(show('content/collections/reviews/1-ann.md')).toBe('---\nreviewer: Ann\norder: 2\n---\nGood.')
    expect(show('content/collections/reviews/2-bo.md')).toBe('---\nreviewer: Bo\norder: 1\n---\nGood.')
    expect((await read('content/collections/reviews/1-ann.md')).collection.index).toBe(1)

    const bo = await read('content/collections/reviews/2-bo.md')
    const copied = await arrange('content/collections/reviews/2-bo.md', { blob: bo.blob, act: 'copy' })
    expect(copied.copy).toBe('content/collections/reviews/2-bo-copy.md')
    expect(show(copied.copy)).toBe('---\nreviewer: Bo\norder: 2\n---\nGood.')
    expect((await read(copied.copy)).collection).toEqual({ folder: 'content/collections/reviews', index: 1, count: 4 })

    const copy = await read(copied.copy)
    await arrange(copied.copy, { blob: copy.blob, act: 'remove' })
    expect(git(remote, 'ls-tree', '--name-only', 'draft/lists', 'site/content/collections/reviews/')).not.toContain('copy')
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'draft/lists')).toBe('Owner|Remove 2-bo-copy.md in reviews')

    const last = head()
    const cy = await read('content/collections/reviews/3-cy.md')
    expect((await refusal(arrange('content/collections/reviews/3-cy.md', { blob: cy.blob, act: 'later' }))).message).toMatch(/already last/)
    expect((await refusal(arrange('content/routes/index.md', { blob: cy.blob, act: 'later' }))).message).toMatch(/not an item of a collection/)
    expect((await refusal(arrange('content/collections/reviews/3-cy.md', { blob: cy.blob, act: 'shuffle' }))).code).toBe(400)
    expect((await refusal(drafts(stranger).call('arrange', undefined, { ...args, path: 'content/collections/reviews/3-cy.md', blob: cy.blob, act: 'earlier' }))).code).toBe(404)
    expect(head()).toBe(last)
  })

  // ─── Photos (3.2, FJS-D1406–FJS-D1408) ─────────────────────────────────
  test('a photo is swapped re-encoded, beside the old one, with its words, in one commit', async () => {
    const work = join(tmp, 'photos')
    git(tmp, 'clone', '--quiet', remote, work)
    git(work, 'checkout', '--quiet', '-b', 'draft/photos')
    mkdirSync(join(work, 'site/content/public/media/images'), { recursive: true })
    writeFileSync(join(work, 'site/content/public/media/images/owner.jpg'), 'old bytes')
    writeFileSync(join(work, 'site/content/routes/about.md'),
      '---\ntitle: About\nhero_image: /media/images/owner.jpg?width=800&height=600\n---\nHi.\n')
    git(work, 'add', '.')
    git(work, '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-m', 'Photos')
    git(work, 'push', '--quiet', 'origin', 'draft/photos')

    const args = { appId: site.id, draft: 'photos', path: 'content/routes/about.md' }
    const read = () => drafts(editor).call('read', undefined, args)
    const photo = (extra: Record<string, unknown>) => drafts(editor).call('photo', undefined, { ...args, ...extra })
    const show = (path: string) => git(remote, 'show', `draft/photos:site/${path}`)

    // A 3000×2000 phone photo carrying an EXIF block with a marker in it.
    const plain = await new (Bun as any).Image(bmp(30, 20)).resize(3000, 2000).jpeg({ quality: 80 }).bytes()
    const exif = new TextEncoder().encode('Exif\0\0MM\0*\0\0\0\x08\0\0GPS-PORCH-30.26N')
    const seg = new Uint8Array([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif])
    const shot = new Uint8Array([...plain.slice(0, 2), ...seg, ...plain.slice(2)])
    expect(Buffer.from(shot).includes('GPS-PORCH')).toBe(true)

    const form = await read()
    expect(form.keys.find((k: any) => k.key === 'hero_image').photo).toEqual({ src: '/media/images/owner.jpg', alt: '', file: 'content/public/media/images/owner.jpg' })
    expect((await refusal(photo({ blob: form.blob, key: 'hero_image', alt: ' ', photo: new File([shot], 'Porch.JPG', { type: 'image/jpeg' }) }))).message).toMatch(/what it shows/)
    expect((await refusal(photo({ blob: form.blob, key: 'hero_image', alt: 'Porch', photo: new File(['<html>'], 'x.jpg') }))).message).toMatch(/not a photo/)
    expect((await refusal(photo({ blob: form.blob, key: 'title', alt: 'Porch' }))).message).toMatch(/not one of the site's photos/)

    const before = git(remote, 'rev-parse', 'draft/photos')
    const done = await photo({ blob: form.blob, key: 'hero_image', alt: 'The front porch', photo: new File([shot], 'Porch.JPG', { type: 'image/jpeg' }) })
    expect(done).toMatchObject({ changed: true, photo: 'content/public/media/images/porch.jpg' })
    expect(git(remote, 'rev-list', '--count', `${before}..draft/photos`)).toBe('1')
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'draft/photos')).toBe('Owner|Photo for hero_image in content/routes/about.md')
    expect(show('content/routes/about.md')).toBe('---\ntitle: About\nhero_image: /media/images/porch.jpg?width=800&text=The+front+porch\n---\nHi.')
    expect(show('content/public/media/images/owner.jpg')).toBe('old bytes')
    const kept = execFileSync('git', ['-C', remote, 'show', 'draft/photos:site/content/public/media/images/porch.jpg'])
    expect(Buffer.from(kept).includes('GPS-PORCH')).toBe(false)
    expect(await new (Bun as any).Image(new Uint8Array(kept)).metadata()).toEqual({ width: 2560, height: 1707, format: 'jpeg' })

    // Words alone, and a second upload of the same name lands beside the first.
    const again = await read()
    await photo({ blob: again.blob, key: 'hero_image', alt: 'Our porch at dusk' })
    expect(show('content/routes/about.md')).toContain('hero_image: /media/images/porch.jpg?width=800&text=Our+porch+at+dusk')
    expect(git(remote, 'log', '-1', '--format=%s', 'draft/photos')).toBe('Words for the photo hero_image in content/routes/about.md')
    const third = await read()
    const second = await photo({ blob: third.blob, key: 'hero_image', alt: 'Porch', photo: new File([shot], 'porch.jpg', { type: 'image/jpeg' }) })
    expect(second.photo).toBe('content/public/media/images/porch-2.jpg')

    const last = git(remote, 'rev-parse', 'draft/photos')
    expect((await refusal(photo({ blob: form.blob, key: 'hero_image', alt: 'Stale' }))).code).toBe(409)
    expect((await refusal(drafts(stranger).call('photo', undefined, { ...args, blob: third.blob, key: 'hero_image', alt: 'x' }))).code).toBe(404)
    expect(git(remote, 'rev-parse', 'draft/photos')).toBe(last)
  })
})

// ─── The preview (1.3, FJS-D1251, FJS-D1252) ─────────────────────────────
// Opening a draft queues its build, run as the app. The machine half is
// outpost's own suite and the dev drive; here, what basecamp decides before a
// command leaves: which account uploads, which machine builds, and that every
// refusal lands on the status in words.

describe('a draft\'s preview', () => {
  const settled = async (draft: string) => {
    for (let i = 0; i < 200; i++) {
      const s = previewStatuses(site.id)[draft]
      if (s && (s.state === 'failed' || s.state === 'ready')) return s
      await Bun.sleep(25)
    }
    throw new Error(`the preview of ${draft} never settled: ${JSON.stringify(previewStatuses(site.id)[draft])}`)
  }
  const opened = async (name: string) => (await drafts(editor).call('open', undefined, { appId: site.id, name })).name

  test('a workspace with no Cloudflare account is refused by name, on the status the list answers', async () => {
    const draft = await opened('No account')
    expect((await settled(draft)).error).toMatch(/holds no Cloudflare account/)
    const listed = await drafts(editor).call('list', undefined, { appId: site.id })
    expect(listed.drafts.find((d: any) => d.name === draft).preview.state).toBe('failed')
  })

  test('with the account, the App\'s placement is the builder, and the stub machine is said to have built nothing', async () => {
    const sys = env.system as any
    const secret = await sys.secret.create({ data: {
      workspaceId: site.workspaceId, name: 'cf', kind: 'provider_key', providerKind: 'cloudflare', data: JSON.stringify({ token: 'cfat_devtoken' }) } })
    await registerAccount(env.app, secret, { address: `http://localhost:${sink.port}/client/v4` })
    // The only account is the one, and its id is read off a zone it opens.
    expect(await cloudflareFor(env.app, site.workspaceId)).toEqual({ token: 'cfat_devtoken', accountId: SINK_ACCOUNT })

    const unplaced = await opened('Unplaced')
    expect((await settled(unplaced)).error).toMatch(/not placed on any server/)

    let box = await sys.server.create({ data: { workspaceId: site.workspaceId, name: `box-${uniq()}`, slug: `box-${uniq()}` } })
    box = await sys.server.transition(box.id, 'checkIn')
    await sys.appServer.create({ data: { appId: site.id, serverId: box.id, replicaIndex: 0 } })
    process.env.BASECAMP_STUB_OUTPOST = '1'
    try {
      const stubbed = await opened('Stubbed')
      const status = await settled(stubbed)
      expect(status.error).toBe('stub executor — no /site/preview was issued')
      expect(status.commit).toBe(git(remote, 'rev-parse', 'draft/stubbed'))
    } finally {
      delete process.env.BASECAMP_STUB_OUTPOST
    }
  })

  test('preview builds again on request, and only for an editor of the site', async () => {
    expect((await refusal(drafts(admin).call('preview', undefined, { appId: site.id, draft: 'no-account' }))).code).toBe(404)
    const again = await drafts(editor).call('preview', undefined, { appId: site.id, draft: 'no-account' })
    expect(again.preview.state).toMatch(/queued|building|failed/)
  })
})

// An ask (4.1, FJS-D1242): `claude` is a stand-in that records what it was
// handed and edits the copy it was run in, as the real one would through Edit
// and Write. The argv's scope is the cli's, measured in its own suite; what is
// claimed here is the copy, the key, the cap on the argv, and that a run's
// edits come back as a tree with nothing committed.
describe('asking a model for a change', () => {
  let fake: string, seen: string
  const settled = async (draft: string) => {
    for (let i = 0; i < 400; i++) {
      const s = askStatuses(site.id)[draft]
      if (s && (s.state === 'failed' || s.state === 'ready')) return s
      await Bun.sleep(25)
    }
    throw new Error(`the ask on ${draft} never settled: ${JSON.stringify(askStatuses(site.id)[draft])}`)
  }
  const clone = () => join(tmp, 'sites', `${site.id}.git`)

  beforeAll(() => {
    seen = join(tmp, 'seen')
    mkdirSync(seen)
    fake = join(tmp, 'fake-claude')
    writeFileSync(fake, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${seen}/argv`,
      `printf '%s' "$ANTHROPIC_API_KEY" > ${seen}/key`,
      `cat > ${seen}/prompt`,
      `pwd > ${seen}/cwd`,
      `ok() { echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.04,"num_turns":3}'; }`,
      `if grep -q 'every page' ${seen}/prompt; then`,
      `  sed -i 's/nine/eight/' content/routes/index.md`,
      `  mkdir -p content/faq && printf 'Open at eight.\\n' > content/faq/hours.md`,
      `  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"The hours now say eight."}]}}'`,
      '  ok',
      `elif grep -q 'louder' ${seen}/prompt; then`,
      `  sed -i 's/nine/eight/; s/tone: muted/tone: danger/' content/routes/index.md`,
      '  ok',
      `elif grep -q 'readme' ${seen}/prompt; then`,
      `  sed -i 's/nine/eight/' content/routes/index.md`,
      `  printf 'not content\\n' > notes.md`,
      '  ok',
      `elif grep -q 'drop the review' ${seen}/prompt; then`,
      '  rm content/collections/reviews/9-zed.md',
      '  ok',
      `elif grep -q 'drop the home page' ${seen}/prompt; then`,
      '  rm content/routes/index.md',
      '  ok',
      'else',
      `  sed -i 's/nine/seven/' content/routes/index.md`,
      `  echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":2.01,"num_turns":9}'`,
      'fi',
    ].join('\n') + '\n', { mode: 0o755 })
  })
  afterAll(() => {
    delete (appEnv as Record<string, unknown>).ANTHROPIC_API_KEY
    ;(appEnv as Record<string, unknown>).CLAUDE_BIN = 'claude'
  })

  test('with no key on this basecamp, an ask is refused by name and nothing is queued', async () => {
    const draft = (await drafts(editor).call('open', undefined, { appId: site.id, name: 'Asked' })).name
    const err = await refusal(drafts(editor).call('ask', undefined, { appId: site.id, draft, request: 'Change the hours' }))
    expect([err.code, err.message]).toEqual([400, NO_KEY])
    expect(askStatuses(site.id)[draft]).toBeUndefined()
  })

  test('a run edits a copy of the draft\'s content, and comes back as a tree with nothing committed', async () => {
    ;(appEnv as Record<string, unknown>).ANTHROPIC_API_KEY = 'sk-ant-test'
    ;(appEnv as Record<string, unknown>).CLAUDE_BIN = fake
    expect((await refusal(drafts(admin).call('ask', undefined, { appId: site.id, draft: 'asked', request: 'x' }))).code).toBe(404)
    expect((await refusal(drafts(editor).call('ask', undefined, { appId: site.id, draft: 'asked', request: '  ' }))).code).toBe(400)

    const head = git(remote, 'rev-parse', 'draft/asked')
    const queued = await drafts(editor).call('ask', undefined, { appId: site.id, draft: 'asked', request: 'Change the hours on every page' })
    expect(queued.ask).toMatchObject({ state: 'queued', commit: head })
    const status = await settled('asked')

    expect(status).toMatchObject({ state: 'ready', commit: head, reply: 'The hours now say eight.', cost: 0.04, error: null })
    const was = git(remote, 'rev-parse', `${head}:site/content/routes/index.md`)
    expect(status.files.map(f => [f.path, f.was])).toEqual([['content/faq/hours.md', null], ['content/routes/index.md', was]])
    expect(git(clone(), 'show', `${status.tree}:site/content/routes/index.md`)).toBe(PAGE.replace('nine', 'eight').trimEnd())
    expect(git(clone(), 'show', `${status.tree}:site/content/settings/site.js`)).toBe('export default {}')
    expect(git(remote, 'rev-parse', 'draft/asked')).toBe(head)

    const argv = readFileSync(join(seen, 'argv'), 'utf8').split('\n')
    const cwd  = readFileSync(join(seen, 'cwd'), 'utf8').trim()
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('2')
    expect(argv).toContain(`Edit(/${cwd}/content)`)
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(readFileSync(join(seen, 'key'), 'utf8')).toBe('sk-ant-test')
    expect(readFileSync(join(seen, 'prompt'), 'utf8')).toContain('Leave these front-matter keys exactly as they are wherever a file has them at the top level: layout, name,')
    expect(cwd.startsWith(tmpdir())).toBe(true)

    const listed = await drafts(editor).call('list', undefined, { appId: site.id })
    expect(listed.drafts.find((d: any) => d.name === 'asked').ask.state).toBe('ready')
  })

  // The grade (4.2): the prompt asks the model to leave these alone, and
  // nothing but this holds it to that.
  test('a run that moves a look key is refused whole, naming the file and the key', async () => {
    await drafts(editor).call('ask', undefined, { appId: site.id, draft: 'asked', request: 'Make the welcome louder' })
    const status = await settled('asked')
    expect(status).toMatchObject({ state: 'failed', tree: null, files: [], cost: 0.04,
      error: 'nothing was kept: content/routes/index.md changes tone, which is the developer\'s' })
  })

  test('a run that writes outside content/ is refused whole, though its content edit was fine', async () => {
    await drafts(editor).call('ask', undefined, { appId: site.id, draft: 'asked', request: 'Change the hours and the readme' })
    const status = await settled('asked')
    expect(status).toMatchObject({ state: 'failed', tree: null, files: [],
      error: 'nothing was kept: notes.md is outside content/, so it is the developer\'s' })
  })

  test('a removed file is graded as any other change: an item goes, a page is its layout', async () => {
    const work = join(tmp, 'trim')
    git(tmp, 'clone', '--quiet', remote, work)
    git(work, 'checkout', '--quiet', '-b', 'draft/trim')
    mkdirSync(join(work, 'site/content/collections/reviews'), { recursive: true })
    writeFileSync(join(work, 'site/content/collections/reviews/9-zed.md'), '---\nreviewer: Zed\n---\nFine.\n')
    git(work, 'add', '.')
    git(work, '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-m', 'A review')
    git(work, 'push', '--quiet', 'origin', 'draft/trim')
    const was = git(remote, 'rev-parse', 'draft/trim:site/content/collections/reviews/9-zed.md')

    await drafts(editor).call('ask', undefined, { appId: site.id, draft: 'trim', request: 'Please drop the review from Zed' })
    const status = await settled('trim')
    expect(status).toMatchObject({ state: 'ready', files: [{ path: 'content/collections/reviews/9-zed.md', was, blob: null }] })
    expect(git(clone(), 'ls-tree', '-r', '--name-only', status.tree!)).not.toContain('9-zed.md')
    expect(git(clone(), 'show', `${status.tree}:site/content/routes/index.md`)).toBe(PAGE.trimEnd())

    await drafts(editor).call('ask', undefined, { appId: site.id, draft: 'trim', request: 'Please drop the home page' })
    expect(await settled('trim')).toMatchObject({ state: 'failed', tree: null,
      error: 'nothing was kept: content/routes/index.md changes layout, tone, which are the developer\'s' })
  })

  test('a run stopped at its spending limit is a failed ask, and its edits are dropped', async () => {
    await drafts(editor).call('ask', undefined, { appId: site.id, draft: 'asked', request: 'Make it friendlier' })
    const status = await settled('asked')
    expect(status).toMatchObject({ state: 'failed', tree: null, files: [], cost: 2.01, error: 'the ask reached its spending limit before it finished'})
  })

  // 4.3: the owner sees the lines, then keeps them as one commit or drops them.
  test('a waiting ask shows its lines; Keep is one commit on the draft, and Undo reverts it', async () => {
    const head = git(remote, 'rev-parse', 'draft/asked')
    await drafts(editor).call('ask', undefined, { appId: site.id, draft: 'asked', request: 'Change the hours on every page' })
    await settled('asked')

    const shown = await drafts(editor).call('asked', undefined, { appId: site.id, draft: 'asked' })
    expect(shown.ask.state).toBe('ready')
    expect(shown.diff.map((f: any) => f.path)).toEqual(['content/faq/hours.md', 'content/routes/index.md'])
    expect(shown.diff[0].hunks).toContain('+Open at eight.')
    expect(shown.diff[1].hunks).toMatch(/^-.*nine.*\n\+.*eight/m)
    expect((await refusal(drafts(admin).call('keep', undefined, { appId: site.id, draft: 'asked' }))).code).toBe(404)
    expect((await refusal(drafts(editor).call('undo', undefined, { appId: site.id, draft: 'asked' }))).message)
      .toBe('the ask on asked is waiting to be kept or discarded')

    const kept = await drafts(editor).call('keep', undefined, { appId: site.id, draft: 'asked' })
    expect(git(remote, 'rev-parse', 'draft/asked')).toBe(kept.commit)
    expect(git(remote, 'rev-parse', `${kept.commit}^`)).toBe(head)
    expect(git(remote, 'log', '-1', '--format=%an|%s', kept.commit)).toBe('Owner|Asked: Change the hours on every page')
    expect(git(remote, 'show', `${kept.commit}:site/content/faq/hours.md`)).toBe('Open at eight.')
    expect(askStatuses(site.id).asked).toMatchObject({ state: 'kept', kept: kept.commit })
    expect((await refusal(drafts(editor).call('keep', undefined, { appId: site.id, draft: 'asked' }))).code).toBe(409)
    expect((await refusal(drafts(editor).call('discard', undefined, { appId: site.id, draft: 'asked' }))).message)
      .toBe('the ask on asked is kept')

    const undone = await drafts(editor).call('undo', undefined, { appId: site.id, draft: 'asked' })
    expect(git(remote, 'rev-parse', `${undone.commit}^`)).toBe(kept.commit)
    expect(git(remote, 'rev-parse', `${undone.commit}^{tree}`)).toBe(git(remote, 'rev-parse', `${head}^{tree}`))
    expect(git(remote, 'log', '-1', '--format=%s', undone.commit)).toBe('Undo Asked: Change the hours on every page')
    expect(askStatuses(site.id).asked.state).toBe('undone')
    await drafts(editor).call('discard', undefined, { appId: site.id, draft: 'asked' })
    expect(askStatuses(site.id).asked).toBeUndefined()
    expect((await refusal(drafts(editor).call('asked', undefined, { appId: site.id, draft: 'asked' }))).code).toBe(404)
  })

  test('an ask is kept only on the head it read, and Discard commits nothing', async () => {
    await drafts(editor).call('ask', undefined, { appId: site.id, draft: 'asked', request: 'Change the hours on every page' })
    await settled('asked')
    const work = join(tmp, 'moved')
    git(tmp, 'clone', '--quiet', '--branch', 'draft/asked', remote, work)
    writeFileSync(join(work, 'site/content/settings/site.js'), 'export default { moved: true }')
    git(work, '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-am', 'Moved')
    git(work, 'push', '--quiet', 'origin', 'draft/asked')
    const moved = git(remote, 'rev-parse', 'draft/asked')

    const err = await refusal(drafts(editor).call('keep', undefined, { appId: site.id, draft: 'asked' }))
    expect([err.code, err.message]).toEqual([409, 'asked has changed since the ask read it — ask again'])
    expect(git(remote, 'rev-parse', 'draft/asked')).toBe(moved)
    await drafts(editor).call('discard', undefined, { appId: site.id, draft: 'asked' })
    expect(askStatuses(site.id).asked).toBeUndefined()
    expect(git(remote, 'rev-parse', 'draft/asked')).toBe(moved)
  })
})

// A publish (1.4, FJS-D1229, FJS-D1339): every refusal past the grant is a
// failed step on the release /sites/ shows, and the site's branch moves only
// after a deploy. The stub machine deploys nothing, so it is the last refusal
// a test without a real Outpost reaches; the merge and the branch's move are
// proved over the real remote below.

describe('publishing a draft', () => {
  let publisher: any
  const work = () => join(tmp, 'work')
  const developerPush = (file: string, text: string, message: string) => {
    git(work(), 'pull', '--quiet', remote, 'main')
    writeFileSync(join(work(), 'site', file), text)
    git(work(), 'add', '.')
    git(work(), '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-m', message)
    git(work(), 'push', '--quiet', remote, 'HEAD:main')
    return git(remote, 'rev-parse', 'main')
  }
  // What a developer's Deploy records; the drive that runs one is not here.
  const released = async (commit: string) => {
    const sys = env.system as any
    const row = await sys.deployment.create({ data: {
      workspaceId: site.workspaceId, appId: site.id, environmentId: site.environmentId, trigger: 'manual', commitSha: commit } })
    await sys.deployment.update({ where: { id: row.id }, data: { status: 'building' } })
    await sys.deployment.update({ where: { id: row.id }, data: { status: 'success', finishedAt: new Date().toISOString() } })
  }
  const published = async (draft: string) => {
    const queued = await drafts(publisher).call('publish', undefined, { appId: site.id, draft })
    for (let i = 0; i < 400; i++) {
      const last = (await drafts(publisher).call('list', undefined, { appId: site.id })).published
      if (last?.id === queued.published.id && ['success', 'failed'].includes(last.status)) return last
      await Bun.sleep(25)
    }
    throw new Error(`the publish of ${draft} never settled`)
  }
  const failedAt = (p: any) => p.steps.find((s: any) => s.status === 'failed')

  beforeAll(async () => {
    const sys = env.system as any
    const { accountId } = await sys.workspace.findFirst({ where: { id: site.workspaceId } })
    const u = await sys.user.create({ data: { email: `kim-${uniq()}@x.co`, name: 'Kim', status: 'active', accountId } })
    await sys.appEditor.create({ data: { appId: site.id, userId: u.id, role: 'publish' } })
    publisher = session({ id: u.id })
  })

  test('an editor without the publish grant is refused, and nothing is queued', async () => {
    const e = await refusal(drafts(editor).call('publish', undefined, { appId: site.id, draft: 'spring-hours' }))
    expect(e.code).toBe(403)
    expect((await drafts(editor).call('list', undefined, { appId: site.id })).published).toBeNull()
  })

  test('with no release recorded, what is live is unknown and the publish is refused at Validate', async () => {
    const p = await published('spring-hours')
    expect(p.status).toBe('failed')
    expect(failedAt(p)).toMatchObject({ name: 'Validate' })
    expect(failedAt(p).output).toMatch(/no release of this site is recorded/)
    expect(p.steps.slice(1).map((s: any) => s.status)).toEqual(['skipped', 'skipped', 'skipped'])
  })

  test('a commit on main the live site does not hold is refused, naming it and its author', async () => {
    await released(git(remote, 'rev-parse', 'main'))
    const ahead = developerPush('content/settings/site.js', 'export default { a: 1 }\n', 'Tweak config')
    const p = await published('spring-hours')
    expect(failedAt(p).name).toBe('Validate')
    expect(failedAt(p).output).toContain(`${ahead.slice(0, 7)} by Dev (Tweak config)`)
    expect(failedAt(p).output).toMatch(/Dev deploys it first/)
  })

  test('the stub machine deploys nothing, so main stays where the live release left it', async () => {
    const main = git(remote, 'rev-parse', 'main')
    await released(main)
    process.env.BASECAMP_STUB_OUTPOST = '1'
    try {
      const p = await published('spring-hours')
      expect(p.steps.map((s: any) => [s.name, s.status])).toEqual([
        ['Validate', 'success'], ['Merge', 'success'], ['Build and deploy', 'failed'], ['Advance branch', 'skipped']])
      expect(failedAt(p).output).toMatch(/stub executor — no \/site\/publish was issued, so main stays where it was/)
      expect(git(remote, 'rev-parse', 'main')).toBe(main)
      // The merge is on the draft, by the publisher, over both heads.
      expect(git(remote, 'log', '-1', '--format=%an|%s|%p', 'draft/spring-hours').split('|').slice(0, 2)).toEqual(['Kim', 'Publish spring-hours'])
      expect(git(remote, 'rev-parse', 'draft/spring-hours^1')).toBe(main)
    } finally {
      delete process.env.BASECAMP_STUB_OUTPOST
    }
  })

  test('a line the draft and main both changed is refused at Merge, naming the file', async () => {
    const theirs = developerPush('content/routes/index.md', PAGE.replace('nine', 'eight'), 'Hours')
    await released(theirs)
    const p = await published('spring-hours')
    expect(failedAt(p).name).toBe('Merge')
    expect(failedAt(p).output).toBe('spring-hours and main both changed content/routes/index.md — a developer merges them')
  })

  // History (1.5): a publish that went live, as the job leaves it — merged by
  // the core, the branch advanced, the release recorded with the merge.
  test('history lists each live release with its files and writers, and Revert opens a draft undoing a publish', async () => {
    const sys = env.system as any
    const g = { id: site.id, source: site.source }
    const opened = await drafts(editor).call('open', undefined, { appId: site.id, name: 'Hours' })
    const form = await drafts(editor).call('read', undefined, { appId: site.id, draft: opened.name, path: 'content/routes/index.md' })
    await drafts(editor).call('save', undefined, {
      appId: site.id, draft: opened.name, path: 'content/routes/index.md', blob: form.blob, body: 'We open at noon.\n' })
    const before = git(remote, 'rev-parse', 'main')
    const merged = await mergeDraft(g, opened.name, { name: 'Kim', email: 'kim@x.co' }, 'Publish hours', before)
    await advanceBase(g, merged)
    const row = await sys.deployment.create({ data: {
      workspaceId: site.workspaceId, appId: site.id, environmentId: site.environmentId, trigger: 'publish', author: 'Kim',
      commitSha: merged.commit, configSnapshot: { source: site.source, draft: 'hours', publisher: { userId: 'u', name: 'Kim', email: 'kim@x.co' } } } })
    await sys.deployment.update({ where: { id: row.id }, data: { status: 'building' } })
    await sys.deployment.update({ where: { id: row.id }, data: { status: 'success', finishedAt: new Date(Date.now() + 1000).toISOString() } })

    const { releases } = await drafts(editor).call('history', undefined, { appId: site.id })
    expect(releases[0]).toMatchObject({ id: row.id, draft: 'hours', by: 'Kim', files: ['content/routes/index.md'], authors: ['Owner'], revertable: true })
    expect(releases[1]).toMatchObject({ trigger: 'manual', revertable: false })

    expect((await refusal(drafts(admin).call('revert', undefined, { appId: site.id, release: row.id }))).code).toBe(404)
    const manual = await refusal(drafts(editor).call('revert', undefined, { appId: site.id, release: releases[1].id }))
    expect([manual.code, manual.message]).toEqual([400, expect.stringMatching(/developer's deploy/)])

    // The edit grant suffices: a revert only opens a draft, and main stays.
    const undone = await drafts(editor).call('revert', undefined, { appId: site.id, release: row.id })
    expect(undone.branch).toBe('draft/revert-hours')
    expect(git(remote, 'show', 'draft/revert-hours:site/content/routes/index.md')).toBe(git(remote, 'show', `${before}:site/content/routes/index.md`))
    expect(git(remote, 'log', '-1', '--format=%an|%s|%P', 'draft/revert-hours')).toBe(`Owner|Revert hours|${merged.commit}`)
    expect(git(remote, 'rev-parse', 'main')).toBe(merged.commit)
    expect((await refusal(drafts(editor).call('revert', undefined, { appId: site.id, release: row.id }))).message).toMatch(/revert-hours is already open/)
  })
})

describe('the merge a publish ships', () => {
  const g = { id: '', source: { repo: '' } as any }
  const who = { name: 'Kim', email: 'kim@x.co' }

  test('lines only one side changed are both kept, then main follows and the draft is removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'basecamp-merge-'))
    const w = join(dir, 'w'), r = join(dir, 'r.git')
    mkdirSync(join(w, 'content', 'routes'), { recursive: true })
    writeFileSync(join(w, 'content', 'routes', 'a.md'), 'one\ntwo\nthree\nfour\nfive\n')
    git(dir, 'init', '--quiet', '--initial-branch=main', w)
    git(w, 'add', '.')
    git(w, '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-m', 'Init')
    git(dir, 'clone', '--quiet', '--bare', w, r)
    Object.assign(g, { id: `m-${uniq()}`, source: { repo: r } })
    const root = join(dir, 'sites')

    await openDraft(g, 'Edits', root)
    const read = await readDraftFile(g, 'edits', 'content/routes/a.md', root)
    await saveDraftFile(g, 'edits', { path: 'content/routes/a.md', blob: read.blob, text: 'one\ntwo\nthree\nfour\nFIVE\n', message: 'Owner' }, who, root)
    writeFileSync(join(w, 'content', 'routes', 'a.md'), 'ONE\ntwo\nthree\nfour\nfive\n')
    git(w, '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-am', 'Dev')
    git(w, 'push', '--quiet', r, 'HEAD:main')
    const main = git(r, 'rev-parse', 'main')

    // Checked at the head before the developer's push: refused, not merged over.
    const stale = await mergeDraft(g, 'edits', who, 'x', git(r, 'rev-parse', 'main^'), root).catch((err: Error) => err)
    expect((stale as Error).message).toMatch(/main moved to .* while the publish was checked/)

    const merged = await mergeDraft(g, 'edits', who, 'Publish edits', main, root)
    expect(merged.paths).toEqual(['content/routes/a.md'])
    expect(git(r, 'show', `${merged.commit}:content/routes/a.md`)).toBe('ONE\ntwo\nthree\nfour\nFIVE')
    expect(git(r, 'rev-parse', 'draft/edits')).toBe(merged.commit)
    expect(git(r, 'rev-parse', 'main')).toBe(main)

    expect(await advanceBase(g, merged, root)).toEqual({ draftKept: false })
    expect(git(r, 'rev-parse', 'main')).toBe(merged.commit)
    expect(git(r, 'branch', '--list', 'draft/*')).toBe('')

    // Revert undoes the draft's side only: the developer's ONE came through
    // main, the merge's first parent, so it stays.
    const undo = await revertDraft(g, merged.commit, 'Undo', who, 'Revert edits', () => null, root)
    expect(git(r, 'show', `${undo.head}:content/routes/a.md`)).toBe('ONE\ntwo\nthree\nfour\nfive')
    expect(((await revertDraft(g, merged.commit, 'Vetoed', who, 'x', p => `${p} is no`, root).catch((e: Error) => e)) as Error).message)
      .toBe(`undoing ${merged.commit.slice(0, 7)} would change content/routes/a.md: content/routes/a.md is no`)

    git(w, 'pull', '--quiet', r, 'main')
    writeFileSync(join(w, 'content', 'routes', 'a.md'), 'ONE\ntwo\nthree\nfour\nFive!\n')
    git(w, '-c', 'user.name=Dev', '-c', 'user.email=dev@x.co', 'commit', '--quiet', '-am', 'Again')
    git(w, 'push', '--quiet', r, 'HEAD:main')
    const again = await revertDraft(g, merged.commit, 'Late', who, 'x', () => null, root).catch((e: Error) => e)
    expect(again).toBeInstanceOf(MergeConflict)
    expect((again as Error).message).toMatch(/^content\/routes\/a\.md changed again since/)
    expect(git(r, 'branch', '--list', 'draft/late')).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })
})

// FJS-3280: site-checkout.ts shells out to git, and an ssh remote needs the ssh
// client; oven/bun:1-slim ships neither, so /drafts failed only once deployed.
describe('the deployed image', () => {
  test('the runtime stage installs git and an ssh client', () => {
    const dockerfile = readFileSync(join(import.meta.dir, '../../deploy/Dockerfile'), 'utf8')
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))
    expect(runtime).toMatch(/apt-get install[^\n]*(\\\n[^\n]*)*\bgit\b/)
    expect(runtime).toMatch(/apt-get install[^\n]*(\\\n[^\n]*)*openssh-client/)
  })
})

// FJS-D1357: a preview on another site signs in through a one-time code bound
// to its PKCE challenge and to the origin its preview was recorded at, and
// gets a key that reaches only drafts. Over HTTP, because the origin is a header.
describe('a preview signs in', () => {
  const PREVIEW  = 'https://spring-hours-spa.acct.workers.dev'
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const call = (method: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    let req = env.http.post('/drafts').set('x-service-method', method)
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v)
    return req.send(body)
  }
  const handoff = async () => {
    const back = await drafts(editor).call('handoff', undefined, { appId: site.id, returnTo: `${PREVIEW}/hours/`, challenge })
    return new URL(back.redirect).hash.replace('#fjs-edit=', '')
  }

  beforeAll(() => { markPreview(site.id, 'spring-hours', { state: 'ready', commit: 'c0ffee', url: PREVIEW }) })

  test('a handoff returns only to a recorded preview of this site, and only for an editor', async () => {
    const elsewhere = await refusal(drafts(editor).call('handoff', undefined, { appId: site.id, returnTo: 'https://evil.example.com/', challenge }))
    expect([elsewhere.code, elsewhere.message]).toEqual([400, expect.stringContaining('https://evil.example.com is not a preview of this site')])
    expect((await refusal(drafts(stranger).call('handoff', undefined, { appId: site.id, returnTo: PREVIEW, challenge }))).code).toBe(404)
    const back = await drafts(editor).call('handoff', undefined, { appId: site.id, returnTo: `${PREVIEW}/hours/`, challenge })
    expect(back.redirect).toMatch(/^https:\/\/spring-hours-spa\.acct\.workers\.dev\/hours\/#fjs-edit=/)
  })

  test('the code is redeemed once, from the preview\'s origin, with its verifier', async () => {
    const wrongOrigin = await call('redeem', { appId: site.id, code: await handoff(), verifier }, { origin: 'https://evil.example.com' })
    expect(wrongOrigin.status).toBe(401)

    const code = await handoff()
    expect((await call('redeem', { appId: site.id, code, verifier: verifier.replace(/^./, c => c === 'a' ? 'b' : 'a') }, { origin: PREVIEW })).status).toBe(401)
    const code2 = await handoff()
    const ok = await call('redeem', { appId: site.id, code: code2, verifier }, { origin: PREVIEW })
    expect(ok.status).toBe(200)
    expect(ok.headers['access-control-allow-origin']).toBe(PREVIEW)
    const answer = ok.body.data ?? ok.body
    expect(answer).toMatchObject({ editor: { name: 'Owner' }, site: { id: site.id }, role: 'edit' })
    expect((await call('redeem', { appId: site.id, code: code2, verifier }, { origin: PREVIEW })).status).toBe(401)

    const key = answer.key
    const files = await call('files', { appId: site.id, draft: 'spring-hours' }, { origin: PREVIEW, authorization: `Bearer ${key}` })
    expect([files.status, (files.body.data ?? files.body).files]).toEqual([200, ['content/routes/index.md']])
    const asKey = { origin: PREVIEW, authorization: `Bearer ${key}` }
    const form = (await call('read', { appId: site.id, draft: 'spring-hours', path: 'content/routes/index.md' }, asKey)).body
    const saved = await call('save', { appId: site.id, draft: 'spring-hours', path: 'content/routes/index.md',
      blob: (form.data ?? form).blob, body: 'We open at eleven.\n', message: 'From the preview' }, asKey)
    expect(saved.status).toBe(200)
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'draft/spring-hours')).toBe('Owner|From the preview')
    // Another service, and a second handoff, are out of the key's reach.
    expect((await env.http.get('/apps').auth(key)).status).toBe(403)
    expect((await call('handoff', { appId: site.id, returnTo: PREVIEW, challenge }, { origin: PREVIEW, authorization: `Bearer ${key}` })).status).toBe(403)

    // The grant is read on every call, so a key outliving it reaches nothing.
    const sys = env.system as any
    const grant = await sys.appEditor.findFirst({ where: { appId: site.id, userId: editor.user?.id ?? editor.id } })
    await sys.appEditor.delete({ where: { id: grant.id } })
    try {
      expect((await call('files', { appId: site.id, draft: 'spring-hours' }, { origin: PREVIEW, authorization: `Bearer ${key}` })).status).toBe(404)
    } finally {
      await sys.appEditor.create({ data: { appId: site.id, userId: grant.userId, role: grant.role } })
    }
  })
})
