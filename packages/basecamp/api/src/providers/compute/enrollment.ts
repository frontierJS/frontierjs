// src/providers/compute/enrollment.ts
// How a machine Basecamp MADE proves it is that machine.
//
// The problem this exists for is stated in `core/hooks.ts` at the signature
// check: there is one `OUTPOST_SECRET` for the whole fleet, so a machine that
// is compromised can forge any other machine's check-in. Per-server secrets
// need a mint and a hand-over at install time, and until a machine could be
// created there was no install time to hand anything over at.
//
// ─── Why the token is not the secret ─────────────────────────────────────
//
// A provisioned machine is handed its install through cloud-init `user_data`,
// which is readable by ANYTHING running on that box — the metadata service
// hands it back on request, unauthenticated, forever. So `user_data` carries a
// one-time enrollment token and never the credential: the box exchanges it,
// once, inside a short window, for a secret of its own. Baking `OUTPOST_SECRET`
// in would hand every machine the key to forge every other machine.
//
// What is stored here is the token's HASH. `Server` is readable by every member
// of the workspace, so a column holding the live token would let any of them
// enroll as the machine.
//
// ─── The response is where two unknowns are answered ─────────────────────
//
// The Outpost also learns its own public URL at enrollment. It cannot see the
// address the world reaches it at — `OUTPOST_PUBLIC_URL` is stated rather than
// derived for that reason — and Basecamp knows it, because the vendor said so
// when the machine came up. One exchange, two facts.

import { randomBytes, createHash, timingSafeEqual, X509Certificate } from 'node:crypto'
import { OPENSSL_CERT_ARGS } from '@frontierjs/outpost/cert'

/** What the install runs on a machine, held here so two machines provisioned a
 *  week apart run the same thing. The Outpost is pinned to the version this
 *  workspace carries (a test holds the two together); Docker and Caddy come
 *  from signed apt repositories. */
export const BUN_VERSION     = '1.4.2'
export const OUTPOST_VERSION = '0.1.2'

/** How long a machine has to enroll. A cloud-init run is seconds; fifteen
 *  minutes is room for a slow image pull and nothing like room for a leaked
 *  metadata blob to be useful tomorrow. */
export const ENROLL_WINDOW_MS = 15 * 60 * 1000

/** The prefix makes one of these recognizable in a log or a metadata dump,
 *  which is what somebody grepping for a leak needs. */
const PREFIX = 'bcen_'

export interface MintedToken {
  /** Goes into cloud-init. Never stored. */
  token:     string
  /** Goes into the column. Never leaves the app. */
  hash:      string
  expiresAt: Date
}

/** A fresh enrollment token and the hash to keep. */
export function mintEnrollToken(now = new Date()): MintedToken {
  const token = PREFIX + randomBytes(32).toString('hex')
  return {
    token,
    hash:      hashEnrollToken(token),
    expiresAt: new Date(now.getTime() + ENROLL_WINDOW_MS),
  }
}

/**
 * SHA-256, unsalted, and that is correct here rather than lazy: the input is
 * 32 bytes of CSPRNG output, so there is no dictionary to attack and a slow KDF
 * would only cost the enrollment path. It is a password rule applied to a
 * random token that makes people reach for bcrypt here.
 */
export function hashEnrollToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Does this token match the stored hash, and is the window still open?
 *
 * The comparison is constant-time. A token is presented by an unauthenticated
 * caller — that is the whole point of it — so the compare is reachable by
 * anybody who can reach the route, and a byte-by-byte early return is a
 * measurable oracle.
 *
 * Both failures answer the same `false`. Which of *wrong token* and *too late*
 * it was must not be disclosed to the presenter, because the second one tells
 * an attacker the id they guessed is real.
 */
