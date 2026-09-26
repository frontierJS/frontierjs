/*
 * main.js — the floor: the same table, the same operations, written by hand.
 *
 * Every timing Mesa reports is a ratio to this page, measured in the same
 * browser minutes apart, which is what makes a number from one laptop
 * comparable to a number from another. Its DOM mutation count is the floor
 * those counts are read against: a keyed diff that keeps the longest run of
 * rows already in order and moves only the rest, which is the fewest moves any
 * reconciler can make.
 *
 * It must stay a floor and not become a second framework. It knows the shape
 * of one table and nothing else, and it takes each new array from
 * `../shared/data.js` exactly as the Mesa fixture does.
 */
import * as ops from '../shared/data.js'

const BUTTONS = [
  ['run', 'Create 1,000 rows'], ['runlots', 'Create 10,000 rows'], ['add', 'Append 1,000 rows'],
  ['update', 'Update every 10th row'], ['clear', 'Clear'], ['swaprows', 'Swap Rows'],
  ['reverse', 'Reverse'], ['shuffle', 'Shuffle'], ['rotate', 'Rotate'],
  ['prepend100', 'Prepend 100'], ['insertmid100', 'Insert 100 mid'],
  ['removefirst', 'Remove first'], ['removeevery10', 'Remove every 10th'],
]

document.body.insertAdjacentHTML('beforeend', `
<div id="main"><div class="container">
  <div class="jumbotron"><div class="row">
    <div class="col-md-6"><h1>Vanilla keyed</h1></div>
    <div class="col-md-6"><div class="row">${BUTTONS.map(([id, label]) =>
      `<div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id="${id}">${label}</button></div>`).join('')}
    </div></div>
  </div></div>
  <table class="table table-hover table-striped test-data"><tbody></tbody></table>
  <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
</div></div>`)

const tbody = document.querySelector('tbody')
const tpl   = document.createElement('template')
tpl.innerHTML = '<tr><td class="col-md-1"></td><td class="col-md-4"><a class="lbl"></a></td>' +
  '<td class="col-md-1"><a class="remove"><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td>' +
  '<td class="col-md-6"></td></tr>'

let rows     = []
let selected = 0
const byId   = new Map()   // id → { tr, text, label }

function createRow(r) {
  const tr = tpl.content.firstChild.cloneNode(true)
  tr.setAttribute('data-id', r.id)
  tr.firstChild.textContent = r.id
  const a = tr.childNodes[1].firstChild
  a.textContent = r.label
  if (r.id === selected) tr.className = 'danger'
  const entry = { tr, text: a.firstChild, label: r.label }
  byId.set(r.id, entry)
  return entry
}

// Indices into `seq` of its longest strictly increasing subsequence.
function lis(seq) {
  const tails = [], prev = new Array(seq.length)
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] < 0) continue
    let lo = 0, hi = tails.length
    while (lo < hi) { const m = (lo + hi) >> 1; seq[tails[m]] < seq[i] ? lo = m + 1 : hi = m }
    prev[i] = lo ? tails[lo - 1] : -1
    tails[lo] = i
  }
  const out = new Set()
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i)
  return out
}

function render(next) {
  if (!next.length) {
    tbody.textContent = ''
    byId.clear()
  } else if (!rows.length) {
    const frag = document.createDocumentFragment()
    for (const r of next) frag.appendChild(createRow(r).tr)
    tbody.appendChild(frag)
  } else {
    const keep = new Set(next.map(r => r.id))
    for (const r of rows) if (!keep.has(r.id)) { byId.get(r.id).tr.remove(); byId.delete(r.id) }

    const oldIndex = new Map(rows.map((r, i) => [r.id, i]))
    const stay     = lis(next.map(r => oldIndex.get(r.id) ?? -1))
    let anchor     = null
    for (let i = next.length - 1; i >= 0; i--) {
      const r = next[i]
      let e = byId.get(r.id)
      if (!e) { e = createRow(r); tbody.insertBefore(e.tr, anchor) }
      else {
        if (!stay.has(i)) tbody.insertBefore(e.tr, anchor)
        if (e.label !== r.label) { e.text.data = r.label; e.label = r.label }
      }
      anchor = e.tr
    }
  }
  rows = next
}

function select(id) {
  if (selected) byId.get(selected)?.tr.classList.remove('danger')
  selected = id
  byId.get(id)?.tr.classList.add('danger')
}

const ACTIONS = {
  run:           () => { selected = 0; render(ops.run()) },
  runlots:       () => { selected = 0; render(ops.runLots()) },
  add:           () => render(ops.add(rows)),
  update:        () => render(ops.update(rows)),
  clear:         () => { selected = 0; render(ops.clear()) },
  swaprows:      () => render(ops.swapRows(rows)),
  reverse:       () => render(ops.reverse(rows)),
  shuffle:       () => render(ops.shuffle(rows)),
  rotate:        () => render(ops.rotate(rows)),
  prepend100:    () => render(ops.prepend100(rows)),
  insertmid100:  () => render(ops.insertMid100(rows)),
  removefirst:   () => render(ops.removeFirst(rows)),
  removeevery10: () => render(ops.removeEvery10(rows)),
}

document.getElementById('main').addEventListener('click', (e) => {
  const button = e.target.closest('button')
  if (button) return ACTIONS[button.id]?.()
  const a = e.target.closest('a')
  if (!a) return
  const id = +a.closest('tr').getAttribute('data-id')
  if (a.classList.contains('lbl')) select(id)
  else render(ops.remove(rows, id))
})
