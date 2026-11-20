// api/src/domain/capture/config.ts
// Capture's settings file, `~/.config/capture/config.toml`, read and written
// the way the Rust side does (`capture-core/src/config.rs`, the `Config` struct).
//
// Rust falls back to defaults for the WHOLE file when any one value has the
// wrong type, so a write that slips a bad value through silently resets every
// other setting. `shapeOf` is what Rust's deserializer refuses; `rangeOf` is
// the narrower range the old settings window offered, enforced on write only so
// a hand-edited file Rust accepts still reads as it is.
//
// The file holds the share key: it is written at 0600 through a temp file and a
// rename, as Rust does, and the key is never returned -- only whether it is set
// and its last two characters. A key not named in a write stays as it is.
//
// Keys this module does not know (a newer Capture's, a section of someone's
// own) survive a write. Comments do not: Rust's own save drops them too.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir }                                                                   from 'node:os'
import { dirname, join }                                                             from 'node:path'

export type Where = { file?: string }
type Table = Record<string, unknown>

const FORMATS  = ['webp', 'png256', 'png']
const MODES    = ['screenshot', 'video']
const SIZES    = ['small', 'medium', 'large']
const FAMILIES = ['sans', 'serif', 'mono']
const BACKS    = ['outline', 'solid', 'none']
const TOOLS    = ['number', 'arrow', 'rect', 'ellipse', 'pen', 'text', 'pixelate', 'highlighter']

const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
const isInt   = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNum   = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr   = (v: unknown): v is string => typeof v === 'string'
const isBool  = (v: unknown): v is boolean => typeof v === 'boolean'
const oneOf   = (list: string[]) => (v: unknown) => isStr(v) && list.includes(v)
const hex     = (v: unknown) => isStr(v) && /^#?[0-9a-fA-F]{6}$/.test(v.trim())

// ─── the fields ──────────────────────────────────────────────────────────────

type Field = {
  key: string,                       // the file's key
  wire: string,                      // the API's key
  shape: (v: unknown) => boolean,    // what Rust deserializes
  range?: (v: unknown) => string | null,
  float?: boolean,
}

const nonEmpty = (what: string) => (v: unknown) => isStr(v) && v.trim() ? null : `${what} must not be empty`

export const FIELDS: Field[] = [
  { key: 'save_to_file',           wire: 'saveToFile',           shape: isBool },
  { key: 'save_dir',               wire: 'saveDir',              shape: isStr, range: v => (v as string).trim() && !(v as string).includes('\0') ? null : 'the save folder must not be empty' },
  { key: 'name_template',          wire: 'nameTemplate',         shape: isStr, range: nonEmpty('the file name template') },
  { key: 'delay_secs',             wire: 'delaySecs',            shape: v => isInt(v) && v >= 0, range: v => (v as number) >= 1 && (v as number) <= 30 ? null : 'the delay is 1 to 30 seconds' },
  { key: 'ui_scale',               wire: 'uiScale',              shape: isNum, float: true, range: v => (v as number) >= 0.5 && (v as number) <= 3 ? null : 'the scale is 0.5 to 3, or automatic' },
  { key: 'file_format',            wire: 'fileFormat',           shape: oneOf(FORMATS) },
  { key: 'capture_mode',           wire: 'captureMode',          shape: oneOf(MODES) },
  { key: 'video_fps',              wire: 'videoFps',             shape: v => isInt(v) && v >= 0, range: v => v === 30 || v === 60 ? null : 'the frame rate is 30 or 60' },
  { key: 'video_ink_secs',         wire: 'videoInkSecs',         shape: isNum, float: true, range: v => (v as number) === 0 || ((v as number) >= 1 && (v as number) <= 10) ? null : 'drawings fade after 1 to 10 seconds, or 0 for never' },
  { key: 'video_name_template',    wire: 'videoNameTemplate',    shape: isStr, range: nonEmpty('the recording name template') },
  { key: 'video_cursor_highlight', wire: 'videoCursorHighlight', shape: isBool },
  { key: 'record_audio',           wire: 'recordAudio',          shape: isBool },
  { key: 'record_system_audio',    wire: 'recordSystemAudio',    shape: isBool },
  { key: 'webcam',                 wire: 'webcam',               shape: isBool },
  { key: 'webcam_size',            wire: 'webcamSize',           shape: oneOf(SIZES) },
  { key: 'web_url',                wire: 'webUrl',               shape: isStr, range: v => shareUrlRefusal(v as string) },
  { key: 'web_key',                wire: 'webKey',               shape: isStr, range: v => /[\r\n\0]/.test(v as string) ? 'the key must be one line' : null },
]

