---
title: utils:pack
description: Zip a folder, excluding media and build artifacts by default
alias: pack
examples:
  - fli pack
  - fli pack ./my-project
  - fli pack ./my-project --out ~/Desktop/my-project.zip
  - fli pack ./my-project --media
  - fli pack ./my-project --exclude "*.log" --exclude ".env"
  - fli pack --dry
args:
  -
    name: target
    description: Folder to zip (defaults to current directory)
    defaultValue: '.'
flags:
  out:
    char: o
    type: string
    description: Output zip path (defaults to <folder-name>.zip in cwd)
    defaultValue: ''
  media:
    char: m
    type: boolean
    description: Include media and image files (excluded by default)
    defaultValue: false
  deps:
    char: d
    type: boolean
    description: Include node_modules and vendor directories (excluded by default)
    defaultValue: false
  exclude:
    char: e
    type: string
    description: Additional glob pattern to exclude (can repeat)
    defaultValue: ''
---

<script>
import { resolve, basename, dirname } from 'path'
import { existsSync } from 'fs'
import { execSync } from 'child_process'

// Media / binary formats excluded by default
const MEDIA_EXTS = [
  '*.jpg', '*.jpeg', '*.png', '*.gif', '*.webp', '*.avif', '*.svg',
  '*.mp4', '*.mov', '*.avi', '*.mkv', '*.webm',
  '*.mp3', '*.wav', '*.ogg', '*.flac', '*.aac',
  '*.psd', '*.ai', '*.sketch', '*.figma',
  '*.ttf', '*.otf', '*.woff', '*.woff2', '*.eot',
  '*.pdf', '*.zip', '*.tar', '*.gz', '*.rar',
]

// Always excluded
const ALWAYS_EXCLUDE = [
  '.DS_Store', 'Thumbs.db', '*.tmp', '*.swp',
]

// Excluded unless --deps is passed
const DEP_DIRS = [
  'node_modules/*', 'vendor/*', '.turbo/*', '.next/*', '.svelte-kit/*',
  'dist/*', 'build/*', '.cache/*',
]
</script>

Zips a folder into a portable archive. Media, binaries, and build artifacts
are excluded by default to keep archives lean and fast to transfer.

## Default exclusions

- **Media** — jpg, png, gif, webp, svg, mp4, mp3, pdf, fonts, etc.
- **Deps** — node_modules/, vendor/, dist/, .next/, .turbo/
- **Noise** — .DS_Store, *.tmp, *.swp

Pass `--media` to include images and media files.
Pass `--deps` to include node_modules and build dirs.

```js
const targetDir = resolve(arg.target.replace(/^~/, process.env.HOME || ''))

if (!existsSync(targetDir)) {
  log.error(`Directory not found: ${targetDir}`)
  return
}

const folderName = basename(targetDir)
const outPath    = flag.out
  ? resolve(flag.out.replace(/^~/, process.env.HOME || ''))
  : resolve(process.cwd(), `${folderName}.zip`)

// Build exclusion list
const excludes = [...ALWAYS_EXCLUDE]
if (!flag.media)  excludes.push(...MEDIA_EXTS)
if (!flag.deps)   excludes.push(...DEP_DIRS)

// Extra --exclude flags
const extra = flag.exclude
  ? (Array.isArray(flag.exclude) ? flag.exclude : [flag.exclude])
  : []
excludes.push(...extra)

const excludeArgs = excludes.map(p => `--exclude="${p}"`).join(' ')
const cmd = `zip -r "${outPath}" "${folderName}" ${excludeArgs}`

log.info(`Packing:   ${targetDir}`)
log.info(`Output:    ${outPath}`)
log.info(`Excluding: media=${!flag.media}  deps=${!flag.deps}${extra.length ? `  +${extra.length} custom` : ''}`)

if (flag.dry) {
  log.dry(cmd)
  return
}

// zip works relative to parent dir so the archive contains folder-name/...
const parentDir = dirname(targetDir)

try {
  execSync(cmd, { cwd: parentDir, stdio: 'inherit' })

  // Show size
  try {
    const size = execSync(`du -sh "${outPath}"`, { encoding: 'utf8' }).split('\t')[0]
    log.success(`Created ${outPath}  (${size})`)
  } catch {
    log.success(`Created ${outPath}`)
  }
} catch (err) {
  log.error(`zip failed: ${err.message}`)
}
```
