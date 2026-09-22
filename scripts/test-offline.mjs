// Production-only browser regression. Use the environment's Playwright via
// PIP_PLAYWRIGHT_MODULE, or a locally available `playwright` package.
import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { stampWorker } from './stamp-sw.mjs'

const { chromium } = await import(process.env.PIP_PLAYWRIGHT_MODULE || 'playwright')
const temp = mkdtempSync(join(tmpdir(), 'pip-offline-browser-'))
const evidence = process.env.PIP_OFFLINE_EVIDENCE || join(tmpdir(), 'pip-offline-evidence')
mkdirSync(evidence, { recursive: true })
const a = join(temp, 'a'),
  b = join(temp, 'b')
cpSync('out', a, { recursive: true })
cpSync('out', b, { recursive: true })
// Same Git commit, different exported content: this must install a new release.
writeFileSync(
  join(b, 'credits.html'),
  readFileSync(join(b, 'credits.html'), 'utf8').replace(
    '</body>',
    '<p>P1 update fixture</p></body>',
  ),
)
const template = readFileSync('public/sw.js', 'utf8')
const first = stampWorker(a, template),
  second = stampWorker(b, template)
assert.notEqual(first.contentId, second.contentId)
let root = a,
  fault = '',
  corrupt = false
const types = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.xml': 'application/xml',
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === fault) {
    res.writeHead(corrupt ? 200 : 404, { 'Content-Type': 'text/html' }).end('incomplete deployment')
    return
  }
  const path = resolve(root, `.${decodeURIComponent(url.pathname)}`)
  if (!path.startsWith(`${root}/`) && path !== root) {
    res.writeHead(403).end()
    return
  }
  const file = [path, `${path}.html`, join(path, 'index.html')].find(
    (p) => existsSync(p) && statSync(p).isFile(),
  )
  if (!file) {
    res.writeHead(404).end('Not found')
    return
  }
  res.writeHead(200, {
    'Content-Type':
      types[extname(file)] ||
      (file.endsWith('opengraph-image') ? 'image/png' : 'application/octet-stream'),
    'Cache-Control': 'no-store',
  })
  res.end(readFileSync(file))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })
