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

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

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

/**
 * The cloud-init a provisioned machine boots with.
 *
 * Written here rather than in the connector because it is the same script at
 * every cloud — `user_data` is the one thing the vendors agree about. What
 * differs is only how it is handed over, which is the connector's business.
 *
 * It carries the enrollment TOKEN and no other credential, and the app's URL,
 * and nothing else: everything the Outpost needs afterwards comes back in the
 * enrollment response.
 */
export function cloudInit(opts: {
  serverId:    string
  basecampUrl: string
  token:       string
  outpostPort: number
}): string {
  // `set -eu` and a failing curl is deliberate: a machine whose enrollment did
  // not happen must not come up looking healthy. The deadline on the Basecamp
  // side is what turns that into a reported failure rather than a silent one.
  return `#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq curl ca-certificates

# Docker, from the vendor's own script. The Outpost runs containers and has no
# other way to.
curl -fsSL https://get.docker.com | sh

# Bun, which the Outpost is written for.
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# The exchange. This is the only moment the enrollment token is used, and the
# only moment this machine has no credential of its own.
ENROLL=$(curl -fsSL -X POST "${opts.basecampUrl}/servers/${opts.serverId}/enroll" \\
  -H 'content-type: application/json' \\
  -d "{\\"token\\":\\"${opts.token}\\"}")

OUTPOST_SECRET=$(echo "$ENROLL" | grep -o '"secret":"[^"]*"' | cut -d'"' -f4)
OUTPOST_PUBLIC_URL=$(echo "$ENROLL" | grep -o '"publicUrl":"[^"]*"' | cut -d'"' -f4)

if [ -z "$OUTPOST_SECRET" ]; then
  echo "enrollment did not return a secret" >&2
  exit 1
fi

install -d -m 0700 /etc/basecamp
cat > /etc/basecamp/outpost.env <<ENVEOF
OUTPOST_SERVER_ID=${opts.serverId}
OUTPOST_SECRET=$OUTPOST_SECRET
OUTPOST_PUBLIC_URL=$OUTPOST_PUBLIC_URL
OUTPOST_PORT=${opts.outpostPort}
BASECAMP_URL=${opts.basecampUrl}
ENVEOF
chmod 0600 /etc/basecamp/outpost.env

cat > /etc/systemd/system/outpost.service <<UNITEOF
[Unit]
Description=Basecamp Outpost
After=network-online.target docker.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/basecamp/outpost.env
ExecStart=$BUN_INSTALL/bin/bunx --bun @frontierjs/outpost
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now outpost.service
`
}
