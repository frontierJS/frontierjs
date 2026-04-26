---
title: crypto:keygen
description: Generate cryptographic keys and secrets
alias: keygen
examples:
  - fli crypto:keygen
  - fli crypto:keygen aes --length 16
  - fli crypto:keygen --format hex --length 64
  - fli crypto:keygen --name JWT_SECRET --env
  - fli keygen --name SESSION_KEY --copy
args:
  -
    name: type
    description: "Key type: secret or aes"
    defaultValue: secret
flags:
  length:
    char: l
    type: number
    description: "Number of bytes to generate"
    defaultValue: 32
  format:
    char: f
    type: string
    description: "Output format: hex, base64, base64url"
    defaultValue: base64
  name:
    char: n
    type: string
    description: "Variable name for --env output (e.g. JWT_SECRET)"
    defaultValue: ''
  env:
    char: e
    description: "Append KEY=value to this .env file (pass path, or bare --env for projectRoot .env)"
    defaultValue: ''
  copy:
    char: c
    type: boolean
    description: Copy generated key to clipboard
    defaultValue: false
---

<script>
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

// ─── Key generators ───────────────────────────────────────────────────────────

const generators = {
  secret: (bytes) => randomBytes(bytes),
  aes:    (bytes) => {
    // AES requires 16 (128-bit), 24 (192-bit), or 32 (256-bit) bytes
    const valid = [16, 24, 32]
    if (!valid.includes(bytes)) {
      throw new Error(`AES key length must be 16, 24, or 32 bytes (got ${bytes}). That's AES-${bytes * 8}.`)
    }
    return randomBytes(bytes)
  },
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const formatters = {
  hex:       (buf) => buf.toString('hex'),
  base64:    (buf) => buf.toString('base64'),
  base64url: (buf) => buf.toString('base64url'),
}

// ─── .env writer ──────────────────────────────────────────────────────────────

const writeToEnv = (envPath, name, value, dry, log) => {
  const line = `${name}=${value}`

  if (existsSync(envPath)) {
    const contents = readFileSync(envPath, 'utf8')
    const varRegex = new RegExp(`^${name}=.*$`, 'm')

    if (varRegex.test(contents)) {
      // Key already exists — update it
      if (dry) return log.dry(`Would update ${name} in ${envPath}`)
      writeFileSync(envPath, contents.replace(varRegex, line))
      log.success(`Updated ${name} in ${envPath}`)
    } else {
      // Append to end
      if (dry) return log.dry(`Would append ${name} to ${envPath}`)
      const suffix = contents.endsWith('\n') ? '' : '\n'
      appendFileSync(envPath, `${suffix}${line}\n`)
      log.success(`Appended ${name} to ${envPath}`)
    }
  } else {
    // Create new .env file
    if (dry) return log.dry(`Would create ${envPath} with ${name}`)
    writeFileSync(envPath, `${line}\n`)
    log.success(`Created ${envPath} with ${name}`)
  }
}

// ─── Clipboard ────────────────────────────────────────────────────────────────

const copyToClipboard = (value) => {
  // Detect platform clipboard command
  const cmds = {
    darwin: 'pbcopy',
    linux:  'xclip -selection clipboard 2>/dev/null || xsel --clipboard --input 2>/dev/null',
    win32:  'clip',
  }
  const cmd = cmds[process.platform]
  if (!cmd) {
    log.warn(`Clipboard not supported on platform: ${process.platform}`)
    return false
  }
  try {
    execSync(cmd, { input: value, stdio: ['pipe', 'ignore', 'ignore'] })
    return true
  } catch {
    log.warn('Could not copy to clipboard — is xclip or xsel installed?')
    return false
  }
}
</script>

Generate cryptographic keys and secrets using Node's built-in `crypto` module.
No external dependencies required.

Supports two key types:
- `secret` — random bytes for JWT secrets, session keys, API keys (default)
- `aes` — AES-compatible key (must be 16, 24, or 32 bytes)

Output can be written to stdout, a `.env` file, or your clipboard.

```js
// ─── Validate type ────────────────────────────────────────────────────────────
const validTypes = Object.keys(generators)
if (!validTypes.includes(arg.type)) {
  log.error(`Unknown key type "${arg.type}". Valid types: ${validTypes.join(', ')}`)
  return
}

// ─── Validate format ──────────────────────────────────────────────────────────
const validFormats = Object.keys(formatters)
if (!validFormats.includes(flag.format)) {
  log.error(`Unknown format "${flag.format}". Valid formats: ${validFormats.join(', ')}`)
  return
}

// ─── Generate ─────────────────────────────────────────────────────────────────
const bytes = flag.length
let buf
try {
  buf = generators[arg.type](bytes)
} catch (err) {
  log.error(err.message)
  return
}
const key    = formatters[flag.format](buf)
const bits   = bytes * 8

// ─── Describe what was generated ──────────────────────────────────────────────
const typeLabel   = arg.type === 'aes' ? `AES-${bits}` : `${bits}-bit secret`
const formatLabel = flag.format
log.info(`Generated ${typeLabel} (${formatLabel}, ${bytes} bytes)`)

// ─── Output to stdout ─────────────────────────────────────────────────────────
if (flag.name) {
  echo(`${flag.name}=${key}`)
} else {
  echo(key)
}

// ─── Write to .env ────────────────────────────────────────────────────────────
if (flag.env) {
  const varName = flag.name || `${arg.type.toUpperCase()}_KEY`

  // Resolve .env path — 'true' (boolean from --env without value) or empty
  // string both mean "use projectRoot/.env"
  let envPath
  if (flag.env === true || flag.env === 'true' || flag.env === '') {
    envPath = resolve(context.paths.root, '.env')
  } else {
    envPath = resolve(context.paths.root, flag.env)
  }

  writeToEnv(envPath, varName, key, flag.dry, log)
}

// ─── Copy to clipboard ────────────────────────────────────────────────────────
if (flag.copy) {
  if (flag.dry) {
    log.dry('Would copy key to clipboard')
  } else {
    const ok = copyToClipboard(key)
    if (ok) log.success('Copied to clipboard')
  }
}
```
