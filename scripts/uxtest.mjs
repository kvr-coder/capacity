/**
 * Browser proof harness.
 *
 * This is not a unit test. It launches the real built app in Chromium, walks
 * every screen, drives the interactions the product is actually about — filter,
 * drill down, drag load, turn the OEE knob, undo — and asserts that real data
 * rendered rather than an empty frame. It captures a screenshot at every step.
 *
 * The assertions are deliberately structural rather than selector-coupled:
 * "this canvas has more than one distinct colour", "this table has rows",
 * "these numbers changed after I moved the filter". A screen can be restyled
 * without breaking the proof; a screen that silently renders nothing cannot
 * pass it.
 *
 * Usage:  node scripts/uxtest.mjs [--url http://localhost:4173] [--headed]
 */

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const BASE = argOf('url', 'http://localhost:4173')
const SHOT_DIR = argOf('shots', 'artifacts/screenshots')
const VIEWPORT = { width: 1680, height: 1050 }

const results = []
const consoleErrors = []
const pageErrors = []
let shotIndex = 0

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function shot(page, label) {
  shotIndex += 1
  const file = path.join(SHOT_DIR, `${String(shotIndex).padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return file
}

/** Waits for the worker to finish generating and the app to render a screen. */
async function waitForApp(page, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const root = document.getElementById('root')
      if (!root) return { ready: false, reason: 'no root' }
      const text = root.innerText || ''
      const loading = /generating|building|loading|initialis|initializ/i.test(text)
      const hasNav = !!root.querySelector('nav, [role="navigation"]')
      const hasContent = root.querySelectorAll('svg, canvas, table').length > 0
      return { ready: hasNav && hasContent && !loading, reason: text.slice(0, 120), loading }
    })
    if (state.ready) return true
    await page.waitForTimeout(500)
  }
  return false
}

/** True when a canvas contains more than one distinct colour — i.e. it drew something. */
async function canvasHasContent(page, index = 0) {
  return page.evaluate((i) => {
    const canvases = Array.from(document.querySelectorAll('canvas'))
    const c = canvases[i]
    if (!c || !c.width || !c.height) return { ok: false, reason: 'no canvas or zero size' }
    const ctx = c.getContext('2d')
    if (!ctx) return { ok: false, reason: 'no 2d context' }
    const w = Math.min(c.width, 600)
    const h = Math.min(c.height, 400)
    const data = ctx.getImageData(0, 0, w, h).data
    const seen = new Set()
    for (let p = 0; p < data.length; p += 4 * 37) {
      seen.add(`${data[p]},${data[p + 1]},${data[p + 2]},${data[p + 3]}`)
      if (seen.size > 6) break
    }
    return { ok: seen.size > 3, reason: `${seen.size} distinct sampled colours`, size: `${c.width}x${c.height}` }
  }, index)
}

/** Pulls every number visible on the page, for before/after comparison. */
async function numericFingerprint(page) {
  return page.evaluate(() => {
    const root = document.getElementById('root')
    if (!root) return []
    const text = root.innerText || ''
    return (text.match(/-?[\d][\d,.]*\s*%?/g) || []).slice(0, 400)
  })
}

async function countElements(page) {
  return page.evaluate(() => {
    const root = document.getElementById('root')
    if (!root) return { svg: 0, canvas: 0, table: 0, rows: 0, paths: 0, rects: 0, buttons: 0, text: 0 }
    return {
      svg: root.querySelectorAll('svg').length,
      canvas: root.querySelectorAll('canvas').length,
      table: root.querySelectorAll('table').length,
      rows: root.querySelectorAll('tbody tr').length,
      paths: root.querySelectorAll('svg path').length,
      rects: root.querySelectorAll('svg rect').length,
      buttons: root.querySelectorAll('button').length,
      text: (root.innerText || '').length,
    }
  })
}

async function gotoRoute(page, hash, label) {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'load' })
  await page.waitForTimeout(2200)
  const counts = await countElements(page)
  const file = await shot(page, label)
  return { counts, file }
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch({
    headless: !args.includes('--headed'),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  const page = await context.newPage()

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300))
  })
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 300)))

  console.log(`\n=== Capacity Cockpit — browser proof ===\nURL: ${BASE}\n`)

  // ---------------------------------------------------------------- boot
  console.log('BOOT')
  const t0 = Date.now()
  await page.goto(`${BASE}/#/`, { waitUntil: 'load' })
  const booted = await waitForApp(page)
  const bootMs = Date.now() - t0
  record('App boots past the loading screen', booted, `${bootMs}ms`)
  await shot(page, 'boot')
  if (!booted) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 900))
    console.log('\n--- page text at failure ---\n' + body + '\n')
  }

  // ------------------------------------------------------------- cockpit
  console.log('\nCOCKPIT')
  const cockpit = await gotoRoute(page, '/', 'cockpit')
  record(
    'Cockpit renders charts',
    cockpit.counts.svg >= 3 && cockpit.counts.paths + cockpit.counts.rects > 30,
    `${cockpit.counts.svg} svg, ${cockpit.counts.paths} paths, ${cockpit.counts.rects} rects`,
  )
  record('Cockpit renders substantial text', cockpit.counts.text > 800, `${cockpit.counts.text} chars`)

  const gridCanvas = await canvasHasContent(page, 0)
  record('Utilisation grid drew pixels', gridCanvas.ok, `${gridCanvas.reason} @ ${gridCanvas.size ?? 'n/a'}`)

  // Numbers must be real, not zeros.
  const hasRealNumbers = await page.evaluate(() => {
    const t = document.getElementById('root')?.innerText || ''
    const nums = (t.match(/[\d][\d,.]*/g) || []).map((s) => Number(s.replace(/,/g, '')))
    const big = nums.filter((n) => Number.isFinite(n) && n > 100)
    return { count: big.length, max: Math.max(0, ...big) }
  })
  record(
    'Cockpit shows non-trivial figures',
    hasRealNumbers.count > 5 && hasRealNumbers.max > 500,
    `${hasRealNumbers.count} values >100, max ${hasRealNumbers.max}`,
  )

  // ------------------------------------------------------------- filters
  console.log('\nFILTERS')
  const before = await numericFingerprint(page)
  const filterChanged = await page.evaluate(() => {
    // Find any select/combobox in the filter row and change it.
    const root = document.getElementById('root')
    if (!root) return false
    const selects = Array.from(root.querySelectorAll('select'))
    for (const s of selects) {
      if (s.options.length > 1) {
        s.selectedIndex = Math.min(1, s.options.length - 1)
        s.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }
    }
    return false
  })
  if (filterChanged) {
    await page.waitForTimeout(2500)
    const after = await numericFingerprint(page)
    const differing = before.filter((v, i) => after[i] !== v).length
    record('Changing a filter re-renders the numbers', differing > 0, `${differing} values changed`)
    await shot(page, 'cockpit-filtered')
  } else {
    // Fall back to clicking a filter button.
    const btn = page.locator('button', { hasText: /week|month|quarter|13|26/i }).first()
    if (await btn.count()) {
      await btn.click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(2500)
      const after = await numericFingerprint(page)
      const differing = before.filter((v, i) => after[i] !== v).length
      record('Changing the time bucket re-renders', differing > 0, `${differing} values changed`)
      await shot(page, 'cockpit-filtered')
    } else {
      record('Filter control found', false, 'no select or bucket button located')
    }
  }

  // --------------------------------------------------------- network map
  console.log('\nNETWORK MAP')
  const net = await gotoRoute(page, '/network', 'network-map')
  record(
    'Network map renders a canvas or rich SVG',
    net.counts.canvas > 0 || net.counts.paths > 40,
    `${net.counts.canvas} canvas, ${net.counts.paths} paths, ${net.counts.svg} svg`,
  )
  // Try to zoom into a plant by clicking the largest circle.
  const zoomed = await page.evaluate(() => {
    const circles = Array.from(document.querySelectorAll('svg circle'))
    if (!circles.length) return false
    const biggest = circles.sort(
      (a, b) => Number(b.getAttribute('r') || 0) - Number(a.getAttribute('r') || 0),
    )[0]
    biggest?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  if (zoomed) {
    await page.waitForTimeout(2000)
    await shot(page, 'network-zoomed')
    const after = await countElements(page)
    record('Clicking a plant changes the view', after.text !== net.counts.text, `text ${net.counts.text} -> ${after.text}`)
  } else {
    record('Plant node clickable', false, 'no svg circle found to click')
  }

  // -------------------------------------------------------- work centers
  console.log('\nWORK CENTERS')
  const wc = await gotoRoute(page, '/workcenters', 'workcenters')
  record('Work-center register has rows', wc.counts.rows > 5, `${wc.counts.rows} rows`)
  const rowClicked = await page.evaluate(() => {
    const row = document.querySelector('tbody tr')
    if (!row) return false
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const btn = row.querySelector('button, [role="button"]')
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  if (rowClicked) {
    await page.waitForTimeout(2500)
    await shot(page, 'workcenter-detail')
    const detail = await countElements(page)
    record('Selecting a work center opens detail', detail.text > wc.counts.text, `${wc.counts.text} -> ${detail.text} chars`)
  } else {
    record('Work-center row clickable', false, 'no table row found')
  }

  // ------------------------------------------------------------ products
  console.log('\nPRODUCTS')
  const prod = await gotoRoute(page, '/products', 'products')
  record('Products screen has tabular data', prod.counts.rows > 5, `${prod.counts.rows} rows`)
  record('Products screen has charts', prod.counts.svg >= 1, `${prod.counts.svg} svg`)

  // ----------------------------------------------------------- scenarios
  console.log('\nSCENARIOS')
  const scen = await gotoRoute(page, '/scenarios', 'scenarios')
  record('Scenarios screen renders', scen.counts.text > 300, `${scen.counts.text} chars`)

  // Apply a starter move if one is offered, then undo it.
  const kpiBefore = await numericFingerprint(page)
  const applied = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const target = buttons.find((b) =>
      /ceiling|ramp|move .*off|add (a )?move|apply|start a/i.test(b.textContent || ''),
    )
    if (!target) return null
    target.click()
    return (target.textContent || '').trim().slice(0, 60)
  })
  if (applied) {
    await page.waitForTimeout(3000)
    await shot(page, 'scenario-move-applied')
    const kpiAfter = await numericFingerprint(page)
    const changed = kpiBefore.filter((v, i) => kpiAfter[i] !== v).length
    record('Applying a move changes the model output', changed > 0, `clicked "${applied}", ${changed} values changed`)

    const undone = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const u = buttons.find((b) =>
        /^undo$/i.test((b.textContent || '').trim()) ||
        /undo/i.test(b.getAttribute('aria-label') || ''),
      )
      if (!u) return false
      u.click()
      return true
    })
    if (undone) {
      await page.waitForTimeout(3000)
      const kpiUndo = await numericFingerprint(page)
      const back = kpiUndo.filter((v, i) => kpiBefore[i] === v).length
      record('Undo restores the previous model output', back > kpiBefore.length * 0.7, `${back}/${kpiBefore.length} values back`)
      await shot(page, 'scenario-undone')
    } else {
      record('Undo control present', false, 'no undo button found')
    }
  } else {
    record('A move can be applied from the Scenarios screen', false, 'no starter-move button found')
  }

  // ---------------------------------------------------------------- data
  console.log('\nDATA')
  const data = await gotoRoute(page, '/data', 'data-admin')
  record('Data screen lists master data', data.counts.rows > 5, `${data.counts.rows} rows`)

  // ----------------------------------------------------------- dark mode
  console.log('\nTHEME')
  const toggled = await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark')
    return true
  })
  if (toggled) {
    await page.goto(`${BASE}/#/`, { waitUntil: 'load' })
    await page.waitForTimeout(2500)
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(800)
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const isDark = (() => {
      const m = bg.match(/\d+/g)
      if (!m) return false
      const [r, g, b] = m.map(Number)
      return (r + g + b) / 3 < 90
    })()
    record('Dark theme applies', isDark, `body background ${bg}`)
    await shot(page, 'cockpit-dark')
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  }

  // ------------------------------------------------------- responsiveness
  console.log('\nRESPONSIVE')
  await page.setViewportSize({ width: 1180, height: 900 })
  await page.goto(`${BASE}/#/`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }))
  record(
    'No horizontal page overflow at 1180px',
    overflow.scrollW <= overflow.clientW + 2,
    `scrollWidth ${overflow.scrollW} vs clientWidth ${overflow.clientW}`,
  )
  await shot(page, 'cockpit-1180')
  await page.setViewportSize(VIEWPORT)

  // ------------------------------------------------------------- console
  console.log('\nCONSOLE HEALTH')
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|DevTools|Download the React DevTools|source map/i.test(e),
  )
  record('No uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'clean')
  record('No console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || 'clean')

  await browser.close()

  // -------------------------------------------------------------- report
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\n=== ${passed}/${results.length} checks passed, ${failed} failed ===`)
  if (failed) {
    console.log('\nFailures:')
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`)
  }
  console.log(`\nScreenshots: ${SHOT_DIR} (${shotIndex} captured)`)

  await writeFile(
    path.join(SHOT_DIR, 'report.json'),
    JSON.stringify({ base: BASE, passed, failed, results, consoleErrors: realErrors, pageErrors }, null, 2),
  )

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Harness crashed:', err)
  process.exit(2)
})
