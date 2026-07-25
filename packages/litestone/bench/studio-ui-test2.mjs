import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message))
page.on('dialog', d => d.accept())
const ok = (name, cond) => console.log((cond ? 'ok ' : 'FAIL ') + name)

await page.goto('http://127.0.0.1:5601/', { waitUntil: 'networkidle' })

// Generate some queries
await page.click('[data-table="users"]')
await page.waitForTimeout(500)
await page.fill('#browseSearch', 'acme')
await page.waitForTimeout(800)

// Query Log panel
await page.click('#navQlog')
await page.waitForTimeout(2600)
const qlogRows = await page.locator('#qlogList .sql-log-item').count()
ok('query log captures browse queries', qlogRows >= 2)
const countText = await page.textContent('#qlogCount')
ok('query log count label', /\d+ queries/.test(countText))

// Duration filter
await page.selectOption('#qlogMinDur', '100')
await page.waitForTimeout(300)
const afterFilter = await page.locator('#qlogList .sql-log-item').count()
ok('duration filter narrows', afterFilter <= qlogRows)
await page.selectOption('#qlogMinDur', '0')
await page.waitForTimeout(300)

// Click-through to analyzer
await page.locator('#qlogList .sql-log-item').first().click()
await page.waitForTimeout(1000)
const perfActive = await page.locator('#panelPerf').evaluate(el => el.classList.contains('active'))
const analyzerSql = await page.inputValue('#perfQueryInput')
ok('click-through opens analyzer', perfActive && analyzerSql.length > 10)
const planNodes = await page.locator('#perfQueryResults .plan-node, #perfQueryResults [class*="plan"]').count()
ok('analyzer produced a plan', planNodes >= 1)

// Stats panel: maintenance + disk usage + rotate key
await page.click('#navStats')
await page.waitForTimeout(1200)
ok('disk usage renders', (await page.locator('#diskUsage').textContent()).includes('Disk usage'))
ok('rotate key section renders', (await page.locator('#rotateKeySection').textContent()).includes('rotation'))

await page.click('button:has-text("Integrity")')
await page.waitForTimeout(1200)
const maint = await page.textContent('#maintResult')
ok('integrity check shows result', maint.includes('integrity') && maint.includes('ok'))

await page.click('button:has-text("Checkpoint")')
await page.waitForTimeout(1200)
ok('checkpoint shows result', (await page.textContent('#maintResult')).includes('checkpoint'))

// Rotate key with bad input → toast error, no crash
await page.fill('#rotateKeyInput', 'nothex')
await page.click('button:has-text("Rotate key")')
await page.waitForTimeout(400)
ok('bad key rejected client-side', (await page.inputValue('#rotateKeyInput')) === 'nothex')

// screenshot for layout check
await page.screenshot({ path: '/tmp/studio-stats.png' })
await page.click('#navQlog'); await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/studio-qlog.png' })

console.log(errors.length ? '\nJS ERRORS:\n' + errors.join('\n') : '\nNo JS errors')
await browser.close()
process.exit(errors.length ? 1 : 0)
