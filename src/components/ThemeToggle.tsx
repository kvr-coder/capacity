/**
 * Light / System / Dark.
 *
 * Three states rather than two, and shown as three, because the interesting
 * case is the one a two-state switch cannot express: an explicit choice that
 * **overrides** `prefers-color-scheme` in either direction. A planner on a
 * machine set to dark who wants this one tool light must be able to say so, and
 * must be able to take it back.
 *
 * The store owns the preference and writes `data-theme` on the root element;
 * `tokens.css` does the rest with no JavaScript involved in the repaint.
 */

import { SegmentedControl } from '@/components/ui'
import type { ThemePreference } from '@/lib/storage'
import { useUiStore } from '@/state/store'
import styles from '@/components/ThemeToggle.module.css'

const OPTIONS = [
  { value: 'light' as const, label: 'Light', icon: 'sun' as const, hint: 'Always light' },
  {
    value: 'system' as const,
    label: 'System',
    icon: 'monitor' as const,
    hint: 'Follow the operating system',
  },
  { value: 'dark' as const, label: 'Dark', icon: 'moon' as const, hint: 'Always dark' },
]

export interface ThemeToggleProps {
  /** Icons only. The labels remain the accessible names. */
  compact?: boolean
  className?: string
}

export function ThemeToggle({ compact = true, className }: ThemeToggleProps) {
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)

  return (
    <SegmentedControl<ThemePreference>
      label="Colour theme"
      value={theme}
      options={OPTIONS}
      onChange={setTheme}
      size="sm"
      compact={compact}
      className={[styles.toggle, className ?? ''].filter(Boolean).join(' ')}
    />
  )
}
