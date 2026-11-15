// api/test/git-forgejo.test.ts
// `ForgejoGit` — Forgejo's `/api/v1` read as `IGit` answers it, against a
// stand-in that answers Forgejo's shapes on a real port.
//
// The send here is a plain fetch with Forgejo's `token` scheme, because the
// provider is not yet a conduit target (no config slot holds its token ref);
// what is graded is the dialect: paging to the end, every combined-status
// state, and a 401 or 404 refused in Forgejo's terms rather than read as empty.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { ForgejoGit, ciVerdict } from '../src/providers/git/forgejo.ts'
import type { AccountSend } from '../src/providers/compute/index.ts'
import type { IGit }        from '../src/basecamp.types.ts'

const TOKEN = 'forgejo-test-pat'

// 53 repositories: two pages of 50 would hide a loop that stops at one.
const repos = Array.from({ length: 53 }, (_, i) => ({
  name:              `r${i}`,
  full_name:         `ana/r${i}`,
  clone_url:         `http://forge.test/ana/r${i}.git`,
  html_url:          `http://forge.test/ana/r${i}`,
  description:       i === 0 ? 'the first' : '',
  default_branch:    'main',
  private:           false,
  empty:             i === 52,
  archived:          false,
  open_issues_count: i === 0 ? 4 : 0,
  open_pr_counter:   i === 0 ? 2 : 0,
  updated_at:        '2026-11-15T10:00:00Z',
  permissions:       { admin: true, push: true, pull: true },
  owner:             { login: 'ana', id: 1 },
}))

// Repository r1..r5 have each combined state on main; the rest have none.
const stateOf: Record<string, string> = {
  'ana/r1': 'success', 'ana/r2': 'failure', 'ana/r3': 'error', 'ana/r4': 'pending', 'ana/r5': 'warning',
}

const pulls = [
  { number: 7, title: 'Add a thing', user: { login: 'bo' }, head: { ref: 'feat', sha: 'sha-ok' },
    base: { ref: 'main' }, mergeable: true,  merged: false, created_at: '2026-11-14T09:00:00Z', state: 'open' },
  { number: 8, title: 'Break a thing', user: { login: 'cy' }, head: { ref: 'bad', sha: 'sha-bad' },
    base: { ref: 'main' }, mergeable: false, merged: false, created_at: '2026-11-14T10:00:00Z', state: 'open' },
]
const shaState: Record<string, string> = { 'sha-ok': 'success', 'sha-bad': 'failure' }

const seen: string[] = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    seen.push(url.pathname + url.search)
    if (req.headers.get('authorization') !== `token ${TOKEN}`)
      return Response.json({ message: 'token is required' }, { status: 401 })
    const path  = url.pathname.replace(/^\/api\/v1/, '')
    const page  = Number(url.searchParams.get('page') ?? 1)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 30), 50)
    const paged = <T>(rows: T[]) => Response.json(rows.slice((page - 1) * limit, page * limit),
      { headers: { 'x-total-count': String(rows.length) } })

    if (path === '/user/repos') return paged(repos)
    let m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/status$/.exec(path)
    if (m) {
      const full = `${m[1]}/${m[2]}`
      if (!repos.some(r => r.full_name === full)) return Response.json({ message: 'not found' }, { status: 404 })
      const state = m[3] === 'main' ? stateOf[full] ?? '' : shaState[decodeURIComponent(m[3]!)] ?? ''
      return Response.json({ state, sha: 'x', total_count: state ? 1 : 0, statuses: [] })
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path)
    if (m) {
      if (`${m[1]}/${m[2]}` !== 'ana/r0') return Response.json({ message: 'not found' }, { status: 404 })
      return paged(pulls.filter(p => url.searchParams.get('state') !== 'closed'))
    }
    return Response.json({ message: 'not found' }, { status: 404 })
  },
})

const sendWith = (token: string): AccountSend => async (req) => {
  try {
    const res  = await fetch(`http://localhost:${server.port}/api/v1${req.path}`, {
      method:  req.method,
      headers: { authorization: `token ${token}`, accept: 'application/json' },
      signal:  AbortSignal.timeout(5000),
    })
    const data = await res.json().catch(() => null)
    return res.ok ? { data, status: res.status }
      : { data, status: res.status, error: { kind: res.status < 500 ? 'client_error' : 'server_error' } }
  } catch (e) {
    return { data: null, error: { kind: 'connection_failed', message: String(e) } }
  }
}

