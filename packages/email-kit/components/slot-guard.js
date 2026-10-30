// ─── slot-guard.js — a component warns where Mesa cannot ─────────────────────
//
// Children handed to a component with no matching `<slot>` are named by Mesa
// itself, with the props the component declares (`FJS-926`, `FJS-938`), so
// nothing here repeats that. What Mesa cannot know is the parent: `refuseCell`.

const warned = new Set()

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
