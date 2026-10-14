// widgets/src/dev.js — the dev harness entry, not part of any bundle.
// `sierra widgets` generates its own entry per widget; this one is served by
// Sierra's dev plugin and calls the same embed() for every widget in
// src/Embeds/, with each stylesheet routed to its shadow root.

import 'virtual:sierra-widgets'
