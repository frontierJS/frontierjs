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
import { litestreamInstall } from '@frontierjs/litestone/replicate'

/** What the install runs on a machine, held here so two machines provisioned a
 *  week apart run the same thing. The Outpost is pinned to the version this
 *  workspace carries (a test holds the two together); Docker and Caddy come
 *  from signed apt repositories. */
export const BUN_VERSION     = '1.4.4'
export const OUTPOST_VERSION = '0.1.5'

/** How long a machine has to enroll. A cloud-init run is seconds; fifteen
 *  minutes is room for a slow image pull and nothing like room for a leaked
 *  metadata blob to be useful tomorrow. */
export const ENROLL_WINDOW_MS = 15 * 60 * 1000

/** The port an outpost listens on. `packages/cli/core/ports.js` — project 8
 *  (outpost), backend. It reaches a machine in the cloud-init a provisioned box
 *  boots with and in the command a person pastes, and two literals is two
 *  places for them to disagree. */
export const OUTPOST_PORT = 8180

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
    `A machine cannot enroll with ${basecampUrl}: the answer carries its key, so FRONTIER_API_URL must be https (FJS-1603)`)
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
# set -e exits without a word, and over ssh only this line says where.
trap 'echo "install stopped at line $LINENO: $BASH_COMMAND" >&2' ERR

# The security pass below can upgrade systemd, which re-executes it, and a
# systemctl call that lands in the re-exec is refused by the bus rather than
# queued (FJS-3469). A refusal is retried for two minutes; any other failure is
# the call's own.
systemctl() {
  local n=0 out
  until out=$(command systemctl "$@" 2>&1); do
    case $out in
      *"message bus"*|*"Connection reset"*|*"Transport endpoint"*|*"Failed to connect to bus"*) ;;
      *) printf '%s\\n' "$out" >&2; return 1 ;;
    esac
    n=$((n + 1))
    [ $n -lt 24 ] || { printf '%s\\n' "$out" >&2; return 1; }
    sleep 5
  done
  printf '%s' "$out"
}
export -f systemctl

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

# apt-daily and unattended-upgrades take apt's locks on their own clock, and a
# box that has been up a while is often mid-run. A run in progress is waited
# out first, bounded: under cloud-init a queued apt-daily can be waiting on this
# very script. DPkg::Lock::Timeout then covers dpkg's lock and nothing else: an
# update meeting the lists lock fails at once, so it is tried again.
timeout 600 systemd-run --quiet --wait --property=After=apt-daily.service --property=After=apt-daily-upgrade.service true || true
apt_update() {
  for attempt in 1 2 3 4 5 6; do
    apt-get -o DPkg::Lock::Timeout=300 update -qq && return 0
    echo "apt-get update failed (attempt $attempt of 6) — trying again in 20s" >&2
    sleep 20
  done
  return 1
}
apt_install() { apt-get -o DPkg::Lock::Timeout=300 install -yqq "$@"; }

apt_update
apt_install curl ca-certificates openssl chrony nftables unattended-upgrades

# Every signed command is refused past 300 seconds of clock skew, so this
# machine's clock is part of whether it takes commands. chrony replaces
# systemd-timesyncd where the image ships it (the packages conflict), so there
# is one daemon and never two disciplining the same clock.
# posture: time.synced
systemctl enable --now chrony.service

# Each step below is graded by the control its marker names (core/posture.ts),
# so the box this builds is the box the posture tab expects.

# Security updates apply themselves and never reboot the machine: a reboot
# takes down every app placed here, so it waits for a person. The origins are
# cleared first because the image's own list also takes point releases, and
# Docker and Caddy come from origins not named here, so neither moves alone.
# posture: patch.auto-updates-on
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APTEOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APTEOF
cat > /etc/apt/apt.conf.d/52basecamp-unattended-upgrades <<'APTEOF'
#clear Unattended-Upgrade::Allowed-Origins;
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=\${distro_codename}-security,label=Debian-Security";
  "origin=Ubuntu,archive=\${distro_codename}-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
