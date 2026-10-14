/**
 * devline — what a dev server tells the `fli dev` that started it, as one line.
 *
 * `fli dev` runs each surface as a child and reads its output as text. Under
 * `FLI_DEV=1` a server prints a marked line in place of its boot banner, and
 * fli lays the summary out from it. Junction and Sierra write it and fli reads
 * it, so the writer and the reader share one format here rather than fli
 * scraping two banners whose wording each package owns.
 *
 * Two messages:
 *   ready  the server is listening — its URL, and one row per thing it brought
 *          up (`{ name: 'Junction', facts: ['29 routes', '16 services'] }`)
 *   warn   something a person should act on, with the file it is about
 *
 * A line that is not marked, or is marked and does not parse, is `null` — the
 * reader prints it as ordinary output, so nothing a server says is lost.
 */

/** The variable `fli dev` sets on every surface it starts. */
export const DEV_ENV = 'FLI_DEV'

const MARK = '::fli '

/**
 * One message as the line a server prints.
 *
 * @param {{ ready?: { url?: string, rows: { name: string, facts?: string[] }[] },
 *           warn?: { file?: string, text: string } }} message
 * @returns {string}
 */
export function formatDevLine(message) {
  const kinds = Object.keys(message ?? {})
  if (kinds.length !== 1 || !(kinds[0] in READERS)) {
    throw new TypeError(`devline: a message is exactly one of ${Object.keys(READERS).join(', ')}, not ${JSON.stringify(kinds)}`)
  }
  const read = READERS[kinds[0]](message[kinds[0]])
  if (!read) throw new TypeError(`devline: a malformed ${kinds[0]} message: ${JSON.stringify(message)}`)
  // JSON never holds a raw line break, so the message stays one line.
  return MARK + JSON.stringify({ [kinds[0]]: read })
}

/**
 * The message a line carries, or null when it carries none.
 *
 * @param {string} line
 * @returns {{ ready: { url: string|null, rows: { name: string, facts: string[] }[] } }
 *         | { warn: { file: string|null, text: string } } | null}
 */
export function parseDevLine(line) {
  if (typeof line !== 'string') return null
  const at = line.indexOf(MARK)
  // A launcher may indent what its child prints; anything else before the mark
  // is a line that merely mentions it.
  if (at < 0 || line.slice(0, at).trim()) return null
  let body
  try { body = JSON.parse(line.slice(at + MARK.length)) } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const kinds = Object.keys(body)
  if (kinds.length !== 1 || !Object.hasOwn(READERS, kinds[0])) return null
  const read = READERS[kinds[0]](body[kinds[0]])
  return read ? { [kinds[0]]: read } : null
}

// ─── the shapes ───────────────────────────────────────────────────────────────

const text = (v) => typeof v === 'string' && v.length > 0

const READERS = Object.freeze({
  __proto__: null,
  ready(v) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.rows)) return null
    if (v.url != null && !text(v.url)) return null
    const rows = []
    for (const r of v.rows) {
      if (!r || !text(r.name)) return null
      const facts = r.facts ?? []
      if (!Array.isArray(facts) || !facts.every(text)) return null
      rows.push({ name: r.name, facts: [...facts] })
    }
    return { url: v.url ?? null, rows }
  },
  warn(v) {
    if (!v || !text(v.text)) return null
    if (v.file != null && !text(v.file)) return null
    return { file: v.file ?? null, text: v.text }
  },
})
