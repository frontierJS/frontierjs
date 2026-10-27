// ─── file-tree.js — a project's files drawn as a tree — `fli tree` ──────────
//
// The listing is `tree.js`'s: what a clone holds, so `node_modules`, build
// output and a `*.db-wal` are absent without a skip list that goes stale. A
// root with no git falls back to the disk, minus the two folders no reader
// wants.
//
// Icons are emoji, never Nerd Font glyphs: a glyph from a font the terminal
// does not have prints as a box, and an emoji renders in any terminal with an
// emoji font. Only emoji whose DEFAULT presentation is emoji are in the table —
// one that needs U+FE0F (⚙️, 🗄️) is one cell wide in some terminals and two in
// others, and every name after it shifts.

import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename }                   from 'node:path'
import { treePaths }                        from './tree.js'
import { kindOf }                           from './file-kind.js'
import { chalk }                            from './color.js'

// ─── the listing ────────────────────────────────────────────────────────────

const NEVER = new Set(['.git', 'node_modules'])

/** Every file under `root`, relative, `/`-separated. */
export function listPaths(root) {
  const tracked = treePaths(root)
  // `--cached` still names a file deleted from the working tree.
  if (tracked) return [...tracked.files].filter(p => existsSync(join(root, p)))
  const out  = []
  const walk = rel => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (NEVER.has(e.name)) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk('')
  return out
}

// ─── the model ──────────────────────────────────────────────────────────────

const node = (name, path) => ({ name, path, dirs: new Map(), files: [] })

/** Paths → nested directories. A directory's `path` is relative to the root. */
export function buildTree(paths) {
  const root = node('', '')
  for (const p of paths) {
    const parts = p.split('/')
    let at = root
    for (const part of parts.slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, node(part, at.path ? `${at.path}/${part}` : part))
      at = at.dirs.get(part)
    }
    at.files.push({ name: parts.at(-1), path: p })
  }
  return root
}

/**
 * A directory whose only child is a directory is drawn as one row,
 * `cli/src/routes` — VS Code's compact folders — and one whose only child is a
 * file is drawn as that file's row, `alerts/alerts.service.ts`. The root
 * itself never folds.
 */
export function compactTree(dir) {
  for (const [key, child] of dir.dirs) {
    let c = child
    while (c.files.length === 0 && c.dirs.size === 1) {
      const [only] = c.dirs.values()
      c = { ...only, name: `${c.name}/${only.name}` }
    }
    if (c.dirs.size === 0 && c.files.length === 1) c.inline = true
    dir.dirs.set(key, compactTree(c))
  }
  return dir
}

export function countFiles(dir) {
  let n = dir.files.length
  for (const d of dir.dirs.values()) n += countFiles(d)
  return n
}

// VS Code's order: folders first, then names case-insensitively, digits by value.
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

// ─── icons and colors ───────────────────────────────────────────────────────

// [emoji, hex] — the hex colors the NAME, since an emoji brings its own color.
const BY_NAME = {
  'package.json': ['📦', '#e53935'],
  'bun.lock':     ['🔒', '#9e9e9e'],
  'bun.lockb':    ['🔒', '#9e9e9e'],
  'README.md':    ['📘', '#42a5f5'],
  'CLAUDE.md':    ['🤖', '#d97757'],
  'AGENTS.md':    ['🤖', '#d97757'],
  'LICENSE':      ['📜', '#ef5350'],
  'Dockerfile':   ['🐳', '#0288d1'],
  '.dockerignore':['🐳', '#0288d1'],
  '.gitignore':   ['🌿', '#e64a19'],
  '.gitattributes':['🌿', '#e64a19'],
  '.gitmodules':  ['🌿', '#e64a19'],
}

