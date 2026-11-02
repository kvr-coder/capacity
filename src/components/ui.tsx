/**
 * The shared primitives.
 *
 * Everything in `routes/` and most of `charts/` draws from this file, so it is
 * the one place the product's manners are enforced rather than remembered:
 *
 * - A status is **never colour alone**. `Badge` takes a tone and always renders
 *   the matching glyph next to the word, because a red pill and an orange pill
 *   are the same pill to a large minority of the people who will use this.
 * - Every overlay is dismissible with Escape, traps focus while it is open and
 *   hands focus back to whatever opened it.
 * - Every table wears `tabular-nums`, sticks its header, virtualises past 200
 *   rows and scrolls **inside its own wrapper** — the page never moves sideways.
 * - Icons are an inline SVG sprite. No icon font, no network request, no
 *   flash of missing glyph, and they inherit `currentColor` so they are correct
 *   in both themes without a second definition.
 *
 * Colour comes from `tokens.css` through class names. There is no hex here.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { at, clamp } from '@/domain/lookup'
import styles from '@/components/ui.module.css'

// ===========================================================================
// Icon
// ===========================================================================

/**
 * The sprite. Every glyph is a 24x24 stroke drawing on `currentColor`, so one
 * definition works on a dark rail, a light card and a coloured button without
 * a variant.
 */
const ICONS = {
  cockpit: (
    <>
      <path d="M3.6 17.5a9 9 0 1 1 16.8 0" />
      <path d="M12 14.5 16 9" />
      <circle cx="12" cy="15.5" r="1.4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17Z" />
    </>
  ),
  machine: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3.5v3.5M14 3.5v3.5M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" />
    </>
  ),
  product: (
    <>
      <path d="m12 3.2 8 4.4v8.8l-8 4.4-8-4.4V7.6Z" />
      <path d="m4 7.6 8 4.4 8-4.4M12 12v8.8" />
    </>
  ),
  scenario: (
    <>
      <path d="m12 3.5 8.5 4.6L12 12.7 3.5 8.1Z" />
      <path d="m3.5 13 8.5 4.6 8.5-4.6" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
      <path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>
  ),
  undo: (
    <>
      <path d="M4 10h10a6 6 0 0 1 0 12h-4" />
      <path d="m8 6-4 4 4 4" />
    </>
  ),
  redo: (
    <>
      <path d="M20 10H10a6 6 0 0 0 0 12h4" />
      <path d="m16 6 4 4-4 4" />
    </>
  ),
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  chevronUp: <path d="m6 14.5 6-6 6 6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  chevronLeft: <path d="m14.5 6-6 6 6 6" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
    </>
  ),
  moon: <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z" />,
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M9 20.5h6M12 16.5v4" />
    </>
  ),
  good: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.2 12.4 2.6 2.6 5-5.6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.8 21 20H3Z" />
      <path d="M12 9.8v4.4" />
      <circle cx="12" cy="17.1" r="0.9" />
    </>
  ),
  serious: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.4v5.2" />
      <circle cx="12" cy="16.2" r="0.9" />
    </>
  ),
  critical: (
    <>
      <path d="M8.4 3.5h7.2L20.5 8.4v7.2L15.6 20.5H8.4L3.5 15.6V8.4Z" />
      <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.4" />
      <circle cx="12" cy="7.9" r="0.9" />
    </>
  ),
  neutral: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.4 12h7.2" />
    </>
  ),
  filter: (
    <>
      <path d="M4 5.5h16l-6.2 7.2v6l-3.6 1.8v-7.8Z" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M9.5 9.5v10" />
    </>
  ),
  download: <path d="M12 4v11m-4-4 4 4 4-4M4.5 19.5h15" />,
  upload: <path d="M12 20V9M8 13l4-4 4 4M4.5 4.5h15" />,
  arrowUp: <path d="M12 19.5V5m-5.5 6L12 5l5.5 6" />,
  arrowDown: <path d="M12 4.5V19m-5.5-6L12 19l5.5-6" />,
  command: (
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" />
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.8h5V7" />
      <path d="m6.5 7 1 13.2h9L17.5 7" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11.5" height="11.5" rx="1.5" />
      <path d="M15 5.5H5.5a1 1 0 0 0-1 1V15" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.4l3.4 2" />
    </>
  ),
  zap: <path d="M13.4 3 5.5 14h6l-1 7 8-11.4h-6Z" />,
  reset: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4" />
      <path d="M4.2 4.5v4.2h4.2" />
    </>
  ),
  drag: (
    <>
      <circle cx="9" cy="6" r="1.3" />
      <circle cx="15" cy="6" r="1.3" />
      <circle cx="9" cy="12" r="1.3" />
      <circle cx="15" cy="12" r="1.3" />
      <circle cx="9" cy="18" r="1.3" />
      <circle cx="15" cy="18" r="1.3" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h5M13 7h7M4 12h11M19 12h1M4 17h3M11 17h9" />
      <circle cx="11" cy="7" r="1.8" />
      <circle cx="17" cy="12" r="1.8" />
      <circle cx="9" cy="17" r="1.8" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.3 9.6a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.1 1-1.1 1.9" />
      <circle cx="12" cy="17.1" r="0.9" />
    </>
  ),
} as const

