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
import { existsSync } from 'node:fs'
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
const failedRequests = []
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

/**
 * Screen position of the work-center node carrying `code`, or null if it is
 * not currently on screen. Used to catch a canvas PAN masquerading as a drag:
 * a real load-move never has to move any node other than the ghost, so a
 * third node drifting during the gesture means the whole stage scrolled.
 */
async function nodeAnchor(page, code) {
  return page.evaluate((needle) => {
    for (const el of Array.from(document.querySelectorAll('svg text, svg g'))) {
      const t = (el.textContent || '').replace(/\s+/g, '')
      if (!t.startsWith(needle)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    return null
  }, code)
}

/**
 * Whether the drag ghost is on screen mid-gesture. The ghost is the product's
 * own "what is being moved" readout (DragGhost in DragLayer.tsx, the only
 * role="status" element the canvas renders) — its presence is a live signal
 * that a load-move gesture is in progress, not a pan.
 *
 * Its TEXT changes with what is under the pointer: "Drop on a work center…"
 * before any target is hovered, replaced by a classification verdict
 * ("Approved" / "Needs qualification" / "Needs retrofit" / "Drop refused")
 * the moment a candidate is. Both are the ghost doing its job, so the
 * presence check does not require a specific wording.
 */
async function readDragState(page) {
  return page.evaluate(() => {
    const status = document.querySelector('[role="status"]')
    return {
      ghostVisible: status !== null,
      ghostText: status ? (status.textContent || '').trim().slice(0, 160) : null,
    }
  })
}

/**
 * The work-center register, keyed by code — every row carries that work
 * center's mean and peak utilisation for the ACTIVE scenario, so this is the
 * app's own reading of where the load sits.
 */
async function workCenterLoadRows(page) {
  await page.goto(`${BASE}/#/workcenters`, { waitUntil: 'load' })
  await page.waitForTimeout(4000)
  return page.evaluate(() => {
    const out = {}
    for (const tr of Array.from(document.querySelectorAll('tbody tr'))) {
      const t = (tr.innerText || '').replace(/\s+/g, ' ').trim()
      const m = t.match(/[A-Z]{2}-[A-Z]{3}-WC\d{3}/)
      if (m && !(m[0] in out)) out[m[0]] = t
    }
    return out
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

  // The environment ships a pinned Chromium at PLAYWRIGHT_BROWSERS_PATH whose
  // build number need not match the npm playwright package's expectation, and
  // `playwright install` is not available here. Point at the real binary when
  // it exists and let Playwright resolve normally otherwise.
  const explicit = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  const launchOpts = {
    headless: !args.includes('--headed'),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  }
  if (existsSync(explicit)) launchOpts.executablePath = explicit
  const browser = await chromium.launch(launchOpts)
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  const page = await context.newPage()

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300))
  })
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 300)))
  // A bare "Failed to load resource" console line names no URL, which makes it
  // unactionable. Capture the actual failing request instead.
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`)
  })
  page.on('requestfailed', (req) => {
    failedRequests.push(`FAILED ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`)
  })

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
  // The globe draws five bubbles on one map. Two of the plants are ~500km
  // apart, which at world scale is less than one bubble, so the layout has to
  // separate them: a label printed over another label is a plant that has
  // silently disappeared from the network.
  const globe = await page.evaluate(() => {
    const codes = Array.from(document.querySelectorAll('svg text'))
      .map((t) => ({ text: (t.textContent || '').trim(), box: t.getBoundingClientRect() }))
      .filter((t) => /^[A-Z]{2}-[A-Z]{3}$/.test(t.text) && t.box.width > 0)
      .map((t) => ({ text: t.text, x: t.box.x, y: t.box.y, w: t.box.width, h: t.box.height }))
    const overlaps = []
    for (let i = 0; i < codes.length; i += 1) {
      for (let j = i + 1; j < codes.length; j += 1) {
        const a = codes[i]
        const b = codes[j]
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          overlaps.push(`${a.text}/${b.text}`)
        }
      }
    }
    const hudEl = document.querySelector('[class*="hud"]')
    const hud = hudEl ? hudEl.getBoundingClientRect() : null
    const hidden = hud
      ? codes.filter((c) => c.x < hud.x + hud.width && hud.x < c.x + c.w && c.y < hud.y + hud.height && hud.y < c.y + c.h)
      : []
    return { count: codes.length, labels: codes.map((c) => c.text), overlaps, hidden: hidden.map((c) => c.text) }
  })
  record(
    'Every plant on the globe carries its own readable label',
    globe.count >= 5 && globe.overlaps.length === 0,
    `${globe.count} labels (${globe.labels.join(', ')}), ${globe.overlaps.length} colliding${globe.overlaps.length ? `: ${globe.overlaps.join(' ')}` : ''}`,
  )
  record(
    'No plant label is buried under the canvas legend',
    globe.hidden.length === 0,
    globe.hidden.length ? globe.hidden.join(', ') : 'all clear of the HUD',
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

    // Changing the breadcrumb is not drilling. The canvas itself has to travel:
    // globe -> plant means the plant's work centers are on screen.
    const drilled = await page.evaluate(() => {
      const text = document.getElementById('root')?.innerText || ''
      return {
        workCenterNodes: (text.match(/[A-Z]{2}-[A-Z]{3}-WC\d{3}/g) || []).length,
        circles: document.querySelectorAll('svg circle').length,
      }
    })
    record(
      'A single click drills the canvas into the plant layer',
      drilled.workCenterNodes > 5 && drilled.circles > net.counts.svg,
      `${drilled.workCenterNodes} work-center codes drawn, ${drilled.circles} circles`,
    )

    // Backspace is the way back out, and it has to actually come back out.
    await page.evaluate(() => {
      const stage = document.querySelector('[role="application"]')
      if (stage instanceof HTMLElement) stage.focus()
    })
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(1200)
    const out = await page.evaluate(
      () => ((document.getElementById('root')?.innerText || '').match(/[A-Z]{2}-[A-Z]{3}-WC\d{3}/g) || []).length,
    )
    record('Backspace zooms back out one level', out < drilled.workCenterNodes, `${drilled.workCenterNodes} -> ${out} work-center codes`)
  } else {
    record('Plant node clickable', false, 'no svg circle found to click')
  }

  // --------------------------------------------------------- plant layer
  //
  // The plant layer is the screen this product is judged on, and it has two
  // failure modes that a "did anything render?" check sails straight past: the
  // work centers can be drawn correctly but too small to read, and the
  // capability graph can bury them under hundreds of near-parallel curves.
  // Both are measured here in rendered pixels rather than in element counts.
  console.log('\nPLANT LAYER')
  await page.evaluate(() => {
    const circles = Array.from(document.querySelectorAll('[role="application"] svg circle'))
    const biggest = circles.sort(
      (a, b) => Number(b.getAttribute('r') || 0) - Number(a.getAttribute('r') || 0),
    )[0]
    biggest?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(2000)
  await shot(page, 'plant-layer')

  /** Where the plant's own work-center marks are, in stage pixels. */
  const readPlant = () =>
    page.evaluate(() => {
      const app = document.querySelector('[role="application"]')
      if (!app) return null
      const stage = app.getBoundingClientRect()
      const codes = Array.from(app.querySelectorAll('svg text'))
        .filter((t) => /^[A-Z]{2}-[A-Z]{3}-WC\d{3}$/.test((t.textContent || '').trim()))
        .map((t) => t.getBoundingClientRect())
        .filter((b) => b.width > 0 && b.height > 0)
      if (!codes.length) return { stage: { w: stage.width, h: stage.height }, count: 0 }
      const left = Math.min(...codes.map((b) => b.left))
      const right = Math.max(...codes.map((b) => b.right))
      const top = Math.min(...codes.map((b) => b.top))
      const bottom = Math.max(...codes.map((b) => b.bottom))
      // The tallest glyph run in a node label — its rendered size, after the
      // canvas transform, which is the only size a reader actually gets.
      const glyph = Math.max(
        ...Array.from(app.querySelectorAll('svg text tspan'))
          .filter((t) => /^WC\d{3}$/.test((t.textContent || '').trim()))
          .map((t) => t.getBoundingClientRect().height),
        0,
      )
      const svgEdges = app.querySelectorAll('[class*="edgeGroup"] path').length
      return {
        stage: { w: stage.width, h: stage.height },
        count: codes.length,
        spanX: (right - left) / stage.width,
        spanY: (bottom - top) / stage.height,
        glyph,
        svgEdges,
        footer: document.querySelector('[class*="footerNote"]')?.textContent || '',
      }
    })

  const plant = await readPlant()
  if (plant && plant.count > 5) {
    // Fitting to the off-plant satellites left the plant's own machines at
    // roughly a third of the frame. They are the content; they get the frame.
    record(
      'The plant fills its frame with its own work centers',
      plant.spanX > 0.6 && plant.spanY > 0.5,
      `marks span ${(plant.spanX * 100).toFixed(0)}% x ${(plant.spanY * 100).toFixed(0)}% of the ` +
        `${Math.round(plant.stage.w)}x${Math.round(plant.stage.h)} stage`,
    )
    // A label the reader has to zoom in to read conveys nothing at rest.
    record(
      'Work-center codes are legible without zooming',
      plant.glyph >= 8,
      `node code renders at ${plant.glyph.toFixed(1)}px tall`,
    )
    // Hundreds of dashed curves fanning to the other four plants is noise, not
    // information. Nothing is hovered or selected here, so nothing is asked for.
    record(
      'Capability edges stay quiet until they are asked for',
      plant.svgEdges <= 24,
      `${plant.svgEdges} edge paths drawn with nothing selected`,
    )
    record(
      'The other plants are docked rather than scattered',
      /partner plants docked/.test(plant.footer),
      plant.footer.trim() || 'no footer note',
    )
  } else {
    record('Plant layer drew its work centers', false, `${plant ? plant.count : 0} codes found`)
  }

  // The toggle is the escape hatch, and it has to be a real, named control.
  const showAll = page.getByRole('button', { name: /show all links/i })
  if ((await showAll.count()) > 0) {
    await showAll.click()
    await page.waitForTimeout(900)
    await shot(page, 'plant-all-links')
    const opened = await readPlant()
    const canvasEdges = await page.evaluate(
      () => document.querySelectorAll('[role="application"] canvas').length,
    )
    record(
      'Showing all capability links is one keyboard-reachable toggle away',
      (opened && opened.svgEdges > (plant?.svgEdges ?? 0)) || canvasEdges > 0,
      `${plant?.svgEdges ?? 0} -> ${opened ? opened.svgEdges : 0} svg edges, ${canvasEdges} edge canvas`,
    )
    const back = page.getByRole('button', { name: /show selected only/i })
    if ((await back.count()) > 0) await back.click()
    await page.waitForTimeout(500)
  } else {
    record('Capability edge toggle exists', false, 'no "show all links" button found')
  }

  // Anything clickable is operable by keyboard, and that includes the dock.
  const nodeCount = Number((plant?.footer || '').match(/(\d+)\s+work centers/)?.[1] || 0)
  if (nodeCount > 0) {
    await page.evaluate(() => {
      const stage = document.querySelector('[role="application"]')
      if (stage instanceof HTMLElement) stage.focus()
    })
    const before = await page.evaluate(
      () => ((document.getElementById('root')?.innerText || '').match(/[A-Z]{2}-[A-Z]{3}-WC\d{3}/g) || []).length,
    )
    // Tab walks every work center, then arrives at the first dock card.
    for (let i = 0; i <= nodeCount; i += 1) await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    await shot(page, 'plant-dock-open')
    const after = await page.evaluate(
      () => ((document.getElementById('root')?.innerText || '').match(/[A-Z]{2}-[A-Z]{3}-WC\d{3}/g) || []).length,
    )
    record(
      'The partner dock opens from the keyboard alone',
      after > before,
      `${before} -> ${after} work-center codes after Tab x${nodeCount + 1} then Enter`,
    )
  } else {
    record('Plant footer reports its work-center count', false, plant?.footer || 'no footer note')
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

  const starterButtons = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('button'))
        .map((b) => (b.textContent || '').trim())
        .filter((t) => t.length > 0 && t.length < 60).length,
  )
  record('Scenarios screen offers actions', starterButtons > 3, `${starterButtons} buttons`)

  // --------------------------------------------- applying a move (the core)
  // Drive the Cockpit's utilisation-ceiling slider. It writes a real
  // `utilisationCeiling` move through applyMove, so this exercises the whole
  // loop: move -> worker re-run -> new numbers -> undo.
  console.log('\nAPPLY A MOVE + UNDO')
  await page.goto(`${BASE}/#/`, { waitUntil: 'load' })
  await page.waitForTimeout(3000)

  const sliderInfo = await page.evaluate(() => {
    const s = document.querySelector('input[type="range"]')
    if (!s) return null
    return { value: s.value, min: s.min, max: s.max, step: s.step }
  })
  if (!sliderInfo) {
    record('Utilisation ceiling control present', false, 'no input[type=range] on the cockpit')
  } else {
    const kpiBefore = await numericFingerprint(page)
    // Keyboard-drive it: this also proves the control is keyboard operable.
    const slider = page.locator('input[type="range"]').first()
    await slider.focus()
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(3500)
    const kpiAfter = await numericFingerprint(page)
    const changed = kpiBefore.filter((v, i) => kpiAfter[i] !== v).length
    const sliderAfter = await page.evaluate(
      () => document.querySelector('input[type="range"]')?.value ?? null,
    )
    record(
      'Lowering the ceiling re-runs the model',
      changed > 0 && sliderAfter !== sliderInfo.value,
      `ceiling ${sliderInfo.value} -> ${sliderAfter}, ${changed} values changed`,
    )
    await shot(page, 'ceiling-lowered')

    // The baseline is read-only, so applying a move must have forked a scenario.
    const forked = await page.evaluate(() => {
      const t = document.getElementById('root')?.innerText || ''
      return !/read-?only/i.test(t) || /scenario 1/i.test(t)
    })
    record('Applying a move forks off the read-only baseline', forked, 'baseline stays immutable')

    const undone = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button'))
      const u = all.find(
        (b) =>
          /^undo$/i.test((b.textContent || '').trim()) ||
          /undo/i.test(b.getAttribute('aria-label') || '') ||
          /undo/i.test(b.getAttribute('title') || ''),
      )
      if (!u || u.disabled) return false
      u.click()
      return true
    })
    if (undone) {
      await page.waitForTimeout(3500)
      const back = await page.evaluate(
        () => document.querySelector('input[type="range"]')?.value ?? null,
      )
      record('Undo restores the previous ceiling', back === sliderInfo.value, `${sliderAfter} -> ${back} (was ${sliderInfo.value})`)
      await shot(page, 'ceiling-undone')
    } else {
      record('Undo control is available after a move', false, 'no enabled undo button found')
    }
  }

  // ------------------------------------------------ drag load between machines
  // The headline interaction of the whole product: drag a saturated work
  // center's load onto one that can take it, with the move applying at once.
  // Driven with real pointer events, not a synthesised click.
  console.log('\nDRAG LOAD BETWEEN WORK CENTERS')
  // Where the load sits BEFORE the drag, per work center. "A move object was
  // recorded" is not the promise the product makes, and a page-wide numeric
  // fingerprint is not proof either — forking a scenario changes numbers on
  // the chrome all by itself. Only the source's and the target's own
  // utilisation can say whether load actually relocated.
  const loadBeforeDrag = await workCenterLoadRows(page)

  await page.goto(`${BASE}/#/network`, { waitUntil: 'load' })
  await page.waitForTimeout(3000)

  // Drill into a plant so work-center nodes are on screen.
  const drilled = await page.evaluate(() => {
    const circles = Array.from(document.querySelectorAll('svg circle'))
    if (!circles.length) return false
    const biggest = circles.sort(
      (a, b) => Number(b.getAttribute('r') || 0) - Number(a.getAttribute('r') || 0),
    )[0]
    const r = biggest?.getBoundingClientRect()
    if (!r) return false
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (drilled && typeof drilled === 'object') {
    await page.mouse.click(drilled.x, drilled.y)
    await page.waitForTimeout(2500)
  }

  const nodeBoxes = await page.evaluate(() => {
    // Work-center nodes carry their full code, e.g. CN-SUZ-WC005.
    const out = []
    for (const el of Array.from(document.querySelectorAll('svg text, svg g'))) {
      const t = (el.textContent || '').replace(/\s+/g, '')
      const m = t.match(/^[A-Z]{2}-[A-Z]{3}-WC\d{3}/)
      if (!m) continue
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      if (out.some((o) => o.code === m[0])) continue
      out.push({ code: m[0], x: r.x + r.width / 2, y: r.y + r.height / 2 })
      if (out.length >= 12) break
    }
    return out
  })
  record('Plant layer exposes draggable work-center nodes', nodeBoxes.length >= 2, `${nodeBoxes.length} nodes located`)

  if (nodeBoxes.length >= 2) {
    const movesBefore = await page.evaluate(() => {
      const t = document.getElementById('root')?.innerText || ''
      const m = t.match(/(\d+)\s+moves?\s+on/i)
      return m ? Number(m[1]) : 0
    })
    // Drag the way the product tells the planner to: off the most saturated
    // node on screen, onto the one with the most room. Grabbing an arbitrary
    // node can pick one carrying no load at all, and "nothing moved because
    // there was nothing to move" would prove nothing either way.
    const meanUtil = (code) => {
      const row = loadBeforeDrag[code]
      const m = row ? row.match(/(\d+)%\s+(\d+)%/) : null
      return m ? Number(m[1]) : -1
    }
    const byLoad = [...nodeBoxes].sort((a, b) => meanUtil(b.code) - meanUtil(a.code))
    const src = byLoad[0]
    const dst = byLoad[byLoad.length - 1]
    const bystander = byLoad.find((n) => n.code !== src.code && n.code !== dst.code) ?? nodeBoxes[1]
    /** Where a node that is neither end of the drag sits, to catch a stray pan. */
    const anchorBefore = await nodeAnchor(page, bystander.code)
    await page.mouse.move(src.x, src.y)
    await page.mouse.down()
    // Move in steps so pointermove handlers see a genuine gesture.
    for (let i = 1; i <= 12; i += 1) {
      await page.mouse.move(
        src.x + ((dst.x - src.x) * i) / 12,
        src.y + ((dst.y - src.y) * i) / 12,
      )
      await page.waitForTimeout(30)
    }
    const inFlight = await readDragState(page)
    const anchorDuring = await nodeAnchor(page, bystander.code)
    await shot(page, 'drag-in-flight')
    await page.mouse.up()
    await page.waitForTimeout(3500)
    await shot(page, 'drag-dropped')

    // The regression this whole check exists to catch: pressing down on a
    // node and dragging must pick up load, not pan the stage. A pan moves
    // EVERY node, including ones that are neither end of the gesture.
    const bystanderDrifted =
      anchorBefore !== null &&
      anchorDuring !== null &&
      (Math.abs(anchorDuring.x - anchorBefore.x) > 6 || Math.abs(anchorDuring.y - anchorBefore.y) > 6)
    record(
      'The stage does not pan while dragging a node',
      !bystanderDrifted,
      anchorBefore === null || anchorDuring === null
        ? `${bystander.code} left the viewport mid-drag`
        : `bystander ${bystander.code} moved ${Math.round(anchorDuring.x - anchorBefore.x)},${Math.round(anchorDuring.y - anchorBefore.y)}px`,
    )
    record(
      'A ghost shows what is being moved while dragging',
      inFlight.ghostVisible && /work center|product group/i.test(inFlight.ghostText ?? ''),
      inFlight.ghostVisible ? inFlight.ghostText : 'no role="status" drag ghost found mid-gesture',
    )

    const after = await page.evaluate(() => {
      const t = document.getElementById('root')?.innerText || ''
      const m = t.match(/(\d+)\s+moves?\s+on/i)
      return { moves: m ? Number(m[1]) : 0, text: t }
    })
    // Strict: a pointer drag from one work center onto another must actually
    // create a move. Accepting "the page mentions qualification somewhere"
    // let a canvas PAN pass as a successful drag, which is exactly the bug
    // this check exists to catch.
    record(
      'Dragging one work center onto another creates a move',
      after.moves > movesBefore,
      `moves ${movesBefore} -> ${after.moves}, dragged ${src.code} -> ${dst.code}`,
    )

    // ...and the move must DO something. Recording a move object while the
    // model produced byte-identical load is the exact failure this check let
    // through for the whole time `resourceMove` was inert: no routing version
    // ran at the target work center, so every material was skipped, and
    // utilisation, overloaded weeks and capex all came back identical to
    // baseline while the scenario cheerfully reported "1 move".
    const loadAfterDrag = await workCenterLoadRows(page)
    const sourceRowChanged =
      loadBeforeDrag[src.code] !== undefined && loadAfterDrag[src.code] !== loadBeforeDrag[src.code]
    const targetRowChanged =
      loadBeforeDrag[dst.code] !== undefined && loadAfterDrag[dst.code] !== loadBeforeDrag[dst.code]
    record(
      'The drag actually relocates load, not just a move object',
      after.moves > movesBefore && (sourceRowChanged || targetRowChanged),
      `${src.code} ${loadBeforeDrag[src.code] ?? '?'} -> ${loadAfterDrag[src.code] ?? '?'} | ${dst.code} ${loadBeforeDrag[dst.code] ?? '?'} -> ${loadAfterDrag[dst.code] ?? '?'}`,
    )
    await shot(page, 'drag-load-register')
  }

  // ------------------------------------------------------- the OEE glide knob
  console.log('\nOEE GLIDE')
  await page.goto(`${BASE}/#/workcenters`, { waitUntil: 'load' })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    const row = document.querySelector('tbody tr')
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    row?.querySelector('button, [role="button"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(3000)

  const oeePresent = await page.evaluate(() => {
    const t = document.getElementById('root')?.innerText || ''
    return /oee/i.test(t)
  })
  record('Work-center detail exposes the OEE knob', oeePresent, oeePresent ? 'OEE section present' : 'no OEE section found')

  if (oeePresent) {
    const before = await numericFingerprint(page)
    // The glide end-value handle must be keyboard operable per the spec.
    const knob = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('[role="slider"], input[type="range"], [aria-valuenow]'),
      )
      const el = candidates.find((c) => {
        const label = `${c.getAttribute('aria-label') || ''} ${c.getAttribute('name') || ''}`
        return /oee|glide|ramp/i.test(label)
      })
      if (!el) return null
      el.focus?.()
      const r = el.getBoundingClientRect()
      return { tag: el.tagName, x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    if (knob) {
      for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowUp')
      await page.waitForTimeout(3000)
      const after = await numericFingerprint(page)
      const changed = before.filter((v, i) => after[i] !== v).length
      record('Turning the OEE knob re-runs the model', changed > 0, `${knob.tag}, ${changed} values changed`)
      await shot(page, 'oee-glide')
    } else {
      record('OEE glide handle is keyboard reachable', false, 'no labelled slider/handle found in the OEE section')
      await shot(page, 'oee-glide')
    }
  }

  // ---------------------------------------------------------------- data
  console.log('\nDATA')
  const data = await gotoRoute(page, '/data', 'data-admin')
  // The default tab is Plants, which legitimately has exactly five rows —
  // asserting "more than five" here was testing the wrong thing.
  record('Data screen lists master data', data.counts.rows >= 5, `${data.counts.rows} rows on the default tab`)

  // Switching to Work centers must produce many more rows, which is the real
  // proof that the tabs are wired to different datasets.
  const switched = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], button'))
    const target = tabs.find((t) => /work\s*cent/i.test(t.textContent || ''))
    if (!target) return false
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  if (switched) {
    await page.waitForTimeout(2000)
    const after = await countElements(page)
    record('Switching to the work-center tab loads 150 rows', after.rows > 100, `${after.rows} rows`)
    await shot(page, 'data-workcenters')
  } else {
    record('Data tabs are switchable', false, 'no work-center tab found')
  }

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
  const realFailures = failedRequests.filter((u) => !/favicon/i.test(u))
  const realErrors = consoleErrors.filter(
    (e) =>
      !/favicon|DevTools|Download the React DevTools|source map/i.test(e) &&
      // A generic "Failed to load resource" line is only meaningful when the
      // request behind it was not a favicon; failedRequests is the real signal.
      !(/Failed to load resource/i.test(e) && realFailures.length === 0),
  )
  record('No uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'clean')
  record('No failed network requests', realFailures.length === 0, realFailures.slice(0, 4).join(' | ') || 'clean (favicon ignored)')
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
    JSON.stringify(
      { base: BASE, passed, failed, results, consoleErrors: realErrors, pageErrors, failedRequests },
      null,
      2,
    ),
  )

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Harness crashed:', err)
  process.exit(2)
})
