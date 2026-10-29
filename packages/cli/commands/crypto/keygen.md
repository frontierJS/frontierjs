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
  - fli crypto:keygen vapid --env --subject mailto:ops@acme.test
args:
  -
    name: type
    choices: [secret, aes, vapid]
    description: Which kind of key
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
    choices: [hex, base64, base64url]
    description: How the key is written out
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
  print:
    char: p
    type: boolean
    description: Print the key even when --env or --copy already delivered it
    defaultValue: false
  subject:
    char: s
    type: string
    description: "vapid: the contact a push service may reach (mailto: or https:); kept from .env when omitted"
    defaultValue: ''
  rotate:
    type: boolean
    description: "vapid: replace a pair already in .env — every browser subscription made under it stops receiving pushes"
    defaultValue: false
---

<script>
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { resolve } from 'path'

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

const varPattern = (name) => new RegExp(`^${name}=(.*)$`, 'm')

const readEnvVar = (envPath, name) =>
  existsSync(envPath) ? readFileSync(envPath, 'utf8').match(varPattern(name))?.[1] ?? null : null

const writeToEnv = (envPath, name, value, dry, log) => {
  const line = `${name}=${value}`

  if (existsSync(envPath)) {
    const contents = readFileSync(envPath, 'utf8')
    const varRegex = varPattern(name)

    if (varRegex.test(contents)) {
      // Key already exists — update it
      if (dry) return log.dry(`Would update ${name} in ${envPath}`)
      writeFileSync(envPath, contents.replace(varRegex, () => line))
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

// 'true' (boolean from --env without value) or empty string both mean
// "use projectRoot/.env"
const envPathFor = (env, root) =>
  env === true || env === 'true' || env === '' ? resolve(root, '.env') : resolve(root, env)

// ─── VAPID ────────────────────────────────────────────────────────────────────

const VAPID_PKG = '@frontierjs/notifications'

// RFC 8292 asks for a contact, and Apple's push service refuses a subject that
// is not one, so a placeholder would pass here and fail on the first iPhone.
const isVapidSubject = (s) => /^mailto:[^@\s]+@[^@\s]+$/.test(s) || /^https:\/\/\S+$/.test(s)

// A P-256 pair has one length and one encoding, and the pair is three names, so
// these flags have nothing to change and ignoring them would hand back a key
// the caller did not ask for.
const vapidFlagRefusal = (flag) => {
  if (flag.length !== 32)                              return '--length does not apply: a VAPID key is a P-256 key, always 32 bytes'
  if (!['base64', 'base64url'].includes(flag.format)) return '--format does not apply: VAPID keys are base64url, which is what the browser and the push service read'
  if (flag.name)                                       return '--name does not apply: the pair is VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT'
  if (flag.rotate && !flag.env)                        return '--rotate replaces a pair in a .env file; pass --env too'
  return null
}
</script>

Generate cryptographic keys and secrets using Node's built-in `crypto` module.
No external dependencies required.

Supports three key types:
- `secret` — random bytes for JWT secrets, session keys, API keys (default)
- `aes` — AES-compatible key (must be 16, 24, or 32 bytes)
- `vapid` — the Web Push pair `webPush()` signs with, as `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`

Output can be written to stdout, a `.env` file, or your clipboard.

A `vapid` pair is made by `generateVapidKeys()` from the app's own
`@frontierjs/notifications`, so the app must have it installed. `--subject` is
required the first time and kept from the `.env` after. With `--env` only the
public key is printed. Unlike `secret`, an existing pair is not overwritten
without `--rotate`: every browser subscribed under the old public key stops
receiving pushes until it subscribes again.

```js
// ─── vapid: a pair, not a byte string ─────────────────────────────────────────
if (arg.type === 'vapid') {
  const refusal = vapidFlagRefusal(flag)
  if (refusal) return log.error(refusal)

  const envPath = flag.env ? envPathFor(flag.env, $.paths.root) : null
  const held    = envPath && readEnvVar(envPath, 'VAPID_PRIVATE_KEY') !== null
  const subject = flag.subject || (envPath && readEnvVar(envPath, 'VAPID_SUBJECT')) || ''

  if (!subject) return log.error('A VAPID pair needs a contact: pass --subject mailto:ops@your.domain (or an https: URL)')
  if (!isVapidSubject(subject)) return log.error(`--subject must be mailto:<address> or https://<url>; got "${subject}"`)
  if (held && !flag.rotate) {
    log.error(`${envPath} already holds VAPID_PRIVATE_KEY`)
    log.info('--rotate replaces it, and every browser subscribed under the old key stops receiving pushes until it subscribes again.')
    return
  }

  const { shippedFile } = await import(resolve(global.fliRoot, 'core/app-schema.js'))
  const entry = shippedFile($.paths.root, VAPID_PKG, '.')
  if (!entry) {
    log.error(`${VAPID_PKG} is not installed in ${$.paths.root}`)
    log.info(`bun add ${VAPID_PKG}, then fli notifications:install`)
    return
  }
  const { generateVapidKeys } = await import(entry.file)
  const keys = generateVapidKeys(subject)

  const vars = {
    VAPID_PUBLIC_KEY:  keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT:     keys.subject,
  }
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')

  log.info('Generated VAPID pair (P-256, base64url)')

  if (flag.print || (!flag.env && !flag.copy)) echo(lines)

  if (envPath) {
    for (const [name, value] of Object.entries(vars)) writeToEnv(envPath, name, value, flag.dry, log)
    if (!flag.dry) {
      if (held) log.warn('Rotated: every existing push subscription is now dead; browsers must subscribe again.')
      if (!flag.print) echo(`VAPID_PUBLIC_KEY=${keys.publicKey}`)
    }
  }

  if (flag.copy) {
    if (flag.dry) {
      log.dry('Would copy the pair to clipboard')
    } else {
      const { copyToClipboard, clipboardTools } = await import(resolve(global.fliRoot, 'core/clipboard.js'))
      if (copyToClipboard(lines)) log.success('Copied to clipboard')
      else log.warn(`Could not copy to clipboard — is ${clipboardTools() ?? 'a clipboard tool'} installed?`)
    }
  }
  return
}

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
//
// Only when nothing else is carrying the key. `fli keygen | pbcopy` is the whole
// point of the bare form, but `--env` and `--copy` have already delivered it, and
// printing it again puts real key material in terminal scrollback and in the log
// of every CI job and scaffold that composes this command.
if (flag.print || (!flag.env && !flag.copy)) {
  if (flag.name) {
    echo(`${flag.name}=${key}`)
  } else {
    echo(key)
  }
}

// ─── Write to .env ────────────────────────────────────────────────────────────
if (flag.env) {
  const varName = flag.name || `${arg.type.toUpperCase()}_KEY`

  writeToEnv(envPathFor(flag.env, $.paths.root), varName, key, flag.dry, log)
}

// ─── Copy to clipboard ────────────────────────────────────────────────────────
if (flag.copy) {
  if (flag.dry) {
    log.dry('Would copy key to clipboard')
  } else {
    const { copyToClipboard, clipboardTools } = await import(resolve(global.fliRoot, 'core/clipboard.js'))
    if (copyToClipboard(key)) log.success('Copied to clipboard')
    else log.warn(`Could not copy to clipboard — is ${clipboardTools() ?? 'a clipboard tool'} installed?`)
  }
}
```
