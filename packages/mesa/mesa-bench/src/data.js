// Standardized data generation for js-framework-benchmark
// Uses the exact word lists specified by the benchmark

const adjectives = [
  'pretty','large','big','small','tall','short','long','handsome',
  'plain','quaint','clean','elegant','easy','angry','crazy','helpful',
  'mushy','odd','unsightly','adorable','important','inexpensive','cheap',
  'expensive','fancy'
]
const colors = [
  'red','yellow','blue','green','pink','brown','purple','brown',
  'white','black','orange'
]
const nouns = [
  'table','chair','house','bbq','desk','car','pony','cookie',
  'sandwich','burger','pizza','mouse','keyboard'
]

let _nextId = 1

function _rnd(max) {
  return Math.round(Math.random() * 1000) % max
}

export function buildData(count) {
  return Array.from({ length: count }, () => ({
    id:    _nextId++,
    label: `${adjectives[_rnd(adjectives.length)]} ${colors[_rnd(colors.length)]} ${nouns[_rnd(nouns.length)]}`
  }))
}
