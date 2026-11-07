// src/domain/release/dotenv.ts
// A scope's variables as a .env file, and a .env file as variables — the one
// reader and writer of the text `variables.export` hands out and
// `variables.import` takes in.
//
// A container gets a value through `docker run -e` exactly as stored, so `$NAME`
// is never expanded here: a file whose value says `$HOME` sets `$HOME`.
// `# secret` on the line above a key is the marker the export writes; a plain
// .env has none, so a key named like a credential is suggested secret too.

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const MARKER = /^#\s*secret\s*$/i
const CREDENTIAL_WORDS = new Set(['KEY', 'SECRET', 'TOKEN', 'PASSWORD'])

export interface DotenvEntry {
  key:     string
  value:   string
  line:    number
  /** The export's `# secret` marker, or a name like `API_KEY`. */
  suggestSecret: boolean
}

export interface DotenvRow { key: string; value: string | null; isSecret: boolean }

/** A credential's name has one of the words as a whole `_`-segment, so `API_KEY` is one and `MONKEY` is not. */
export function looksSecret(key: string): boolean {
  return key.toUpperCase().split('_').some(w => CREDENTIAL_WORDS.has(w))
}

// ─── format ──────────────────────────────────────────────────────────────

/** A value bare where it reads back as itself, double-quoted otherwise. */
function quote(value: string): string {
  if (/^[^\s"'#\\]*$/.test(value)) return value
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
}

/** A secret with no value in hand is written `KEY=`, which `parseDotenv` reads as "keep what is set". */
export function formatDotenv(rows: DotenvRow[]): string {
  return rows.map(r => `${r.isSecret ? '# secret\n' : ''}${r.key}=${quote(r.value ?? '')}`).join('\n') + '\n'
}

// ─── parse ───────────────────────────────────────────────────────────────

/** Index of the quote closing a value that opens with `q` at 0, or -1. */
function closing(s: string, q: string): number {
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') i++
    else if (s[i] === q) return i
  }
  return -1
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\(.)/gs, (_, c) => c === 'n' ? '\n' : c === 'r' ? '\r' : c)
}

/**
 * The entries of a .env text, or every line that is not one. A key set twice
 * is refused rather than resolved, because loaders disagree on which wins.
 */
export function parseDotenv(text: string): { entries: DotenvEntry[]; problems: string[] } {
  const lines    = text.replace(/\r\n/g, '\n').split('\n')
  const entries: DotenvEntry[] = []
  const problems: string[] = []
  const seen     = new Map<string, number>()
  let marked     = false

  for (let i = 0; i < lines.length; i++) {
    const at = i + 1
    const t  = lines[i]!.trim()
    if (MARKER.test(t)) { marked = true; continue }
    if (!t || t.startsWith('#')) continue

    const body = t.replace(/^export\s+/, '')
    const eq   = body.indexOf('=')
    const key  = eq === -1 ? body : body.slice(0, eq).trim()
    if (eq === -1 || !KEY.test(key)) {
      problems.push(`line ${at}: ${eq === -1 ? 'no `=`' : `\`${key}\` is not a variable name`}`)
      marked = false
      continue
    }

    let rest = body.slice(eq + 1).trimStart()
    let value: string
    const q = rest[0]
    if (q === '"' || q === "'") {
      // A quoted value may run over lines until its quote closes.
      let end = closing(rest, q)
      while (end === -1 && i + 1 < lines.length) { rest += '\n' + lines[++i]; end = closing(rest, q) }
      if (end === -1) { problems.push(`line ${at}: ${key}'s ${q} is never closed`); break }
      value = q === '"' ? unescapeQuoted(rest.slice(1, end)) : rest.slice(1, end)
    } else {
      value = rest.replace(/\s+#.*$/, '').trim()
    }

    if (seen.has(key)) problems.push(`line ${at}: ${key} is already set on line ${seen.get(key)}`)
    seen.set(key, at)
    entries.push({ key, value, line: at, suggestSecret: marked || looksSecret(key) })
    marked = false
  }
  return { entries, problems }
}
