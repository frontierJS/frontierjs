/*
 * test/record.ts — re-record the stream-json fixtures from the installed `claude`.
 *
 *   bun test/record.ts            # writes test/fixtures/*.jsonl and version.json
 *
 * Not part of `bun run test`: it spends a few cents of the logged-in account on
 * five haiku runs. The tests replay what it wrote.
 *
 * FIXTURE SHAPE, the same in all five files: one JSON object per line,
 *
 *   {"dir":"out","line":<an object the process wrote to stdout>}
 *   {"dir":"in","line":<an object written to the process's stdin>}
 *
 * The one-shot runs (read-only, edit, resumed) take their prompt as an argument
 * and have no `in` lines. The two chats record both directions in the order they
 * crossed the pipe. Order is the arrival order of `out` lines and the send order
 * of `in` lines, so an answer follows the request it answers.
 *
 * The five runs are made in a throwaway folder (CLAUDE_RECORD_DIR, or a fresh
 * mkdtemp), never in a repo. Hooks are off in every one: the Stop hook of the
 * repo a recording is made from must not run inside it. `CLAUDECODE` and
 * `CLAUDE_CODE_ENTRYPOINT` are dropped from the environment or the child labels
 * itself with its parent's entrypoint.
 *
 * SCRUB: fixtures are public. `scrub` replaces the home directory, the run folder,
 * the user name, email addresses, the account block of `initialize`, every uuid
 * and `msg_`/`req_`/`toolu_` id with a stable placeholder, trims the machine's
 * lists of tools, skills, plugins, agents, slash commands and MCP servers to two
 * entries, and zeroes the account's usage numbers. One scrubber instance is
 * shared by all five files so the resumed run still names the earlier session.
 * It changes nothing else: event content is what the program wrote.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }
export type Frame = { dir: 'in' | 'out', line: Obj }

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const MODEL = 'haiku'
const BUDGET = '0.5'
const TIMEOUT_MS = 120_000
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const TRIMMED = ['tools', 'mcp_servers', 'slash_commands', 'terminal_slash_commands', 'skills', 'plugins', 'agents', 'commands', 'models']

// ─── scrub ──────────────────────────────────────────────────────────

export function makeScrubber(root: string) {
  const home = homedir()
  const user = userInfo().username
  const seen = new Map<string, string>()
  const sessions = new Map<string, string>()
  const count: Record<string, number> = {}
  const name = (kind: string, real: string) => {
    const key = `${kind}:${real}`
    if (!seen.has(key)) seen.set(key, `${kind}-${count[kind] = (count[kind] ?? 0) + 1}`)
    return seen.get(key)!
  }
  // Claude Code names a project's transcript folder after its path, every
  // non-alphanumeric turned into a dash, and puts that name in `memory_paths`.
  const encoded = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-')
  const text = (s: string): string => {
    let out = s
      .split(encoded(root)).join(encoded('/home/user/project'))
      .split(root).join('/home/user/project')
      .split(home).join('/home/user')
      .split(encoded(home)).join(encoded('/home/user'))
    if (user.length > 2) out = out.split(user).join('user')
    return out
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'user@example.com')
      .replace(/\/run\/user\/\d+\/cc-socks\/\d+\.sock/g, '/run/user/1000/cc-socks/1.sock')
      .replace(UUID, id => sessions.get(id) ?? name('uuid', id))
      .replace(/\bmsg_\w+/g, id => name('msg', id))
      .replace(/\breq_\w+/g, id => name('req', id))
      .replace(/\btoolu_\w+/g, id => name('toolu', id))
  }
  const walk = (v: Json, key = ''): Json => {
    if (typeof v === 'string') return text(v)
    if (Array.isArray(v)) {
      const list = TRIMMED.includes(key) ? v.slice(0, 2) : v
      return list.map(x => walk(x, key))
    }
    if (v && typeof v === 'object') {
      const out: Obj = {}
      for (const [k, x] of Object.entries(v)) {
        if (k === 'account') out[k] = { email: 'user@example.com', organization: 'Example', subscriptionType: 'example' }
        else if (k === 'resetsAt' || k === 'utilization' || k === 'credential_expires_at') out[k] = 0
        else out[k] = walk(x, k)
      }
      return out
    }
    return v
  }
  return {
    // Session ids become `session-N` in the order they first appear; every other
    // uuid is `uuid-N`.
    frames(frames: Frame[]): Frame[] {
      for (const f of frames) {
        const id = f.line.session_id
        if (typeof id === 'string' && id.length === 36) sessions.set(id, sessions.get(id) ?? `session-${sessions.size + 1}`)
      }
      return frames.map(f => ({ dir: f.dir, line: walk(f.line) as Obj }))
    },
  }
}

// ─── runs ──────────────────────────────────────────────────────────

const clean = () => {
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

const NO_HOOKS = ['--settings', JSON.stringify({ disableAllHooks: true }), '--setting-sources', '', '--strict-mcp-config']

export type Run = { frames: Frame[], sessionId: string }

function parse(line: string): Obj | null {
  try { return JSON.parse(line) as Obj } catch { return null }
}

async function lines(stream: ReadableStream<Uint8Array>, onLine: (o: Obj) => void) {
  const decoder = new TextDecoder()
  let rest = ''
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    rest += decoder.decode(value, { stream: true })
    let at: number
    while ((at = rest.indexOf('\n')) >= 0) {
      const o = parse(rest.slice(0, at))
      rest = rest.slice(at + 1)
      if (o) onLine(o)
    }
  }
  const o = parse(rest)
  if (o) onLine(o)
}

function sessionOf(frames: Frame[]): string {
  const init = frames.find(f => f.dir === 'out' && f.line.type === 'system' && f.line.subtype === 'init')
  return String(init?.line.session_id ?? '')
}

async function oneShot(cwd: string, argv: string[], prompt: string): Promise<Run> {
  const frames: Frame[] = []
  const child = Bun.spawn(['claude', '-p', prompt, ...argv], { cwd, env: clean(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
  const err = new Response(child.stderr).text()
  await lines(child.stdout, line => frames.push({ dir: 'out', line }))
  const code = await child.exited
  clearTimeout(timer)
  if (code !== 0) throw new Error(`claude exited ${code}: ${await err}`)
  return { frames, sessionId: sessionOf(frames) }
}

const ONE_SHOT = ['--output-format', 'stream-json', '--verbose', '--model', MODEL, '--max-budget-usd', BUDGET, ...NO_HOOKS]

export const readOnly = (cwd: string) =>
  oneShot(cwd, [...ONE_SHOT, '--tools', 'Read', '--permission-mode', 'dontAsk', '--allowedTools', 'Read'],
    'Read notes.txt and tell me in one sentence which day the launch is.')

const edit = (cwd: string) =>
  oneShot(cwd, [...ONE_SHOT, '--tools', 'Read,Edit', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Edit'],
    'In notes.txt change the word blue to green, then reply with the word done.')

const resumed = (cwd: string, session: string) =>
  oneShot(cwd, [...ONE_SHOT, '--tools', 'Read', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', '--resume', session],
    'Which file did you read earlier? Answer with the file name only.')

type Answer = (request: Obj) => Obj

// One long-lived process: initialize, one user message, every `can_use_tool`
// answered by `answer`, stdin closed at the first `result`.
async function chat(cwd: string, prompt: string, answer: Answer): Promise<Run> {
  const frames: Frame[] = []
  const argv = [
    '-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--replay-user-messages',
    '--model', MODEL, '--max-budget-usd', BUDGET, '--permission-mode', 'default', ...NO_HOOKS,
  ]
  const child = Bun.spawn(['claude', ...argv], { cwd, env: clean(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
  const err = new Response(child.stderr).text()
  const send = (line: Obj) => {
    frames.push({ dir: 'in', line })
    child.stdin.write(JSON.stringify(line) + '\n')
    child.stdin.flush()
  }
  let sent = false
  const message = () => send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null, session_id: '' })
  send({ type: 'control_request', request_id: 'host-1', request: { subtype: 'initialize' } })
  await lines(child.stdout, line => {
    frames.push({ dir: 'out', line })
    if (line.type === 'control_response' && !sent) { sent = true; message() }
    if (line.type === 'control_request') {
      const request = line.request as Obj
      if (request.subtype === 'can_use_tool') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id as string, response: answer(request) } })
      }
    }
    if (line.type === 'result') child.stdin.end()
  })
  const code = await child.exited
  clearTimeout(timer)
  if (code !== 0) throw new Error(`claude exited ${code}: ${await err}`)
  return { frames, sessionId: sessionOf(frames) }
}

const allow: Answer = request => ({ behavior: 'allow', updatedInput: request.input })

const permission = (cwd: string) =>
  chat(cwd, 'Create a file named hello.txt that contains the word hi, then reply with the word done.', allow)

const question = (cwd: string) =>
  chat(cwd, 'Use the AskUserQuestion tool to ask me which fruit I prefer, with the options Apple and Pear, then reply with just my answer.', request => {
    if (request.tool_name !== 'AskUserQuestion') return allow(request)
    const input = request.input as Obj
    const answers: Obj = {}
    for (const q of input.questions as Obj[]) answers[String(q.question)] = String((q.options as Obj[])[1]?.label ?? (q.options as Obj[])[0].label)
    return { behavior: 'allow', updatedInput: { ...input, answers } }
  })

// ─── main ──────────────────────────────────────────────────────────

export async function version(): Promise<string> {
  const out = await new Response(Bun.spawn(['claude', '--version'], { stdout: 'pipe' }).stdout).text()
  return out.trim()
}

async function main() {
  const root = process.env.CLAUDE_RECORD_DIR ?? mkdtempSync(join(tmpdir(), 'claude-record-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'notes.txt'), 'The launch is on Tuesday.\nBring the blue folder.\n')
  const scrubber = makeScrubber(root)
  mkdirSync(FIXTURES, { recursive: true })
  const save = (file: string, run: Run) => {
    const body = scrubber.frames(run.frames).map(f => JSON.stringify(f)).join('\n') + '\n'
    writeFileSync(join(FIXTURES, file), body)
    console.log(`${file}: ${run.frames.length} lines`)
  }
  try {
    const first = await readOnly(root)
    save('read-only.jsonl', first)
    save('resumed.jsonl', await resumed(root, first.sessionId))
    save('edit.jsonl', await edit(root))
    save('chat-permission.jsonl', await permission(root))
    save('chat-question.jsonl', await question(root))
    writeFileSync(join(FIXTURES, 'version.json'), JSON.stringify({ claude: await version(), model: MODEL }, null, 2) + '\n')
  } finally {
    // The runs leave transcripts under ~/.claude/projects for the throwaway folder.
    const transcripts = join(homedir(), '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
    if (existsSync(transcripts)) rmSync(transcripts, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