const BY_EXT = {
  md:   ['📝', '#42a5f5'], mdx: ['📝', '#42a5f5'], txt: ['📄', null],
  js:   ['🟨', '#f0db4f'], mjs: ['🟨', '#f0db4f'], cjs: ['🟨', '#f0db4f'], jsx: ['🟨', '#f0db4f'],
  ts:   ['🟦', '#3b8eea'], mts: ['🟦', '#3b8eea'], cts: ['🟦', '#3b8eea'], tsx: ['🟦', '#3b8eea'],
  lite: ['🪨', '#d4a35a'],
  mesa: ['🌵', '#66bb6a'],
  json: ['🔧', '#fbc02d'], jsonc: ['🔧', '#fbc02d'],
  yml:  ['📋', '#ef5350'], yaml: ['📋', '#ef5350'], toml: ['📋', '#9e9e9e'], ini: ['📋', '#9e9e9e'],
  css:  ['🎨', '#42a5f5'], scss: ['🎨', '#ec407a'],
  html: ['🌐', '#e44d26'], htm: ['🌐', '#e44d26'],
  sql:  ['💾', '#ffca28'], db: ['💾', '#ffca28'], sqlite: ['💾', '#ffca28'],
  sh:   ['🐚', '#4caf50'], bash: ['🐚', '#4caf50'], zsh: ['🐚', '#4caf50'],
  py:   ['🐍', '#3776ab'], rs: ['🦀', '#dea584'], go: ['🐹', '#00add8'], rb: ['💎', '#cc342d'],
  png:  ['📸', '#26a69a'], jpg: ['📸', '#26a69a'], jpeg: ['📸', '#26a69a'], gif: ['📸', '#26a69a'],
  webp: ['📸', '#26a69a'], ico: ['📸', '#26a69a'], svg: ['📸', '#ffb300'],
  woff: ['🔤', '#9e9e9e'], woff2: ['🔤', '#9e9e9e'], ttf: ['🔤', '#9e9e9e'], otf: ['🔤', '#9e9e9e'],
  pdf:  ['📕', '#e53935'],
  mp4:  ['🎬', '#ab47bc'], webm: ['🎬', '#ab47bc'], mp3: ['🎵', '#ab47bc'], wav: ['🎵', '#ab47bc'],
  zip:  ['📦', '#9e9e9e'], gz: ['📦', '#9e9e9e'], tgz: ['📦', '#9e9e9e'],
  wasm: ['🧩', '#654ff0'],
  lock: ['🔒', '#9e9e9e'],
}

// A folder's color is its ROLE: the realms of Invariant 3's surfaces, then the
// folders every project has.
const FOLDER = {
  db: '#ffca28', migrations: '#ffca28',
  api: '#26c6da',
  web: '#ab7df8', site: '#ab7df8', widgets: '#ab7df8', extension: '#ab7df8',
  desktop: '#ab7df8', mobile: '#ab7df8', resources: '#ab7df8', routes: '#ab7df8', components: '#ab7df8',
  cli: '#4caf50', commands: '#4caf50',
  test: '#8bc34a', tests: '#8bc34a', specs: '#8bc34a', __tests__: '#8bc34a',
  docs: '#42a5f5', IDEAS: '#42a5f5',
  src: '#e0e0e0', core: '#e0e0e0', packages: '#e0e0e0', public: '#26a69a', assets: '#26a69a',
  scripts: '#ff7043', deploy: '#ff7043', config: '#9e9e9e',
}

const TEST_FILE = /\.(test|spec)\.[a-z]+$/i
const SERVICE_FILE = /\.service\.[mc]?[jt]s$/

const paint = (hex, s) => hex ? chalk.hex(hex)(s) : s

/** `[emoji, hex | null]` for a file. */
export function fileIcon(name) {
  if (BY_NAME[name]) return BY_NAME[name]
  if (TEST_FILE.test(name)) return ['🧪', '#8bc34a']
  if (SERVICE_FILE.test(name)) return ['📡', '#26c6da']
  if (/\.snapshot\./.test(name)) return ['🧊', '#80deea']
  if (name === '.env' || name.startsWith('.env.')) return ['🔑', '#fbc02d']
  if (/\.db-(wal|shm|journal)$/.test(name)) return ['💾', '#9e9e9e']
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (BY_EXT[ext]) return BY_EXT[ext]
  return ['📄', null]
}

/** A compacted row takes the color of its deepest segment that has one — `db/migrations/main` reads as migrations. */
export function folderColor(name) {
  for (const seg of name.split('/').reverse()) {
    if (FOLDER[seg]) return FOLDER[seg]
    if (seg.startsWith('.')) return '#9e9e9e'
  }
  return null
}

// ─── the drawing ────────────────────────────────────────────────────────────