// A tool's size is a preset, or a number once the wheel moved it off one. Rust
// reads any number (a non-positive one as medium) and draws it in the tool's
// own unit, so the file's reader accepts them all and a write wants a real size.
const toolSize = (v: unknown) => oneOf(SIZES)(v) || typeof v === 'number'
const writableToolSize = (v: unknown) => oneOf(SIZES)(v) || (isNum(v) && v > 0)

const toolShape: Record<string, (v: unknown) => boolean> = {
  color: hex, size: toolSize, family: oneOf(FAMILIES), background: oneOf(BACKS),
  bold: isBool, italic: isBool,
}
const TOOL_KEYS = ['color', 'size']
const TEXT_KEYS = ['color', 'family', 'size', 'bold', 'italic', 'background']

// The share server's rule from `capture-core/src/share.rs`: https, or plain http
// only to this machine, because the key rides every upload.
export function shareUrlRefusal(raw: string): string | null {
  const base = raw.trim()
  if (!base) return null
  let url: URL
  try { url = new URL(base.includes('://') ? base : `https://${base}`) } catch { return `'${base}' is not a URL` }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
  return url.protocol === 'http:'
    ? 'the key would travel in the clear over http; use https://'
    : 'the share server URL must start with https://'
}

// ─── paths and defaults ──────────────────────────────────────────────────────

const configHome = () => {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.config')
}

/** Where Rust's `Config::path()` looks. A `file` option stands in for it. */
export const configFile = ({ file }: Where = {}) => file ?? join(configHome(), 'capture', 'config.toml')

// `dirs::picture_dir()`: XDG_PICTURES_DIR in user-dirs.dirs, else ~/Pictures.
function picturesDir(): string {
  try {
    const text = readFileSync(join(configHome(), 'user-dirs.dirs'), 'utf8')
    const m = text.match(/^XDG_PICTURES_DIR="?([^"\n]+)"?/m)
    if (m) return m[1].replace('$HOME', homedir())
  } catch {}
  return join(homedir(), 'Pictures')
}

const defaultTools = (): Record<string, Table> => {
  const t: Record<string, Table> = {}
  for (const name of TOOLS) t[name] = name === 'text'
    ? { color: '#e53935', family: 'sans', size: 22, bold: false, italic: false, background: 'outline' }
    : { color: name === 'highlighter' ? '#ffc107' : '#e53935', size: 'medium' }
  return t
}

const defaults = (): Table => ({
  save_to_file: true, save_dir: join(picturesDir(), 'Screenshots'), name_template: 'Screenshot_%Y-%m-%d_%H-%M-%S',
  delay_secs: 5, ui_scale: null, file_format: 'webp', capture_mode: 'screenshot', video_fps: 30, video_ink_secs: 3,
  video_name_template: 'Recording_%Y-%m-%d_%H-%M-%S', video_cursor_highlight: true, record_audio: false,
  record_system_audio: false, webcam: false, webcam_size: 'medium', web_url: '', web_key: '',
})

// ─── the toml file ───────────────────────────────────────────────────────────

type Loaded = { table: Table, exists: boolean, broken: string | null }

function load(path: string): Loaded {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return { table: {}, exists: false, broken: null } }
  try {
    const table = Bun.TOML.parse(text) as Table
    return { table: isTable(table) ? table : {}, exists: true, broken: null }
  } catch (err) {
    return { table: {}, exists: true, broken: (err as Error).message }
  }
}

/** What in `table` Rust would refuse to deserialize, or null. */
function typeProblem(table: Table): string | null {
  for (const f of FIELDS) {
    const v = table[f.key]
    if (v !== undefined && !f.shape(v)) return `${f.key} is not a valid value`
  }
  const styles = table.tool_styles
  if (styles === undefined) return null
  if (!isTable(styles)) return 'tool_styles is not a table'
  for (const [tool, style] of Object.entries(styles)) {
    if (!TOOLS.includes(tool)) continue
    if (!isTable(style)) return `tool_styles.${tool} is not a table`
    for (const [k, v] of Object.entries(style)) {
      if (!(tool === 'text' ? TEXT_KEYS : TOOL_KEYS).includes(k)) continue
      const check = k === 'size' && tool === 'text' ? isNum : toolShape[k]
      if (!check(v)) return `tool_styles.${tool}.${k} is not a valid value`
    }
  }
  return null
}

const key = (k: string) => /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)

