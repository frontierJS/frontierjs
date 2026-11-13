// `fli top --hitlist` over a made-up process table: the grouping, the naming,
// the churn accounting and the kill line, none of which a live machine holds
// still long enough to assert on.

import { test, expect, describe } from 'bun:test'
import { buildHitlist, renderHitlist, parseStat, shortCmd, shortPath } from '../core/hitlist.js'

const HOME = '/home/u'
const plain = new Proxy({}, { get: () => s => String(s) })

const proc = (pid, ppid, pgid, comm, args, ticks, extra = {}) => ({
  pid, ppid, pgid, comm, args, ticks, childTicks: 0, start: 100, rssPages: 1000, cwd: extra.cwd ?? null, ...extra,
})

function table() {
  const wt = `${HOME}/code/fjs/.claude/worktrees/agent-a76be1f8f7554cd29`
  const after = [
    proc(1, 0, 1, 'systemd', ['/sbin/init'], 0),
    proc(2, 0, 0, 'kthreadd', [], 0),
    proc(95, 2, 0, 'kcompactd0', [], 40),
    proc(6135, 1, 6135, 'gnome-shell', ['/usr/bin/gnome-shell'], 0),
    proc(7303, 6135, 6135, 'code', ['/usr/share/code/code'], 10, { cwd: HOME }),
    proc(8023, 7303, 6135, 'code', ['/usr/share/code/code', '--type=utility'], 0, { cwd: HOME }),
    proc(20490, 8023, 6135, 'claude', ['claude', '--output-format', 'stream-json'], 5, { cwd: `${HOME}/code/lathe` }),
    // Claude's Bash tool: bash -c → bash -c → bun run typecheck → bun run --filter → node typecheck.mjs → tsc
    proc(500, 20490, 500, 'bash', ['/bin/bash', '-c', 'source snap && eval "bun run typecheck"'], 0, { cwd: wt }),
    proc(501, 500, 500, 'bash', ['/bin/bash', '-c', 'bun run typecheck'], 0, { cwd: wt }),
    proc(502, 501, 500, 'bun', ['bun', 'run', 'typecheck'], 0, { cwd: wt }),
    proc(503, 502, 500, 'bun', ['bun', 'run', '--filter', '*', 'typecheck'], 0, { cwd: wt }),
    proc(510, 503, 500, 'node', ['node', '../../scripts/typecheck.mjs'], 0, { cwd: `${wt}/packages/a`, childTicks: 150 }),
    proc(511, 510, 500, 'node', ['node', `${wt}/node_modules/.bin/tsc`, '--noEmit'], 100),
    proc(520, 503, 500, 'node', ['node', '../../scripts/typecheck.mjs'], 0),
    proc(521, 520, 500, 'node', ['node', `${wt}/node_modules/.bin/tsc`, '--noEmit'], 100),
    // a terminal user's own vitest, which started a detached worker group
    proc(900, 7303, 6135, 'bash', ['/usr/bin/bash', '--init-file', '/x/shellIntegration-bash.sh'], 0, { cwd: HOME }),
    proc(901, 900, 901, 'node', ['node', '/r/node_modules/.bin/vitest', 'run'], 20, { cwd: `${HOME}/code/fjs/packages/sierra` }),
    proc(902, 901, 902, 'node', ['node', '--require', '/r/vitest/worker.js', '/r/vitest/dist/workers/forks.js'], 30),
  ]
  const before = after
    .filter(p => ![520, 521].includes(p.pid)) // born inside the window
    .map(p => ({ ...p, ticks: 0, childTicks: 0 }))
  // a tsc that had used 30 ticks before the window and was reaped by 510 inside
  // it: 510's cutime rose by its whole life (150), and 150 − 30 is this window's
  before.push(proc(512, 510, 500, 'node', ['node', 'tsc'], 30))
  const m = list => new Map(list.map(p => [p.pid, p]))
  return {
    before: m(before), after: m(after), elapsedMs: 1000, clkTck: 100, pageSize: 4096, selfPid: 99999, home: HOME,
    sys: { cores: 4, load: [9, 5, 2], uptime: 400, cpuPct: 100, memPct: 50, swapPct: 95, stall: { cpu: 40, memory: 12, io: 0 } },
  }
}

