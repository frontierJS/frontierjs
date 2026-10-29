---
namespace: server
description: A box at a cloud — buy one, list them, power one off, destroy it
---

<script>
const { CLOUDS, cloudLabel, pickCloud, cloudsToRead, listBoxes, cloudOf, runProvision, withHosts, hostRecord,
  publicKey, boxName, buyBox, machineLine } = await import(new URL('file://' + global.fliRoot + '/core/cloud.js'))
</script>

A Server is a place (`FJS-D29`): one machine at a cloud, bought here with your
SSH key on it and nothing else. What goes on it is another command's — `fli
deploy:setup` from an app's directory puts that app on it, `fli outpost:install`
makes it a machine of a Basecamp's fleet, and `fli basecamp:install` puts
Basecamp itself on it. `fli basecamp:create` is `server:create` and
`basecamp:install` in one run.

The vendor's dialect is Basecamp's compute connector, run in place
(`FJS-D1253`), so these commands need the framework checkout fli runs from.

## Setup

`create`, `stop`, `destroy` and the bare `fli server` list need a cloud's API
token in your global fli env. `--cloud` names the cloud; without it the one
whose token is stored is used, and with both stored a terminal is asked which.
A first run at a terminal with neither asks which cloud, opens the page its
token is made on, takes the paste and stores it.

The token is shown once; a project `.env` overrides the global one, for a
client's own account.

### DigitalOcean — `DIGITALOCEAN_TOKEN`

- Made at https://cloud.digitalocean.com/account/api/tokens/new
- **Full Access**, or **Custom Scopes**: `droplet` create/read/delete, `ssh_key` create/read, `tag` create, `regions` `sizes` `image` read, `reserved_ip` create/read/delete
- **For Basecamp too** — the same token as a cloud account in Basecamp (Secrets, kind `provider_key`) — add `account` read: Basecamp's Verify reads `/v2/account`, and a token without it is refused there
- A reserved IP bills $5/mo while no droplet holds it
- `fli eset DIGITALOCEAN_TOKEN <token> --global`

### Hetzner — `HETZNER_TOKEN`

- Made per project: https://console.hetzner.cloud/projects, open the project, then **Security → API tokens → Generate**, **Read & Write**
- The token reaches that project only, so the box is bought in it
- A Primary IPv4 bills €0.50/mo plus VAT whether or not a server holds it
- `fli eset HETZNER_TOKEN <token> --global`

### Cloudflare — `CLOUDFLARE_TOKEN`

Optional here: with one, `fli server` ends each row in the hostname whose A
record points at the box. The token and what it needs are `fli basecamp`'s
Setup.

## What it makes

One box, marked `basecamp` at its cloud, carrying your SSH public key and
nothing else — the list reads it as `bare`. A box an app is deployed to stays
bare in the list, since the cloud is not told; one `fli outpost:install`
enrolled names its server, and one `fli basecamp:install` installed reads
`Basecamp host`.
