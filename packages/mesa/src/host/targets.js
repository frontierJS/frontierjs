/**
 * The targets the host emitter writes for, one profile each (`FJS-D1074`):
 * the lowering tables the compiler refuses against, and the runtime the
 * emitted module imports as `$$host`. The DOM is not here — its builder is
 * compiler.js's own. Pure data over each target's `tags.js`, so the
 * compiler loads it with no engine installed.
 */

import * as terminal from '../terminal/tags.js'
import * as native from '../native/tags.js'
import { cssOffense } from '../native/css.js'

export const TARGETS = {
  terminal: {
    name:      'terminal',
    runtime:   '@frontierjs/mesa/runtime/terminal.js',
    tags:      terminal.TERMINAL_TAGS,
    events:    terminal.TERMINAL_EVENTS,
    isInline:  terminal.isInline,
    inputKind: terminal.inputKind,
    // A terminal paints no CSS, so a `class:` reaches it only when it names
    // a surface or a see-through variant, as the `class` attribute does (`opaque`).
    paintsClass: (name) => terminal.SURFACES.includes(name) || terminal.SEE_THROUGH.includes(name),
    // No stylesheet: `style`, `style:` and the scoped rules are inert.
    paintsCss:   false,
    cssOffense:  () => null,
  },
  native: {
    name:        'native',
    runtime:     '@frontierjs/mesa/runtime/native.js',
    tags:        native.NATIVE_TAGS,
    events:      native.NATIVE_EVENTS,
    isInline:    native.isInline,
    inputKind:   native.inputKind,
    paintsClass: () => true,
    paintsCss:   true,
    cssOffense,
  },
}
