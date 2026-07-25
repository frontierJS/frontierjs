// Studio UI e2e test — drives the browser against a running studio instance.
// Setup:  bun example/seed.ts && litestone studio --port=5501  (from example/, with ENCRYPTION_KEY set)
// Run:    node bench/studio-ui-test.mjs   (requires playwright-core + chromium)
import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()) })

const ok = (name, cond) => console.log((cond ? 'ok ' : 'FAIL ') + name)

await page.goto('http://127.0.0.1:5501/', { waitUntil: 'networkidle' })
ok('page loads', (await page.title()) !== '')

// Select users table
await page.click('[data-table="users"]')
await page.waitForTimeout(600)
const rowCount = await page.locator('#dataGrid tbody tr').count()
ok('users table renders rows', rowCount >= 5)
ok('checkbox column present', await page.locator('#dataGrid input.row-sel').count() >= 5)

// Server-side search
await page.fill('#browseSearch', 'alice')
await page.waitForTimeout(700)
const filtered = await page.locator('#dataGrid tbody tr').count()
const info = await page.textContent('#pageInfo')
ok('server search narrows to 1 row', filtered === 1)
ok('pageInfo shows matching total', /1 row.*matching/.test(info))

// Clear search, sort by email desc (two clicks)
await page.fill('#browseSearch', '')
await page.waitForTimeout(700)
await page.click('th:has-text("email")')
await page.waitForTimeout(600)
await page.click('th:has-text("email")')
await page.waitForTimeout(600)
const firstEmail = (await page.locator('#dataGrid tbody tr').first().locator('td[data-col="email"]').textContent()).trim()
// expected: max email according to the server
const maxEmail = await (await fetch('http://127.0.0.1:5501/api/query', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ sql: "SELECT email FROM users WHERE deletedAt IS NULL ORDER BY email DESC LIMIT 1" }) })).json().then(d => d.rows[0].email)
ok('sort desc by email (server)', firstEmail.startsWith(maxEmail))

// Bulk select two rows + check delete button label
await page.locator('#dataGrid input.row-sel').nth(0).check()
await page.locator('#dataGrid input.row-sel').nth(1).check()
const delLabel = await page.textContent('#btnDeleteRow')
ok('bulk delete button shows count', delLabel.includes('2'))

// Bulk soft-delete with dialog accept
page.once('dialog', d => d.accept())
await page.click('#btnDeleteRow')
await page.waitForTimeout(700)
ok('rows soft-deleted (grid reloaded)', await page.locator('#dataGrid tbody tr').count() >= 1)

// Show deleted + restore
await page.check('#showDeleted')
await page.waitForTimeout(700)
const delRows = await page.locator('#dataGrid tr.cell-del').count()
ok('deleted rows visible struck-through', delRows >= 2)   // seed pre-deletes 2 demo users
// select ALL deleted rows and restore
const checks = page.locator('#dataGrid tr.cell-del input.row-sel')
const nChecks = await checks.count()
for (let i = 0; i < nChecks; i++) await checks.nth(i).check()
await page.click('#btnRestoreRow')
await page.waitForTimeout(700)
ok('restore clears deleted rows', await page.locator('#dataGrid tr.cell-del').count() === 0)

// Page size selector
await page.selectOption('#pageSizeSel', '25')
await page.waitForTimeout(500)
ok('page size change reloads', await page.locator('#dataGrid tbody tr').count() >= 1)

// Export CSV (download event)
const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null)
await page.click('button[title*="as CSV"]')
const download = await dl
ok('CSV export downloads', !!download && (await download.suggestedFilename()).endsWith('.csv'))

// Migrations panel — buttons hidden when in sync
await page.click('text=Migrations')
await page.waitForTimeout(800)
const applyVisible  = await page.locator('#btnMigApply').isVisible()
const autoVisible   = await page.locator('#btnMigAuto').isVisible()
ok('migration action buttons hidden when in sync', !applyVisible && !autoVisible)

console.log(errors.length ? '\nJS ERRORS:\n' + errors.join('\n') : '\nNo JS errors')
await browser.close()
process.exit(errors.length ? 1 : 0)
