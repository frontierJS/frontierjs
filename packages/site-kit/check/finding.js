// check/finding.js — a finding: { level, key, message, fix?, where?, pages?, atLaunch? }
//
//   level     error blocks a deploy; warn and info don't
//   fix       where it is fixed, when the rule knows (a preset's settings file)
//   where     [{ file, line }] — source locations, relative to the site
//   pages     rendered paths that show it
//   atLaunch  a preset's mark on a warning it raises to an error later
export const finding = (level, key, message, extra = {}) => ({ level, key, message, ...extra })

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/** The closest name, if it's close enough to be a typo. */
export function didYouMean(name, candidates) {
  const lower = name.toLowerCase()
  let best = null
  let bestD = Infinity
  for (const c of candidates) {
    const d = c.toLowerCase() === lower ? 0 : levenshtein(lower, c.toLowerCase())
    if (d < bestD) [best, bestD] = [c, d]
  }
  return best && bestD <= Math.max(2, Math.floor(name.length / 4)) ? best : null
}

/**
 * Lines of a file that are prose, not code: skips frontmatter (unless asked)
 * and fenced code blocks, and blanks out inline code spans.
 */
export function proseLines(text, { frontmatter = false } = {}) {
  const lines = text.split('\n')
  const out = []
  let i = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---')
    if (end > 0) {
      if (frontmatter) for (let n = 1; n < end; n++) out.push({ n: n + 1, line: lines[n] })
      i = end + 1
    }
  }
  let fence = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      continue
    }
    if (m) {
      fence = m[1]
      continue
    }
    out.push({ n: i + 1, line: line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length)), prev: lines[i - 1] })
  }
  return out
}
