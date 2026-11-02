/**
 * Entry point.
 *
 * The theme is applied **before** the first paint. Reading the persisted
 * preference after React mounts would flash a light frame at someone who chose
 * dark, and that flash is the single most noticeable defect a tool like this
 * can ship.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/tokens.css'
import '@/styles/global.css'
import { App } from '@/App'
import { initTheme } from '@/state/store'

initTheme()

const host = document.getElementById('root')
if (host === null) {
  throw new Error('The page is missing its #root element; index.html and main.tsx disagree.')
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
