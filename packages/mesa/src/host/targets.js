/**
 * The targets the host emitter writes for, one profile each (`FJS-D1074`):
 * the lowering tables the compiler refuses against, and the runtime the
 * emitted module imports as `$$host`. The DOM is not here — its builder is
 * compiler.js's own. Pure data over each target's `tags.js`, so the
 * compiler loads it with no engine installed.
 */

import * as terminal from '../terminal/tags.js'
import * as native from '../native/tags.js'
import { cssOffense, lowerTypes } from '../native/css.js'

export const TARGETS = {
  terminal: {
    name:      'terminal',
    runtime:   '@frontierjs/mesa/runtime/terminal',
    tags:      terminal.TERMINAL_TAGS,
    events:    terminal.TERMINAL_EVENTS,
    isInline:  terminal.isInline,
    inputKind: terminal.inputKind,
    // A terminal paints no CSS, so a `class:` reaches it only when it names
    // a class the runtime reads off the `class` attribute too.
    paintsClass: terminal.paintsClass,
    // No stylesheet: `style` and the scoped rules are inert, and a `style:`
    // reaches it only for a property the runtime reads (a stack's gap).
    paintsCss:   false,
    paintsStyle: terminal.paintsStyle,
    cssOffense:  () => null,
  },
  native: {
    name:        'native',
    runtime:     '@frontierjs/mesa/runtime/native',
    tags:        native.NATIVE_TAGS,
    events:      native.NATIVE_EVENTS,
    isInline:    native.isInline,
    inputKind:   native.inputKind,
    paintsClass: () => true,
    paintsCss:   true,
    paintsStyle: () => true,
    cssOffense,
    // Every element is a `view` or `text`, so a scoped rule's type selector
    // is written as the class the runtime gives that tag.
    lowerSelector: lowerTypes,
  },
}
