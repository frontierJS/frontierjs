// ─── zip.js — a folder as one stored zip ─────────────────────────────────────
//
// `fli tell:upload <folder>` sends a folder as one file, and the recipient may
// have only a browser, so it is a zip: the one archive every phone and desktop
// opens without a tool. Entries are STORED, not deflated, since `sealFile`
// deflates the whole archive before sealing it, and a second pass over
// deflated bytes only costs time.
//
// A symlink is left out rather than followed, so a link inside the folder
// never sends a file from outside it. No ZIP64: the post's 24 MiB cap is far
// under the 4 GiB a plain zip holds, and the entry count is refused past
// 65,535 by name.
// ─────────────────────────────────────────────────────────────────────────────

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 0xffff
/** General-purpose flag 11: the name is UTF-8. */
const UTF8 = 0x0800
/** Made by Unix, spec 2.0, so the external attributes carry the mode. */
const MADE_BY = (3 << 8) | 20

const dosTime = (d) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
})

/** Every regular file under `dir`, `/`-separated and relative, in a stable order. */
const walk = (dir, prefix = '') => readdirSync(dir).sort().flatMap(name => {
  const full = join(dir, name)
  const stat = lstatSync(full)
  if (stat.isDirectory()) return walk(full, `${prefix}${name}/`)
  return stat.isFile() ? [{ name: `${prefix}${name}`, full, stat }] : []
})

/**
 * The folder at `dir` as zip bytes. `max` stops the read once the files alone
 * pass it, so a folder far over the cap is refused before it is held.
 */
export function zipFolder(dir, { max = Infinity } = {}) {
  const files = walk(dir)
  if (files.length > MAX_ENTRIES) throw new Error(`A folder is zipped with at most ${MAX_ENTRIES} files, and ${dir} holds ${files.length}.`)
  const total = files.reduce((n, f) => n + f.stat.size, 0)
  if (total > max) throw new Error(`The files in ${dir} come to ${total} bytes, over the ${max} a file may be.`)

  const encoder = new TextEncoder()
  const locals = [], centrals = []
  let offset = 0
  for (const { name, full, stat } of files) {
    const data = readFileSync(full)
    const path = encoder.encode(name)
    const crc  = Bun.hash.crc32(data)
    const { time, date } = dosTime(stat.mtime)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, UTF8, true)
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, path.length, true)
    locals.push(new Uint8Array(local.buffer), path, data)

    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, MADE_BY, true)
    central.setUint16(6, 20, true)
    central.setUint16(8, UTF8, true)
    central.setUint16(12, time, true)
    central.setUint16(14, date, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, data.length, true)
    central.setUint32(24, data.length, true)
    central.setUint16(28, path.length, true)
    central.setUint32(38, ((stat.mode & 0o777) | 0o100000) << 16 >>> 0, true)
    central.setUint32(42, offset, true)
    centrals.push(new Uint8Array(central.buffer), path)

    offset += 30 + path.length + data.length
  }

  const centralSize = centrals.reduce((n, part) => n + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)

  return new Uint8Array(Buffer.concat([...locals, ...centrals, new Uint8Array(end.buffer)]))
}