let git: ForgejoGit
beforeAll(() => { git = new ForgejoGit(sendWith(TOKEN)) })
afterAll(() => server.stop(true))

describe('ciVerdict', () => {
  test('maps every combined state, and no status at all to unknown', () => {
    expect(ciVerdict('success')).toBe('passing')
    expect(ciVerdict('failure')).toBe('failing')
    expect(ciVerdict('error')).toBe('failing')
    expect(ciVerdict('pending')).toBe('pending')
    expect(ciVerdict('warning')).toBe('pending')
    expect(ciVerdict('')).toBe('unknown')
    expect(ciVerdict(undefined)).toBe('unknown')
  })
})

describe('listRepos', () => {
  test('follows the pages to the end', async () => {
    seen.length = 0
    const list = await git.listRepos()
    expect(list).toHaveLength(53)
    expect(seen.filter(s => s.startsWith('/api/v1/user/repos'))).toEqual([
      '/api/v1/user/repos?page=1&limit=50', '/api/v1/user/repos?page=2&limit=50',
    ])
  })

  test("answers Basecamp's record, counts from the repository row", async () => {
    const first = (await git.listRepos()).find(r => r.name === 'ana/r0')
    expect(first).toEqual({
      name: 'ana/r0', clone_url: 'http://forge.test/ana/r0.git', description: 'the first',
      defaultBranch: 'main', ci: 'unknown', openPullRequests: 2, openIssues: 4,
      lastPushedAt: '2026-11-15T10:00:00Z',
    })
  })

  test('the default branch verdict, each state', async () => {
    const by = Object.fromEntries((await git.listRepos()).map(r => [r.name, r.ci]))
    expect([by['ana/r1'], by['ana/r2'], by['ana/r3'], by['ana/r4'], by['ana/r5'], by['ana/r6']])
      .toEqual(['passing', 'failing', 'failing', 'pending', 'pending', 'unknown'])
  })

  test('an empty repository is unknown without asking for a status', async () => {
    seen.length = 0
    const empty = (await git.listRepos()).find(r => r.name === 'ana/r52')
    expect(empty?.ci).toBe('unknown')
    expect(seen.some(s => s.startsWith('/api/v1/repos/ana/r52/'))).toBe(false)
  })

  test('a refused token throws in Forgejo terms, never answers empty', async () => {
    await expect(new ForgejoGit(sendWith('wrong')).listRepos()).rejects.toThrow(/Forgejo refused the token/)
  })
})

describe('listPullRequests', () => {
  test('open pull requests, each with its head commit verdict', async () => {
    seen.length = 0
    expect(await git.listPullRequests('ana/r0')).toEqual([
      { number: 7, title: 'Add a thing', author: 'bo', branch: 'feat', ci: 'passing', mergeable: true,  openedAt: '2026-11-14T09:00:00Z' },
      { number: 8, title: 'Break a thing', author: 'cy', branch: 'bad', ci: 'failing', mergeable: false, openedAt: '2026-11-14T10:00:00Z' },
    ])
    expect(seen).toContain('/api/v1/repos/ana/r0/pulls?state=open&page=1&limit=50')
  })

  test('a repository the forge does not have is a 404 by name', async () => {
    await expect(git.listPullRequests('ana/nope')).rejects.toThrow(/ana\/nope\/pulls.* was not found/)
  })

  test('a name without its owner is refused before any call', async () => {
    await expect(git.listPullRequests('r0')).rejects.toThrow(/not owner\/name/)
  })
})

describe('writes', () => {
  test('each refuses by name', async () => {
    await expect(git.createRepo('x')).rejects.toThrow(/ForgejoGit.createRepo/)
    await expect(git.deleteRepo('x')).rejects.toThrow(/ForgejoGit.deleteRepo/)
    await expect((git as IGit).createWebhook('ana/r0', 'http://x', ['push'])).rejects.toThrow(/FJS-D1370/)
  })
})
