// ─── b2.js — Backblaze B2's native API, for the laptop's key ─────────────────
//
// Basecamp's backups speak S3, and S3 has no way to make a bucket's lock or a
// key, so the setup that hands a Basecamp its bucket speaks B2's own API with
// the laptop's key (`B2_KEY_ID`, `B2_APPLICATION_KEY` in the global env,
// `FJS-D2077`). That key can mint keys of any reach, so it never leaves this
// machine: what a Basecamp gets is a key minted here, limited to one bucket and
// one prefix.
//
// Every call answers its value or throws an Error whose message is B2's own
// `code: message`, which names the fix more often than any rewording would.

const AUTHORIZE = 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account'

// What Basecamp's archive job needs at a locked bucket (`basecamp/docs/backups.md`
// § 2): the five to write, list and prune, and the two retention reads that let
// it tell *locked* from *no delete permission*. Never a retention write — with
// one, a stolen key uploads under a one-second retention.
export const ARCHIVE_CAPABILITIES = ['listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'deleteFiles', 'readBucketRetentions', 'readFileRetentions']
// Litestream's, at an unlocked bucket (§ 9).
export const REPLICA_CAPABILITIES = ['listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'deleteFiles']

/** The laptop's key from `env`, or null when either half is missing. */
export function laptopKey(env = process.env) {
  const keyId = env.B2_KEY_ID?.trim(), applicationKey = env.B2_APPLICATION_KEY?.trim()
  return keyId && applicationKey ? { keyId, applicationKey } : null
}

async function answer(res, what) {
  const body = await res.json().catch(() => null)
  if (res.ok) return body
  throw new Error(`B2 ${what}: ${body?.code ?? res.status}: ${body?.message ?? res.statusText}`)
}

/**
 * Sign in with the laptop's key. Answers the session every other call takes:
 * `{ accountId, apiUrl, s3Url, token, fetcher }`.
 */
export async function authorize({ keyId, applicationKey }, { fetcher = fetch } = {}) {
  const basic = Buffer.from(`${keyId}:${applicationKey}`).toString('base64')
  const got   = await answer(await fetcher(AUTHORIZE, { headers: { authorization: `Basic ${basic}` } }), 'authorize')
  const api   = got.apiInfo?.storageApi ?? {}
  return { accountId: got.accountId, apiUrl: api.apiUrl, s3Url: api.s3ApiUrl, token: got.authorizationToken, fetcher }
}

function post(session, op, body) {
  return session.fetcher(`${session.apiUrl}/b2api/v3/${op}`, {
    method:  'POST',
    headers: { authorization: session.token, 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  }).then(res => answer(res, op))
}

/** The account's S3 endpoint and region, as a `BackupDestination` takes them:
 *  `https://s3.us-west-004.backblazeb2.com` and `us-west-004`. */
export function s3Address(session) {
  const endpoint = session.s3Url?.replace(/\/+$/, '')
  const region   = endpoint && new URL(endpoint).hostname.split('.')[1]
  if (!region) throw new Error(`B2 answered no S3 endpoint for this account (${session.s3Url ?? 'none'})`)
  return { endpoint, region }
}

/** The bucket this account holds by that name, or null. A name another account
 *  holds is not seen here, and `createBucket` is refused it. */
export async function findBucket(session, bucketName) {
  const { buckets } = await post(session, 'b2_list_buckets', { accountId: session.accountId, bucketName })
  return buckets?.[0] ?? null
}

/** Whole days of compliance retention the bucket holds every new file for:
 *  0 with none, or with only a governance one, which a key can step past. */
export function lockDaysOf(bucket) {
  const lock = bucket?.fileLockConfiguration?.value
  const kept = lock?.defaultRetention
  if (!lock?.isFileLockEnabled || kept?.mode !== 'compliance') return 0
  const { duration = 0, unit } = kept.period ?? {}
  return unit === 'years' ? duration * 365 : duration
}

/**
 * Make a private bucket with Object Lock available (it can only be turned on
 * at creation) and the lifecycle rule `backups.md` § 1 asks for: keep only the
 * last version, so what a plain DELETE left behind goes once its lock ends.
 * `lockDays` sets a compliance default retention, which nobody can shorten or
 * lift afterwards, the account included. Bucket names are global across B2,
 * so a name another account holds is refused with `duplicate_bucket_name`.
 */
export async function createBucket(session, bucketName, { lockDays = 0 } = {}) {
  const made = await post(session, 'b2_create_bucket', {
    accountId:       session.accountId,
    bucketName,
    bucketType:      'allPrivate',
    fileLockEnabled: true,
    lifecycleRules:  [{ fileNamePrefix: '', daysFromHidingToDeleting: 1, daysFromUploadingToHiding: null }],
  })
  if (!lockDays) return made
  return post(session, 'b2_update_bucket', {
    accountId:        session.accountId,
    bucketId:         made.bucketId,
    defaultRetention: { mode: 'compliance', period: { duration: lockDays, unit: 'days' } },
  })
}

/** `findBucket`, else `createBucket`. Answers `{ bucket, made }`. */
export async function ensureBucket(session, bucketName, opts) {
  const held = await findBucket(session, bucketName)
  if (held) return { bucket: held, made: false }
  return { bucket: await createBucket(session, bucketName, opts), made: true }
}

/**
 * A key limited to one bucket and one name prefix. `namePrefix` ends in `/`,
 * or `ws/` would also reach `ws-other/`. Answers `{ applicationKeyId,
 * applicationKey, keyName, … }`; the secret is in no later answer.
 */
export async function createKey(session, { keyName, bucketId, namePrefix, capabilities }) {
  if (namePrefix && !namePrefix.endsWith('/')) throw new Error(`A key's name prefix ends in a slash, or it reaches the prefixes beside it: '${namePrefix}'`)
  return post(session, 'b2_create_key', {
    accountId: session.accountId, keyName, capabilities, bucketId,
    ...(namePrefix ? { namePrefix } : {}),
  })
}

/** Every key on the account named `keyName` — B2 does not make names unique. */
export async function keysNamed(session, keyName) {
  const found = []
  let startApplicationKeyId
  do {
    const page = await post(session, 'b2_list_keys', { accountId: session.accountId, maxKeyCount: 1000, ...(startApplicationKeyId ? { startApplicationKeyId } : {}) })
    found.push(...(page.keys ?? []).filter(k => k.keyName === keyName))
    startApplicationKeyId = page.nextApplicationKeyId
  } while (startApplicationKeyId)
  return found
}

export function deleteKey(session, applicationKeyId) {
  return post(session, 'b2_delete_key', { applicationKeyId })
}
