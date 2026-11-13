/*
 * download — a file the page saves lands in the launch's own directory.
 *
 * Chrome's default is the user's Downloads folder, so a drive that clicked a
 * download wrote into it on every run unless it set the behavior itself
 * (FJS-4279). The name is unique per run so a leftover from an earlier one
 * cannot answer for this one.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'download — saved into the launch, gone with it'

/** Poll for a file Chrome is still writing. */
async function landed(path, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(path)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

export async function run(t) {
  const file = `drive-${process.pid}-${Date.now()}.txt`
  const stray = join(homedir(), 'Downloads', file)
  const b = await t.openChrome()
  let dir
  try {
    dir = b.downloads
    t.ok(typeof dir === 'string', 'the handle names its downloads directory')
    await b.navigate(t.origin, 'window.put')
    await b.evaluate(`
      const a = document.createElement('a')
      a.href = '/download/${file}'
      document.body.append(a)
      a.click()
      return true
    `)
    const saved = dir ? join(dir, file) : stray
    t.ok(await landed(saved), 'the download lands in it')
    t.ok(!existsSync(stray), 'and not in the Downloads folder')
    if (dir && existsSync(join(dir, file))) t.is(readFileSync(join(dir, file), 'utf8'), 'saved by the drive', 'with the bytes the server sent')
  } finally {
    await b.close()
    rmSync(stray, { force: true })
  }
  if (dir) t.ok(!existsSync(dir), 'the directory goes with the browser')
}
