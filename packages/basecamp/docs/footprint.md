# Footprint — what a Basecamp box spends

What Basecamp and the Apps beside it cost in memory, measured on a real box. There is no
stated minimum yet; this is the evidence one will be set from. Re-measure before quoting a
number from here as current.

## Measured — yuma, 2026-11-04

DigitalOcean, 2 vCPU, 3.9 GB, no swap. Up 2 days 15 h, idle (load 0.01). Running Basecamp,
one App (kapp) as two containers, Outpost and Caddy.

| Unit | Memory (cgroup `anon`) |
| ---- | ---------------------- |
| `frontier-basecamp` container | 138 MB |
| kapp containers (two) | 64 + 54 MB |
| `docker.service` | 77 MB |
| `containerd.service` | 34 MB |
| `caddy-api.service` | 15 MB |
| `outpost.service` | 11 MB |
| `basecamp-litestream.service` | 6 MB |
| Whole box, `free -m` | 940 MB used, 2,974 MB available |

Read as: about 300 MB of fixed cost (Basecamp + the Docker runtime + Outpost and Caddy),
then about 60 MB per small App container. The OS and kernel make up the rest of the 940 MB.
No kernel OOM line in the 3 days before the reading.

## What this does not cover yet

- **A build's peak.** A git-sourced Release builds on the box: Outpost runs `vite build`
  and `docker build` there (`packages/outpost/src/docker.js`, the `vite build` and
  `docker build` calls). That peak is unmeasured and is the likeliest thing to exhaust a
  small box.
- **A start-first swap.** Old and new containers of one App run together until the cutover
  (`FJS-D1840`), so that App's share doubles briefly.
- **CPU and disk.** Only memory was read.

## How to read it again

Memory is read as cgroup v2 `memory.stat` `anon` per systemd unit, not RSS: RSS counts
bun's mapped binary once per process and read Outpost at 58 MB where its private memory
was 10 MB (`FJS-D1824`). On the box:

```sh
free -m
for u in /sys/fs/cgroup/system.slice/*.s*/memory.stat; do
  n=$(basename $(dirname $u)); a=$(awk '/^anon /{print $2}' $u)
  [ "${a:-0}" -gt 5000000 ] && echo "$((a/1048576)) MB  $n"
done | sort -rn
docker ps --no-trunc --format '{{.ID}} {{.Names}}'   # names the docker-<id>.scope rows
```

The Health card on `/hub` shows the same breakdown, grouped, from Outpost's heartbeat.