const dirLabel = (d, open, { icons, link }) => {
  const icon   = icons ? `${open ? '📂' : '📁'} ` : ''
  const hidden = open ? '' : ` ${chalk.dim(`(${countFiles(d)})`)}`
  return `${icon}${link(chalk.bold(paint(folderColor(d.name), d.name)), d.path)}${hidden}`
}

const fileLabel = (f, { icons, link }) => {
  const [emoji, hex] = fileIcon(f.name)
  const name = kindOf(f.path) === 'generated' ? chalk.dim(paint(hex, f.name)) : paint(hex, f.name)
  return `${icons ? `${emoji} ` : ''}${link(name, f.path)}`
}

// A folder holding one file, as the file's row with the folder before it.
const inlineLabel = (d, { icons, link }) => {
  const [file] = d.files
  const [emoji] = fileIcon(file.name)
  const folder = link(chalk.bold(paint(folderColor(d.name), `${d.name}/`)), d.path)
  return `${icons ? `${emoji} ` : ''}${folder}${fileLabel(file, { icons: false, link })}`
}

/**
 * Rows of the tree under `dir`.
 *   icons   — emoji before each name
 *   depth   — levels drawn below the root, 0 for all
 *   dirsOnly — folders and no files
 *   link    — (text, relPath) → text, the clickable name
 */
export function renderTree(dir, { icons = true, depth = 0, dirsOnly = false, link = t => t } = {}) {
  const rows   = []
  const counts = { dirs: 0, files: 0 }
  const walk = (d, prefix, level) => {
    const dirs  = [...d.dirs.values()].sort(byName)
    const files = dirsOnly ? [] : [...d.files].sort(byName)
    const items = [...dirs.map(x => ({ dir: x })), ...files.map(x => ({ file: x }))]
    items.forEach((it, i) => {
      const last   = i === items.length - 1
      const branch = chalk.dim(last ? '└── ' : '├── ')
      if (it.dir) {
        counts.dirs += it.dir.name.split('/').length
        if (it.dir.inline && !dirsOnly) {
          counts.files++
          rows.push(`${prefix}${branch}${inlineLabel(it.dir, { icons, link })}`)
          return
        }
        const open = !depth || level < depth
        rows.push(`${prefix}${branch}${dirLabel(it.dir, open, { icons, link })}`)
        if (open) walk(it.dir, prefix + chalk.dim(last ? '    ' : '│   '), level + 1)
        else counts.files += countFiles(it.dir)
        return
      }
      counts.files++
      rows.push(`${prefix}${branch}${fileLabel(it.file, { icons, link })}`)
    })
  }

  walk(dir, '', 1)
  if (dirsOnly) counts.files = countFiles(dir)
  return { rows, counts }
}

/** Levels below `dir`, a compacted row counting as one — the largest `depth` that changes anything. */
export function treeDepth(dir) {
  const dirs = [...dir.dirs.values()].filter(d => !d.inline)
  let deepest = 0
  for (const d of dirs) deepest = Math.max(deepest, treeDepth(d))
  return dirs.length ? deepest + 1 : (dir.files.length || dir.dirs.size ? 1 : 0)
}

/** The root row — the directory's own name. */
export function rootRow(root, { icons = true } = {}) {
  const name = basename(root) || root
  return `${icons ? '📂 ' : ''}${chalk.bold(paint(folderColor(name), name))}`
}

// ─── lanes ──────────────────────────────────────────────────────────────────
//
// Each top-level folder its own tree, the trees packed side by side to the
// terminal's width. A lane is kept whole wherever one fits the screen, because
// a folder broken across two columns loses the guides that say where a row is.

// SGR color, and the OSC 8 link around a name.
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g

/** Terminal cells a row takes — escapes are zero, an emoji is two. */
export function visibleWidth(s) {
  let w = 0
  for (const ch of s.replace(ANSI, '')) w += /\p{Emoji_Presentation}/u.test(ch) ? 2 : 1
  return w
}

