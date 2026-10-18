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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                 from 'node:os'
import { join }                   from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }             from '@frontierjs/litestone'
import { basecampGateLevel }      from '../src/core/gate.ts'
import { buildBasecampApp }       from '../src/app.ts'
import { grantsFor }              from '../src/core/capabilities.ts'
import { env as appEnv }          from '../src/core/env.ts'

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

  admin    = session({ userId: a.id, workspaceId: ws.id })
  editor   = session({ userId: e.id })
  stranger = session({ userId: s.id })
})

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const drafts = (who: any) => env.as(who).service('drafts')
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
    expect(head()).toBe(before)

    // Someone else saved since this form was read.
    await drafts(editor).call('save', undefined, {
      appId: site.id, draft: 'spring-hours', path: 'content/routes/index.md', blob: form.blob, body: 'Closed Mondays.\n' })
    expect((await save({ body: 'Open Sundays.\n' })).code).toBe(409)
    expect(git(remote, 'show', 'draft/spring-hours:site/content/routes/index.md')).toMatch(/Closed Mondays\.$/)
  })
})
