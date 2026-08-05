/**
 * What the app shows until the worker says `ready`.
 *
 * Generating 15,000 SKUs, 150 work centers and 78 weekly buckets takes real
 * seconds, and a spinner over those seconds is indistinguishable from a hang.
 * So this screen reports what is *actually* happening — the phase string comes
 * straight off the worker's `progress` messages — next to the counts involved,
 * because "Generating 15,000 SKUs" is a promise that something is working and
 * "Loading…" is not.
 *
 * If init fails, the same screen carries the failure and a retry. There is no
 * state in which this component shows nothing.
 */

import { units } from '@/lib/format'
import { Button, Icon } from '@/components/ui'
import styles from '@/components/LoadingScreen.module.css'

export interface LoadingScreenProps {
  /** The worker's own phase text, e.g. `Generating Standard — 15k SKUs…`. */
  phase: string
  /** 0..1. */
  pct: number
  skuCount: number
  workCenterCount: number
  weekCount: number
  /** Set when init failed. The phase is then the last thing that worked. */
  error?: string | null
  onRetry?: () => void
}

interface Step {
  id: string
  label: string
  detail: string
}

/**
 * The three things init actually does. Ordering matches the worker's own
 * sequence, so the checkmarks land in the order a reader watches them.
 */
function steps(skuCount: number, workCenterCount: number, weekCount: number): Step[] {
  return [
    {
      id: 'generate',
      label: 'Generating master data',
      detail: `${units(skuCount)} SKUs · ${units(workCenterCount)} work centers · routings, calendars and two plans`,
    },
    {
      id: 'index',
      label: 'Building indexes',
      detail: 'Allow-lists, feature sets, routing lookups and plan rows',
    },
    {
      id: 'run',
      label: 'Running the baseline',
      detail: `${units(workCenterCount * 2 * weekCount)} capacity cells across ${weekCount} weekly buckets`,
    },
  ]
}

/** Which step the worker's phase text belongs to. `-1` means "not started". */
function activeStep(phase: string): number {
  const text = phase.toLowerCase()
  if (text.startsWith('generating') || text.startsWith('parsing') || text.startsWith('seed')) return 0
  if (text.startsWith('indexing')) return 1
  if (text.startsWith('running')) return 2
  if (text.startsWith('ready')) return 3
  return 0
}

export function LoadingScreen({
  phase,
  pct,
  skuCount,
  workCenterCount,
  weekCount,
  error,
  onRetry,
}: LoadingScreenProps) {
  const list = steps(skuCount, workCenterCount, weekCount)
  const current = activeStep(phase)
  const failed = error !== undefined && error !== null && error !== ''
  const percent = Math.round(Math.max(0, Math.min(1, pct)) * 100)

  return (
    <div className={styles.screen}>
      <div className={styles.panel} role="status" aria-live="polite">
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          <div>
            <p className={styles.name}>Capacity Cockpit</p>
            <p className={styles.tagline}>Five plants · four continents · 18 months of weekly buckets</p>
          </div>
        </div>

        {failed ? (
          <div className={styles.failure} role="alert">
            <p className={styles.failureTitle}>
              <Icon name="critical" size={15} />
              The model could not start
            </p>
            <p className={styles.failureMessage}>{error}</p>
            {onRetry !== undefined ? (
              <Button variant="primary" icon="reset" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <div className={styles.progress}>
              <div
                className={styles.track}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label="Model start-up"
              >
                <div className={styles.fill} style={{ width: `${percent}%` }} />
              </div>
              <span className={styles.percent}>{percent}%</span>
            </div>

            <p className={styles.phase}>{phase}</p>

            <ol className={styles.steps}>
              {list.map((step, index) => {
                const done = index < current
                const active = index === current
                return (
                  <li
                    key={step.id}
                    className={[
                      styles.step,
                      done ? styles.stepDone : '',
                      active ? styles.stepActive : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className={styles.stepMark} aria-hidden="true">
                      {done ? <Icon name="check" size={12} /> : <span className={styles.dot} />}
                    </span>
                    <span className={styles.stepText}>
                      <span className={styles.stepLabel}>{step.label}</span>
                      <span className={styles.stepDetail}>{step.detail}</span>
                    </span>
                  </li>
                )
              })}
            </ol>

            <p className={styles.foot}>
              Everything runs in this browser. No data leaves the machine, and there is no backend
              to wait for.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
