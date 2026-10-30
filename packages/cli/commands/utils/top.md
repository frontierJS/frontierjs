---
title: utils:top
description: A vtop look-alike — CPU and memory graphs, processes grouped by name, dd to kill
alias: top
examples:
  - fli top
  - fli top --interval 1000
flags:
  interval:
    char: i
    type: number
    description: milliseconds between redraws
    defaultValue: 300
---

<script>
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { dlopen, FFIType, ptr } from 'bun:ffi'

const source = () => resolve(global.fliRoot, 'native/top')
const cacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'frontierjs/top')
const has = tool => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0

// Cargo when the machine has it; cc otherwise, since a C compiler is on nearly
// every Linux box and the two sources draw the same screen. Each returns the
// binary, or cargo's or cc's own output so a broken toolchain explains itself.
const buildRust = () => {
  const r = spawnSync('cargo', ['build', '--release', '--quiet',
    '--manifest-path', join(source(), 'Cargo.toml'), '--target-dir', cacheDir()], { encoding: 'utf8' })
  return r.status === 0 ? { bin: join(cacheDir(), 'release/fli-top') } : { error: r.stderr || r.stdout }
}

// cargo fingerprints its own sources; cc does not, so an edit to top.c rebuilds by mtime
const buildC = () => {
  const src = join(source(), 'top.c')
  const bin = join(cacheDir(), 'fli-top-c')
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return { bin }
  mkdirSync(cacheDir(), { recursive: true })
  const r = spawnSync('cc', ['-O2', '-o', bin, src], { encoding: 'utf8' })
  return r.status === 0 ? { bin } : { error: r.stderr || r.stdout }
}

// Replace this process rather than spawn a child: Bun idles at ~27 MB, the
// monitor at ~2 MB, and a parent left waiting would hold both for the session.
const execv = argv => {
  const libc = dlopen('libc.so.6', { execv: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 } })
  const bufs = argv.map(s => Buffer.from(s + '\0'))
  const list = new BigUint64Array(bufs.length + 1)
  bufs.forEach((b, i) => { list[i] = BigInt(ptr(b)) })
  libc.symbols.execv(ptr(bufs[0]), ptr(list))
}
</script>

The monitor is native code built on first use from `native/top/` — Rust with
cargo, else C with cc — into `~/.cache/frontierjs/top`, then fli hands the
terminal to it. Keys: `j`/`k` move, `g`/`G` jump, `c`/`m` sort by CPU or
memory, `dd` sends SIGTERM to every process in the selected group, `q` quits.

```js
if (process.platform !== 'linux') {
  log.error('fli top reads /proc, so it runs on Linux only')
  process.exitCode = 1; return
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  log.error('fli top needs a terminal')
  process.exitCode = 1; return
}

const built = has('cargo') ? buildRust() : has('cc') ? buildC() : null
if (!built) {
  log.error('fli top builds on first use and needs cargo (https://rustup.rs) or a C compiler (cc)')
  process.exitCode = 1; return
}
if (built.error) {
  log.error(`fli top did not build:\n${built.error.trim()}`)
  process.exitCode = 1; return
}

execv([built.bin, '--interval', String(flag.interval)])
log.error(`could not start ${built.bin}`)
process.exitCode = 1
```
