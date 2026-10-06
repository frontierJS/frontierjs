// watch.js — the dev server's file watcher, over fs.watch's recursive mode.
//
// An editor that saves atomically writes a temp file and renames it, which is
// two or three events for one save; each path is settled for `settleMs` after
// its LAST event, so one save is one rebuild. Add, change and delete are not
// told apart — the classifier reads the path and re-discovers the tree.

import { watch } from 'node:fs'
import { join } from 'node:path'

export const IGNORED = [
  /(^|[/\\])\.[^/\\]+$/,   // dot-files: an editor's swap and temp files
  /node_modules/,
  /\.jetty-cache/,
  /\bdist\b/,
  /\.git([/\\]|$)/,
]

export function watchTree(dirs, { ignored = IGNORED, settleMs = 60, onChange, onError }) {
  const timers = new Map()

  const settle = (path) => {
    clearTimeout(timers.get(path))
    timers.set(path, setTimeout(() => { timers.delete(path); onChange(path) }, settleMs))
  }

  const watchers = dirs.map((dir) => {
    const w = watch(dir, { recursive: true }, (_event, filename) => {
      // null on a platform that cannot say which file; nothing to classify.
      if (!filename) return
      const path = join(dir, filename.toString())
      if (ignored.some((re) => re.test(path))) return
      settle(path)
    })
    w.on('error', (err) => onError?.(err))
    return w
  })

  return {
    async close() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      for (const w of watchers) w.close()
    },
  }
}