export type IconName = keyof typeof ICONS

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  /** Set when the icon is the only content and carries meaning on its own. */
  title?: string
}

export function Icon({ name, size = 16, className, title }: IconProps) {
  return (
    <svg
      className={[styles.icon, className ?? ''].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  )
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ===========================================================================
// Surfaces
// ===========================================================================

export interface CardProps {
  children: ReactNode
  /** Rendered as a heading row above the content. */
  title?: ReactNode
  subtitle?: ReactNode
  aside?: ReactNode
  /** Removes the inner padding, for a table or canvas that bleeds to the edge. */
  flush?: boolean
  /** Dimmed while a recompute is in flight. No skeleton, no layout jump. */
  stale?: boolean
  className?: string
  style?: CSSProperties
}

export function Card({
  children,
  title,
  subtitle,
  aside,
  flush,
  stale,
  className,
  style,
}: CardProps) {
  const headingId = useId()
  const labelled = title !== undefined
  return (
    <section
      className={cx(styles.card, stale && styles.stale, className)}
      style={style}
      aria-labelledby={labelled ? headingId : undefined}
      aria-busy={stale === true ? true : undefined}
    >
      {labelled ? (
        <header className={styles.cardHeader}>
          <div className={styles.cardTitles}>
            <h2 className={styles.cardTitle} id={headingId}>
              {title}
            </h2>
            {subtitle !== undefined ? <p className={styles.cardSubtitle}>{subtitle}</p> : null}
          </div>
          {aside !== undefined ? <div className={styles.cardAside}>{aside}</div> : null}
        </header>
      ) : null}
      <div className={flush === true ? styles.cardBodyFlush : styles.cardBody}>{children}</div>
    </section>
  )
}

export interface SectionHeadingProps {
  children: ReactNode
  /** Sits under the title in muted text — the "why am I looking at this". */
  description?: ReactNode
  aside?: ReactNode
  /** `h1` for a screen title, `h2` for a band within it. */
  level?: 1 | 2 | 3
  id?: string
}

export function SectionHeading({
  children,
  description,
  aside,
  level = 2,
  id,
}: SectionHeadingProps) {
  const Tag = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
  return (
    <div className={styles.sectionHeading}>
      <div className={styles.sectionTitles}>
        <Tag className={level === 1 ? styles.screenTitle : styles.bandTitle} id={id}>
          {children}
        </Tag>
        {description !== undefined ? (
          <p className={styles.sectionDescription}>{description}</p>
        ) : null}
      </div>
      {aside !== undefined ? <div className={styles.sectionAside}>{aside}</div> : null}
    </div>
  )
}

// ===========================================================================
// Buttons
// ===========================================================================

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle'
export type ControlSize = 'sm' | 'md'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  size?: ControlSize
  icon?: IconName
  iconRight?: IconName
  /** Fills the width of its container — for a menu or a drawer footer. */
  block?: boolean
  /** Held state, for a toggle rendered as a button. */
  pressed?: boolean
  className?: string
  children?: ReactNode
}

export function Button({
  variant = 'subtle',
  size = 'md',
  icon,
  iconRight,
  block,
  pressed,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-pressed={pressed}
      className={cx(
        styles.button,
        styles[`btn_${variant}`],
        size === 'sm' ? styles.ctlSm : styles.ctlMd,
        block === true && styles.block,
        className,
      )}
    >
      {icon !== undefined ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {children !== undefined ? <span className={styles.btnLabel}>{children}</span> : null}
      {iconRight !== undefined ? <Icon name={iconRight} size={size === 'sm' ? 13 : 15} /> : null}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconRight'> {
  icon: IconName
  /** Required — an icon-only control with no accessible name is not a control. */
  label: string
  /** Shown on hover as well; usually the label plus its shortcut. */
  hint?: string
}

export function IconButton({
  icon,
  label,
  hint,
  variant = 'ghost',
  size = 'md',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      title={hint ?? label}
      className={cx(
        styles.button,
        styles.iconButton,
        styles[`btn_${variant}`],
        size === 'sm' ? styles.ctlSm : styles.ctlMd,
        className,
      )}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
    </button>
  )
}

// ===========================================================================
// Fields
// ===========================================================================

interface FieldFrameProps {
  label: string
  hideLabel?: boolean
  hint?: ReactNode
  error?: string
  htmlFor: string
  children: ReactNode
  className?: string
}

function FieldFrame({
  label,
  hideLabel,
  hint,
  error,
  htmlFor,
  children,
  className,
}: FieldFrameProps) {
  return (
    <div className={cx(styles.field, className)}>
      <label
        className={hideLabel === true ? styles.visuallyHidden : styles.fieldLabel}
        htmlFor={htmlFor}
      >
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p className={styles.fieldError}>
          <Icon name="serious" size={12} />
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className={styles.fieldHint}>{hint}</p>
      ) : null}
    </div>
  )
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  hideLabel?: boolean
  hint?: ReactNode
  size?: ControlSize
  disabled?: boolean
  id?: string
  className?: string
}

export function Select({
  label,
  value,
  options,
  onChange,
  hideLabel,
  hint,
  size = 'md',
  disabled,
  id,
  className,
}: SelectProps) {
  const generated = useId()
  const selectId = id ?? generated
  return (
    <FieldFrame
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      htmlFor={selectId}
      className={className}
    >
      <div className={styles.selectWrap}>
        <select
          id={selectId}
          className={cx(styles.control, styles.select, size === 'sm' ? styles.ctlSm : styles.ctlMd)}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} className={styles.selectChevron} />
      </div>
    </FieldFrame>
  )
}

