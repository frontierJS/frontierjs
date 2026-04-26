/**
 * Mesa document symbols provider.
 *
 * Populates the outline panel (Cmd+Shift+O / Ctrl+Shift+O) with a structured
 * view of the component's contents.
 *
 * Symbol tree:
 *
 *   📦 Props
 *     ↳ export let price = 49.99      (Variable)
 *     ↳ export const sku = 'WGT'      (Constant)
 *     ↳ export var taxRate = 0.08     (Variable)
 *   ⚡ Reactive State
 *     ↳ let count = 0                  (Variable)
 *     ↳ let items = []                 (Variable)
 *   🔗 Derived
 *     ↳ const double = count * 2       (Function — memo)
 *     ↳ $: doubled = count * 2         (Function — writable derived)
 *   ⏳ Async
 *     ↳ const cities = await getCities(...)  (Function)
 *   👁 Watches
 *     ↳ $: count, () => ...            (Event)
 *     ↳ $_logCount: count, () => ...   (Event, named)
 *   🌐 Context
 *     ↳ $context.theme = darkMode      (Property — provide)
 *     ↳ const theme = $context.theme   (Property — consume)
 *   📋 Variables (var)
 *     ↳ var snapshot = price           (Variable)
 *   🔧 Functions
 *     ↳ function handleClick() {}      (Function)
 *   🧩 Components / Template structure
 *     ↳ <MyComponent />                (Class)
 */

'use strict'

const vscode = require('vscode')
const { DocumentSymbol, SymbolKind, Range, Position } = vscode

// ─── Main provider ─────────────────────────────────────────────────────────────

/**
 * @param {vscode.TextDocument} document
 * @returns {vscode.DocumentSymbol[]}
 */
