/**
 * The one figure a screen is about.
 *
 * A dense cockpit needs exactly one of these per screen: the number a planner
 * came to see, set in generous negative space so the surrounding density has
 * somewhere to resolve. Everything else on the screen is a StatTile.
 *
 * Same rules as the tile — proportional digits on the figure, delta colour from
 * intent rather than sign, status as glyph plus word — at a larger size and
 * with an optional limit rail underneath.
 */

import { deltaTextColor, statusColor } from '@/charts/palette'
import { Meter } from '@/charts/Meter'
import { SparkBar } from '@/charts/SparkBar'
import { STATUS_GLYPH, deltaIsGood } from '@/charts/StatTile'
import type { HeroFigureProps } from '@/charts/types'
import styles from '@/charts/HeroFigure.module.css'

const DELTA_GLYPH = { up: '↑', down: '↓', flat: '→' } as const

export function HeroFigure({
  label,
  value,
  unit,
  caption,
  delta,
  deltaContext,
  status,
  spark,
  sparkSlot = 1,
  meter,
  secondary,
}: HeroFigureProps) {
  return (
    <section className={styles.hero}>
      <div className={styles.main}>
        <p className={styles.label}>{label}</p>
        <p className={styles.figure}>
          {value}
          {unit ? <span className={styles.unit}>{unit}</span> : null}
        </p>

        <div className={styles.meta}>
          {delta ? (
            <span
              className={styles.delta}
              style={{ color: deltaTextColor(deltaIsGood(delta.direction, delta.goodDirection)) }}
            >
              <span className={styles.deltaGlyph} aria-hidden="true">
                {DELTA_GLYPH[delta.direction]}
              </span>
              {delta.value}
            </span>
          ) : null}
          {deltaContext ? <span className={styles.context}>{deltaContext}</span> : null}
          {status ? (
            <span className={styles.status}>
              <span
                className={styles.statusGlyph}
                style={{ color: statusColor(status.level) }}
                aria-hidden="true"
              >
                {STATUS_GLYPH[status.level]}
              </span>
              {status.label}
            </span>
          ) : null}
        </div>

        {caption ? <p className={styles.caption}>{caption}</p> : null}
      </div>

      <div className={styles.side}>
        {spark && spark.length > 0 ? (
          <SparkBar values={spark} slot={sparkSlot} width={132} height={40} ariaLabel={`${label} trend`} />
        ) : null}
        {meter ? (
          <div className={styles.meterSlot}>
            <Meter
              label="Against limit"
              ratio={meter.ratio}
              valueLabel={meter.valueLabel}
              limitLabel={meter.limitLabel}
              slot={sparkSlot}
            />
          </div>
        ) : null}
        {secondary && secondary.length > 0 ? (
          <dl className={styles.secondary}>
            {secondary.map((item) => (
              <div key={item.label} className={styles.secondaryItem}>
                <dt className={styles.secondaryLabel}>{item.label}</dt>
                <dd className={styles.secondaryValue}>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  )
}