export interface TextFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hideLabel?: boolean
  hint?: ReactNode
  error?: string
  size?: ControlSize
  disabled?: boolean
  id?: string
  className?: string
  autoFocus?: boolean
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hideLabel,
  hint,
  error,
  size = 'md',
  disabled,
  id,
  className,
  autoFocus,
}: TextFieldProps) {
  const generated = useId()
  const fieldId = id ?? generated
  return (
    <FieldFrame
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      htmlFor={fieldId}
      className={className}
    >
      <input
        id={fieldId}
        type="text"
        className={cx(styles.control, size === 'sm' ? styles.ctlSm : styles.ctlMd)}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== undefined}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldFrame>
  )
}

export interface NumberFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Rendered after the input — "%", "h", "units". */
  suffix?: string
  hideLabel?: boolean
  hint?: ReactNode
  error?: string
  size?: ControlSize
  disabled?: boolean
  id?: string
  className?: string
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  hideLabel,
  hint,
  error,
  size = 'md',
  disabled,
  id,
  className,
}: NumberFieldProps) {
  const generated = useId()
  const fieldId = id ?? generated
  // Kept as text while typing so "1." and "" survive long enough to become a
  // number. Committing on blur is what stops a field from fighting its user.
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: string): void => {
    setDraft(null)
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    const lower = min ?? Number.NEGATIVE_INFINITY
    const upper = max ?? Number.POSITIVE_INFINITY
    onChange(clamp(parsed, lower, upper))
  }

  return (
    <FieldFrame
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      htmlFor={fieldId}
      className={className}
    >
      <div className={styles.numberWrap}>
        <input
          id={fieldId}
          type="number"
          inputMode="decimal"
          className={cx(
            styles.control,
            styles.numberInput,
            size === 'sm' ? styles.ctlSm : styles.ctlMd,
          )}
          value={draft ?? String(value)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-invalid={error !== undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value)
          }}
        />
        {suffix !== undefined ? <span className={styles.numberSuffix}>{suffix}</span> : null}
      </div>
    </FieldFrame>
  )
}

export interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** How the live readout is written — `pct`, `hours`, whatever fits. */
  format?: (value: number) => string
  hint?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
}

/**
 * A range with its value always visible.
 *
 * The native input carries the keyboard contract for free — arrows step,
 * PageUp/PageDown jump, Home/End go to the ends — and the readout beside it
 * means a planner never has to guess what 0.87 of the track means.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  hint,
  disabled,
  id,
  className,
}: SliderProps) {
  const generated = useId()
  const fieldId = id ?? generated
  const shown = format === undefined ? String(value) : format(value)
  return (
    <div className={cx(styles.field, className)}>
      <div className={styles.sliderHead}>
        <label className={styles.fieldLabel} htmlFor={fieldId}>
          {label}
        </label>
        <output className={styles.sliderValue} htmlFor={fieldId}>
          {shown}
        </output>
      </div>
      <input
        id={fieldId}
        type="range"
        className={styles.slider}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint !== undefined ? <p className={styles.fieldHint}>{hint}</p> : null}
    </div>
  )
}

export interface ToggleProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
}

export function Toggle({ label, checked, onChange, hint, disabled, id, className }: ToggleProps) {
  const generated = useId()
  const fieldId = id ?? generated
  const hintId = `${fieldId}-hint`
  return (
    <div className={cx(styles.toggleRow, className)}>
      <button
        type="button"
        id={fieldId}
        role="switch"
        aria-checked={checked}
        aria-describedby={hint !== undefined ? hintId : undefined}
        disabled={disabled}
        className={cx(styles.toggle, checked && styles.toggleOn)}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.toggleKnob} aria-hidden="true" />
      </button>
      <div className={styles.toggleText}>
        <label className={styles.toggleLabel} htmlFor={fieldId}>
          {label}
        </label>
        {hint !== undefined ? (
          <p className={styles.fieldHint} id={hintId}>
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: IconName
  /** Shown on hover; the label stays short so the control stays narrow. */
  hint?: string
}

export interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  options: Array<SegmentedOption<T>>
  onChange: (value: T) => void
  size?: ControlSize
  /** Icons only, with the label as the accessible name. */
  compact?: boolean
  className?: string
}

/**
 * A small set of mutually exclusive choices, shown all at once.
 *
 * Rendered as a radio group rather than a row of buttons: arrow keys move
 * between the options and only the selected one is a tab stop, which is what a
 * keyboard user expects from something that looks like this.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  compact,
  className,
}: SegmentedControlProps<T>) {
  const move = (delta: number): void => {
    const index = options.findIndex((option) => option.value === value)
    const next = at(options, (index + delta + options.length) % options.length, 'segment')
    onChange(next.value)
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(styles.segmented, size === 'sm' ? styles.ctlSm : styles.ctlMd, className)}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        }
      }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={compact === true ? option.label : undefined}
            title={option.hint ?? option.label}
            tabIndex={selected ? 0 : -1}
            className={cx(styles.segment, selected && styles.segmentOn)}
            onClick={() => onChange(option.value)}
          >
            {option.icon !== undefined ? <Icon name={option.icon} size={14} /> : null}
            {compact === true ? null : <span>{option.label}</span>}
          </button>
        )
      })}
    </div>
  )
}

// ===========================================================================
// Multi-select
// ===========================================================================

export interface MultiSelectOption {
  value: string
  label: string
  /** 1..5 paints the colour chip. Plants carry theirs; nothing else does. */
  slot?: 1 | 2 | 3 | 4 | 5
  hint?: string
}

export interface MultiSelectProps {
  label: string
  options: MultiSelectOption[]
  /** **Empty means ALL**, never none. The summary says so out loud. */
  value: string[]
  onChange: (next: string[]) => void
  /** Plural noun for the summary: "plants" -> "All plants" / "3 plants". */
  noun: string
  hideLabel?: boolean
  size?: ControlSize
  disabled?: boolean
  className?: string
  /** Adds a type-to-filter box once the list is long. */
  searchable?: boolean
}

