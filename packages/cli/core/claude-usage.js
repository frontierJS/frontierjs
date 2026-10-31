// ─── claude-usage — Claude Code sessions and tokens per day, beside the commits ─
//
// Pure: one session transcript's text in, its per-day usage out. The command
// finds the `.jsonl` files under `~/.claude/projects/` and merges; no fs here,
// so it is testable with fixtures.
//
// A streamed reply writes the SAME message id on several lines, each carrying
// the full usage, so counting lines counts a reply two or three times. `seen`
// is shared across files because a resumed session repeats earlier replies.

export const CLAUDE_ZERO = { sessions: 0, headless: 0, output: 0, total: 0 }

// The LOCAL calendar day, the reading git's `--date=short-local` gives, so a
// reply and a commit made in the same evening land in the same column.
const localDay = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ─── one transcript's text, read as messages ─────────────────────────────────
//
// `readMessages` is the reader both the per-day tally below and basecamp's usage
// index (`api/src/domain/claude/claude-index.ts`) stand on, so there is one
// opinion of what a transcript line means.
//
// A reply streams as several lines with one `message.id`, each carrying the
// same full `usage` but ONE content block, so usage is taken from the first line
// and `tools` is the union over every line of that id.
//
// **The text may be a chunk.** An index re-reads only what a transcript gained
// since the byte offset it stopped at, so the last line of a chunk may be half
// written. `consumed` is the byte length of the text through its last newline,
// and the caller's next read starts there; `final` reads the tail line too, for a
// whole file that is complete. A message split across two chunks comes back from
// both, and the caller unions the tool names (usage is the same on both).
//
// Facts about the FILE are what this chunk saw: `title` is the last `ai-title`
// line and `firstPrompt` the first real user line, either null when the chunk
// holds none, so a caller appending keeps what it had.

const PROMPT_CHARS = 200

// A slash command's own echo (`/clear`) and a harness reminder are the first
// user lines of a session and nothing a person typed.
const WRAPPED = /^<(command-name|command-message|local-command|system-reminder)/

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const block = content.find(b => b?.type === 'text' && typeof b.text === 'string')
  return block ? block.text : null
}

export const readMessages = (text, { final = false } = {}) => {
  const lastNl = text.lastIndexOf('\n')
  const end = final ? text.length : lastNl + 1
  const body = text.slice(0, end)
  const consumed = Buffer.byteLength(body)
  const file = { sessionId: null, cwd: null, headless: false, title: null, firstPrompt: null, startedAt: null, lastAt: null }
  const byId = new Map(), list = []
  const lines = body.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  let haveCwd = false, havePrompt = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const edge = i === 0 || i === lines.length - 1
    const wantsUsage = line.includes('"usage"')
    const wantsCwd = !haveCwd && line.includes('"cwd"')
    const wantsPrompt = !havePrompt && line.includes('"type":"user"')
    const wantsTitle = line.includes('"type":"ai-title"')
    if (!(edge || wantsUsage || wantsCwd || wantsPrompt || wantsTitle)) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (!j || typeof j !== 'object') continue

    if (j.timestamp) { file.startedAt ??= j.timestamp; file.lastAt = j.timestamp }
    file.sessionId ??= j.sessionId ?? null
    if (!haveCwd && j.cwd) { haveCwd = true; file.cwd = j.cwd; file.headless = j.entrypoint === 'sdk-cli' }
    if (j.type === 'ai-title' && typeof j.aiTitle === 'string') file.title = j.aiTitle
    if (!havePrompt && j.type === 'user' && !j.isMeta) {
      const t = textOf(j.message?.content)?.trim()
      if (t && !WRAPPED.test(t)) { havePrompt = true; file.firstPrompt = t.slice(0, PROMPT_CHARS) }
    }

    const u = j.message?.usage
    if (!u || !j.timestamp) continue
    const id = j.message.id ?? null
    const tools = []
    if (Array.isArray(j.message.content))
      for (const b of j.message.content) if (b?.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name)

    let m = id ? byId.get(id) : null
    if (m) {
      for (const t of tools) if (!m.tools.includes(t)) m.tools.push(t)
      continue
    }
    const cacheWrite = u.cache_creation_input_tokens ?? 0
    m = {
      id,
      model: j.message.model ?? null,
      at: j.timestamp,
      sessionId: j.sessionId ?? null,
      cwd: j.cwd ?? null,
      input: u.input_tokens ?? 0,
      cacheWrite,
      cacheWrite1h: Math.min(cacheWrite, u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      tools: [...new Set(tools)],
    }
    if (id) byId.set(id, m)
    list.push(m)
  }
  return { consumed, file, messages: list }
}

// `cwd` is the directory the session ran in, read from the transcript rather
// than the folder name, because the folder slug flattens `/` and `.` alike.
// `headless` is a `claude -p` run — a fix loop, not a person at a prompt.
export const tallySession = (text, { seen = new Set(), day = localDay } = {}) => {
  const { file, messages } = readMessages(text, { final: true })
  const days = new Map()
  let first = null
  for (const m of messages) {
    if (m.id) { if (seen.has(m.id)) continue; seen.add(m.id) }
    const key = day(m.at)
    first ??= key
    const d = days.get(key) ?? { ...CLAUDE_ZERO }
    d.output += m.output
    d.total += m.input + m.cacheWrite + m.cacheRead + m.output
    days.set(key, d)
  }
  return { cwd: file.cwd, headless: file.headless, first, days }
}

// Folds one session into the running map. A subagent's tokens count, but it is
// not a session of its own — its parent already is.
export const mergeSession = (into, { headless, first, days }, { subagent = false } = {}) => {
  for (const [key, d] of days) {
    const t = into.get(key) ?? { ...CLAUDE_ZERO }
    t.output += d.output
    t.total += d.total
    into.set(key, t)
  }
  if (first && !subagent) {
    const t = into.get(first)
    t.sessions++
    if (headless) t.headless++
  }
  return into
}

// 4200000 → '4.2M', so a token axis fits the column the commit axis uses.
export const compact = (v) => {
  const a = Math.abs(v)
  const [n, s] = a >= 1e9 ? [v / 1e9, 'B'] : a >= 1e6 ? [v / 1e6, 'M'] : a >= 1e3 ? [v / 1e3, 'k'] : [v, '']
  return (Math.abs(n) >= 10 || !s ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '')) + s
}
