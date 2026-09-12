/**
 * web/test/lib/authenticator.mjs — the phone, for the drives.
 *
 * RFC 6238 over node:crypto, written here rather than imported from
 * `@frontierjs/auth`'s `totp.ts`. The server agreeing with ITSELF is the failure
 * a second implementation exists to catch: an authenticator on a phone is not
 * running this repo's code, so a drive whose codes came from the same function
 * that checks them would pass against arithmetic no real app accepts.
 *
 * One copy for every drive that signs in with a code — `verify:users`,
 * `verify:account` and `verify:extension` — since three copies of the arithmetic
 * are three places for a fix to miss.
 */
import { createHmac } from 'node:crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** The six digits an authenticator shows for `secret`, `offset` steps from now. */
export function authenticator(secret, offset = 0) {
  let bits = 0, acc = 0
  const key = []
  for (const ch of secret) {
    acc = (acc << 5) | B32.indexOf(ch); bits += 5
    if (bits >= 8) { key.push((acc >>> (bits - 8)) & 255); bits -= 8 }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset))
  const mac = createHmac('sha1', Buffer.from(key)).update(counter).digest()
  const o   = mac[mac.length - 1] & 0x0f
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0')
}

/**
 * Six digits no nearby step answers. A literal `000000` is right a million times
 * out of a million and one, which is a drive that fails for no reason once in a
 * long while — the kind nobody reruns twice before deleting.
 */
export function wrongCode(secret) {
  const live = new Set([-2, -1, 0, 1, 2].map(o => authenticator(secret, o)))
  for (let n = 0; ; n++) { const c = String(n).padStart(6, '0'); if (!live.has(c)) return c }
}

/**
 * An account with the factor switched on, over HTTP — the arrangement a drive
 * needs before it can ask a SCREEN about the second step. Registered fresh per
 * run: a factor left on by a run that died would change how a seeded person
 * signs in for every drive after it.
 *
 * Confirmed with the PREVIOUS step's code, so the current one is still unspent
 * for the sign-in that follows.
 */
export async function enrolledAccount(api, email, password) {
  const post = async (path, body, token, method) => {
    const r = await fetch(`${api}/api${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token  ? { authorization: `Bearer ${token}` } : {}),
        ...(method ? { 'x-service-method': method }       : {}),
      },
      body: JSON.stringify(body),
    })
    const json = await r.json().catch(() => null)
    if (!r.ok) throw new Error(`${method ?? path} answered ${r.status}: ${JSON.stringify(json)}`)
    return json
  }
  const { token }         = await post('/auth/register', { email, password, name: 'Two Step' })
  const { secret }        = await post('/account/me', { currentPassword: password }, token, 'setupTotp')
  const { recoveryCodes } = await post('/account/me', { code: authenticator(secret, -1) }, token, 'confirmTotp')
  return {
    email, secret, recoveryCodes, token,
    /** Switch it off again, as the account itself would. */
    disable: (withToken = token) => post('/account/me', { currentPassword: password }, withToken, 'disableTotp'),
  }
}