APTEOF
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer

# The timer's first pass can be a day out, and an image ships weeks of security
# updates behind, so the box would enroll exposed. The pass the timer runs, run
# now, so its stamp is the last run posture reports. A failed or slow pass
# leaves the box to the timer; patch.security-pending says so.
# posture: patch.security-pending
echo "Applying pending security updates: several minutes on a fresh image"
timeout 1800 systemctl start apt-daily-upgrade.service \
  || echo "the first security-update pass did not finish; apt-daily-upgrade.timer will retry" >&2
# A pass that upgrades systemd re-executes it, which ends the wait above while
# unattended-upgrade still holds dpkg's lock, and every apt call below then
# spends its lock timeout on it (FJS-3469).
timeout 1800 bash -c 'while [ "$(systemctl show -P ActiveState apt-daily-upgrade.service)" = activating ]; do sleep 5; done' || true

# sshd takes the first value it reads and the drop-ins are read in name order,
# so 10- wins over the 50-cloud-init.conf that turns passwords back on. A box
# no key can reach keeps its password rather than locking its owner out, and
# its posture says so.
# posture: ssh.password-off
# posture: ssh.root-key-only
if { cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null || true; } | grep -q '^[^#[:space:]]'; then
  cat > /etc/ssh/sshd_config.d/10-basecamp.conf <<'SSHEOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
SSHEOF
  # Where ssh is socket-activated, a security pass that upgraded openssh leaves
  # ssh.service stopped until the next login, and its /run/sshd with it, so
  # sshd -t and sshd -T refuse a config that is fine.
  install -d -m 0755 /run/sshd
  sshd -t
  systemctl try-reload-or-restart ssh.service
else
  echo "no authorized ssh key on this machine: password login is left on" >&2
fi

# Inbound is dropped unless it is ssh, the web, or the Outpost's two ports. Its
# own table, never a flush: Docker's rules share this nftables, and a flush
# takes every container's networking with it. The ssh ports are read off sshd
# rather than assumed, because an imported box may not listen on 22.
#
# A published container port is DNAT'd and forwarded, never input, so the input
# policy does not reach it. The forward chain drops a DNAT'd connection unless
# its host port is in the exposed set, which the Outpost refills from its
# containers on every deploy and at start: the ports apps declare are not known
# here. Its priority runs it before Docker's own chains, and a drop in any base
# chain is final whatever another accepts. A container's own egress and a
# loopback-published port are never DNAT'd from outside, so neither is touched.
# posture: net.firewall-default-deny
SSH_PORTS=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | paste -sd, -) || true
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
install -d -m 0700 /etc/basecamp
cat > /etc/basecamp/firewall.nft <<NFTEOF
table inet basecamp
delete table inet basecamp
table inet basecamp {
  set exposed {
    type inet_service
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    ct state invalid drop
    iif lo accept
    meta l4proto { icmp, ipv6-icmp } accept
    udp dport { 68, 546 } accept
    tcp dport { $SSH_PORTS, 80, 443, $OUTPOST_PORT } accept
    udp dport 443 accept
  }
  chain forward {
    type filter hook forward priority -1; policy accept;
    ct state established,related accept
    iifname "docker0" accept
    iifname "br-*" accept
    ct status dnat meta l4proto { tcp, udp } ct original proto-dst @exposed accept
    ct status dnat drop
  }
}
NFTEOF
cat > /etc/systemd/system/basecamp-firewall.service <<UNITEOF
[Unit]
Description=Basecamp host firewall
DefaultDependencies=no
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/basecamp/firewall.nft

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable --now basecamp-firewall.service

# Docker, from the vendor's signed apt repository: apt verifies every package
# against the key, where a piped script is whatever the site returns today. The
# Outpost runs containers and has no other way to.
. /etc/os-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$ID/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \\
  > /etc/apt/sources.list.d/docker.list
