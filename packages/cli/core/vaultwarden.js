// Read secrets out of a Vaultwarden (or Bitwarden) server with no `bw` binary:
// log in, sync, derive the keys, decrypt in-process. Read-only.
//
// The server holds ciphertext only, so whatever reads a secret must be a vault
// USER and must hold that user's master password. Vaultwarden has no Secrets
// Manager machine accounts (dani-garcia/vaultwarden#3368), so the intended
// login is a dedicated user, a read-only member of one collection, signing in
// with its personal API key (client_credentials) and unlocking with its password.
//
// Proved against Vaultwarden 1.37.4: PBKDF2 and Argon2id accounts, org items
// with a per-item key, API-key and password logins, the wrong-password refusal.
import { argon2Sync, constants, createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, hkdfSync, pbkdf2Sync, privateDecrypt, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const KDF_PBKDF2 = 0
const KDF_ARGON2ID = 1
// Bitwarden's DeviceType enum: 25 is LinuxCLI. The server records a device per
// identifier, so one stable id per process keeps the account's device list short.
const DEVICE = { deviceType: '25', deviceName: 'frontierjs-fli', deviceIdentifier: randomUUID() }

const CIPHER_LOGIN = 1
const SEND_TEXT = 0
const STANDARD_FIELDS = new Set(['password', 'username', 'totp', 'notes', 'uri', 'name'])

// Vaultwarden answered PascalCase before 1.32 and camelCase after; reading both
// means a server upgrade is not a client outage.
function camel(value) {
  if (Array.isArray(value)) return value.map(camel)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), camel(v)]))
}

async function call(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  if (!res.ok) {
    let reason = text.slice(0, 300)
    try { const j = camel(JSON.parse(text)); reason = j.errorModel?.message ?? j.error_description ?? j.message ?? reason } catch {}
    // An identity error carries its message as a JSON string inside error_description.
    try { reason = JSON.parse(reason).message ?? reason } catch {}
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${reason}`)
  }
  return text ? camel(JSON.parse(text)) : null
}

function form(fields) {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }
}

function prelogin(base, email) {
  return call(base, '/identity/accounts/prelogin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
}

function deriveMasterKey(password, email, kdf) {
  const salt = email.trim().toLowerCase()
  if (kdf.kdf === KDF_PBKDF2) return pbkdf2Sync(password, salt, kdf.kdfIterations, 32, 'sha256')
  if (kdf.kdf === KDF_ARGON2ID) {
    return argon2Sync('argon2id', {
      message: password,
      nonce: createHash('sha256').update(salt).digest(),
      passes: kdf.kdfIterations,
      memory: kdf.kdfMemory * 1024,
      parallelism: kdf.kdfParallelism,
      tagLength: 32,
    })
  }
  throw new Error(`KDF type ${kdf.kdf} is neither PBKDF2 (0) nor Argon2id (1)`)
}

// RFC 5869 expand only — Bitwarden skips extract, so hkdfSync (which extracts
// first) derives a different key and every MAC fails.
function hkdfExpand(prk, info) {
  return createHmac('sha256', prk).update(info).update(Buffer.from([1])).digest()
}

function stretch(key) {
  return Buffer.concat([hkdfExpand(key, 'enc'), hkdfExpand(key, 'mac')])
}

/** EncString type 2: AES-256-CBC with HMAC-SHA256 over iv||ct. */
function decrypt(encString, key64) {
  const dot = encString.indexOf('.')
  const type = encString.slice(0, dot)
  if (type !== '2') throw new Error(`EncString type ${type} — only 2 is handled`)
  const [iv, ct, tag] = encString.slice(dot + 1).split('|').map(s => Buffer.from(s, 'base64'))
  const expect = createHmac('sha256', key64.subarray(32, 64)).update(iv).update(ct).digest()
  if (tag.length !== expect.length || !timingSafeEqual(tag, expect)) throw new Error('EncString MAC mismatch')
  const d = createDecipheriv('aes-256-cbc', key64.subarray(0, 32), iv)
  return Buffer.concat([d.update(ct), d.final()])
}

function encrypt(plain, key64) {
  const iv = randomBytes(16)
  const c = createCipheriv('aes-256-cbc', key64.subarray(0, 32), iv)
  const ct = Buffer.concat([c.update(plain), c.final()])
  const tag = createHmac('sha256', key64.subarray(32, 64)).update(iv).update(ct).digest()
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${tag.toString('base64')}`
}

// A Send's link carries 16 bytes of key material; unlike the user key, this
// one runs the full HKDF, extract included, under Bitwarden's fixed salt.
function sendKey(material) {
  return Buffer.from(hkdfSync('sha256', material, 'bitwarden-send', 'send', 64))
}

const sendPasswordHash = (password, material) => pbkdf2Sync(password, material, 100000, 32, 'sha256').toString('base64')

// An org key arrives wrapped under the user's RSA key: type 4 is OAEP-SHA1,
// type 3 OAEP-SHA256; 5/6 add a MAC this client does not check and refuse.
function unwrapRsa(encString, privateKeyDer) {
  const dot = encString.indexOf('.')
  const type = encString.slice(0, dot)
  const oaepHash = { 3: 'sha256', 4: 'sha1' }[type]
  if (!oaepHash) throw new Error(`RSA EncString type ${type} — only 3 and 4 are handled`)
  const key = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' })
  return privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash }, Buffer.from(encString.slice(dot + 1), 'base64'))
}