function scalar(v: unknown, float: boolean): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') return float && Number.isInteger(v) ? v.toFixed(1) : String(v)
  if (typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return `[${v.map(x => scalar(x, false)).join(', ')}]`
  if (isTable(v)) return `{ ${Object.entries(v).map(([k, x]) => `${key(k)} = ${scalar(x, false)}`).join(', ')} }`
  throw new Error(`cannot write ${typeof v} to TOML`)
}

const FLOATS = new Set(['ui_scale', 'video_ink_secs', ...TOOLS.map(t => `tool_styles.${t}.size`)])

function emit(table: Table, path: string[], out: string[]) {
  const subs: [string, Table][] = []
  for (const [k, v] of Object.entries(table)) {
    if (isTable(v)) { subs.push([k, v]); continue }
    out.push(`${key(k)} = ${scalar(v, FLOATS.has([...path, k].join('.')))}`)
  }
  for (const [k, v] of subs) {
    if (out.length) out.push('')
    out.push(`[${[...path, k].map(key).join('.')}]`)
    emit(v, [...path, k], out)
  }
}

// A temp file at 0600 and a rename, so a crash leaves the old file whole and
// the key is never readable by anyone else, even for an instant.
function save(path: string, table: Table) {
  mkdirSync(dirname(path), { recursive: true })
  const lines: string[] = []
  emit(table, [], lines)
  const tmp = path.replace(/(\.toml)?$/, '.toml.tmp')
  writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

// ─── read ────────────────────────────────────────────────────────────────────

export type ConfigView = {
  path: string, exists: boolean, invalid: string | null,
  saveToFile: boolean, saveDir: string, nameTemplate: string, delaySecs: number, uiScale: number | null,
  fileFormat: string, captureMode: string, videoFps: number, videoInkSecs: number, videoNameTemplate: string,
  videoCursorHighlight: boolean, recordAudio: boolean, recordSystemAudio: boolean, webcam: boolean, webcamSize: string,
  webUrl: string, webKeySet: boolean, webKeyHint: string | null, shareOn: boolean,
  toolStyles: Record<string, Table>,
}

const expandTilde = (p: string) => p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p

/** Every setting as Rust would load it: a missing file, or an invalid one, reads as the defaults. */
export function captureConfig(where: Where = {}): ConfigView {
  const path = configFile(where)
  const { table: onDisk, exists, broken } = load(path)
  const problem = broken ?? typeProblem(onDisk)
  const base = defaults()
  const effective: Table = problem ? base : { ...base, ...onDisk }
  // Older configs had `image_quality`; "lossless" meant plain PNG.
  if (!problem && !('file_format' in onDisk) && onDisk.image_quality === 'lossless') effective.file_format = 'png'

  const tools = defaultTools()
  if (!problem && isTable(onDisk.tool_styles)) {
    for (const t of TOOLS) {
      const style = onDisk.tool_styles[t]
      if (!isTable(style)) continue
      for (const k of t === 'text' ? TEXT_KEYS : TOOL_KEYS) if (k in style) tools[t][k] = style[k]
    }
  }
  const webKey = (effective.web_key as string)
  const webUrl = effective.web_url as string
  return {
    path, exists, invalid: problem,
    saveToFile: effective.save_to_file as boolean,
    saveDir: expandTilde(effective.save_dir as string),
    nameTemplate: effective.name_template as string,
    delaySecs: effective.delay_secs as number,
    uiScale: (effective.ui_scale ?? null) as number | null,
    fileFormat: effective.file_format as string,
    captureMode: effective.capture_mode as string,
    videoFps: effective.video_fps as number,
    videoInkSecs: effective.video_ink_secs as number,
    videoNameTemplate: effective.video_name_template as string,
    videoCursorHighlight: effective.video_cursor_highlight as boolean,
    recordAudio: effective.record_audio as boolean,
    recordSystemAudio: effective.record_system_audio as boolean,
    webcam: effective.webcam as boolean,
    webcamSize: effective.webcam_size as string,
    webUrl,
    webKeySet: webKey.trim() !== '',
    webKeyHint: webKey.trim() ? '••••' + (webKey.length > 8 ? webKey.slice(-2) : '') : null,
    shareOn: webUrl.trim() !== '' && webKey.trim() !== '',
    toolStyles: tools,
  }
}

/**
 * The address and key as the tool would load them, for the calls that spend the
 * key. A file the tool cannot load reads as empty, as it does for the tool.
 */
export function shareCredentials(where: Where = {}): { url: string, key: string } {
  const { table, broken } = load(configFile(where))
  if (broken || typeProblem(table)) return { url: '', key: '' }
  return {
    url: isStr(table.web_url) ? table.web_url.trim() : '',
    key: isStr(table.web_key) ? table.web_key.trim() : '',
  }
}

// ─── write ───────────────────────────────────────────────────────────────────

export type Patch = Partial<Omit<ConfigView, 'path' | 'exists' | 'invalid' | 'webKeySet' | 'webKeyHint' | 'shareOn'>> & { webKey?: string }

/**
 * Apply a patch. A key absent from the patch is untouched, `uiScale: null` clears the
 * scale to automatic, and `webKey: ''` removes the key. One refusal anywhere writes nothing.
 */
export function setCaptureConfig(patch: Patch, where: Where = {}): ConfigView | { refused: string } {
  const path = configFile(where)
  const { table, broken } = load(path)
  if (broken) return { refused: `${path} is not valid TOML (${broken}); fix or remove it first, or this save would erase what is in it` }
  const bad = typeProblem(table)
  if (bad) return { refused: `${path} has a value Capture cannot load (${bad}); fix it first, or this save would hide it` }

  const next: Table = { ...table }
  const input = patch as Record<string, unknown>
  const known = new Set([...FIELDS.map(f => f.wire), 'toolStyles'])
  for (const name of Object.keys(input)) if (!known.has(name)) return { refused: `'${name}' is not a Capture setting` }

  for (const f of FIELDS) {
    if (!(f.wire in input)) continue
    const v = input[f.wire]
    if (f.key === 'ui_scale' && v === null) { delete next.ui_scale; continue }
    if (!f.shape(v)) return { refused: `${f.wire} has the wrong type` }
    const why = f.range?.(v)
    if (why) return { refused: why }
    next[f.key] = f.key === 'name_template' || f.key === 'video_name_template' || f.key === 'web_url' ? (v as string).trim() : v
  }

  if ('toolStyles' in input) {
    const styles = input.toolStyles
    if (!isTable(styles)) return { refused: 'toolStyles must be an object' }
    const merged: Table = isTable(next.tool_styles) ? { ...next.tool_styles } : {}
    for (const [tool, style] of Object.entries(styles)) {
      if (!TOOLS.includes(tool)) return { refused: `'${tool}' is not an annotation tool` }
      if (!isTable(style)) return { refused: `toolStyles.${tool} must be an object` }
      const allowed = tool === 'text' ? TEXT_KEYS : TOOL_KEYS
      const one: Table = isTable(merged[tool]) ? { ...merged[tool] as Table } : {}
      for (const [k, v] of Object.entries(style)) {
        if (!allowed.includes(k)) return { refused: `toolStyles.${tool}.${k} is not a setting` }
        if (k === 'size' && tool === 'text') {
          if (!isNum(v) || v < 12 || v > 72) return { refused: 'text size is 12 to 72' }
        } else if (k === 'size') {
          if (!writableToolSize(v)) return { refused: `toolStyles.${tool}.size is small, medium, large or a size above 0` }
        } else if (!toolShape[k](v)) return { refused: `toolStyles.${tool}.${k} has the wrong value` }
        one[k] = k === 'color' ? '#' + (v as string).trim().replace(/^#/, '').toLowerCase() : v
      }
      merged[tool] = one
    }
    next.tool_styles = merged
  }

  try { save(path, next) } catch (err) { return { refused: `could not save ${path}: ${(err as Error).message}` } }
  return captureConfig(where)
}

// ─── reset ───────────────────────────────────────────────────────────────────

/**
 * Every setting back to Capture's defaults, as the old settings window's Reset
 * did, keeping the share URL and key. Keys this module does not know survive,
 * here and inside each tool's style. A value of the wrong type is replaced, so
 * reset is the way out of a file Capture cannot load; one that is not TOML is
 * still refused, since nothing in it could be kept.
 */
export function resetCaptureConfig(where: Where = {}): ConfigView | { refused: string } {
  const path = configFile(where)
  const { table, broken } = load(path)
  if (broken) return { refused: `${path} is not valid TOML (${broken}); fix or remove it first, or this reset would erase what is in it` }

  const next: Table = { ...table, ...defaults() }
  delete next.ui_scale
  for (const k of ['web_url', 'web_key']) if (isStr(table[k])) next[k] = table[k]

  const styles: Table = isTable(table.tool_styles) ? { ...table.tool_styles } : {}
  for (const [tool, style] of Object.entries(defaultTools())) {
    styles[tool] = { ...(isTable(styles[tool]) ? styles[tool] as Table : {}), ...style }
  }
  next.tool_styles = styles

  try { save(path, next) } catch (err) { return { refused: `could not save ${path}: ${(err as Error).message}` } }
  return captureConfig(where)
}