/**
 * An accessible combobox with checkboxes.
 *
 * The empty selection is "all", which is the only sane default for a filter
 * over 150 work centers — and because that is a rule a reader cannot infer, the
 * trigger says "All work centers" rather than showing nothing.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  noun,
  hideLabel,
  size = 'md',
  disabled,
  className,
  searchable,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()
  const labelId = useId()

  const selected = useMemo(() => new Set(value), [value])
  const showSearch = searchable ?? options.length > 8

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return options
    return options.filter((option) => option.label.toLowerCase().includes(needle))
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const node = rootRef.current
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const summary =
    value.length === 0
      ? `All ${noun}`
      : value.length === 1
        ? (options.find((option) => option.value === at(value, 0, 'selection'))?.label ??
          `1 ${noun.replace(/s$/, '')}`)
        : `${value.length} ${noun}`

  const toggle = (optionValue: string): void => {
    if (selected.has(optionValue)) onChange(value.filter((v) => v !== optionValue))
    else onChange([...value, optionValue])
  }

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (visible.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((prior) => (prior + 1) % visible.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((prior) => (prior - 1 + visible.length) % visible.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActive(visible.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const option = visible[clamp(active, 0, visible.length - 1)]
      if (option !== undefined) toggle(option.value)
    }
  }

  return (
    <div className={cx(styles.multi, className)} ref={rootRef}>
      <span
        className={hideLabel === true ? styles.visuallyHidden : styles.fieldLabel}
        id={labelId}
      >
        {label}
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelId}
        className={cx(
          styles.control,
          styles.multiTrigger,
          size === 'sm' ? styles.ctlSm : styles.ctlMd,
          value.length > 0 && styles.multiActive,
        )}
        onClick={() => {
          setOpen((prior) => !prior)
          setActive(0)
        }}
      >
        <span className={styles.multiSummary}>{summary}</span>
        <Icon name="chevronDown" size={13} className={styles.selectChevron} />
      </button>

      {open ? (
        <div className={styles.popover} onKeyDown={onListKeyDown}>
          {showSearch ? (
            <div className={styles.popoverSearch}>
              <Icon name="search" size={13} />
              <input
                type="text"
                className={styles.popoverSearchInput}
                placeholder={`Filter ${noun}`}
                value={query}
                autoFocus
                aria-label={`Filter ${noun}`}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActive(0)
                }}
              />
            </div>
          ) : null}

          <div className={styles.popoverActions}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => onChange(options.map((option) => option.value))}
            >
              Select all
            </button>
            <button type="button" className={styles.linkButton} onClick={() => onChange([])}>
              Clear
            </button>
          </div>

          <ul className={styles.optionList} role="listbox" aria-multiselectable="true" id={listId}>
            {visible.length === 0 ? (
              <li className={styles.optionEmpty}>Nothing matches “{query}”</li>
            ) : null}
            {visible.map((option, index) => {
              const isSelected = selected.has(option.value)
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={cx(styles.option, index === active && styles.optionActive)}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => toggle(option.value)}
                  >
                    <span className={cx(styles.checkbox, isSelected && styles.checkboxOn)}>
                      {isSelected ? <Icon name="check" size={11} /> : null}
                    </span>
                    {option.slot !== undefined ? (
                      <span
                        className={cx(styles.chipDot, styles[`slot${option.slot}`])}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className={styles.optionLabel}>{option.label}</span>
                    {option.hint !== undefined ? (
                      <span className={styles.optionHint}>{option.hint}</span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>

          <p className={styles.popoverFoot}>
            {value.length === 0 ? `Nothing selected means all ${noun}.` : `${value.length} selected`}
          </p>
        </div>
      ) : null}
    </div>
  )
}

// ===========================================================================
// Status marks
// ===========================================================================

export type BadgeTone = 'neutral' | 'good' | 'warning' | 'serious' | 'critical'

const BADGE_ICON: Record<BadgeTone, IconName> = {
  neutral: 'neutral',
  good: 'good',
  warning: 'warning',
  serious: 'serious',
  critical: 'critical',
}

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  size?: ControlSize
  className?: string
}

/**
 * A status mark. **Always icon plus text** — the icon is not decoration and
 * cannot be turned off, because the colour alone is not a signal everyone
 * receives.
 */
export function Badge({ tone = 'neutral', children, size = 'md', className }: BadgeProps) {
  return (
    <span
      className={cx(
        styles.badge,
        styles[`tone_${tone}`],
        size === 'sm' ? styles.badgeSm : '',
        className,
      )}
    >
      <Icon name={BADGE_ICON[tone]} size={size === 'sm' ? 11 : 12} />
      <span>{children}</span>
    </span>
  )
}

export interface PillProps {
  children: ReactNode
  /** A dismissible pill grows an x. Used for active filters. */
  onRemove?: () => void
  removeLabel?: string
  className?: string
}

export function Pill({ children, onRemove, removeLabel, className }: PillProps) {
  return (
    <span className={cx(styles.pill, className)}>
      <span>{children}</span>
      {onRemove !== undefined ? (
        <button
          type="button"
          className={styles.pillRemove}
          aria-label={removeLabel ?? 'Remove'}
          onClick={onRemove}
        >
          <Icon name="close" size={11} />
        </button>
      ) : null}
    </span>
  )
}

export interface ChipProps {
  children: ReactNode
  /** The entity's permanent categorical slot. Colour follows the entity. */
  slot?: 1 | 2 | 3 | 4 | 5 | 'other'
  /** Any CSS colour *token reference* — e.g. a `var(--status-good)` from a scale. */
  color?: string
  className?: string
  title?: string
}

/**
 * A label with a colour key beside it. The mark sits *next to* the text and the
 * text never wears the series colour — that rule is why this component exists
 * instead of a coloured `<span>`.
 */
export function Chip({ children, slot, color, className, title }: ChipProps) {
  const slotClass = slot === undefined ? '' : slot === 'other' ? styles.slotOther : styles[`slot${slot}`]
  return (
    <span className={cx(styles.chip, className)} title={title}>
      <span
        className={cx(styles.chipDot, slotClass)}
        style={color === undefined ? undefined : { background: color }}
        aria-hidden="true"
      />
      <span className={styles.chipLabel}>{children}</span>
    </span>
  )
}

// ===========================================================================
// States
// ===========================================================================

export interface EmptyStateProps {
  /** What is missing, in the planner's words — never "no data". */
  title: string
  description?: ReactNode
  action?: ReactNode
  icon?: IconName
  className?: string
}

