# A release

A release is the bytes a deploy builds, an image, plus the configuration it ran with, recorded in a journal on the machine it went to. `fli deploy` builds the image over SSH, starts it, waits for the health check, and writes the result into that journal.

```bash
fli make:deploy --server myapp.com --domain myapp.com   # Dockerfile + a deploy block in frontier.config.js
fli deploy:local                                        # build, run and health-check the image here first
fli deploy:setup                                        # check the server, install what is missing
fli deploy --production                                 # build, ship, swap, record
```

## What else it can do

- `fli deploy` with no flag picks the target from the git branch: `stage` or `staging` is stage, anything else is dev
- `--production` and `--stage` pick the target; `--api` and `--web` ship one half; `--dry` and `--plan` show the run without doing it
- `--resume` continues a deploy a previous run did not finish
- A release id is content-addressed, so an unchanged redeploy is the same release and a changed one is a new release
- `deploy.builder` builds the image once on one machine and ships it to every target
- A `server` of `localhost` runs the same pipeline against this machine, which is what the lesson uses
- An app with `BASECAMP_APP_ID` set is released through its Basecamp: `fli deploy` runs `fli basecamp:deploy` for it
- `fli tutor:deploy` is the lesson that runs all of this for real: a deploy, a change, a second deploy and a revert, needing Docker and git

**In depth:** [deploy:all](../../../../cli/commands/deploy/index.md), [deploy:local](../../../../cli/commands/deploy/local.md), [tutor:deploy](../../../../cli/commands/tutor/deploy.md), [QUICKSTART](../../../../../docs/QUICKSTART.md)
