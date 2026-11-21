# Provisioning a server

`fli server:create` buys one box at DigitalOcean or Hetzner with your SSH key on it, prints its address and can add an ssh `Host` for it. It installs nothing: what goes on the box is a later command's.

```bash
fli server:create --cloud hetzner --size 8gb --name box1
fli server                  # the boxes fli made, with the id the next two take
fli server:stop <id>        # power off
fli server:destroy <id>     # refused until the box is off
```

At a terminal the answers are shown together and one last key buys the box or leaves it. The run ends on the three commands that put something there: `fli deploy:setup`, `fli outpost:install` and `fli basecamp:install`.

## What else it can do

- The token comes from `DIGITALOCEAN_TOKEN` or `HETZNER_TOKEN`, stored with `fli eset <NAME> <token> --global`
- `--yes` answers every question and still needs `--name`, and `--cloud` unless exactly one token is stored
- `--size` takes a memory (`4gb`, `8gb`) or the cloud's own slug, and `--region`, `--image` and `--key` override the defaults
- A reserved IP is held by default so a replacement box keeps the address, and `--no-reserved-ip` skips it
- A reserved IP bills at the cloud's rate until released, and `fli server:destroy --release-ip` releases it
- `fli server:destroy` refuses a box `server:create` did not make and any fleet machine, which is destroyed in Basecamp
- `fli basecamp:create` is `server:create` and `basecamp:install` in one run
- Basecamp's own Servers screen can provision a machine too, at `/servers/provision`
- Basecamp's spend guard refuses a POST or DELETE to a cloud unless the address is loopback, `NODE_ENV=production` or `ALLOW_CLOUD_SPEND=1`
- `fli server:create --json` prints the answer as JSON

**In depth:** [server:create](../../../../cli/commands/server/create.md), [server module](../../../../cli/commands/server/_module.md), [Provisioning plan](../../provisioning.md)