export function EmptyState({
  title,
  description,
  action,
  icon = 'filter',
  className,
}: EmptyStateProps) {
  return (
    <div className={cx(styles.state, className)} role="status">
      <Icon name={icon} size={22} className={styles.stateIcon} />
      <p className={styles.stateTitle}>{title}</p>
      {description !== undefined ? <p className={styles.stateBody}>{description}</p> : null}
      {action !== undefined ? <div className={styles.stateAction}>{action}</div> : null}
    </div>
  )
}

export interface ErrorStateProps {
  title?: string
  /** The real message. Never swallowed, never replaced with "something failed". */
  message: string
  detail?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  className?: string
}

export function ErrorState({
  title = 'The model could not answer',
  message,
  detail,
  onRetry,
  retryLabel = 'Try again',
  className,
}: ErrorStateProps) {
  return (
    <div className={cx(styles.state, styles.stateError, className)} role="alert">
      <Icon name="critical" size={22} className={styles.stateIconError} />
      <p className={styles.stateTitle}>{title}</p>
      <p className={styles.stateMessage}>{message}</p>
      {detail !== undefined ? <div className={styles.stateBody}>{detail}</div> : null}
      {onRetry !== undefined ? (
        <div className={styles.stateAction}>
          <Button variant="primary" icon="reset" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

// ===========================================================================
// Overlays
// ===========================================================================

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Escape closes, Tab cycles inside, and focus goes back where it came from.
 *
 * All three are the same requirement wearing different clothes: an overlay must
 * not strand a keyboard user, and it must not silently move them somewhere else
 * when it closes.
 */
function useOverlay(open: boolean, onClose: () => void, panel: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusFirst = (): void => {
      const node = panel.current
      if (node === null) return
      const targets = node.querySelectorAll<HTMLElement>(FOCUSABLE)
      const first = targets.item(0)
      if (first !== null) first.focus()
      else node.focus()
    }
    // One frame late, so the panel exists and any autoFocus has landed first.
    const raf = requestAnimationFrame(focusFirst)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const node = panel.current
      if (node === null) return
      const targets = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      )
      if (targets.length === 0) {
        event.preventDefault()
        return
      }
      const first = at(targets, 0, 'focusable')
      const last = at(targets, targets.length - 1, 'focusable')
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      if (opener !== null && document.contains(opener)) opener.focus()
    }
  }, [open, onClose, panel])
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  /** Buttons for the bottom-right. The primary action goes last. */
  footer?: ReactNode
  width?: number
}

export function Modal({ open, onClose, title, description, children, footer, width = 520 }: ModalProps) {
  const panel = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const descId = useId()
  useOverlay(open, onClose, panel)

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className={styles.scrim} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descId}
        className={styles.modal}
        style={{ maxWidth: width }}
        tabIndex={-1}
      >
        <header className={styles.overlayHeader}>
          <div>
            <h2 className={styles.overlayTitle} id={titleId}>
              {title}
            </h2>
            {description !== undefined ? (
              <p className={styles.overlayDescription} id={descId}>
                {description}
              </p>
            ) : null}
          </div>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
        </header>
        <div className={styles.overlayBody}>{children}</div>
        {footer !== undefined ? <footer className={styles.overlayFooter}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  side?: 'right' | 'left'
  width?: number
}

/** The detail panel: a work center, a move, a SKU. Same contract as `Modal`. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = 'right',
  width = 460,
}: DrawerProps) {
  const panel = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  useOverlay(open, onClose, panel)

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(styles.drawer, side === 'left' ? styles.drawerLeft : styles.drawerRight)}
        style={{ width }}
        tabIndex={-1}
      >
        <header className={styles.overlayHeader}>
          <div>
            <h2 className={styles.overlayTitle} id={titleId}>
              {title}
            </h2>
            {description !== undefined ? (
              <p className={styles.overlayDescription}>{description}</p>
            ) : null}
          </div>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
        </header>
        <div className={styles.overlayBody}>{children}</div>
        {footer !== undefined ? <footer className={styles.overlayFooter}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}

// ===========================================================================
// Tabs
// ===========================================================================

export interface TabItem {
  id: string
  label: string
  icon?: IconName
  /** A count or a status mark rendered after the label. */
  badge?: ReactNode
}

export interface TabsProps {
  label: string
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  className?: string
}

/**
 * Roving tabindex: one tab stop for the whole strip, arrows move within it.
 * Tabbing into a tablist and then having to tab through nine tabs to reach the
 * panel is the most common way this control is got wrong.
 */