const report = { browser: browser.version(), first, second, checks: [], errors: [] }
function pass(name) {
  report.checks.push(name)
  console.log(`PASS ${name}`)
}
async function ready(page) {
  await page.waitForFunction(
    async () => {
      if (!navigator.serviceWorker.controller) return false
      return new Promise((done) => {
        const channel = new MessageChannel()
        const timer = setTimeout(() => done(false), 2000)
        channel.port1.onmessage = (e) => {
          clearTimeout(timer)
          channel.port1.close()
          done(e.data.ready === true)
        }
        navigator.serviceWorker.controller.postMessage({ type: 'STATUS' }, [channel.port2])
      })
    },
    undefined,
    { timeout: 60000 },
  )
}
async function player(page) {
  await page.goto(`${origin}/game`)
  await page.getByPlaceholder('Your name').fill('Offline test')
  await page.getByRole('button', { name: 'Enter', exact: true }).click()
  await page.getByRole('button', { name: 'Deal me in' }).click()
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  let page = await context.newPage()
  page.on('pageerror', (e) => report.errors.push(e.message))
  await player(page)
  await ready(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Ready to play offline.', { exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, 'offline-ready.png') })
  await page.keyboard.press('Escape')
  pass('complete install reports ready in Settings')
  const originalProfile = await page.evaluate(() => localStorage.getItem('pip.profile'))
  await context.setOffline(true)
  const manifest = JSON.parse(
    readFileSync(join(a, 'sw.js'), 'utf8').match(/const ASSETS = (\[.*\])/)[1],
  )
  await page.evaluate(async (assets) => {
    for (const asset of assets) {
      const response = await fetch(asset.url)
      if (!response.ok) throw new Error(`Offline asset missing: ${asset.url}`)
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
      const integrity = `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`
      if (integrity !== asset.integrity) throw new Error(`Offline asset changed: ${asset.url}`)
    }
  }, manifest)
  pass('every precached resource is readable offline with the expected digest')
  await page.close()
  page = await context.newPage()
  // Cold document loads in a new tab, including routes never opened online.
  for (const [path, title] of [
    ['/stats', /stats/i],
    ['/learn/pot-odds', /Pot odds/],
    ['/game/drills', /Drills/],
    ['/game/drills/which-hand-wins', /Which hand wins/],
  ]) {
    await page.goto(origin + path)
    assert.match(await page.title(), title)
    assert.ok((await page.locator('body').innerText()).length > 20)
    assert.equal(await page.locator('nextjs-portal').count(), 0)
  }
  // Back, forward, refresh and RSC navigation while offline.
  await page.goBack()
  assert.match(await page.title(), /Drills/)
  await page.goForward()
  assert.match(await page.title(), /Which hand wins/)
  await page.reload()
  assert.match(await page.title(), /Which hand wins/)
  await page.goto(`${origin}/game`)
  await page.locator('a[href="/game/drills"]').click()
  await page.waitForURL('**/game/drills')
  await page.getByRole('button').filter({ hasText: 'Which hand wins' }).click()
  await page.waitForURL('**/game/drills/which-hand-wins')
  await page.getByRole('button', { name: /They split it/ }).click()
  await page.getByRole('button', { name: 'Next hand', exact: true }).waitFor()
  assert.notEqual(await page.evaluate(() => localStorage.getItem('pip.profile')), originalProfile)
  await page.screenshot({ path: join(evidence, 'offline-drill.png') })
  pass('cold offline routes, refresh, history, RSC navigation and drill grading')
  await page.goto(`${origin}/game`)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Move it by hand', exact: true }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save file', exact: true }).click()
  const download = await downloadEvent
  const backupFile = join(temp, 'profile.json')
  await download.saveAs(backupFile)
  const backup = JSON.parse(readFileSync(backupFile, 'utf8'))
  await page.locator('input[type="file"]').setInputFiles(backupFile)
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Restore', exact: true }).click(),
  ])
  assert.deepEqual(
    JSON.parse(await page.evaluate(() => localStorage.getItem('pip.profile'))),
    backup.profile,
  )
  pass('file export and confirmed restore work offline')
  const missing = await page.goto(`${origin}/nonexistent-route`)
  assert.equal(missing.status(), 404)
  pass('unknown route returns 404')
  await page.goto(`${origin}/game`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => localStorage.setItem('theme', 'light'))
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Ready to play offline.', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(evidence, 'offline-ready-mobile-light.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  pass('offline status fits a mobile viewport in light theme')
  await context.close()

  const updates = await browser.newContext()
  const lobby = await updates.newPage()
  await player(lobby)
  await ready(lobby)
  await lobby.evaluate(async () => {
    await (await caches.open('another-app')).put('/keep', new Response('keep'))
  })
  root = b
  fault = '/stats'
  await lobby.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update()
  })
  await lobby.waitForFunction(
    async () => !(await navigator.serviceWorker.getRegistration()).installing,
  )
  assert.equal(
    await lobby.evaluate(async () =>
      Boolean((await navigator.serviceWorker.getRegistration()).waiting),
    ),
    false,
  )
  await updates.setOffline(true)
  const preserved = await updates.newPage()
  await preserved.goto(`${origin}/stats`)
  assert.match(await preserved.title(), /stats/i)
  await preserved.close()
  pass('failed new release leaves old release usable offline')
  await updates.setOffline(false)
  corrupt = true
  await lobby.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update()
  })
  await lobby.waitForFunction(
    async () => !(await navigator.serviceWorker.getRegistration()).installing,
  )
  assert.equal(
    await lobby.evaluate(async () =>
      Boolean((await navigator.serviceWorker.getRegistration()).waiting),
    ),
    false,
  )
  pass('HTTP 200 with mismatched content fails integrity and cannot activate')
  corrupt = false
  fault = ''
  await lobby.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update()
  })
  await lobby.waitForFunction(
    async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting),
    undefined,
    { timeout: 60000 },
  )
  const table = await updates.newPage()
  await table.goto(`${origin}/play/garage`)
  await table.waitForFunction(() => Boolean(localStorage.getItem('pip.table')))
  await lobby.getByRole('button', { name: 'Reload', exact: true }).click()
  await lobby.getByText(/Finish or leave tables in other tabs/).waitFor()
  assert.equal(
    await lobby.evaluate(async () =>
      Boolean((await navigator.serviceWorker.getRegistration()).waiting),
    ),
    true,
  )
  pass('active table in another tab vetoes update')
  await table.close()
  const saved = await lobby.evaluate(() => ({
    profile: localStorage.getItem('pip.profile'),
    table: localStorage.getItem('pip.table'),
  }))
  await Promise.all([
    lobby.waitForEvent('load'),
    lobby.getByRole('button', { name: 'Reload', exact: true }).click(),
  ])
  await ready(lobby)
  assert.deepEqual(
    await lobby.evaluate(() => ({
      profile: localStorage.getItem('pip.profile'),
      table: localStorage.getItem('pip.table'),
    })),
    saved,
  )
  const cacheNames = await lobby.evaluate(() => caches.keys())
  assert.ok(cacheNames.includes('another-app'))
  assert.ok(cacheNames.includes(`pip-offline-${first.contentId}`))
  assert.ok(cacheNames.includes(`pip-offline-${second.contentId}`))
  await updates.setOffline(true)
  await lobby.goto(`${origin}/credits`)
  await lobby.getByText('P1 update fixture', { exact: true }).waitFor()
  pass('complete new release activates; prior assets, unrelated cache and saved table survive')
  await updates.close()
  root = a
  fault = '/stats'
  const fresh = await browser.newContext()
  const retryPage = await fresh.newPage()
  await player(retryPage)
  await retryPage.getByRole('button', { name: 'Settings', exact: true }).click()
  await retryPage
    .getByText('Offline download incomplete. Connect and try again.', { exact: true })
    .waitFor()
  fault = ''
  await retryPage.getByRole('button', { name: 'Retry download', exact: true }).click()
  await ready(retryPage)
  await retryPage.getByText('Ready to play offline.', { exact: true }).waitFor()
  await fresh.close()
  pass('failed first installation can be retried from Settings')
  assert.deepEqual(report.errors, [])
} finally {
  writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await browser.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  rmSync(temp, { recursive: true, force: true })
}
console.log(`Evidence: ${evidence}`)
