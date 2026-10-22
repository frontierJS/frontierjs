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

// ─── a row component inside a Column ─────────────────────────────────────────
//
// Every component but Email, Section, Column and Link renders a <tr>; Column
// renders a <td>. A row inside a cell is invalid HTML, so the parser moves it out and
// everything after it runs the client's full width — a DataTable laid out 668px
// in a 700px window instead of 568px inside the 600px container. The server
// render has already moved the rows by the time anything could read the output,
// so the component says it while it still knows its parent.
//
// Column provides `$context.emailCell`; Section, Card and Review, which open a
// table inside whatever holds them, provide it false again.

/**
 * @param {string}  component  the component's own name, for the message
 * @param {boolean} inCell     `$context.emailCell`
 */
export function refuseCell(component, inCell) {
  const key = `${component}:cell`
  if (!inCell || warned.has(key)) return
  warned.add(key)
  console.warn(
    `[email-kit] <${component}> renders a table row and was placed inside a <Column>, ` +
    `which is a table cell — the row is moved out of the cell and the layout runs full width. ` +
    `Put it directly in a <Section> or <Card>, or wrap it in one inside the Column.`
  )
}