const text = (enc, key) => (enc ? decrypt(enc, key).toString('utf8') : null)

function decryptCipher(c, userKey, orgKeys) {
  let key = c.organizationId ? orgKeys.get(c.organizationId) : userKey
  if (!key) return null // an org this user's sync did not hand a key for
  if (c.key) key = decrypt(c.key, key)
  const login = c.type === CIPHER_LOGIN && c.login ? c.login : null
  return {
    id: c.id,
    organizationId: c.organizationId ?? null,
    collectionIds: c.collectionIds ?? [],
    name: text(c.name, key),
    notes: text(c.notes, key),
    username: login ? text(login.username, key) : null,
    password: login ? text(login.password, key) : null,
    totp: login ? text(login.totp, key) : null,
    uri: login?.uris?.[0]?.uri ? text(login.uris[0].uri, key) : null,
    fields: Object.fromEntries((c.fields ?? []).map(f => [text(f.name, key), text(f.value, key)])),
  }
}

/**
 * The `VW_*` keys a login still lacks, as `requiresOf` entries for
 * `acquireMissing`. An API key is not asked for: with neither it nor an email
 * set, the email is the one a person has to hand.
 */
export function loginNeeds(env) {
  const need = []
  if (!env.VW_URL) need.push({ key: 'VW_URL', url: null, note: 'the vault server, https://<host>' })
  if (!env.VW_CLIENT_ID && !env.VW_EMAIL) need.push({ key: 'VW_EMAIL', url: null, note: 'or set VW_CLIENT_ID + VW_CLIENT_SECRET, an API key, for a 2FA account' })
  if (!env.VW_PASSWORD) need.push({ key: 'VW_PASSWORD', url: null, note: "the vault user's master password", secret: true })
  return need
}

/**
 * Log in, sync once, and hold the decrypted items in memory.
 * Either `clientId` + `clientSecret` (an API key — survives 2FA) or `email`
 * (a password grant — refused by a 2FA account), and always `password`.
 */
