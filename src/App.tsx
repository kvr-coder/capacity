/**
 * The application: bootstrap, routing, and the two states that exist before a
 * screen can.
 *
 * Nothing renders a screen until the worker has answered `init`. That is a
 * deliberate simplification with a real payoff — every screen below can take
 * the catalog as a fact rather than opening with a null check, and the moment
 * before the catalog exists gets a screen of its own that reports what is
 * actually happening instead of a spinner over an empty frame.
 *
 * Routing is a hash router because this app is a static bundle that has to work
 * from a file server, a GitHub Pages subpath and a domain root without anybody
 * configuring a rewrite rule.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import {
  Link,
  RouterProvider,
  createHashRouter,
  isRouteErrorResponse,
  useRouteError,
} from 'react-router-dom'
import { DEFAULT_PROFILE, profileById } from '@/data/factory'
import { initWorker, resetEngineClient } from '@/worker/client'
import { useUiStore } from '@/state/store'
import { AppShell } from '@/components/AppShell'
import { LoadingScreen } from '@/components/LoadingScreen'
import { ErrorState } from '@/components/ui'

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * Load a screen module and pick its component.
 *
 * Both a named export (`export function Cockpit`) and a default export are
 * accepted. Six screens are written by six different hands against this router;
 * a mismatch in export style should be a non-event, not a blank page.
 */
function screen(
  load: () => Promise<unknown>,
  name: string,
): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const loaded = await load()
    if (typeof loaded !== 'object' || loaded === null) {
      throw new Error(`The ${name} screen module did not load.`)
    }
    const record = loaded as Record<string, unknown>
    const picked = record[name] ?? record['default']
    if (typeof picked !== 'function') {
      throw new Error(
        `The ${name} screen exports no component — expected a named \`${name}\` or a default export.`,
      )
    }
    return { default: picked as ComponentType }
  })
}

const Cockpit = screen(() => import('@/routes/Cockpit'), 'Cockpit')
const NetworkMap = screen(() => import('@/routes/NetworkMap'), 'NetworkMap')
const WorkCenters = screen(() => import('@/routes/WorkCenters'), 'WorkCenters')
const Products = screen(() => import('@/routes/Products'), 'Products')
const Scenarios = screen(() => import('@/routes/Scenarios'), 'Scenarios')
const DataAdmin = screen(() => import('@/routes/DataAdmin'), 'DataAdmin')

// ---------------------------------------------------------------------------
// Error element
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'The screen failed for a reason it did not name.'
}

/**
 * What a screen that threw looks like. The real message is shown — a screen
 * that fails silently and says "something went wrong" costs whoever is holding
 * the bug an afternoon.
 */
function RouteError() {
  const error = useRouteError()
  const workerError = useUiStore((state) => state.error)
  return (
    <div style={{ padding: 'var(--space-5)' }}>
      <ErrorState
        title="This screen could not render"
        message={messageOf(error)}
        detail={
          workerError === null ? (
            <>
              The model is still running; the failure is in this screen rather than in the
              engine. Another screen will still work.
            </>
          ) : (
            <>The engine also reported: {workerError}</>
          )
        }
      />
      <p style={{ marginTop: 'var(--space-4)', textAlign: 'center' }}>
        <Link to="/">Back to the cockpit</Link>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Cockpit />, errorElement: <RouteError /> },
      { path: 'network', element: <NetworkMap />, errorElement: <RouteError /> },
      { path: 'workcenters', element: <WorkCenters />, errorElement: <RouteError /> },
      { path: 'products', element: <Products />, errorElement: <RouteError /> },
      { path: 'scenarios', element: <Scenarios />, errorElement: <RouteError /> },
      { path: 'data', element: <DataAdmin />, errorElement: <RouteError /> },
      { path: '*', element: <UnknownRoute /> },
    ],
  },
])

function UnknownRoute() {
  return (
    <div style={{ padding: 'var(--space-5)' }}>
      <ErrorState
        title="No such screen"
        message="That address does not match any of the six screens."
        detail={<Link to="/">Back to the cockpit</Link>}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

interface Progress {
  phase: string
  pct: number
}

export function App() {
  const status = useUiStore((state) => state.status)
  const error = useUiStore((state) => state.error)
  const [progress, setProgress] = useState<Progress>({ phase: 'Starting the engine', pct: 0.01 })
  const [attempt, setAttempt] = useState(0)

  const profile = useMemo(() => profileById(DEFAULT_PROFILE), [])

  useEffect(() => {
    let listening = true
    initWorker({ kind: 'factory', profile: profile.id, seed: profile.seed }, (phase, pct) => {
      if (listening) setProgress({ phase, pct })
    })
      .then((result) => {
        if (!listening) return
        useUiStore.getState().setReady(result.catalog, result.timings, result.usingFallback)
      })
      .catch((cause: unknown) => {
        if (!listening) return
        useUiStore.getState().setError(messageOf(cause))
      })
    return () => {
      listening = false
    }
  }, [profile, attempt])

  const retry = useCallback(() => {
    resetEngineClient()
    setProgress({ phase: 'Starting the engine', pct: 0.01 })
    setAttempt((prior) => prior + 1)
  }, [])

  if (status !== 'ready') {
    return (
      <LoadingScreen
        phase={progress.phase}
        pct={progress.pct}
        skuCount={profile.skuCount}
        workCenterCount={profile.workCenterCount}
        weekCount={profile.weekCount}
        error={status === 'error' ? error : null}
        onRetry={retry}
      />
    )
  }

  return (
    <Suspense fallback={null}>
      <RouterProvider router={router} />
    </Suspense>
  )
}