apt_update
# Written before the install so the daemon's first start reads it. With the
# proxy on, a published port is a nat rule AND a docker-proxy process, and the
# firewall above grades only the rule. Off, it is the one rule, a loopback
# publish included: dockerd sets route_localnet on docker0 and drops spoofed
# 127/8 itself.
install -d -m 0755 /etc/docker
cat > /etc/docker/daemon.json <<'DOCKEREOF'
{
  "userland-proxy": false
}
DOCKEREOF
apt_install docker-ce docker-ce-cli containerd.io

# Caddy, the machine's ingress (FJS-D564). The Outpost is the only thing that
# configures it, through the admin API on localhost:2019, so it runs as the
# package's caddy-api unit: no Caddyfile, and --resume, which reloads the
# config the admin API last saved. That is what puts every route back after
# Caddy restarts on its own; the Outpost keeps no copy to replay. fli deploy
# installs the same unit on the box Basecamp itself runs on (cli
# commands/deploy/_steps-setup/01-check-deps.md), so a change here goes there.
apt_install debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \\
  | gpg --dearmor --batch --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \\
  > /etc/apt/sources.list.d/caddy-stable.list
apt_update
apt_install caddy
systemctl disable --now caddy.service
# That unit ran the package's default Caddyfile and autosaved its :80 server,
# which --resume would load back beside every route the Outpost writes.
systemctl is-enabled --quiet caddy-api.service || rm -f /var/lib/caddy/.config/caddy/autosave.json
systemctl enable --now caddy-api.service

# Litestream, which replicates every app's SQLite to its bucket: litestone's
# pinned, checksum-verified build, the one fli deploy:setup installs. Its own
# unit, outside the Outpost's sandbox, because it writes into every app's
# volume. The Outpost rewrites the config from Basecamp's list and restarts the
# unit; until then it names no database, which 0.5 logs and runs on through.
# It holds every app's bucket key and reads every app's database, so it is
# sandboxed like the Outpost: it writes the volumes and /var/lib/litestream,
# where each database's meta-dir goes so a /backup tar does not carry it. Its
# control socket is under /run/litestream, which the Outpost reads each
# heartbeat for every app's last sync.
${litestreamInstall()}
# A second install keeps the Outpost's entries: the file holds every app's key.
if [ ! -f /etc/basecamp/litestream.yml ]; then
  cat > /etc/basecamp/litestream.yml <<'LSEOF'
socket:
  enabled: true
  path: "/run/litestream/litestream.sock"
dbs: []
LSEOF
fi
chmod 0600 /etc/basecamp/litestream.yml
cat > /etc/systemd/system/basecamp-litestream.service <<UNITEOF
[Unit]
Description=Basecamp Litestream replication
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/litestream replicate -config /etc/basecamp/litestream.yml
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=-/var/lib/docker/volumes
StateDirectory=litestream
RuntimeDirectory=litestream
RuntimeDirectoryMode=0700
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
PrivateDevices=yes
RestrictRealtime=yes
RestrictNamespaces=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable --now basecamp-litestream.service

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

OUTPOST_SECRET=$(echo "$ENROLL" | grep -o '"secret":"[^"]*"' | cut -d'"' -f4 || true)
OUTPOST_PUBLIC_URL=$(echo "$ENROLL" | grep -o '"publicUrl":"[^"]*"' | cut -d'"' -f4 || true)

if [ -z "$OUTPOST_SECRET" ]; then
  echo "enrollment did not return a secret" >&2
  exit 1
fi

# publicUrl is null for a row Basecamp holds no address for — its own box,
# enrolled by fli deploy or the Use this Basecamp server button. This box
# answers on its default route's source address, and a Basecamp running on it
# reaches it there.
if [ -z "$OUTPOST_PUBLIC_URL" ]; then
  SELF_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)
  if [ -z "$SELF_IP" ]; then
    echo "enrollment named no address for this machine, and it has no default route to take one from" >&2
    exit 1
  fi
  OUTPOST_PUBLIC_URL="https://$SELF_IP:$OUTPOST_PORT"
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