function provideDocumentSymbols(document) {
  const src   = document.getText()
  const lines = src.split('\n')

  // Find script block boundaries
  const scriptMatch = src.match(/<script[^>]*>/)
  if (!scriptMatch) return []

  const scriptTagEnd    = scriptMatch.index + scriptMatch[0].length
  const scriptCloseIdx  = src.indexOf('</script>', scriptTagEnd)
  const scriptSrc       = scriptCloseIdx !== -1
    ? src.slice(scriptTagEnd, scriptCloseIdx)
    : src.slice(scriptTagEnd)
  const scriptLineStart = src.slice(0, scriptTagEnd).split('\n').length - 1

  // Groups — we build these then only emit non-empty ones
  const groups = {
    props:    { label: 'Props',          icon: '$(symbol-package)',  kind: SymbolKind.Namespace, children: [] },
    state:    { label: 'Reactive State', icon: '$(zap)',             kind: SymbolKind.Namespace, children: [] },
    derived:  { label: 'Derived',        icon: '$(link)',            kind: SymbolKind.Namespace, children: [] },
    async:    { label: 'Async',          icon: '$(watch)',           kind: SymbolKind.Namespace, children: [] },
    watches:  { label: 'Watches',        icon: '$(eye)',             kind: SymbolKind.Namespace, children: [] },
    context:  { label: 'Context',        icon: '$(globe)',           kind: SymbolKind.Namespace, children: [] },
    nonreact: { label: 'Non-reactive',   icon: '$(symbol-variable)', kind: SymbolKind.Namespace, children: [] },
    funcs:    { label: 'Functions',      icon: '$(symbol-method)',   kind: SymbolKind.Namespace, children: [] },
  }

  const scriptLines = scriptSrc.split('\n')

  // ── Pass: classify each line of the script block ──────────────────────────
  for (let i = 0; i < scriptLines.length; i++) {
    const raw  = scriptLines[i]
    const line = raw.trim()
    const docLine = scriptLineStart + i
    const lineRange = lineRangeFor(document, docLine, raw)

    // $context.key = expr  (provide)
    const ctxProvide = line.match(/^\$context\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=(?!=)/)
    if (ctxProvide) {
      groups.context.children.push(sym(
        `$context.${ctxProvide[1]} =`, SymbolKind.Property,
        'provide', lineRange
      ))
      continue
    }

    // let/const/var name = $context.key  (consume)
    const ctxConsume = line.match(/^(?:export\s+)?(let|const|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*\$context\.([a-zA-Z_$][a-zA-Z0-9_$]*)/)
    if (ctxConsume) {
      groups.context.children.push(sym(
        `${ctxConsume[2]} ← $context.${ctxConsume[3]}`, SymbolKind.Property,
        `${ctxConsume[1]} consume`, lineRange
      ))
      continue
    }

    // export let/const/var  (props)
    const propMatch = line.match(/^export\s+(let|const|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/)
    if (propMatch) {
      const detail = propMatch[1] === 'let'   ? 'reactive prop' :
                     propMatch[1] === 'const' ? 'immutable prop' : 'snapshot prop'
      const kind   = propMatch[1] === 'const' ? SymbolKind.Constant : SymbolKind.Variable
      groups.props.children.push(sym(propMatch[2], kind, detail, lineRange))
      continue
    }

    // $: name = expr  (writable derived)
    const writableDerived = line.match(/^\$:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=(?!=)/)
    if (writableDerived) {
      groups.derived.children.push(sym(
        `$: ${writableDerived[1]}`, SymbolKind.Function,
        'writable derived', lineRange
      ))
      continue
    }

    // $: dep, handler  or  $_name: dep, handler  (watch + handler)
    const watchDebug = line.match(/^\$(_[a-zA-Z_][a-zA-Z0-9_]*):\s*(.+?),\s*(async\s+)?[()=]/)
    const watchPlain = line.match(/^\$:\s*(.+?),\s*(async\s+)?(?:=>|\(\)|function|\w+\s*=>)/)
    if (watchDebug || watchPlain) {
      const debugName = watchDebug ? watchDebug[1].slice(1) : null
      const deps      = watchDebug ? watchDebug[2].trim() : watchPlain[1].trim()
      const isAsync   = !!(watchDebug ? watchDebug[3] : watchPlain[2])
      const label     = debugName
        ? `$_${debugName}: ${deps}`
        : `$: ${deps}`
      groups.watches.children.push(sym(
        label, SymbolKind.Event,
        isAsync ? 'async handler' : 'handler', lineRange
      ))
      continue
    }

    // $: path/expression  (side effect or path watch)
    const sideEffect = line.match(/^\$:\s*(.+)$/)
    if (sideEffect) {
      const expr = sideEffect[1].trim()
      groups.watches.children.push(sym(
        `$: ${expr.slice(0, 40)}${expr.length > 40 ? '…' : ''}`,
        SymbolKind.Event, 'effect', lineRange
      ))
      continue
    }

    // const name = await expr  (async derived)
    const asyncDerived = line.match(/^const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*await\s/)
    if (asyncDerived) {
      groups.async.children.push(sym(
        asyncDerived[1], SymbolKind.Function,
        'async derived', lineRange
      ))
      continue
    }

    // const name = expr  (derived const)
    const constDerived = line.match(/^const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/)
    if (constDerived) {
      // Static vs derived is determined by the compiler — we use 'derived' as
      // the label since most top-level consts in a component reference state.
      groups.derived.children.push(sym(
        constDerived[1], SymbolKind.Constant,
        'const', lineRange
      ))
      continue
    }

    // let name  (reactive state)
    const letDecl = line.match(/^let\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/)
    if (letDecl) {
      groups.state.children.push(sym(
        letDecl[1], SymbolKind.Variable,
        'let', lineRange
      ))
      continue
    }

    // var name  (non-reactive)
    const varDecl = line.match(/^var\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/)
    if (varDecl) {
      groups.nonreact.children.push(sym(
        varDecl[1], SymbolKind.Variable,
        'var (non-reactive)', lineRange
      ))
      continue
    }

    // function name(
    const funcDecl = line.match(/^(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/)
    if (funcDecl) {
      // Find the end of the function (heuristic: next line at same indent that closes })
      const funcEnd = findBlockEnd(scriptLines, i)
      const endLine = scriptLineStart + Math.min(funcEnd, scriptLines.length - 1)
      const fullRange = new Range(
        new Position(docLine, 0),
        new Position(endLine, scriptLines[funcEnd]?.length ?? 0)
      )
      groups.funcs.children.push(sym(
        funcDecl[1], SymbolKind.Function,
        line.startsWith('async') ? 'async function' : 'function',
        fullRange
      ))
      continue
    }

    // const name = (...) =>  or  const name = async (...) =>
    const arrowFunc = line.match(/^const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?\(/)
    if (arrowFunc) {
      groups.funcs.children.push(sym(
        arrowFunc[1], SymbolKind.Function,
        'function', lineRange
      ))
      continue
    }
  }

  // ── Emit non-empty groups as top-level symbols with children ──────────────
  const result = []
  const order = ['props', 'state', 'derived', 'async', 'watches', 'context', 'nonreact', 'funcs']

  for (const key of order) {
    const g = groups[key]
    if (g.children.length === 0) continue

    // Span the group from its first child to its last
    const first = g.children[0].range.start
    const last  = g.children[g.children.length - 1].range.end
    const groupRange = new Range(first, last)

    const groupSym = new DocumentSymbol(
      g.label, '', g.kind, groupRange, groupRange
    )
    groupSym.children = g.children
    result.push(groupSym)
  }

  return result
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a DocumentSymbol with a single-line range.
 */
function sym(name, kind, detail, range) {
  return new DocumentSymbol(name, detail, kind, range, range)
}

/**
 * Get the full range of a line in the document.
 */
function lineRangeFor(document, lineNum, rawLine) {
  const safeNum = Math.min(lineNum, document.lineCount - 1)
  const len     = rawLine?.length ?? document.lineAt(safeNum).text.length
  return new Range(
    new Position(safeNum, 0),
    new Position(safeNum, len)
  )
}

/**
 * Find the line index where a `{`-delimited block opened on `startLine` closes.
 * Heuristic — counts braces. Good enough for function body detection.
 */
function findBlockEnd(lines, startLine) {
  let depth = 0
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return i
      }
    }
  }
  return startLine
}

module.exports = { provideDocumentSymbols }