export function Tabs({ label, items, value, onChange, className }: TabsProps) {
  const refs = useRef<Map<string, HTMLButtonElement>>(new Map())

  const move = (delta: number): void => {
    const index = items.findIndex((item) => item.id === value)
    const next = at(items, (index + delta + items.length) % items.length, 'tab')
    onChange(next.id)
    refs.current.get(next.id)?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx(styles.tabs, className)}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          move(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onChange(at(items, 0, 'tab').id)
        } else if (event.key === 'End') {
          event.preventDefault()
          onChange(at(items, items.length - 1, 'tab').id)
        }
      }}
    >
      {items.map((item) => {
        const selected = item.id === value
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node === null) refs.current.delete(item.id)
              else refs.current.set(item.id, node)
            }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            className={cx(styles.tab, selected && styles.tabOn)}
            onClick={() => onChange(item.id)}
          >
            {item.icon !== undefined ? <Icon name={item.icon} size={14} /> : null}
            <span>{item.label}</span>
            {item.badge !== undefined ? <span className={styles.tabBadge}>{item.badge}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/** The panel a `Tabs` strip controls. Pairs the aria wiring up correctly. */
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  )
}

// ===========================================================================
// Tooltip
// ===========================================================================

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  placement?: 'top' | 'bottom'
  className?: string
}

/**
 * Hover **and** focus, because a tooltip only reachable by mouse is not a
 * tooltip. The content is React children, never `innerHTML` — these labels come
 * from user data.
 */