# The sandbox bounds what a flaw in any route can write to the Outpost's own
# directories (its apps and static origin, the cert, bun's cache) and keeps it
# from gaining privilege. It is root still, because Docker access is
# root-equivalent and a non-root User= would buy nothing. The /exec route leaves
# the unit through systemd-run (FJS-D602), so a recipe is not confined by it.
# posture() grades this unit's own systemd-analyze score against 7, so a
# directive dropped here fails outpost.sandbox on every box. AF_NETLINK stays:
# posture reads ss and nft over it. No MemoryDenyWriteExecute: bun's JIT
# needs writable executable pages.
# StateDirectory creates /var/lib/outpost before the namespace is built: a
# ReadWritePaths entry that does not exist yet fails the start on a fresh box.
# ExecStart is bun x, never bunx: bun's installer writes the bun binary alone,
# and a unit naming a file that is not there exits 203/EXEC on every restart.
# posture: outpost.sandbox
cat > /etc/systemd/system/outpost.service <<UNITEOF
[Unit]
Description=Basecamp Outpost
After=network-online.target docker.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/basecamp/outpost.env
ExecStart=$BUN_INSTALL/bin/bun x --bun @frontierjs/outpost@${OUTPOST_VERSION}
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
ReadWritePaths=/var/lib/outpost /etc/basecamp $BUN_INSTALL -$HOME/.docker
StateDirectory=outpost
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
PrivateDevices=yes
RestrictRealtime=yes
RestrictNamespaces=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
UNITEOF

# The way back off, written by the install that put the Outpost on, so it is
# here whatever becomes of the Basecamp that enrolled this machine.
cat > /usr/local/sbin/outpost-uninstall <<'UNINSTALLEOF'
${uninstallScript()}UNINSTALLEOF
chmod 0755 /usr/local/sbin/outpost-uninstall

systemctl daemon-reload
systemctl enable --now outpost.service
`
}

/**
 * The install undone — written onto the box by `installScript` as
 * `/usr/local/sbin/outpost-uninstall`, which is the only way it is run.
 *
 * Bare, it takes off the Outpost and what exists only for it: the unit, the
 * machine's credential and certificate, the Litestream unit whose config the
 * Outpost wrote, and the firewall, whose forward chain drops a published port
 * nothing refills the exposed set for once the Outpost is gone. The apps it
 * placed keep running. `--purge` takes the rest: those apps and their volumes,
 * `/var/lib/outpost` with its backups, Docker, Caddy with every route and
 * certificate, the Docker and Caddy apt sources, the Litestream binary and the
 * Outpost's bun.
 *
 * What would be worse undone stays, and the script ends by naming it: the sshd
 * drop-in (gone, cloud-init's password login comes back), chrony (gone, the
 * image may have no time sync left) and security updates.
 *
 * The Server row is Basecamp's: the box stops heartbeating, and removing it is
 * a person's act there.
 *
 * Embedded in a quoted heredoc, so nothing here is expanded at install time,
 * and no line may read UNINSTALLEOF.
 */
export function uninstallScript(): string {
  return `#!/bin/bash
set -euo pipefail

PURGE=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes)   YES=1 ;;
    *) echo "usage: outpost-uninstall [--purge [--yes]]" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root: sudo outpost-uninstall" >&2; exit 1; }

UNIT=/etc/systemd/system/outpost.service
# Where the install put bun, read off the unit before the unit goes.
BUN_BIN=$(awk -F= '$1 == "ExecStart" { split($2, w, " "); print w[1] }' $UNIT 2>/dev/null || true)
BUN_DIR=
[ -n "$BUN_BIN" ] && BUN_DIR=$(dirname "$(dirname "$BUN_BIN")")