describe('buildHitlist', () => {
  const { jobs, kernelHot } = buildHitlist(table())
  const typecheck = jobs.find(j => j.rootPid === 500)

  test('a fan-out is one job, named for the command and its hot worker', () => {
    expect(typecheck.procs).toBe(8)
    expect(typecheck.label).toBe('bun run typecheck → tsc ×2')
    expect(jobs[0]).toBe(typecheck)
  })

  test('a child reaped inside the window keeps its in-window CPU, not its whole life', () => {
    // 100 + 100 live tsc ticks, plus 150 reaped − 30 already used before = 320 ticks in 1s
    expect(Math.round(typecheck.cpu)).toBe(320)
    expect(Math.round(typecheck.share)).toBe(80)
  })

  test('says where and who: the agent worktree, the Claude session in VS Code', () => {
    expect(typecheck.where).toBe('~/code/fjs/wt:agent-a76b')
    expect(typecheck.startedBy).toMatchObject({ kind: 'claude', pid: 20490, project: 'lathe' })
    expect(typecheck.startedBy.text).toBe('claude lathe 20490 vscode')
  })

  test('the job it leads is stopped with one group kill', () => {
    expect(typecheck.stop).toBe('kill -TERM -- -500')
  })

  test('a terminal command keeps its detached worker, and the kill names both groups', () => {
    const vitest = jobs.find(j => j.rootPid === 901)
    expect(vitest.label).toBe('vitest run → forks.js')
    expect(vitest.startedBy).toMatchObject({ kind: 'shell', pid: 900, in: 'vscode' })
    expect(vitest.stop).toBe('kill -TERM -- -901 -902')
  })

  test('the Claude session is its own row, not folded into VS Code', () => {
    expect(jobs.find(j => j.rootPid === 20490).label).toBe('claude session 20490 itself')
    expect(jobs.find(j => j.rootPid === 7303).procs).toBe(2)
  })

  test('an app is stopped at its root, with a warning; a Claude session without one', () => {
    expect(jobs.find(j => j.rootPid === 7303).stop).toMatch(/^kill -TERM 7303 +# quits the whole app/)
    expect(jobs.find(j => j.rootPid === 20490).stop).toBe('kill -TERM 20490')
  })

  test('kernel reclaim threads are reported, not made jobs', () => {
    expect(kernelHot).toEqual([{ comm: 'kcompactd0', cpu: 40, reclaim: true }])
    expect(jobs.some(j => j.rootPid === 95 || j.rootPid === 2)).toBe(false)
  })
})

describe('renderHitlist', () => {
  const lines = renderHitlist(buildHitlist(table()), { width: 120, c: plain })
  const text = lines.join('\n')

  test('the head line says load, swap and stalls', () => {
    expect(lines[0]).toBe('load 9.0 on 4 cores · cpu 100% · mem 50% · swap 95% FULL · stalled: cpu 40% memory 12%')
    expect(lines[1]).toBe('kernel is reclaiming memory: kcompactd0 40%')
  })

  test('rows, the summary and stop lines', () => {
    expect(text).toMatch(/^1 +320% .* claude lathe 20490 vscode +bun run typecheck → tsc ×2 +~\/code\/fjs\/wt:agent-a76b$/m)
    expect(text).toContain('#1 alone is 80% of the machine · 1 started by 1 Claude session · swap is full')
    expect(text).toContain('stop #1: kill -TERM -- -500')
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(120)
  })

  test('a quiet machine says so', () => {
    const quiet = renderHitlist({ sys: table().sys, kernelHot: [], jobs: [] }, { c: plain })
    expect(quiet.at(-1)).toMatch(/^nothing is busy/)
  })
})

describe('naming', () => {
  test('parseStat reads a comm with spaces and parens', () => {
    const s = '42 (tmux: server (x)) S 1 42 42 0 -1 0 0 0 0 0 7 3 2 1 20 0 1 0 555 0 77'
    expect(parseStat(s)).toMatchObject({ pid: 42, comm: 'tmux: server (x)', ppid: 1, pgid: 42, ticks: 10, childTicks: 3, start: 555, rssPages: 77 })
  })

  test('shortCmd drops env, runtime flags and paths', () => {
    expect(shortCmd({ comm: 'sh', args: ['ENCRYPTION_KEY=11', 'bun', 'test'] })).toBe('bun test')
    expect(shortCmd({ comm: 'bun', args: ['bun', '/home/u/.bun/bin/fli', 'dev'] })).toBe('fli dev')
    expect(shortCmd({ comm: 'code', args: ['/usr/share/code/code', '--type=gpu-process', '--enable-crash-reporter=abc'] })).toBe('code')
    expect(shortCmd({ comm: 'kworker', args: [] })).toBe('kworker')
  })

  test('shortPath folds home and an agent worktree', () => {
    expect(shortPath('/home/u/x/.claude/worktrees/agent-a76be1f8f7554cd29/pkg', '/home/u')).toBe('~/x/wt:agent-a76b/pkg')
    expect(shortPath(null)).toBe('?')
  })
})
