// ─── slot-guard.js — a component that cannot take children says so ───────────
//
// Mesa drops children handed to a component with no matching `<slot>`, in
// silence. Fourteen of this kit's components take children and eight cannot, so
// a caller has no way to tell which kind they are holding, and getting it wrong
// renders an empty button or a missing line rather than an error.
//
// `Button` is the case that decides the shape. Its label goes into the anchor
// AND into the Outlook VML, which is built as a STRING in `<script>` and
// percent-encoded into a data attribute — slot content is DOM and never a
// string, so a `<slot>` there would label the anchor and leave every Outlook
// recipient an unlabelled button. The answer is to refuse the children and name
// the prop, not to accept them halfway.
//
// Warn rather than throw: a render happens when mail is being sent, and one
// mislabelled component is not worth losing the message over. Once per
// component per process, because a list renders the same component many times
// and a warning per row is a warning nobody reads.

const warned = new Set()

/**
 * @param {string} component  the component's own name, for the message
 * @param {object} slots      `$.slots`
 * @param {string} advice     a whole sentence saying what to write instead —
 *                            not a fragment, because half of these components
 *                            take no content at all and *pass nothing instead*
 *                            is not a sentence anybody can act on.
 */
export function refuseChildren(component, slots, advice) {
  if (!slots?.default || warned.has(component)) return
  warned.add(component)
  console.warn(
    `[email-kit] <${component}> was given children and cannot render them — ` +
    `they have been dropped. ${advice}`
  )
}

/** Test seam: the warning is once per process, so a suite has to clear it. */
export function resetSlotGuard() { warned.clear() }
