# Status and logs

`fli deploy:status` shows what is running on the target, and `fli deploy:logs` shows the API container's log. Both read the target the git branch names, or `--production` and `--stage`.

```bash
fli deploy:status --production
fli deploy:logs --production --follow
fli deploy:doctor --remote
```

## What else it can do

- `deploy:status` prints the API container, its state, image, start time and a health check, then the pause state
- `deploy:logs --tail 100` sets how many lines to show, 50 by default, and `--follow` streams until Ctrl+C
- `deploy:doctor` checks readiness locally; `--remote` adds server-side probes and `--json` prints each check as a row
- `fli deploy:pause` makes Caddy answer 503 for the app's routes while the container keeps running, and records who paused it in the journal
- Pausing also drains the Caravan queues in the running container, and `deploy:unpause` resumes the ones the deploy paused
- A deploy while paused is supported and the app stays paused
- `deploy:status` prints what the journal says and what the edge is doing, and flags a difference between them
- `fli deploy:retire` takes the app off the server, container, images, Caddy routes, Outpost and the deploy root with its database
- `deploy:retire --keep-data` leaves the database directory and the env file, and a person confirms every run

**In depth:** [deploy:status](../../../../cli/commands/deploy/status.md), [deploy:logs](../../../../cli/commands/deploy/logs.md), [deploy:doctor](../../../../cli/commands/deploy/doctor.md), [deploy:pause](../../../../cli/commands/deploy/pause.md), [deploy:unpause](../../../../cli/commands/deploy/unpause.md), [deploy:retire](../../../../cli/commands/deploy/retire.md)
