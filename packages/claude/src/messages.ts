// src/messages.ts — one transcript's text, read as messages.
//
// `readMessages` is the reader the per-day tally (`fli git:history`), the
// session list and basecamp's usage index (`api/src/domain/claude/claude-index.ts`)
// all stand on, so there is one opinion of what a transcript line means.
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
//
// **A skill colors the whole turn it loads in**, as `/stats` reads it: every
// message from its `Base directory for this skill:` line to the next prompt
// carries its name, a slash command's and a `Skill` call's alike. Only the
// message that CALLED it would put each skill under 1% (`FJS-D1733`). A turn
// can straddle a chunk, so `skills` passes in the turn open at the chunk's start
// and `file.skills` hands back the one open at its end.

/** What a chunk says about the file it came from. */
export type TranscriptFile = {
  sessionId:   string | null
  /** The directory the session ran in, from the line rather than the folder name, which flattens `/` and `.` alike. */
  cwd:         string | null
  /** A `claude -p` run: a fix loop, not a person at a prompt. */
  headless:    boolean
  title:       string | null
  firstPrompt: string | null
  startedAt:   string | null
  lastAt:      string | null
  /** The skills of the turn open at the end of this chunk. */
  skills:      string[]
}

/** One reply, its streamed lines merged. */
export type TranscriptMessage = {
  id:           string | null
  model:        string | null
  at:           string
  sessionId:    string | null
  cwd:          string | null
  input:        number
  cacheWrite:   number
  cacheWrite1h: number
  cacheRead:    number
  output:       number
  tools:        string[]
  skills:       string[]
}

export type ReadMessagesOptions = { final?: boolean, skills?: string[] }

const PROMPT_CHARS = 200

// A slash command's own echo (`/clear`) and a harness reminder are the first
// user lines of a session and nothing a person typed.
const WRAPPED = /^<(command-name|command-message|local-command|system-reminder)/
// The editor wraps what the person typed in a closed tag block, so the first
// 200 characters of the raw line are the tag and never the typing after it.
const TAGGED = /<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>\s*/g
// A slash command's echo starts a turn; a reminder and a command's output do not.
const NOT_A_TURN = /^<(local-command|system-reminder)/
const SKILL_LOAD = /^Base directory for this skill: (\S+)/

const textOf = (content: any): string | null => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  // The editor's tag and the typing arrive as two text blocks; the first alone is the tag.
  const blocks = content.filter(b => b?.type === 'text' && typeof b.text === 'string')
  return blocks.length ? blocks.map(b => b.text).join('\n') : null
}

export const readMessages = (
  text: string,
  { final = false, skills = [] }: ReadMessagesOptions = {},
): { consumed: number, file: TranscriptFile, messages: TranscriptMessage[] } => {
  const lastNl = text.lastIndexOf('\n')
  const end = final ? text.length : lastNl + 1
  const body = text.slice(0, end)
  const consumed = Buffer.byteLength(body)
  const file: TranscriptFile = { sessionId: null, cwd: null, headless: false, title: null, firstPrompt: null, startedAt: null, lastAt: null, skills: [...skills] }
  const byId = new Map<string, TranscriptMessage>()
  const list: TranscriptMessage[] = []
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
    const wantsTurn = line.includes('"type":"user"') && !line.includes('"type":"tool_result"')
    if (!(edge || wantsUsage || wantsCwd || wantsPrompt || wantsTitle || wantsTurn)) continue
    let j: any
    try { j = JSON.parse(line) } catch { continue }
    if (!j || typeof j !== 'object') continue

    if (j.timestamp) { file.startedAt ??= j.timestamp; file.lastAt = j.timestamp }
    file.sessionId ??= j.sessionId ?? null
    if (!haveCwd && j.cwd) { haveCwd = true; file.cwd = j.cwd; file.headless = j.entrypoint === 'sdk-cli' }
    if (j.type === 'ai-title' && typeof j.aiTitle === 'string') file.title = j.aiTitle
    if (!havePrompt && j.type === 'user' && !j.isMeta) {
      const t = textOf(j.message?.content)?.replace(TAGGED, '').trim()
      if (t && !WRAPPED.test(t)) { havePrompt = true; file.firstPrompt = t.slice(0, PROMPT_CHARS) }
    }
    if (j.type === 'user') {
      const c = j.message?.content
      const t = Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result') ? null : textOf(c)
      const load = j.isMeta && t ? SKILL_LOAD.exec(t) : null
      if (load) { const name = load[1].split('/').pop()!; if (!file.skills.includes(name)) file.skills.push(name) }
      else if (!j.isMeta && t && !NOT_A_TURN.test(t)) file.skills = []
    }

    const u = j.message?.usage
    if (!u || !j.timestamp) continue
    const id: string | null = j.message.id ?? null
    const tools: string[] = []
    if (Array.isArray(j.message.content))
      for (const b of j.message.content) if (b?.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name)

    let m = id ? byId.get(id) : undefined
    if (m) {
      for (const t of tools) if (!m.tools.includes(t)) m.tools.push(t)
      for (const s of file.skills) if (!m.skills.includes(s)) m.skills.push(s)
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
      skills: [...file.skills],
    }
    if (id) byId.set(id, m)
    list.push(m)
  }
  return { consumed, file, messages: list }
}