if [ $PURGE = 1 ] && [ $YES = 0 ]; then
  HELD=$(docker ps -a --format '{{.Names}}' 2>/dev/null | paste -sd' ' - || true)
  echo "--purge removes every container on this machine ($HELD), every Docker volume,"
  echo "Caddy with every route and certificate, and /var/lib/outpost with its backups."
  if [ -t 0 ]; then
    read -r -p "Type purge to go on: " ANSWER
    [ "$ANSWER" = purge ] || { echo "nothing removed" >&2; exit 1; }
  else
    echo "no terminal to confirm on: pass --yes" >&2
    exit 1
  fi
fi

# The agent first: a running Outpost refills the exposed set and rewrites routes.
systemctl disable --now outpost.service 2>/dev/null || true
systemctl disable --now basecamp-litestream.service 2>/dev/null || true
systemctl disable --now basecamp-firewall.service 2>/dev/null || true
nft delete table inet basecamp 2>/dev/null || true
rm -f $UNIT /etc/systemd/system/basecamp-litestream.service /etc/systemd/system/basecamp-firewall.service
rm -rf /etc/systemd/system/basecamp-litestream.service.d
rm -rf /etc/basecamp
systemctl daemon-reload
echo "Outpost removed: its unit, its credential, its firewall and its Litestream, so no app here replicates."

# The 80/20 line: what is cheap to keep and worse to undo is named, not undone.
left() {
  echo
  echo "Left on purpose -- remove by hand if you want them gone:"
  echo "  Basecamp       this machine's Server row; remove it under Servers"
  echo "  ssh hardening  /etc/ssh/sshd_config.d/10-basecamp.conf; removing it can turn password login back on"
  echo "  time sync      chrony, which replaced systemd-timesyncd"
  echo "  auto-updates   unattended-upgrades and /etc/apt/apt.conf.d/20auto-upgrades"
  echo "  firewall       gone with the Outpost; this box now takes inbound on every port it listens on"
}

if [ $PURGE = 0 ]; then
  echo "Its apps, their data, Docker, Caddy and /var/lib/outpost are left: outpost-uninstall --purge removes them."
  left
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  docker ps -aq | xargs -r docker rm -f >/dev/null || true
  docker volume ls -q | xargs -r docker volume rm >/dev/null || true
fi
rm -rf /var/lib/outpost

systemctl disable --now caddy-api.service 2>/dev/null || true
export DEBIAN_FRONTEND=noninteractive
apt-get purge -yqq caddy docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 || true
rm -rf /var/lib/docker /var/lib/containerd /etc/docker /var/lib/caddy /etc/caddy
rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc
rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
rm -f /etc/apt/apt.conf.d/52basecamp-unattended-upgrades
rm -rf /usr/local/bin/litestream /var/lib/litestream

[ -n "$BUN_DIR" ] && [ "$BUN_DIR" != /usr/local ] && rm -rf "$BUN_DIR"
rm -f /usr/local/sbin/outpost-uninstall
echo "Purged: apps, volumes, Docker, Caddy, Litestream, /var/lib/outpost and the Outpost's bun."
left
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
 * The script is fetched unauthenticated and carries nothing. The four inputs go
 * ahead of it on bash's stdin, never in the URL (an access log, a proxy) and
 * never in sudo's argv, which sudo writes to the system journal; `echo` is a
 * shell builtin, so no process argv holds the token either.
 */
export function installCommand(opts: {
  serverId:    string
  basecampUrl: string
  token:       string
  outpostPort: number
}): string {
  assertEnrollsOverTls(opts.basecampUrl)
  return `{ echo export `
    + `BASECAMP_URL=${opts.basecampUrl} `
    + `SERVER_ID=${opts.serverId} `
    + `ENROLL_TOKEN=${opts.token} `
    + `OUTPOST_PORT=${opts.outpostPort}; `
    + `curl -fsSL ${opts.basecampUrl}/install.sh; } | sudo bash`
}
