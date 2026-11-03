---
namespace: outpost
description: The Outpost — the process a fleet machine runs for its Basecamp
---

<script>
const { basecamp, basecampAll, installOutpost, readOutpost } = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))
const { boxAddress, markServer }   = await import(new URL('file://' + global.fliRoot + '/core/cloud.js'))
const { createMachine }            = await import(new URL('file://' + global.fliRoot + '/core/machine.js'))
</script>

An Outpost is what a machine runs to be a member of a Basecamp's fleet: it
checks in, and runs the Docker commands a release sends. It is not an app, and
it is installed by one command Basecamp issues for one machine, carrying a
single-use token — the Servers page prints it for a person to paste, cloud-init
runs it on a box Basecamp bought, and `fli outpost:install` runs it over ssh on
a box you made some other way.

A box an app already runs on, whose deploy block says `outpost: true`, enrolls
itself at the end of `fli deploy` instead (`FJS-D1191`), and `fli
deploy:outpost` is that step alone: the install is the same, reached from inside
the serving container rather than through an API key.

`fli outpost:status <box>` reads an enrolled box back over ssh, from its own
Outpost: no key and no Basecamp needed. With no box named it reads every Server
row the Basecamp holds, one line each, and that needs the key. `fli
outpost:logs` is the log after it: an App's container by its `fjs.app` label,
or a unit's journal.
