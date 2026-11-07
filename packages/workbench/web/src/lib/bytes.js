// web/src/lib/bytes.js
// A size in the unit a person reads it in: KB, MB or GB to one decimal. 1024,
// as `du -h` counts, so the number beside a folder matches the terminal's.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function bytes(n) {
  if (!n) return '0 B'
  let i = 0
  let v = n
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${UNITS[i]}`
}
