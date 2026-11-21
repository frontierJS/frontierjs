# Enrolling a machine

Enrolling puts Outpost on a box and joins it to a Basecamp's fleet. `fli outpost:install` does it over ssh with one single-use command Basecamp issues, then waits for the machine's first heartbeat.

```bash
fli outpost:install box1 --basecamp ops --name eu-1
fli outpost:status box1       # one screen read off the box's own Outpost
fli outpost:status            # a line per box in the fleet
```

The install ends when the Server row reads `online`, since a machine listed with no Outpost answering is a release that looks green and runs nothing.

## What else it can do

- The Servers screen prints the same enrollment command for a person to paste on a box
- A box Basecamp bought enrolls itself from cloud-init
- The box installs docker, caddy, bun and the Outpost, and the enrollment token travels on bash's stdin, never in argv
- The Basecamp and its key come from `~/.config/fli/basecamps.json`, filed by `fli basecamp:key`
- The key needs `servers:write`, and issuing an enrollment is an administrator's act
- Enrollment travels over https only
- The machine makes its own Ed25519 pair and its own TLS certificate, and Basecamp pins that certificate
- A new Server row is `pending` with no heartbeat until its Outpost reports in
- Outpost refuses to start without `OUTPOST_SERVER_ID`, `OUTPOST_SIGNING_KEY`, `OUTPOST_HUB_KEY`, `BASECAMP_URL`, `OUTPOST_TLS_CERT` and `OUTPOST_TLS_KEY`
- `fli outpost:logs box1 [app-or-unit]` reads an app's container logs or a unit's journal
- `sudo outpost-uninstall` on the box takes Outpost off and leaves the apps running
- `--purge` also removes the apps, every Docker volume, Docker and Caddy, and asks you to type `purge`
- The Server row stays in Basecamp until a person removes it there

**In depth:** [Outpost README § Running one](../../../../outpost/README.md#running-one), [§ Taking one off](../../../../outpost/README.md#taking-one-off), [§ The protocol](../../../../outpost/README.md#the-protocol), [outpost:install](../../../../cli/commands/outpost/install.md)