export function Tooltip({ content, children, placement = 'top', className }: TooltipProps) {
  const [shown, setShown] = useState(false)
  const id = useId()
  return (
    <span
      className={cx(styles.tooltipWrap, className)}
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      aria-describedby={shown ? id : undefined}
    >
      {children}
      {shown ? (
        <span
          role="tooltip"
          id={id}
          className={cx(styles.tooltip, placement === 'bottom' ? styles.tooltipBottom : styles.tooltipTop)}
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}

export interface InfoTipProps {
  /** The explanation. Usually a model definition a planner may not share. */
  children: ReactNode
  label?: string
}

/** The little "i" beside a metric whose definition is worth stating. */
export function InfoTip({ children, label = 'What this means' }: InfoTipProps) {
  return (
    <Tooltip content={children}>
      <button type="button" className={styles.infoTip} aria-label={label}>
        <Icon name="info" size={13} />
      </button>
    </Tooltip>
  )
}

// ===========================================================================
// Toasts
// ===========================================================================

export type ToastTone = 'info' | 'good' | 'warning' | 'danger'

export interface ToastMessage {
  id: string
  message: ReactNode
  tone: ToastTone
  /** Milliseconds before it dismisses itself. `0` keeps it until dismissed. */
  duration: number
  action?: { label: string; onClick: () => void }
}

interface ToastApi {
  toast: (message: ReactNode, options?: { tone?: ToastTone; duration?: number; action?: ToastMessage['action'] }) => string
  dismiss: (id: string) => void
}

const noopToast: ToastApi = { toast: () => '', dismiss: () => undefined }
const ToastContext = createContext<ToastApi>(noopToast)

/** The imperative handle. Safe outside a provider — it simply does nothing. */
export function useToast(): ToastApi {
  return useContext(ToastContext)
}

const TONE_ICON: Record<ToastTone, IconName> = {
  info: 'info',
  good: 'good',
  warning: 'warning',
  danger: 'critical',
}

export interface ToastProps {
  toast: ToastMessage
  onDismiss: (id: string) => void
}

/** One toast. Exported so a screen can render the same shape inline. */
export function Toast({ toast, onDismiss }: ToastProps) {
  return (
    <div className={cx(styles.toast, styles[`toast_${toast.tone}`])}>
      <Icon name={TONE_ICON[toast.tone]} size={15} className={styles.toastIcon} />
      <div className={styles.toastBody}>{toast.message}</div>
      {toast.action !== undefined ? (
        <button type="button" className={styles.linkButton} onClick={toast.action.onClick}>
          {toast.action.label}
        </button>
      ) : null}
      <IconButton icon="close" label="Dismiss" size="sm" onClick={() => onDismiss(toast.id)} />
    </div>
  )
}

let toastSeq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMessage[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    setItems((prior) => prior.filter((item) => item.id !== id))
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const toast = useCallback<ToastApi['toast']>(
    (message, options) => {
      toastSeq += 1
      const id = `toast-${toastSeq}`
      const duration = options?.duration ?? 6000
      const item: ToastMessage = {
        id,
        message,
        tone: options?.tone ?? 'info',
        duration,
        action: options?.action,
      }
      setItems((prior) => [...prior.slice(-3), item])
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => {
            setItems((prior) => prior.filter((entry) => entry.id !== id))
            timers.current.delete(id)
          }, duration),
        )
      }
      return id
    },
    [],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.toastRegion} role="status" aria-live="polite" data-print="hide">
        {items.map((item) => (
          <Toast key={item.id} toast={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// ===========================================================================
// DataTable
// ===========================================================================

export interface DataTableColumn<T> {
  key: string
  header: ReactNode
  /** Numbers right, text left. Anything else reads as a mistake. */
  align?: 'left' | 'right'
  width?: number | string
  /** Omit to make the column unsortable. */
  sortValue?: (row: T) => number | string
  render: (row: T) => ReactNode
}

export interface DataTableProps<T> {
  /** Required — a table with no caption is unnavigable with a screen reader. */
  caption: string
  columns: Array<DataTableColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  selectedKey?: string
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  /** Fixed, because virtualisation needs to predict where a row is. */
  rowHeight?: number
  maxHeight?: number
  empty?: ReactNode
  stale?: boolean
  className?: string
}

/** Past this many rows the body is windowed; below it, everything renders. */
const VIRTUAL_THRESHOLD = 200
const OVERSCAN = 8

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  initialSort,
  rowHeight = 32,
  maxHeight = 460,
  empty,
  stale,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null)
  const [scrollTop, setScrollTop] = useState(0)
  const captionId = useId()

  const sorted = useMemo(() => {
    if (sort === null) return rows
    const column = columns.find((candidate) => candidate.key === sort.key)
    const read = column?.sortValue
    if (read === undefined) return rows
    const sign = sort.dir === 'asc' ? 1 : -1
    return rows.slice().sort((a, b) => {
      const left = read(a)
      const right = read(b)
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign
      return String(left).localeCompare(String(right)) * sign
    })
  }, [rows, columns, sort])

  const virtual = sorted.length > VIRTUAL_THRESHOLD
  const visibleCount = Math.ceil(maxHeight / rowHeight) + OVERSCAN * 2
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN) : 0
  const end = virtual ? Math.min(sorted.length, start + visibleCount) : sorted.length
  const visibleRows = virtual ? sorted.slice(start, end) : sorted
  const padTop = start * rowHeight
  const padBottom = Math.max(0, (sorted.length - end) * rowHeight)

  const toggleSort = (key: string): void => {
    setSort((prior) => {
      if (prior === null || prior.key !== key) return { key, dir: 'desc' }
      if (prior.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }

  if (rows.length === 0 && empty !== undefined) {
    return <div className={cx(styles.tableWrap, className)}>{empty}</div>
  }

  return (
    <div
      className={cx(styles.tableWrap, stale === true && styles.stale, className)}
      style={{ maxHeight }}
      data-print="expand"
      onScroll={(event) => {
        if (virtual) setScrollTop(event.currentTarget.scrollTop)
      }}
    >
      <table className={styles.table} aria-describedby={captionId} aria-rowcount={sorted.length}>
        <caption className={styles.visuallyHidden} id={captionId}>
          {caption}
          {virtual ? ` — ${sorted.length} rows, scrolled in a window` : ''}
        </caption>
        <thead className={styles.thead}>
          <tr style={{ height: rowHeight }}>
            {columns.map((column) => {
              const sortable = column.sortValue !== undefined
              const active = sort !== null && sort.key === column.key
              return (
                <th
                  key={column.key}
                  scope="col"
                  style={{ width: column.width, textAlign: column.align ?? 'left' }}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={cx(styles.sortButton, active && styles.sortActive)}
                      onClick={() => toggleSort(column.key)}
                    >
                      <span>{column.header}</span>
                      {active ? (
                        <Icon name={sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={11} />
                      ) : null}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {padTop > 0 ? (
            <tr aria-hidden="true" style={{ height: padTop }}>
              <td colSpan={columns.length} />
            </tr>
          ) : null}
          {visibleRows.map((row) => {
            const key = rowKey(row)
            const selected = selectedKey !== undefined && key === selectedKey
            return (
              <tr
                key={key}
                style={{ height: rowHeight }}
                className={cx(
                  onRowClick !== undefined && styles.rowClickable,
                  selected && styles.rowSelected,
                )}
                aria-selected={onRowClick !== undefined ? selected : undefined}
                tabIndex={onRowClick === undefined ? undefined : 0}
                onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
                onKeyDown={
                  onRowClick === undefined
                    ? undefined
                    : (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onRowClick(row)
                        }
                      }
                }
              >
                {columns.map((column) => (
                  <td key={column.key} style={{ textAlign: column.align ?? 'left' }}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            )
          })}
          {padBottom > 0 ? (
            <tr aria-hidden="true" style={{ height: padBottom }}>
              <td colSpan={columns.length} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
