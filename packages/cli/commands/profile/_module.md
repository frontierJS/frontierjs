---
title: profile
description: One client's account keys per file — make, list and open this machine's fli profiles
---

A profile is `~/.config/fli/profiles/<name>.env`: one client's account keys
(GitHub, DigitalOcean, Cloudflare, …), kept at mode 600 (`FJS-D1942`). A
project spends one by naming it in its own `.env` — `FLI_PROFILE=<name>` — and
loads it between that `.env` and the global env (`docs/configuration.md`
§ Profiles).

| Command | What it does |
| --- | --- |
| `fli profile:create <name>` | → the empty file, at mode 600 |
| `fli profile:list` (`fli profiles`) | every profile, its key names, the projects naming it |
| `fli profile:open <name>` | the file in `$VISUAL`, else `$EDITOR` |
| `fli eset <KEY> <value> --profile <name>` | one key into it |

**There is no `profile:use`.** A current profile remembered on the machine
would make one directory spend whichever client was picked last, so the
project's `.env` is the only thing that picks (`FJS-D1943`); `profile:use`
refuses and says so.