/** One lane per top-level folder, then one for the files at the root. */
export function buildLanes(tree, { icons = true, depth = 0, dirsOnly = false, link = t => t } = {}) {
  const lanes = []
  for (const d of [...tree.dirs.values()].sort(byName)) {
    if (d.inline && !dirsOnly) {
      lanes.push({ rows: [inlineLabel(d, { icons, link })], cont: '' })
      continue
    }
    const open = !depth || depth > 1
    const body = open ? renderTree(d, { icons, depth: depth ? depth - 1 : 0, dirsOnly, link }).rows : []
    lanes.push({
      rows: [dirLabel(d, open, { icons, link }), ...body],
      cont: `${icons ? '📂 ' : ''}${chalk.dim(`${d.name} (cont.)`)}`,
    })
  }
  if (!dirsOnly && tree.files.length) {
    const files = renderTree({ ...tree, dirs: new Map() }, { icons, link }).rows
    const head  = `${icons ? '📄 ' : ''}${chalk.dim('files')}`
    lanes.push({ rows: [head, ...files], cont: `${icons ? '📄 ' : ''}${chalk.dim('files (cont.)')}` })
  }
  return lanes
}

// Lanes in order, down a column of `height` rows and then across. A lane
// taller than the column is cut into column-high pieces, each after the first
// headed by its `cont` row. A cell is `[row, width]`, measured once.
function pack(lanes, height, gap) {
  const columns = []
  let cur = null
  const open = () => { cur = { cells: [] }; columns.push(cur); return cur }
  for (const lane of lanes) {
    if (lane.cells.length > height) {
      let rest = lane.cells
      open().cells.push(...rest.slice(0, height))
      rest = rest.slice(height)
      while (rest.length) {
        open().cells.push(lane.cont, ...rest.slice(0, height - 1))
        rest = rest.slice(height - 1)
      }
      cur.single = false
      continue
    }
    // Two closed folders in a row are a list, and a blank between each doubles it.
    const gapRows = cur?.single && lane.cells.length === 1 ? [] : [['', 0]]
    if (cur && cur.cells.length + gapRows.length + lane.cells.length <= height) cur.cells.push(...gapRows, ...lane.cells)
    else open().cells.push(...lane.cells)
    cur.single = lane.cells.length === 1
  }
  for (const c of columns) c.width = Math.max(0, ...c.cells.map(x => x[1]))
  return {
    columns,
    height: Math.max(0, ...columns.map(c => c.cells.length)),
    width:  columns.reduce((w, c) => w + c.width, 0) + gap * Math.max(0, columns.length - 1),
  }
}

// The shortest column height from `from` whose packing fits `width`. Taller
// columns are never wider in practice, so a binary search; `null` when even
// one column is too wide.
function shortest(lanes, width, gap, from) {
  const total = lanes.reduce((n, l) => n + l.cells.length + 1, 0)
  if (pack(lanes, Math.max(from, total), gap).width > width) return null
  let lo = from, hi = Math.max(from, total)
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pack(lanes, mid, gap).width <= width) hi = mid
    else lo = mid + 1
  }
  return pack(lanes, lo, gap)
}

/**
 * Lanes laid out across `width` cells. Whole lanes if that fits in `height`
 * rows; otherwise the shortest layout that splits one. Nothing fitting the
 * width at all is one column.
 */
export function layoutLanes(lanes, { width, height = Infinity, gap = 3 }) {
  if (!lanes.length) return { columns: [], height: 0, width: 0 }
  const measured = lanes.map(l => ({
    cells: l.rows.map(r => [r, visibleWidth(r)]),
    cont:  [l.cont, visibleWidth(l.cont)],
  }))
  const tallest = Math.max(...measured.map(l => l.cells.length))
  const whole   = shortest(measured, width, gap, tallest)
  if (whole && whole.height <= height) return whole
  // A piece shorter than this is a header and a row or two, and reads as noise.
  const split = shortest(measured, width, gap, Math.min(tallest, 8))
  if (split && (!whole || split.height < whole.height)) return split
  return whole ?? pack(measured, Infinity, gap)
}

/** The layout as printed lines, each column padded to its width. */
export function drawLanes(layout, { gap = 3 } = {}) {
  const lines = []
  for (let i = 0; i < layout.height; i++) {
    const cells = layout.columns.map(c => {
      const [row, w] = c.cells[i] ?? ['', 0]
      return row + ' '.repeat(c.width - w)
    })
    lines.push(cells.join(' '.repeat(gap)).trimEnd())
  }
  return lines
}

export const isDir = p => existsSync(p) && statSync(p).isDirectory()
