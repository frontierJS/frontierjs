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
  // A server render, written by the emitter's string mode (`FJS-D1634`):
  // every tag and every event is HTML's, so only a directive the server
  // drops or a kind the IR left unlowered can refuse. `mode` is the one
  // field that picks the line body — pushes on `$$out` rather than calls on
  // `$$host`; a profile without it is painted by a host runtime.
  server: {
    name:        'server',
    mode:        'string',
    runtime:     '@frontierjs/mesa/runtime/server',
    tags:        new Proxy({}, { get: (_, tag) => (typeof tag === 'string' ? SERVER_ROLES[tag] ?? ANY_TAG : undefined) }),
    events:      new Proxy({}, { get: (_, e) => (typeof e === 'string' ? ANY_TAG : undefined) }),
    isInline:    (tag) => HTML_INLINE.has(tag),
    inputKind:   (type) => SERVER_INPUTS[type && type !== true ? String(type).toLowerCase() : 'text'] ?? 'field',
    paintsClass: () => true,
    paintsCss:   true,
    paintsStyle: () => true,
    cssOffense:  () => null,
  },
}

const ANY_TAG = Object.freeze({})
// The roles the emitter reads for a control's text and its binds; every
// other tag is plain.
const SERVER_ROLES = {
  input:    { role: 'input' },
  textarea: { role: 'textarea' },
  select:   { role: 'select' },
}
const SERVER_INPUTS = { checkbox: 'check', radio: 'check', hidden: 'hidden', file: 'file' }
// HTML's phrasing content, where a browser paints the space between two
// siblings; beside a block tag it paints none.
const HTML_INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'button', 'cite', 'code', 'data', 'dfn', 'em', 'i',
  'img', 'input', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'select', 'small', 'span',
  'strong', 'sub', 'sup', 'svg', 'textarea', 'time', 'u', 'var', 'wbr',
])
