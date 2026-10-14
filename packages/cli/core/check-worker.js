// One scope of `/api/check`, run on its own thread so the scopes overlap and the
// server that asked stays answerable. `runChecks` is synchronous and the repo
// scope alone is several seconds; run in the server's thread they queue behind
// each other and behind every request that arrives meanwhile.
import { runChecks, readBaseline, gradeBaseline } from './checks.js'

self.onmessage = ({ data: { root, scope } }) => {
  try {
    const result   = runChecks({ root, scope })
    const baseline = readBaseline(root)
    self.postMessage({ result, grade: baseline.present ? gradeBaseline(result, baseline) : null })
  } catch (err) {
    self.postMessage({ error: err.message })
  }
}
