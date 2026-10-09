// check-sql.js — the SQL subset a `@@check` is written in, read as SQL.
//
// The seeder reads a rule's shape to decide which parents a row needs, and the
// test factory evaluates it to move a row until it passes; two readers of one
// expression that disagreed would build a row one of them refuses.

// The SQL subset, as a tree. Booleans are 1/0 and NULL is null, as SQLite has them.
export function parseSql(src) {
  const re = /\s*(?:("[^"]*")|('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_]\w*)|(<>|!=|<=|>=|[=<>+\-*\/(),]))/y
  const toks = []
  let m
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1]) toks.push({ k: 'col', v: m[1].slice(1, -1) })
    else if (m[2]) toks.push({ k: 'str', v: m[2].slice(1, -1).replace(/''/g, "'") })
    else if (m[3]) toks.push({ k: 'num', v: Number(m[3]) })
    else if (m[4]) toks.push({ k: 'word', v: m[4] })
    else toks.push({ k: 'op', v: m[5] })
  }
  if (re.lastIndex < src.length && src.slice(re.lastIndex).trim()) throw new Error('unsupported SQL')

  let i = 0
  const peek = () => toks[i]
  const word = w => peek()?.k === 'word' && peek().v.toUpperCase() === w
  const op   = o => peek()?.k === 'op' && peek().v === o
  const eat  = () => toks[i++]
  const need = o => { if (!op(o)) throw new Error(`expected ${o}`); i++ }

  const orExpr = () => {
    let a = andExpr()
    while (word('OR')) { eat(); a = { t: 'or', a, b: andExpr() } }
    return a
  }
  const andExpr = () => {
    let a = notExpr()
    while (word('AND')) { eat(); a = { t: 'and', a, b: notExpr() } }
    return a
  }
  const notExpr = () => {
    if (word('NOT')) { eat(); return { t: 'not', a: notExpr() } }
    return cmpExpr()
  }
  const cmpExpr = () => {
    const a = addExpr()
    if (word('IS')) {
      eat()
      const not = word('NOT') && (eat(), true)
      if (!word('NULL')) throw new Error('expected NULL')
      eat()
      return { t: 'isnull', a, not }
    }
    const not = word('NOT') && (eat(), true)
    if (word('IN')) {
      eat(); need('(')
      const list = [addExpr()]
      while (op(',')) { eat(); list.push(addExpr()) }
      need(')')
      return { t: 'in', a, list, not }
    }
    if (not) throw new Error('unsupported NOT')
    const t = peek()
    if (t?.k === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      eat()
      return { t: 'cmp', op: t.v, a, b: addExpr() }
    }
    return a
  }
  const addExpr = () => {
    let a = mulExpr()
    while (op('+') || op('-')) { const o = eat().v; a = { t: 'bin', op: o, a, b: mulExpr() } }
    return a
  }
  const mulExpr = () => {
    let a = unary()
    while (op('*') || op('/')) { const o = eat().v; a = { t: 'bin', op: o, a, b: unary() } }
    return a
  }
  const unary = () => {
    if (op('-')) { eat(); return { t: 'neg', a: unary() } }
    return primary()
  }
  const primary = () => {
    const t = eat()
    if (!t) throw new Error('unexpected end')
    if (t.k === 'num' || t.k === 'str' || t.k === 'col') return { t: t.k, v: t.v, name: t.v }
    if (t.k === 'op' && t.v === '(') { const e = orExpr(); need(')'); return e }
    if (t.k === 'word') {
      const u = t.v.toUpperCase()
      if (u === 'NULL')  return { t: 'null' }
      if (u === 'TRUE')  return { t: 'num', v: 1 }
      if (u === 'FALSE') return { t: 'num', v: 0 }
      if (op('(')) throw new Error('unsupported function')
      return { t: 'col', name: t.v }
    }
    throw new Error(`unexpected ${t.v}`)
  }

  const ast = orExpr()
  if (i < toks.length) throw new Error('trailing input')
  return ast
}

function sqlCompare(a, b) {
  const na = typeof a === 'number', nb = typeof b === 'number'
  if (na && nb) return a < b ? -1 : a > b ? 1 : 0
  if (na) return -1          // SQLite orders every number before every text
  if (nb) return 1
  const x = String(a), y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function evalSql(n, row) {
  const T = v => v != null && v !== 0
  switch (n.t) {
    case 'num':  return n.v
    case 'str':  return n.v
    case 'null': return null
    case 'col': {
      const v = row[n.name]
      if (v === undefined || v === null) return null
      if (typeof v === 'boolean') return v ? 1 : 0
      if (typeof v === 'object') return null
      return v
    }
    case 'neg': { const v = evalSql(n.a, row); return v == null ? null : -Number(v) }
    case 'bin': {
      const a = evalSql(n.a, row), b = evalSql(n.b, row)
      if (a == null || b == null) return null
      const x = Number(a), y = Number(b)
      if (Number.isNaN(x) || Number.isNaN(y)) return null
      const ints = Number.isInteger(x) && Number.isInteger(y)
      switch (n.op) {
        case '+': return x + y
        case '-': return x - y
        case '*': return x * y
        case '/': return y === 0 ? null : ints ? Math.trunc(x / y) : x / y
      }
      return null
    }
    case 'cmp': {
      const a = evalSql(n.a, row), b = evalSql(n.b, row)
      if (a == null || b == null) return null
      const c = sqlCompare(a, b)
      switch (n.op) {
        case '=':  return c === 0 ? 1 : 0
        case '<>': case '!=': return c !== 0 ? 1 : 0
        case '<':  return c < 0 ? 1 : 0
        case '<=': return c <= 0 ? 1 : 0
        case '>':  return c > 0 ? 1 : 0
        case '>=': return c >= 0 ? 1 : 0
      }
      return null
    }
    case 'isnull': { const v = evalSql(n.a, row); return (v == null) !== n.not ? 1 : 0 }
    case 'in': {
      const v = evalSql(n.a, row)
      if (v == null) return null
      let hit = false, sawNull = false
      for (const item of n.list) {
        const x = evalSql(item, row)
        if (x == null) sawNull = true
        else if (sqlCompare(v, x) === 0) hit = true
      }
      const r = hit ? 1 : sawNull ? null : 0
      return n.not && r != null ? 1 - r : r
    }
    case 'not': { const v = evalSql(n.a, row); return v == null ? null : T(v) ? 0 : 1 }
    case 'and': {
      const a = evalSql(n.a, row), b = evalSql(n.b, row)
      if ((a != null && !T(a)) || (b != null && !T(b))) return 0
      return a == null || b == null ? null : 1
    }
    case 'or': {
      const a = evalSql(n.a, row), b = evalSql(n.b, row)
      if (T(a) || T(b)) return 1
      return a == null || b == null ? null : 0
    }
  }
  return null
}
