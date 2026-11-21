# Redeploying and reverting

Run `fli deploy` again to ship a new release; the journal on the machine records each attempt and which one is serving. To go back, `fli deploy:revert` restores a release and the configuration it ran with, and `fli deploy:rollback` puts the previous container or image back.

```bash
fli deploy:journal                 # what was deployed, and which release is serving
fli deploy:revert --plan           # what a revert would do and refuse, touching nothing
fli deploy:revert                  # restore the previous release and its configuration
```

## What else it can do

- `fli deploy:journal --steps` shows the steps of the latest transition, `--transition <id>` one by id, `--limit` how many to list and `--json` emits rows
- The `serving` mark sits on the latest transition that succeeded, so a failed deploy leaves the previous release marked
- `fli deploy:revert --to <release id>` goes to a named release instead of the one before
- A revert is a transition of its own, so a revert can itself be reverted
- `fli deploy:revert` refuses by name, prints every refusal at once, and names the flag that overrides each: `--past-pivot`, `--past-retention` and `--onto-current-configuration`
- `fli deploy:rollback` restores the replaced container, or offers the previous image when there is none, with no journal, and works on a target that never deployed through a journal
- `fli deploy:rollback --web` or `--api` rolls back one half, and `--dry` shows the run
- Revert restores the pair, a release and its configuration; rollback restores only the image

**In depth:** [deploy:journal](../../../../cli/commands/deploy/journal.md), [deploy:revert](../../../../cli/commands/deploy/revert.md), [deploy:rollback](../../../../cli/commands/deploy/rollback.md)
