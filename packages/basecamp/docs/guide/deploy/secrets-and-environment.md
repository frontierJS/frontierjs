# Secrets and environment

`fli deploy:setup` seeds the server's env file once from your local `.env.production`, and from then on the copy on the server is yours to edit. The `env:` commands read and write env files on your side, and `fli env:push` sends keys to the target.

```bash
fli deploy:setup            # first run seeds the server's env file from .env.production
fli epush STRIPE_KEY --dry  # which keys would reach the target, never their values
fli epush STRIPE_KEY        # add the key to the server's env file
```

## What else it can do

- `deploy:setup` never overwrites an env file the server already holds, and writes it at mode 600
- `ENCRYPTION_KEY` goes to its own file on the server at mode 400, not into the env file, and setup makes one in your local file when neither side has one
- A deploy writes no env file on the target; it passes the `deploy.configuration` values of `frontier.config.js` to the container
- A key named in `deploy.secrets` is checked for presence in the server's env file and is never applied by a deploy
- `fli epush` leaves a key the target holds with another value alone and names it; `--overwrite` replaces it
- With `BASECAMP_APP_ID` set, `fli epush` writes the App's Variables in Basecamp instead
- `fli eset`, `eget`, `elist` and `edel` change and read a local env file; `--global` uses `~/.config/fli/.env`
- `fli elist` masks values unless you pass `--values`
- `fli ecopy` writes `.env.example` with the values stripped, safe to commit
- `fli epull --from` fetches variables from `url`, `gist`, `ssh`, `file`, `vaultwarden` or `send`
- `fli esend` shares keys as a one-read Vaultwarden Send link

**In depth:** [deploy:setup](../../../../cli/commands/deploy/setup.md), [env:push](../../../../cli/commands/env/push.md), [env:pull](../../../../cli/commands/env/pull.md), [env:send](../../../../cli/commands/env/send.md)