export function enrollTokenMatches(
  presented: string | null | undefined,
  storedHash: string | null | undefined,
  expiresAt: Date | string | null | undefined,
  now = new Date(),
): boolean {
  if (!presented || !storedHash || !expiresAt) return false

  const deadline = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= now.getTime()) return false

  const a = Buffer.from(hashEnrollToken(presented), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  // `timingSafeEqual` throws on a length mismatch, which is itself a signal —
  // but both sides are a SHA-256 digest here, so a wrong length means a
  // malformed stored value rather than anything a caller controls.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** The per-machine credential minted at enrollment. Long enough that it is not
 *  guessable and shaped like the fleet secret it replaces, so
 *  `@frontierjs/toolbelt/signature` signs with it unchanged. */
export function mintOutpostSecret(): string {
  return randomBytes(32).toString('hex')
}

/** A certificate's PEM, or anything else. The one a machine enrolls with is
 *  pinned on its Conduit target, and conduit refuses a pin it cannot parse at
 *  register() — which is a heartbeat, long after the token was spent. */
export function isCertificate(pem: unknown): pem is string {
  if (typeof pem !== 'string' || pem.length > 16_384 || !pem.includes('BEGIN CERTIFICATE')) return false
  try {
    new X509Certificate(pem)
    return true
  } catch {
    return false
  }
}

/**
 * The enrollment answer carries the machine's own key, so the address it is
 * asked of must be https. Loopback is the exception: nothing crosses a network,
 * and it is where a dev API and its Outpost live.
 */
export function assertEnrollsOverTls(basecampUrl: string): void {
  const url = new URL(basecampUrl)
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return
  throw new Error(
    `A machine cannot enroll with ${basecampUrl}: the answer carries its key, so API_URL must be https (FJS-1603)`)
}

/**
 * The install, as one script, and it is the SAME script both ways a machine
 * gets one.
 *
 * A provisioned machine receives it as cloud-init `user_data`, with the four
 * values baked in. An imported machine receives it as a command a person pastes,
 * with the four values on the command line. Two copies of an install is two
 * things to keep in step, and the one nobody ran is the one that rots — which
 * is exactly what happened to the `site/` surface (`FJS-758`).
 *
 * It carries NO credential. The enrollment token is an input, and it is the only
 * secret involved: the box exchanges it, once, inside a short window, for a
 * credential of its own. That is why this can be served unauthenticated at
 * `GET /install.sh` — there is nothing in it worth having.
 *
 * `set -eu` and a failing curl is deliberate: a machine whose enrollment did not
 * happen must not come up looking healthy. The deadline on the Basecamp side is
 * what turns that into a reported failure rather than a silent one.
 *
 * Every shell variable is unbraced on purpose. This is a JavaScript template
 * literal, so a bash `${VAR}` would be read by JS and interpolated away.
 */
export function installScript(): string {
  return `#!/bin/bash
set -euo pipefail

: "$BASECAMP_URL"   # where this machine reports to
: "$SERVER_ID"      # which row it is
: "$ENROLL_TOKEN"   # single-use, short-lived, and the only secret here
OUTPOST_PORT="$OUTPOST_PORT"

# The enrollment answer is this machine's key. Over plain http it crosses the
# network readable by anybody on the path.
case "$BASECAMP_URL" in
  https://*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;;
  *) echo "BASECAMP_URL must be https: the enrollment answer carries this machine's key" >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq curl ca-certificates openssl chrony

# Every signed command is refused past 300 seconds of clock skew, so this
# machine's clock is part of whether it takes commands. chrony replaces
# systemd-timesyncd where the image ships it (the packages conflict), so there
# is one daemon and never two disciplining the same clock.
systemctl enable --now chrony.service

# Docker, from the vendor's signed apt repository: apt verifies every package
# against the key, where a piped script is whatever the site returns today. The
# Outpost runs containers and has no other way to.
. /etc/os-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$ID/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \\
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -yqq docker-ce docker-ce-cli containerd.io

# Caddy, the machine's ingress (FJS-D564). The Outpost is the only thing that
# configures it, through the admin API on localhost:2019, so it runs as the
# package's caddy-api unit: no Caddyfile, and --resume, which reloads the
# config the admin API last saved. That is what puts every route back after
# Caddy restarts on its own; the Outpost keeps no copy to replay. fli deploy
# installs the same unit on the box Basecamp itself runs on (cli
# commands/deploy/_steps-setup/01-check-deps.md), so a change here goes there.
apt-get install -yqq debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \\
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \\
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -yqq caddy
systemctl disable --now caddy.service
systemctl enable --now caddy-api.service

# Bun, which the Outpost is written for, at the version Basecamp holds.
curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# The command port's certificate. Made before the exchange because it rides in
# it: Basecamp pins this one, and a command reaches no port holding any other.
install -d -m 0700 /etc/basecamp
openssl ${OPENSSL_CERT_ARGS.join(' ')} \\
  -keyout /etc/basecamp/outpost.key -out /etc/basecamp/outpost.crt 2>/dev/null
chmod 0600 /etc/basecamp/outpost.key
# One JSON string: every line ends in a literal backslash-n. PEM holds no quote
# and no backslash, so nothing else needs escaping.
CERT=$(awk '{printf "%s\\\\n", $0}' /etc/basecamp/outpost.crt)

# The exchange. This is the only moment the enrollment token is used, and the
# only moment this machine has no credential of its own.
ENROLL=$(curl -fsSL -X POST "$BASECAMP_URL/servers/$SERVER_ID/enroll" \\
  -H 'content-type: application/json' \\
  -d "{\\"token\\":\\"$ENROLL_TOKEN\\",\\"cert\\":\\"$CERT\\"}")

OUTPOST_SECRET=$(echo "$ENROLL" | grep -o '"secret":"[^"]*"' | cut -d'"' -f4)
OUTPOST_PUBLIC_URL=$(echo "$ENROLL" | grep -o '"publicUrl":"[^"]*"' | cut -d'"' -f4)

if [ -z "$OUTPOST_SECRET" ]; then
  echo "enrollment did not return a secret" >&2
  exit 1
fi

cat > /etc/basecamp/outpost.env <<ENVEOF
OUTPOST_SERVER_ID=$SERVER_ID
OUTPOST_SECRET=$OUTPOST_SECRET
OUTPOST_PUBLIC_URL=$OUTPOST_PUBLIC_URL
OUTPOST_PORT=$OUTPOST_PORT
OUTPOST_TLS_CERT=/etc/basecamp/outpost.crt
OUTPOST_TLS_KEY=/etc/basecamp/outpost.key
BASECAMP_URL=$BASECAMP_URL
ENVEOF
chmod 0600 /etc/basecamp/outpost.env

cat > /etc/systemd/system/outpost.service <<UNITEOF
[Unit]
Description=Basecamp Outpost
After=network-online.target docker.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/basecamp/outpost.env
ExecStart=$BUN_INSTALL/bin/bunx --bun @frontierjs/outpost@${OUTPOST_VERSION}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now outpost.service
`
}

/**
 * The cloud-init a provisioned machine boots with — the shared install with its
 * four inputs baked in, because a booting machine has nobody to type them.
 */
export function cloudInit(opts: {
  serverId:    string
  basecampUrl: string
  token:       string
  outpostPort: number
}): string {
  assertEnrollsOverTls(opts.basecampUrl)
  const script = installScript().replace(/^#!\/bin\/bash\n/, '')
  return `#!/bin/bash
BASECAMP_URL=${JSON.stringify(opts.basecampUrl)}
SERVER_ID=${JSON.stringify(opts.serverId)}
ENROLL_TOKEN=${JSON.stringify(opts.token)}
OUTPOST_PORT=${JSON.stringify(String(opts.outpostPort))}
export BASECAMP_URL SERVER_ID ENROLL_TOKEN OUTPOST_PORT
${script}`
}

/**
 * What a person pastes on a machine they already own.
 *
 * The script is fetched unauthenticated and carries nothing; the token rides as
 * an environment variable rather than in the URL, so it stays out of access logs
 * and out of any proxy in between. `sudo env` and not `sudo` alone: sudo drops
 * the environment by default, and the script would then fail on its first line
 * rather than halfway through an install.
 */
export function installCommand(opts: {
  serverId:    string
  basecampUrl: string
  token:       string
  outpostPort: number
}): string {
  assertEnrollsOverTls(opts.basecampUrl)
  return `curl -fsSL ${opts.basecampUrl}/install.sh | sudo env `
    + `BASECAMP_URL=${opts.basecampUrl} `
    + `SERVER_ID=${opts.serverId} `
    + `ENROLL_TOKEN=${opts.token} `
    + `OUTPOST_PORT=${opts.outpostPort} bash`
}
