# Releasing from Basecamp

A release from Basecamp is a click, not a command you type on the machine. A job sends signed commands to the enrolled Outpost, which builds or pulls the image, starts it and answers the digest of what it built. Basecamp records that digest on the deployment and addresses every later step by it.

```bash
fli tutor:fleet --tmp --yes
```

The lesson starts a control plane, adds a Server row, enrolls a real Outpost on this machine, runs a command there and releases an image. It needs a framework checkout, and Docker for the last step.

## What else it can do

- Each command is signed with method, path, timestamp, nonce and a hash of the body, so it cannot be replayed or moved
- `POST /pull` fetches an image and answers its digest, and `POST /deploy` starts a container of exactly those bytes
- `POST /build` clones the app with its own deploy key and builds on the machine
- `/deploy` answers once the release is healthy and puts the old one back when it is not
- Only `sha256:<64 hex>` counts as a digest, because a tag is a name two builds can share
- An App whose source is files is released by writing them under their own sha256 and swapping one symlink
- `fli basecamp:app` makes the current app an App in Basecamp, placed on a server
- `fli basecamp:deploy --app <app-id>` builds here, loads the image on each machine and releases that digest
- `fli basecamp:live` says why an App is not live: its release, its machine, then each hostname's DNS and HTTPS
- `fli outpost:logs <box> <app>` reads the container's logs

**In depth:** [Outpost README § Where the bytes come from](../../../../outpost/README.md#where-the-bytes-come-from), [tutor:fleet](../../../../cli/commands/tutor/fleet.md), [Quickstart](../../../../../docs/QUICKSTART.md)
