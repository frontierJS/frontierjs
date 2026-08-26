// widgets/src/dev.js — the dev harness entry, not part of any bundle.
//
// `sierra widgets` generates its own entry per widget; this file exists so
// `vite dev` has something to load while a widget is being written. The host
// pages that PROVE a widget are in test/, each with its own hostile CSS and a
// real <script src> at the built file.

import './Embeds/BuyButton.mesa'