export async function openVault({ url, clientId, clientSecret, email, password }) {
  if (!url || !password) throw new Error('a vault needs a url and the master password')
  const base = url.replace(/\/+$/, '')

  let token
  if (clientId) {
    token = await call(base, '/identity/connect/token', form({ grant_type: 'client_credentials', scope: 'api', client_id: clientId, client_secret: clientSecret ?? '', ...DEVICE }))
  } else {
    if (!email) throw new Error('a vault needs clientId + clientSecret, or email')
    const hash = pbkdf2Sync(deriveMasterKey(password, email, await prelogin(base, email)), password, 1, 32, 'sha256').toString('base64')
    token = await call(base, '/identity/connect/token', form({ grant_type: 'password', scope: 'api offline_access', client_id: 'cli', username: email, password: hash, ...DEVICE }))
  }

  const sync = await call(base, '/api/sync?excludeDomains=true', { headers: { authorization: `Bearer ${token.access_token}` } })
  const profile = sync.profile
  const kdf = await prelogin(base, profile.email)

  let userKey
  try {
    userKey = decrypt(profile.key, stretch(deriveMasterKey(password, profile.email, kdf)))
  } catch (err) {
    // The MAC is the only place a wrong password shows itself.
    throw new Error(/MAC mismatch/.test(err.message) ? `master password does not unlock ${profile.email}` : err.message)
  }
  const privateKey = profile.privateKey ? decrypt(profile.privateKey, userKey) : null
  const orgKeys = new Map()
  for (const org of profile.organizations ?? []) {
    if (org.key && privateKey) orgKeys.set(org.id, unwrapRsa(org.key, privateKey))
  }

  const collections = new Map()
  for (const col of sync.collections ?? []) {
    const k = orgKeys.get(col.organizationId)
    if (k) collections.set(col.id, text(col.name, k))
  }

  const items = (sync.ciphers ?? [])
    .filter(c => !c.deletedDate)
    .map(c => decryptCipher(c, userKey, orgKeys))
    .filter(Boolean)
    .map(item => ({ ...item, collections: item.collectionIds.map(id => collections.get(id)).filter(Boolean) }))

  function find(name) {
    const exact = items.filter(i => i.id === name || i.name === name)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) throw new Error(`${exact.length} items are named "${name}" — name one by id`)
    return null
  }

  return {
    email: profile.email,
    items,
    /**
     * A text Send of `text`, readable by anyone holding the returned link until
     * `maxAccessCount` reads or `days` pass. The server holds only ciphertext;
     * the key travels in the link's fragment, which no request carries.
     */
    async createSend({ name, text: body, maxAccessCount = 1, days = 1, password = null }) {
      const material = randomBytes(16)
      const key = sendKey(material)
      const until = new Date(Date.now() + days * 86400000).toISOString()
      const send = await call(base, '/api/sends', {
        method: 'POST',
        headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: SEND_TEXT,
          key: encrypt(material, userKey),
          name: encrypt(Buffer.from(name), key),
          notes: null,
          text: { text: encrypt(Buffer.from(body), key), hidden: false },
          file: null,
          maxAccessCount,
          expirationDate: until,
          deletionDate: until,
          password: password ? sendPasswordHash(password, material) : null,
          disabled: false,
          hideEmail: false,
        }),
      })
      return { link: `${base}/#/send/${send.accessId}/${material.toString('base64url')}`, until }
    },
    /** `Item` → its password · `Item/field` → a standard or custom field · null when absent. */
    get(ref) {
      const slash = ref.lastIndexOf('/')
      const [name, field] = slash > 0 && !find(ref) ? [ref.slice(0, slash), ref.slice(slash + 1)] : [ref, 'password']
      const item = find(name)
      if (!item) return null
      if (field in item.fields) return item.fields[field]
      if (STANDARD_FIELDS.has(field)) return item[field] ?? null
      return null
    },
  }
}

const SEND_LINK = /^(https?:\/\/[^#]+?)\/?#\/send\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/

/**
 * The text of a Send link, decrypted in-process. No vault login: the link is
 * the credential. Every call is one ACCESS on the server, so a Send capped at
 * one read is spent by the first call whether or not the caller keeps the text.
 */
export async function receiveSend(link, { password = null } = {}) {
  const m = link.trim().match(SEND_LINK)
  if (!m) throw new Error('not a Send link — expected https://<host>/#/send/<id>/<key>')
  const [, base, accessId, keyPart] = m
  const material = Buffer.from(keyPart, 'base64url')
  let send
  try {
    send = await call(base, `/api/sends/access/${accessId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(password ? { password: sendPasswordHash(password, material) } : {}),
    })
  } catch (err) {
    if (/→ 401/.test(err.message) && !password) throw new Error('this Send has a password — pass --password')
    throw err
  }
  if (send.type !== SEND_TEXT) throw new Error('this Send is a file — only a text Send is read')
  const key = sendKey(material)
  return { name: text(send.name, key), text: text(send.text?.text, key) ?? '' }
}

/**
 * One `KEY=value` line both fli's `loadEnv` and Bun's own .env loader read
 * back as `value`, or null when no spelling does. Both expand `$` in either
 * quote and read `\$` as a literal one, and both let a backslash skip the
 * quote after it, so a value holding `\r`, or a `\` beside a `$`, a `'` or the
 * end of the line, has no line they agree on.
 */
export function dotenvLine(key, value) {
  if (value.includes('\r')) return null
  const dollars = (v) => v.replace(/\$/g, '\\$')
  if (!/['\n]/.test(value) && !value.endsWith('\\') && !(value.includes('$') && value.includes('\\'))) {
    return `${key}='${dollars(value)}'`
  }
  if (!/["\\]/.test(value)) return `${key}="${dollars(value).replace(/\n/g, '\\n')}"`
  return null
}
